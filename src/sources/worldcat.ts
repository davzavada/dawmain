import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";
import { snippet } from "./shared/text";
import type { BibHit } from "./shared/bib";

/**
 * Peace Palace Library (The Hague) — its catalogue runs on OCLC's WorldCat
 * Discovery (peacepalace.on.worldcat.org): WorldCat.org itself plus the
 * licensed collections the library subscribes to (Nomos eLibrary, Brill,
 * Kluwer Law Online, OUP Law, Cambridge journals, Springer, Elgar…).
 *
 * The client speaks to the JSON backend of the Discovery SPA, captured from
 * a live browser session (HAR, 2026-09): GET /api/search with the query
 * string in WorldCat's own index syntax (kw:/ti:/au:/su:/la:, yr: ranges),
 * a fixed page size of 10 and 1-based `page`. Response shape and field names
 * are pinned by tests/fixtures/worldcat/*.json (verbatim records from that
 * capture). See docs/research/doctrine-sources.json.
 *
 * Caveat, verified from the capture itself: the SPA signs EVERY request with
 * two headers (Oclc-Apik — a 64-hex digest, Oclc-Apin — a 40-digit nonce;
 * both differ on every call) and carries a session JWE in `api-token`. None
 * of them is reproduced here — their algorithm lives in the SPA's bundle,
 * which the capture does not include. Whether an unsigned request is served
 * is what the probe canary answers; a 401/403 is reported as such, never
 * papered over.
 */

export const SOURCE = "Peace Palace Library (WorldCat)";
const BASE = "https://peacepalace.on.worldcat.org";

/**
 * The databases the library's advanced search ticks by default — verbatim
 * `databaseList` of the captured request. 638 is WorldCat.org; the rest are
 * the licensed collections (the facet response names them: Nomos eLibrary,
 * Cambridge University Press Journals, Boom Juridisch, Bloomsbury
 * Collections, the Brill reference works, Duncker & Humblot, Elgar, Kluwer
 * Law Online, OUP Law Collection, Springer Nature).
 */
export const PEACE_PALACE_DATABASES =
  "10007,10025,10052,10058,10306,10896,11162,11537,2795,3313,3560,3577,3578,3583,3590,3962,3963,4023,4052,4056,638";

/** Records per page the backend returns — fixed; there is no rows parameter
 * on the captured search call. */
export const WORLDCAT_PAGE_SIZE = 10;

export interface WorldcatSearchInput {
  /** Keywords anywhere (kw:). */
  query?: string;
  title?: string;
  author?: string;
  subject?: string;
  /** MARC language code: "eng", "cze", "ger", "fre". */
  language?: string;
  yearFrom?: number;
  yearTo?: number;
  /** Only records with full text available (the "Full Text" content facet). */
  fullTextOnly?: boolean;
}

/**
 * A criterion value inside the index syntax. Parentheses group terms in
 * WorldCat's query language, so a stray one inside a value would unbalance
 * the whole expression; quotes are kept — "exact phrase" works as expected.
 */
function indexValue(value: string): string {
  return value.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The `queryString` of the advanced search, exactly as the form composes it:
 * `kw:(…) AND ti:(…) AND au:(…) AND su:(…)`, language as the `la:` index.
 * Pure — unit-tested.
 */
export function buildWorldcatQuery(input: WorldcatSearchInput): string {
  const parts: string[] = [];
  if (input.query?.trim()) parts.push(`kw:(${indexValue(input.query)})`);
  if (input.title?.trim()) parts.push(`ti:(${indexValue(input.title)})`);
  if (input.author?.trim()) parts.push(`au:(${indexValue(input.author)})`);
  if (input.subject?.trim()) parts.push(`su:(${indexValue(input.subject)})`);
  if (input.language?.trim()) parts.push(`la:${input.language.trim().toLowerCase()}`);
  return parts.join(" AND ");
}

/**
 * Full URL of one results page. Parameter set verbatim from the capture;
 * `year` is the form's publication-year facet (the backend rewrites it into
 * a `yr:from..to` clause, visible in its echoed originalQuery), `content=
 * fullText` the "Full Text" facet, `page` absent on the first page just as
 * the SPA sends it. Pure — unit-tested.
 */
export function buildWorldcatUrl(input: WorldcatSearchInput, page: number): string {
  const params = new URLSearchParams();
  params.set("queryString", buildWorldcatQuery(input));
  params.set("databaseList", PEACE_PALACE_DATABASES);
  params.set("sortKey", "BEST_MATCH");
  params.set("clusterResults", "true");
  params.set("groupVariantRecords", "false");
  params.set("bookReviews", "off");
  if (input.yearFrom || input.yearTo) {
    const from = input.yearFrom ?? 1800;
    const to = input.yearTo ?? new Date().getUTCFullYear() + 1;
    params.set("year", `${from}..${to}`);
  }
  if (input.fullTextOnly) params.set("content", "fullText");
  params.set("idDetect", "true");
  params.set("citeDetect", "true");
  if (page > 1) params.set("page", String(page));
  return `${BASE}/api/search?${params.toString()}`;
}

export interface WorldcatSearchPage {
  total: number;
  hits: BibHit[];
  /** The backend flags a page one of its databases failed to answer for. */
  partial: boolean;
}

type Rec = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
}

/** `{data: "…"}` objects — WorldCat wraps most display strings this way. */
function data(value: unknown): string | undefined {
  return value && typeof value === "object" ? str((value as Rec).data) : undefined;
}

function dataList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = data(entry);
    if (text) out.push(text);
  }
  return out;
}

