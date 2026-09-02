import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";
import { snippet } from "./shared/text";
import type { BibHit } from "./shared/bib";

/**
 * Univerzita Karlova — UKAŽ, the university's discovery service on Ex Libris
 * Primo VE (cuni.primo.exlibrisgroup.com, view 420CKIS_INST:UKAZ): the UK
 * catalogue plus the Central Discovery Index of licensed e-resources.
 *
 * The client speaks to the public REST layer the Primo SPA itself uses,
 * captured from a live browser session (HAR, 2026-09): GET
 * /primaws/rest/pub/pnxs with the advanced-search query in Primo's own
 * `field,operator,value,BOOL;` syntax, `offset`/`limit` paging and the
 * language / date-range pre-filters appended as further clauses. Verified
 * live from the deployment (2026-09-02): the endpoint answers WITHOUT any
 * token, and the verbatim responses pin the envelope and the record layout
 * (tests/fixtures/primo/search-cdi-article.json — a Central Discovery Index
 * article; search-local-book.json — a catalogue book with contents and
 * subjects; record-local-book.json — the full-display endpoint's answer).
 * Every field is still parsed leniently. See docs/research/doctrine-sources.json.
 *
 * The guest-token fallback stays for the day Primo starts demanding one:
 * on 401/403 the client asks the guest-token endpoint the SPA uses (from
 * memory, not from a capture) and retries once; a refusal is reported.
 */

export const SOURCE = "UKAŽ (Univerzita Karlova, Primo)";
const BASE = "https://cuni.primo.exlibrisgroup.com";
export const PRIMO_VID = "420CKIS_INST:UKAZ";
const INST = "420CKIS_INST";
const LANG = "cs";

/** Records per request. The SPA asks for 10; that is the verified value. */
export const PRIMO_PAGE_SIZE = 10;

export interface PrimoSearchInput {
  /** Keywords in any field (`any,contains`). */
  query?: string;
  title?: string;
  author?: string;
  subject?: string;
  /** ISO 639-2 code as Primo indexes it: "cze", "eng", "ger". */
  language?: string;
  yearFrom?: number;
  yearTo?: number;
}

/**
 * A value inside a `field,operator,value,BOOL` clause. Commas and semicolons
 * are the syntax's own separators, so they cannot survive inside a value —
 * the SPA drops them too.
 */
