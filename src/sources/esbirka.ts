import { ESBIRKA_CACHE_BASE, getEsbirkaApiBase, getEsbirkaApiKey } from "@/src/mcp/config";
import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { htmlToText } from "./shared/html";
import { TtlCache } from "./shared/cache";

/**
 * e-Sbírka — the official Czech electronic Collection of Laws.
 *
 * Primary channel: the registered public REST API (key in header
 * `esel-api-access-key`). Fallback: the SPA's keyless gateway (sbr-cache),
 * which serves the SAME paths and response shapes. Everything is addressed by
 * `staleUrl` = `/sb/{rok}/{cislo}` optionally + `/{YYYY-MM-DD}` for a time
 * version; as a path parameter it must be percent-encoded whole (slashes too).
 *
 * Endpoints (see docs/research/cz-sources.json for the full spec):
 *   POST /jednoducha-vyhledavani                       full-text search
 *   GET  /dokumenty-sbirky/{enc}                       act metadata
 *   GET  /dokumenty-sbirky/{enc}/historie              time versions
 *   GET  /dokumenty-sbirky/{enc}/fragmenty?cisloStranky=N   text fragments
 * Single-§ retrieval has no REST endpoint; it goes through the keyless
 * open-data SPARQL endpoint, with a bounded fragment-page scan as fallback.
 */

const SOURCE = "e-Sbírka";
const SPARQL_ENDPOINT = "https://opendata.eselpoint.gov.cz/sparql";
const ESB = "https://slovník.gov.cz/datový/sbírka/pojem/";
/** Fragment-page scan cap for the section fallback (each page is one request). */
const SECTION_SCAN_MAX_PAGES = 15;
/** Act metadata and version history are near-static — cache 10 min. */
const metadataCache = new TtlCache<unknown>(10 * 60 * 1000);

export function buildStaleUrl(collection: string, year: number, number: number, date?: string): string {
  return `/${collection}/${year}/${number}${date ? `/${date}` : ""}`;
}

// ---------- upstream fetch with official→keyless fallback ----------

interface EsbirkaRequest {
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
}

async function esbirkaFetch(request: EsbirkaRequest): Promise<unknown> {
  const key = getEsbirkaApiKey();
  const attempts: Array<{ base: string; headers: Record<string, string> }> = [];
  if (key) {
    attempts.push({ base: getEsbirkaApiBase(), headers: { "esel-api-access-key": key } });
  }
  attempts.push({ base: ESBIRKA_CACHE_BASE, headers: {} });

  let lastError: unknown;
  for (const [index, attempt] of attempts.entries()) {
    const isLast = index === attempts.length - 1;
    try {
      const response = await fetchUpstream(SOURCE, `${attempt.base}${request.path}`, {
        method: request.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(request.body !== undefined ? { "content-type": "application/json" } : {}),
          ...attempt.headers,
        },
        body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
      });

      // 401/403 on the keyed channel = bad key → try the keyless gateway.
      if ((response.status === 401 || response.status === 403) && !isLast) {
        lastError = new Error(`HTTP ${response.status} from ${attempt.base}`);
        continue;
      }
      if (response.status === 404) {
        throw new SourceError(
          SOURCE,
          "NOT_FOUND",
          `e-Sbírka has no document at ${request.path}.`,
          "Check the collection/year/number (e.g. 89/2012 Sb. = year 2012, number 89). For a time version, the date must fall within the act's existence.",
        );
      }
      if (!response.ok) {
        throw new SourceError(
          SOURCE,
          "UPSTREAM_ERROR",
          `e-Sbírka answered HTTP ${response.status} for ${request.path}.`,
          "Try again; if it persists, run dawmain_probe_sources.",
        );
      }

      const json = (await response.json()) as Record<string, unknown>;
      // Error shape used by the gateway: {"chyby":[{popis}]}
      if (Array.isArray(json.chyby) && json.chyby.length) {
        const popis = (json.chyby as Array<{ popis?: string }>).map((ch) => ch.popis).join("; ");
        throw new SourceError(
          SOURCE,
          "UPSTREAM_ERROR",
          `e-Sbírka rejected the request: ${popis}`,
          "Adjust the input (identifier or date) and retry.",
        );
      }
      return json;
    } catch (error) {
      if (error instanceof SourceError && error.kind !== "UPSTREAM_UNREACHABLE") throw error;
      lastError = error;
      if (isLast) throw error;
    }
  }
  throw lastError;
}