/** "Henry G" + "Schermers" → "Henry G Schermers"; organisations carry only
 * one name object. Pure. */
function authorName(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const author = entry as Rec;
  const first = data(author.firstNameObject);
  const last = data(author.lastNameObject);
  const name = [first, last].filter(Boolean).join(" ");
  return name || undefined;
}

/**
 * One record of the search response → BibHit. Field names verbatim from the
 * capture; every field optional, because a record from a licensed database
 * (an article from Nomos or Kluwer) carries a different subset from a
 * WorldCat.org book. Pure — unit-tested.
 */
export function mapWorldcatRecord(record: Rec): BibHit {
  const oclcNumber = str(record.oclcNumber) ?? strings(record.editionOclcNumbers)[0];
  const title = data(record.titleObject) ?? str(record.title) ?? "(bez názvu)";
  const authors: string[] = [];
  if (Array.isArray(record.authors)) {
    for (const entry of record.authors) {
      const name = authorName(entry);
      if (name && !authors.includes(name)) authors.push(name);
    }
  }
  const subjects: string[] = [];
  if (Array.isArray(record.subjectGroups)) {
    for (const group of record.subjectGroups) {
      const bib = (group as Rec)?.bibSubjects;
      if (!Array.isArray(bib)) continue;
      for (const subject of bib) {
        const unified = (subject as Rec)?.unifiedData;
        const label =
          (unified && typeof unified === "object" ? str((unified as Rec).displayData) : undefined) ??
          str((subject as Rec)?.data);
        if (label && !subjects.includes(label)) subjects.push(label);
        if (subjects.length >= 6) break;
      }
      if (subjects.length >= 6) break;
    }
  }
  const links: string[] = [];
  if (Array.isArray(record.links)) {
    for (const link of record.links) {
      const url = str((link as Rec)?.url);
      if (url && !links.includes(url)) links.push(url);
      if (links.length >= 2) break;
    }
  }
  const doi = strings(record.digitalObjectIdentifiers);
  const summary = dataList(record.summariesObjectList)[0];
  const contentsEntry = Array.isArray(record.contentsObjects) ? (record.contentsObjects[0] as Rec | undefined) : undefined;
  const contents = str(contentsEntry?.note) ?? data(contentsEntry?.noteObject);

  return {
    source: "peacepalace",
    id: oclcNumber ?? "",
    title,
    authors: authors.slice(0, 6),
    year: str(record.date),
    publisher: dataList(record.publishers)[0],
    type: str(record.itemTypeDisplay) ?? str(record.itemType),
    language: str(record.language),
    isbn: strings(record.isbns).slice(0, 4),
    issn: strings(record.issns).slice(0, 2),
    doi: doi.slice(0, 2),
    subjects,
    abstract: summary ? snippet(summary, 300) : undefined,
    contents: contents ? snippet(contents, 250) : undefined,
    open_access: typeof record.openAccess === "boolean" ? record.openAccess : undefined,
    // The Discovery permalink of the record; the SPA's own opacLink (a search
    // by OCLC number or ISBN) is the fallback when a record carries no number.
    url: oclcNumber ? `${BASE}/oclc/${encodeURIComponent(oclcNumber)}` : (str(record.opacLink) ?? null),
    links: links.length ? links : undefined,
  };
}

/** Whole search response → page. PARSE_DRIFT when the two fields every
 * page must carry are gone. Pure — unit-tested. */
export function parseWorldcatSearch(json: unknown): WorldcatSearchPage {
  const body = (json ?? {}) as Rec;
  if (typeof body.numberOfRecords !== "number" || !Array.isArray(body.records)) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "WorldCat Discovery search response is missing numberOfRecords/records.",
      "The Discovery backend may have changed shape or refused the unsigned request — run dawmain_probe_sources (canary 'worldcat') with include_raw.",
    );
  }
  return {
    total: body.numberOfRecords,
    hits: body.records.map((record) => mapWorldcatRecord((record ?? {}) as Rec)),
    partial: body.partialResult === true,
  };
}

const searchCache = new TtlCache<WorldcatSearchPage>(SEARCH_TTL_MS);

/** One results page (10 records), 1-based. */
export async function searchWorldcat(input: WorldcatSearchInput, page: number): Promise<WorldcatSearchPage> {
  return searchCache.through(memoKey("worldcat-search", [input, page]), () => runSearchWorldcat(input, page));
}

async function runSearchWorldcat(input: WorldcatSearchInput, page: number): Promise<WorldcatSearchPage> {
  const queryString = buildWorldcatQuery(input);
  if (!queryString) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "WorldCat search needs at least one criterion.",
      "Provide query (keywords), title, author or subject.",
    );
  }
  const url = buildWorldcatUrl(input, page);
  const response = await fetchUpstream(SOURCE, url, {
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "en",
      referer: `${BASE}/search?queryString=${encodeURIComponent(queryString)}`,
    },
    timeoutMs: 20_000,
  });
  if (response.status === 401 || response.status === 403) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `WorldCat Discovery refused the request (HTTP ${response.status}).`,
      "The Discovery SPA signs each call (Oclc-Apik/Oclc-Apin + api-token), which this server does not reproduce — the library's catalogue must be searched by hand at https://peacepalace.on.worldcat.org until that changes.",
    );
  }
  if (!response.ok) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `WorldCat Discovery answered HTTP ${response.status}.`,
      "Try again in a minute; if it persists run dawmain_probe_sources (canary 'worldcat').",
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "WorldCat Discovery answered with a non-JSON body.",
      "Run dawmain_probe_sources (canary 'worldcat') with include_raw to see what came back.",
    );
  }
  return parseWorldcatSearch(json);
}