function clauseValue(value: string): string {
  return value.replace(/[,;]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The `q` parameter: one clause per criterion, each with a trailing boolean
 * (`title,contains,x,AND;`), then the pre-filters the form appends in the
 * same syntax — `lang,exact,cze,AND`, `dr_s,exact,YYYY0101,AND`,
 * `dr_e,exact,YYYY1231,AND`. Verbatim shape of the capture. Pure — unit-tested.
 */
export function buildPrimoQuery(input: PrimoSearchInput): string {
  const clauses: string[] = [];
  if (input.query?.trim()) clauses.push(`any,contains,${clauseValue(input.query)},AND`);
  if (input.title?.trim()) clauses.push(`title,contains,${clauseValue(input.title)},AND`);
  if (input.author?.trim()) clauses.push(`creator,contains,${clauseValue(input.author)},AND`);
  if (input.subject?.trim()) clauses.push(`sub,contains,${clauseValue(input.subject)},AND`);
  if (input.language?.trim()) clauses.push(`lang,exact,${input.language.trim().toLowerCase()},AND`);
  if (input.yearFrom) clauses.push(`dr_s,exact,${input.yearFrom}0101,AND`);
  if (input.yearTo) clauses.push(`dr_e,exact,${input.yearTo}1231,AND`);
  return clauses.join(";");
}

/** Full URL of one results page — the captured parameter set, only `q`,
 * `offset` and `limit` filled in. Pure — unit-tested. */
export function buildPrimoUrl(input: PrimoSearchInput, offset: number, limit: number): string {
  const params = new URLSearchParams({
    acTriggered: "false",
    blendFacetsSeparately: "false",
    citationTrailFilterByAvailability: "true",
    disableCache: "false",
    getMore: "0",
    inst: INST,
    isCDSearch: "false",
    lang: LANG,
    limit: String(limit),
    mode: "advanced",
    newspapersActive: "true",
    newspapersSearch: "false",
    offset: String(offset),
    otbRanking: "false",
    pcAvailability: "false",
    q: buildPrimoQuery(input),
    qExclude: "",
    qInclude: "",
    rapido: "false",
    refEntryActive: "false",
    rtaLinks: "true",
    scope: "MyInst_and_CI",
    searchInFulltextUserSelection: "true",
    skipDelivery: "Y",
    sort: "rank",
    tab: "Everything",
    vid: PRIMO_VID,
  });
  return `${BASE}/primaws/rest/pub/pnxs?${params.toString()}`;
}

export interface PrimoSearchPage {
  total: number;
  /** Hits from the UK catalogue vs. the Central Discovery Index. */
  totalLocal: number;
  totalCentral: number;
  hits: BibHit[];
}

type Rec = Record<string, unknown>;

function obj(value: unknown): Rec {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : [];
}

function first(value: unknown): string | undefined {
  return strings(value)[0];
}

/** Primo display strings carry `$$Q…`/`$$U…` subfield tails ("Novák, Jan$$QNovák, Jan");
 * keep the text before the first marker. Pure. */
export function stripPrimoMarkers(value: string): string {
  return value.split("$$")[0].trim();
}

/** `$$Uhttps://…$$DLabel` → the URL. Pure. */
export function primoLinkUrl(value: string): string | undefined {
  const m = /\$\$U([^$]+)/.exec(value);
  return m ? m[1].trim() : /^https?:\/\//.test(value) ? value.trim() : undefined;
}

/**
 * One `docs[]` entry → BibHit. PNX sections: display (what the UI shows),
 * addata (OpenURL data: doi, isbn, issn, jtitle…), control (recordid). Every
 * field optional. Pure — unit-tested against a synthetic doc.
 */
/** Caps of the record view — the list shows 300 / 250 characters. */
export const FULL_ABSTRACT_CHARS = 4_000;
export const FULL_CONTENTS_CHARS = 6_000;

export function mapPrimoDoc(doc: Rec, full = false): BibHit {
  const pnx = obj(doc.pnx);
  const display = obj(pnx.display);
  const addata = obj(pnx.addata);
  const control = obj(pnx.control);
  const id = first(control.recordid) ?? (typeof doc["@id"] === "string" ? doc["@id"].split("/").pop() ?? "" : "");
  const context = typeof doc.context === "string" ? doc.context : undefined;

  const authors: string[] = [];
  for (const raw of [...strings(display.creator), ...strings(display.contributor)]) {
    const name = stripPrimoMarkers(raw);
    if (name && !authors.includes(name)) authors.push(name);
    if (authors.length >= 6) break;
  }
  const subjects: string[] = [];
  for (const raw of strings(display.subject)) {
    for (const part of stripPrimoMarkers(raw).split(/\s*;\s*/)) {
      if (part && !subjects.includes(part)) subjects.push(part);
      if (subjects.length >= 6) break;
    }
    if (subjects.length >= 6) break;
  }
  const links: string[] = [];
  const pnxLinks = obj(pnx.links);
  for (const raw of [...strings(pnxLinks.linktorsrc), ...strings(pnxLinks.openurlfulltext)]) {
    const url = primoLinkUrl(raw);
    if (url && !links.includes(url)) links.push(url);
    if (links.length >= 2) break;
  }
  const delivery = obj(doc.delivery);
  if (Array.isArray(delivery.link)) {
    for (const raw of delivery.link) {
      const link = obj(raw);
      // Display-only link types (the cover image) are not a way to the
      // work — the same rule accessLinkUrl applies to WorldCat's MARC 856.
      const type = typeof link.linkType === "string" ? link.linkType : "";
      // Both spellings occur live: the purl URI on CDI records, a bare
      // "thumbnail" on catalogue records.
      if (/(^|\/)(thumbnail|cover|coverimage)$/i.test(type)) continue;
      const url = typeof link.linkURL === "string" ? link.linkURL : undefined;
      if (!url || !/^https?:\/\//.test(url) || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) continue;
      if (!links.includes(url)) links.push(url);
      if (links.length >= 2) break;
    }
  }

  // "$$CISBN$$V978-…" / "DOI: 10.…" / "ISSN: …" — the display identifiers,
  // for records whose addata lacks the structured field.
  const identifiers = strings(display.identifier);
  const identifier = (kind: RegExp): string[] =>
    identifiers
      .map((raw) => {
        const marked = /\$\$C([A-Za-z]+)\$\$V(.+)$/.exec(raw);
        if (marked) return kind.test(marked[1]) ? marked[2].trim() : undefined;
        const labelled = /^([A-Za-z]+):\s*(.+)$/.exec(raw);
        return labelled && kind.test(labelled[1]) ? labelled[2].trim() : undefined;
      })
      .filter((value): value is string => Boolean(value));
  const year = first(display.creationdate) ?? first(addata.date);
  const container =
    first(display.ispartof) ??
    (first(addata.jtitle)
      ? [first(addata.jtitle), first(addata.volume) && `vol. ${first(addata.volume)}`, first(addata.issue) && `no. ${first(addata.issue)}`, first(addata.spage) && `p. ${first(addata.spage)}`]
          .filter(Boolean)
          .join(", ")
      : undefined);
  const description = first(display.description) ?? first(addata.abstract);
  const availability = strings(obj(delivery).availability);
  const openAccess = availability.some((a) => /open_access|free/i.test(a)) || strings(addata.oa).length > 0;

  return {
    source: "cuni",
    id,
    title: first(display.title) ? stripPrimoMarkers(first(display.title) as string) : "(bez názvu)",
    authors,
    year: year ? year.replace(/[[\]]/g, "").trim() : undefined,
    publisher: first(display.publisher) ? stripPrimoMarkers(first(display.publisher) as string) : undefined,
    type: first(display.type),
    language: first(display.language),
    isbn: (strings(addata.isbn).length ? strings(addata.isbn) : identifier(/^ISBN$/i)).slice(0, 4),
    issn: (strings(addata.issn).length ? strings(addata.issn) : identifier(/^E?ISSN$/i)).slice(0, 2),
    doi: (strings(addata.doi).length ? strings(addata.doi) : identifier(/^DOI$/i)).slice(0, 2),
    container,
    subjects,
    abstract: description ? snippet(description, full ? FULL_ABSTRACT_CHARS : 300) : undefined,
    // Catalogue books carry their table of contents in display.contents.
    contents: first(display.contents) ? snippet(first(display.contents) as string, full ? FULL_CONTENTS_CHARS : 250) : undefined,
    open_access: openAccess || undefined,
    // The record's own page in UKAŽ; context (L = catalogue, PC = Central
    // Discovery Index) is part of the full-display route.
    url: id
      ? `${BASE}/discovery/fulldisplay?docid=${encodeURIComponent(id)}&vid=${encodeURIComponent(PRIMO_VID)}&lang=${LANG}${context ? `&context=${encodeURIComponent(context)}` : ""}`
      : null,
    links: links.length ? links : undefined,
  };
}

/** Whole pnxs response → page. PARSE_DRIFT when `info.total`/`docs` are
 * missing — the envelope every capture, empty or not, carries. Pure. */
export function parsePrimoSearch(json: unknown): PrimoSearchPage {
  const body = obj(json);
  const info = obj(body.info);
  if (typeof info.total !== "number" || !Array.isArray(body.docs)) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "Primo search response is missing info.total/docs.",
      "The Primo REST layer may have changed shape or demanded a token — run dawmain_probe_sources (canary 'primo') with include_raw.",
    );
  }
  return {
    total: info.total,
    totalLocal: typeof info.totalResultsLocal === "number" ? info.totalResultsLocal : 0,
    totalCentral: typeof info.totalResultsPC === "number" ? info.totalResultsPC : 0,
    hits: body.docs.map((doc) => mapPrimoDoc(obj(doc))),
  };
}

// ---------- one record ----------

/** Local catalogue ids start with "alma", Central Discovery Index ids with
 * "cdi_" — the context the full-display route wants. Pure. */
export function primoContext(id: string): "L" | "PC" {
  return id.startsWith("cdi_") ? "PC" : "L";
}

const recordCache = new TtlCache<BibHit>(SEARCH_TTL_MS);

/**
 * One record in full. The SPA's full-display call — GET
 * /primaws/rest/pub/pnxs/{L|PC}/{recordid}?vid=…&lang=cs&search_scope=… —
 * verified live from the deployment (2026-09-02; response pinned in
 * tests/fixtures/primo/record-local-book.json, holdings included). A miss
 * is reported as such; the search results carry the record's main fields.
 */
export async function getPrimoRecord(id: string): Promise<BibHit> {
  const recordId = id.trim();
  if (!/^[A-Za-z0-9_.:-]{3,200}$/.test(recordId)) {
    throw new SourceError(SOURCE, "INPUT_INVALID", `"${id}" is not a Primo record id.`, "Pass the id of a cuni hit from doctrine_search (alma… or cdi_…).");
  }
  return recordCache.through(memoKey("primo-record", recordId), async () => {
    const context = primoContext(recordId);
    const url = `${BASE}/primaws/rest/pub/pnxs/${context}/${encodeURIComponent(recordId)}?vid=${encodeURIComponent(PRIMO_VID)}&lang=${LANG}&search_scope=MyInst_and_CI`;
    const response = await fetchPrimo(url);
    if (response.status === 404) {
      throw new SourceError(SOURCE, "NOT_FOUND", `Primo has no record ${recordId} in context ${context}.`, "Take the id from a doctrine_search hit; if it came from there, the full-display endpoint (unverified against a capture) may differ — the search results already carry the record's main fields.");
    }
    if (!response.ok) {
      throw new SourceError(SOURCE, "UPSTREAM_ERROR", `Primo answered HTTP ${response.status} for the record.`, "The full-display endpoint is from memory, not from the capture — a HAR of opening one record in UKAŽ would pin it. The search results already carry the record's main fields.");
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new SourceError(SOURCE, "PARSE_DRIFT", "Primo answered the record request with a non-JSON body.", "Run dawmain_probe_sources (canary 'primo') with include_raw.");
    }
    const doc = obj(json);
    if (!obj(doc.pnx).display) {
      throw new SourceError(SOURCE, "PARSE_DRIFT", "Primo's record response carries no pnx.display.", "The full-display endpoint is from memory — a HAR of opening one record in UKAŽ would pin it.");
    }
    const hit = mapPrimoDoc(doc, true);
    return hit.id ? hit : { ...hit, id: recordId };
  });
}

// ---------- guest token (fallback only) ----------

/** Guest JWT the SPA obtains before searching. Cached per warm instance. */
const GUEST_TOKEN_TTL_MS = 30 * 60 * 1000;
const guestToken = new TtlCache<string>(GUEST_TOKEN_TTL_MS, 1);
const GUEST_TOKEN_KEY = "primo-guest-jwt";

async function fetchGuestToken(): Promise<string> {
  return guestToken.through(GUEST_TOKEN_KEY, async () => {
    // From memory of the Primo VE SPA, not from the capture (which was
    // exported without Authorization headers): the institution's guest-JWT
    // endpoint. Only ever called after an unsigned search was refused.
    const target = `${BASE}/discovery/search?vid=${encodeURIComponent(PRIMO_VID)}`;
    const url = `${BASE}/primaws/rest/pub/institution/${INST}/jwt?isGuest=true&lang=${LANG}&targetUrl=${encodeURIComponent(target)}&viewId=${encodeURIComponent(PRIMO_VID)}`;
    const response = await fetchUpstream(SOURCE, url, {
      headers: { accept: "application/json, text/plain, */*", referer: `${BASE}/discovery/search?vid=${PRIMO_VID}` },
    });
    const text = (await response.text()).trim().replace(/^"|"$/g, "");
    if (!response.ok || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) {
      throw new SourceError(
        SOURCE,
        "SESSION_EXPIRED",
        `Primo refused the unsigned search and the guest-token endpoint answered HTTP ${response.status}.`,
        "The token flow needs a capture of the SPA's own request (Authorization header + the jwt call) — until then search UKAŽ by hand at https://cuni.primo.exlibrisgroup.com/discovery/search?vid=420CKIS_INST:UKAZ.",
      );
    }
    return text;
  });
}

/** One Primo REST call: unsigned first, once more with the guest JWT when
 * the unsigned call is refused. */
async function fetchPrimo(url: string): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "accept-language": "cs,en;q=0.8",
    referer: `${BASE}/discovery/search?vid=${PRIMO_VID}&lang=${LANG}&mode=advanced`,
  };
  const response = await fetchUpstream(SOURCE, url, { headers, timeoutMs: 20_000 });
  if (response.status !== 401 && response.status !== 403) return response;
  const token = await fetchGuestToken();
  const signed = await fetchUpstream(SOURCE, url, { headers: { ...headers, authorization: `Bearer ${token}` }, timeoutMs: 20_000 });
  if (signed.status === 401 || signed.status === 403) {
    // A replayed dead token must not stick for its whole TTL.
    guestToken.delete(GUEST_TOKEN_KEY);
    throw new SourceError(
      SOURCE,
      "SESSION_EXPIRED",
      `Primo refused the search even with the guest token (HTTP ${signed.status}).`,
      "The token flow this client knows (from memory, not from the capture) does not open UKAŽ — a HAR of one search in the browser, exported with the Authorization header, would pin it. Until then search UKAŽ by hand at https://cuni.primo.exlibrisgroup.com/discovery/search?vid=420CKIS_INST:UKAZ.",
    );
  }
  return signed;
}