// ---------- parse (pure) ----------

export interface EsbirkaSearchItem {
  staleUrl: string;
  nazev: string;
  kod?: string;
  stav?: string;
  datum?: string;
}

export interface EsbirkaSearchPage {
  total: number;
  items: EsbirkaSearchItem[];
}

export function parseSearch(json: unknown): EsbirkaSearchPage {
  const data = json as { pocetCelkem?: number; seznam?: Array<Record<string, unknown>> };
  if (!Array.isArray(data.seznam)) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "e-Sbírka search response is missing the 'seznam' array.",
      "The API shape may have changed — run dawmain_probe_sources with include_raw to capture the new shape.",
    );
  }
  return {
    total: typeof data.pocetCelkem === "number" ? data.pocetCelkem : data.seznam.length,
    items: data.seznam.map((item) => ({
      staleUrl: String(item.staleUrl ?? ""),
      nazev: String(item.nazev ?? ""),
      kod: item.kodDokumentuSbirky ? String(item.kodDokumentuSbirky) : undefined,
      stav: item.stavDokumentuSbirky ? String(item.stavDokumentuSbirky) : undefined,
      datum: item.datum ? String(item.datum) : undefined,
    })),
  };
}

export interface EsbirkaActDetail {
  staleUrl: string;
  nazev: string;
  eli?: string;
  uplnaCitace?: string;
  datumCasVyhlaseni?: string;
  datumUcinnostiOd?: string;
  datumUcinnostiZneniOd?: string;
  datumUcinnostiZneniDo?: string;
  typZneni?: string;
}

export function parseActDetail(json: unknown): EsbirkaActDetail {
  const data = json as Record<string, unknown>;
  if (typeof data.nazev !== "string" && typeof data.staleUrl !== "string") {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "e-Sbírka act detail is missing both 'nazev' and 'staleUrl'.",
      "The API shape may have changed — run dawmain_probe_sources with include_raw.",
    );
  }
  const str = (key: string) => (typeof data[key] === "string" ? (data[key] as string) : undefined);
  return {
    staleUrl: str("staleUrl") ?? "",
    nazev: str("nazev") ?? "",
    eli: str("eli"),
    uplnaCitace: str("uplnaCitace"),
    datumCasVyhlaseni: str("datumCasVyhlaseni"),
    datumUcinnostiOd: str("datumUcinnostiOd"),
    datumUcinnostiZneniOd: str("datumUcinnostiZneniOd"),
    datumUcinnostiZneniDo: str("datumUcinnostiZneniDo"),
    typZneni: str("typZneni"),
  };
}

export interface EsbirkaVersion {
  datumUcinnostiOd?: string;
  datumUcinnostiDo?: string;
  typZneni?: string;
  cisloZneni?: number;
  staleUrl?: string;
}

export function parseHistory(json: unknown): EsbirkaVersion[] {
  const data = json as { historie?: Array<Record<string, unknown>> };
  if (!Array.isArray(data.historie)) return [];
  return data.historie.map((entry) => {
    const str = (key: string) => (typeof entry[key] === "string" ? (entry[key] as string) : undefined);
    return {
      datumUcinnostiOd: str("datumUcinnostiZneniOd") ?? str("datumUcinnostiOd"),
      datumUcinnostiDo: str("datumUcinnostiZneniDo") ?? str("datumUcinnostiDo"),
      typZneni: str("typZneni"),
      cisloZneni: typeof entry.cisloZneni === "number" ? entry.cisloZneni : undefined,
      staleUrl: str("staleUrl"),
    };
  });
}

export interface EsbirkaFragment {
  text: string;
  zkracenaCitace?: string;
  kodTypuFragmentu?: string;
  hloubka?: number;
}

export interface EsbirkaFragmentsPage {
  totalPages: number;
  fragments: EsbirkaFragment[];
}

export function parseFragments(json: unknown): EsbirkaFragmentsPage {
  const data = json as { seznam?: Array<Record<string, unknown>>; pocetStranek?: number };
  if (!Array.isArray(data.seznam)) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "e-Sbírka fragments response is missing the 'seznam' array.",
      "The API shape may have changed — run dawmain_probe_sources with include_raw.",
    );
  }
  return {
    totalPages: typeof data.pocetStranek === "number" ? data.pocetStranek : 1,
    fragments: data.seznam.map((fragment) => ({
      text: typeof fragment.xhtml === "string" ? htmlToText(fragment.xhtml) : "",
      zkracenaCitace: fragment.zkracenaCitace ? String(fragment.zkracenaCitace) : undefined,
      kodTypuFragmentu: fragment.kodTypuFragmentu ? String(fragment.kodTypuFragmentu) : undefined,
      hloubka: typeof fragment.hloubka === "number" ? fragment.hloubka : undefined,
    })),
  };
}

// ---------- fetch (I/O) ----------

export interface EsbirkaSearchOptions {
  /** all_words (default) | phrase | any_word — how the query terms combine. */
  match?: "all_words" | "phrase" | "any_word";
  /** Words that must NOT occur. */
  excludeWords?: string;
  dateFrom?: string;
  dateTo?: string;
}

export async function searchActs(
  query: string,
  offset: number,
  limit: number,
  options: EsbirkaSearchOptions = {},
): Promise<EsbirkaSearchPage> {
  const paging = { start: offset, pocet: limit, razeni: ["+relevance"] };
  const advanced =
    (options.match && options.match !== "all_words") ||
    options.excludeWords ||
    options.dateFrom ||
    options.dateTo;

  if (!advanced) {
    const json = await esbirkaFetch({
      path: "/jednoducha-vyhledavani",
      method: "POST",
      body: { fulltext: query, ...paging },
    });
    return parseSearch(json);
  }

  // Advanced endpoint (body fields verbatim from the official OpenAPI).
  const body: Record<string, unknown> = { ...paging };
  if (options.match === "phrase") body.fulltextUvedenaFraze = query;
  else if (options.match === "any_word") body.fulltextJednoZeSlov = query;
  else body.fulltextVsechnaSlova = query;
  if (options.excludeWords) body.fulltextNeobsahujeSlova = options.excludeWords;
  if (options.dateFrom) body.predmetneDatumOd = options.dateFrom;
  if (options.dateTo) body.predmetneDatumDo = options.dateTo;

  const json = await esbirkaFetch({ path: "/rozsirena-vyhledavani", method: "POST", body });
  return parseSearch(json);
}

export async function getAct(staleUrl: string): Promise<EsbirkaActDetail> {
  const json = await metadataCache.through(`act:${staleUrl}`, () =>
    esbirkaFetch({ path: `/dokumenty-sbirky/${encodeURIComponent(staleUrl)}` }),
  );
  return parseActDetail(json);
}

export async function getHistory(staleUrl: string): Promise<EsbirkaVersion[]> {
  const json = await metadataCache.through(`hist:${staleUrl}`, () =>
    esbirkaFetch({ path: `/dokumenty-sbirky/${encodeURIComponent(staleUrl)}/historie` }),
  );
  return parseHistory(json);
}

export async function getFragmentsPage(staleUrl: string, page: number): Promise<EsbirkaFragmentsPage> {
  const json = await esbirkaFetch({
    path: `/dokumenty-sbirky/${encodeURIComponent(staleUrl)}/fragmenty?cisloStranky=${page}`,
  });
  return parseFragments(json);
}

// ---------- single § ----------

/** "§ 12", "§12", "12" → the paragraph number as written after the sign. */
export function normalizeSectionLabel(section: string): string {
  return section.replace(/^§\s*/u, "").trim();
}