const searchCache = new TtlCache<PrimoSearchPage>(SEARCH_TTL_MS);

/** One results page: `offset` records in, `limit` records (≤ PRIMO_PAGE_SIZE). */
export async function searchPrimo(input: PrimoSearchInput, offset: number, limit = PRIMO_PAGE_SIZE): Promise<PrimoSearchPage> {
  return searchCache.through(memoKey("primo-search", [input, offset, limit]), () => runSearchPrimo(input, offset, limit));
}

async function runSearchPrimo(input: PrimoSearchInput, offset: number, limit: number): Promise<PrimoSearchPage> {
  if (!buildPrimoQuery(input).replace(/(lang|dr_s|dr_e),exact,[^;]*;?/g, "")) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "Primo search needs at least one search criterion besides language/years.",
      "Provide query (keywords), title, author or subject.",
    );
  }
  const response = await fetchPrimo(buildPrimoUrl(input, offset, limit));
  if (!response.ok) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `Primo answered HTTP ${response.status}.`,
      "Try again in a minute; if it persists run dawmain_probe_sources (canary 'primo').",
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "Primo answered with a non-JSON body.",
      "Run dawmain_probe_sources (canary 'primo') with include_raw to see what came back.",
    );
  }
  return parsePrimoSearch(json);
}