function sectionSparql(actIri: string, paragraph: string, dated: boolean): string {
  // Version IRI: the act IRI itself dereferences to the current version when a
  // date is embedded; otherwise follow má-poslední-znění.
  const versionPattern = dated
    ? `BIND(<${actIri}> AS ?zneni)`
    : `<${actIri}> <${ESB}má-poslední-znění> ?zneni .`;
  return `
SELECT ?ord ?ozn ?text WHERE {
  ${versionPattern}
  ?zneni <${ESB}má-fragment-znění> ?fz .
  ?fz <${ESB}má-předka>* ?parent .
  ?parent <${ESB}označení-fragmentu-znění-právního-aktu> ?ozn .
  FILTER(REGEX(STR(?ozn), "^§\\\\s*${paragraph}$"))
  ?fz <${ESB}pořadí-fragmentu-znění-právního-aktu> ?ord .
  ?fz <${ESB}obsahuje-fragment> ?frag .
  ?frag <${ESB}text-fragmentu> ?text .
}
ORDER BY ?ord
LIMIT 500`;
}

async function getSectionViaSparql(
  collection: string,
  year: number,
  number: number,
  date: string | undefined,
  paragraph: string,
): Promise<string | null> {
  const actIri = `https://opendata.eselpoint.gov.cz/esel-esb/eli/cz/${collection}/${year}/${number}${date ? `/${date}` : ""}`;
  const query = sectionSparql(actIri, paragraph, Boolean(date));
  const response = await fetchUpstream(SOURCE, `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}`, {
    headers: { accept: "application/sparql-results+json, application/json" },
    timeoutMs: 20_000,
  });
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return null;
  const json = (await response.json()) as {
    results?: { bindings?: Array<{ text?: { value?: string } }> };
  };
  const bindings = json.results?.bindings ?? [];
  if (!bindings.length) return null;
  const text = bindings
    .map((b) => (b.text?.value ? htmlToText(b.text.value) : ""))
    .filter(Boolean)
    .join("\n");
  return text || null;
}

async function getSectionViaScan(staleUrl: string, paragraph: string): Promise<string | null> {
  const sectionRe = new RegExp(`(^|[^0-9a-z])§\\s*${paragraph}(\\s|$|[^0-9a-z])`, "iu");
  const collected: string[] = [];
  let totalPages = 1;
  for (let page = 0; page < Math.min(totalPages, SECTION_SCAN_MAX_PAGES); page++) {
    const result = await getFragmentsPage(staleUrl, page);
    totalPages = result.totalPages;
    for (const fragment of result.fragments) {
      if (fragment.zkracenaCitace && sectionRe.test(fragment.zkracenaCitace)) {
        collected.push(fragment.text);
      }
    }
    // Fragments of one § are contiguous; once we have some and the page had
    // none, we are past the section.
    if (collected.length && !result.fragments.some((f) => f.zkracenaCitace && sectionRe.test(f.zkracenaCitace))) {
      break;
    }
  }
  return collected.length ? collected.join("\n") : null;
}

export async function getSection(
  collection: string,
  year: number,
  number: number,
  date: string | undefined,
  section: string,
): Promise<{ text: string; via: "sparql" | "scan" }> {
  const paragraph = normalizeSectionLabel(section);
  // The label feeds two regexes — restrict it to the shapes Czech acts use (12, 3a, 129b).
  if (!/^[0-9]{1,4}[a-z]{0,3}$/i.test(paragraph)) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${section}" is not a valid section label.`,
      'Pass the section as "§ 12" or just "12" (letter suffixes like "3a" are fine).',
    );
  }
  try {
    const viaSparql = await getSectionViaSparql(collection, year, number, date, paragraph);
    if (viaSparql) return { text: viaSparql, via: "sparql" };
  } catch {
    // SPARQL is best-effort — fall through to the REST scan.
  }
  const staleUrl = buildStaleUrl(collection, year, number, date);
  const viaScan = await getSectionViaScan(staleUrl, paragraph);
  if (viaScan) return { text: viaScan, via: "scan" };
  throw new SourceError(
    SOURCE,
    "NOT_FOUND",
    `Section § ${paragraph} was not found in ${staleUrl} (searched via SPARQL and the first ${SECTION_SCAN_MAX_PAGES} fragment pages).`,
    "Verify the section exists in this act and time version, or fetch the whole act page by page (omit 'section').",
  );
}
