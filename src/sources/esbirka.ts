import { ESBIRKA_CACHE_BASE, getEsbirkaApiBase, getEsbirkaApiKey } from "@/src/mcp/config";
import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { htmlToText } from "./shared/html";
import { DOCUMENT_TTL_MS, SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";
import { DOC_PAGE_CHARS } from "./shared/text";

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
const metadataCache = new TtlCache<unknown>(DOCUMENT_TTL_MS);
const searchCache = new TtlCache<EsbirkaSearchPage>(SEARCH_TTL_MS);
/** Fragment pages back both §-scans and whole-act paging — page N of a long
 * act should not re-download pages the previous call already fetched. */
const fragmentsCache = new TtlCache<EsbirkaFragmentsPage>(DOCUMENT_TTL_MS, 120);
/** How many fragment pages to request concurrently during a §-scan. */
const SECTION_SCAN_BATCH = 5;

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
        // undici strips cookie/authorization across origins but FORWARDS custom
        // headers — a cross-origin 302 would hand our registered API key to the
        // redirect target. Never follow a redirect while carrying the key.
        redirect: attempt.headers["esel-api-access-key"] ? "manual" : "follow",
      });

      // Any refusal by a channel that is not the last one hands the request to
      // the next channel: a bad key (401/403), a redirect we refuse to follow
      // while carrying the key (3xx under redirect:"manual"), a gateway hiccup.
      // Only 404 is terminal — "no such document" is the same answer on both.
      if (!response.ok && response.status !== 404 && !isLast) {
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
      // Terminal verdicts stand whichever channel produced them; an outage or
      // an unreachable host is exactly what the other channel is there for.
      // (fetchUpstream turns 429/5xx into UPSTREAM_ERROR before we see the
      // response, so that kind has to fall through here, not above.)
      const retriable =
        !(error instanceof SourceError) ||
        error.kind === "UPSTREAM_UNREACHABLE" ||
        error.kind === "UPSTREAM_ERROR";
      if (!retriable) throw error;
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
  /** "Zákon č. 89/2012 Sb., občanský zákoník ve znění zákona č. 460/2016 Sb., …" — the citation with amendments. */
  uplnaCitaceSNovelami?: string;
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
    uplnaCitaceSNovelami: str("uplnaCitaceSNovelami"),
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
  return searchCache.through(memoKey("esbirka-search", [query, offset, limit, options]), () =>
    runSearchActs(query, offset, limit, options),
  );
}

async function runSearchActs(
  query: string,
  offset: number,
  limit: number,
  options: EsbirkaSearchOptions,
): Promise<EsbirkaSearchPage> {
  // Always the advanced endpoint. The simple one (/jednoducha-vyhledavani)
  // does NOT require all words: measured, "zvlášť závažným způsobem nájemce"
  // matched 11 361 acts there (sanctions and covid laws on top) and 50 here
  // with fulltextVsechnaSlova — the občanský zákoník among the first five.
  // Name lookups keep their rank ("občanský zákoník" → 89/2012 first).
  const body: Record<string, unknown> = { start: offset, pocet: limit, razeni: ["+relevance"] };
  if (options.match === "phrase") body.fulltextUvedenaFraze = query;
  else if (options.match === "any_word") body.fulltextJednoZeSlov = query;
  else body.fulltextVsechnaSlova = query;
  if (options.excludeWords) body.fulltextNeobsahujeSlova = options.excludeWords;
  if (options.dateFrom) body.predmetneDatumOd = options.dateFrom;
  if (options.dateTo) body.predmetneDatumDo = options.dateTo;

  try {
    const json = await esbirkaFetch({ path: "/rozsirena-vyhledavani", method: "POST", body });
    return parseSearch(json);
  } catch (error) {
    // Measured: a phrase carrying "č." and "Sb." got HTTP 500 twice while the
    // service answered everything else — the query, not an outage.
    if (error instanceof SourceError && error.kind === "UPSTREAM_ERROR") {
      throw new SourceError(
        SOURCE,
        "UPSTREAM_ERROR",
        error.message,
        "e-Sbírka refused this search. It does so for some punctuation inside a query (\"č.\", \"Sb.\", commas) — retry without punctuation or with fewer words; if a plain query fails too, the service is down: run dawmain_probe_sources.",
      );
    }
    throw error;
  }
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
  return fragmentsCache.through(memoKey("esbirka-frag", [staleUrl, page]), async () => {
    const json = await esbirkaFetch({
      path: `/dokumenty-sbirky/${encodeURIComponent(staleUrl)}/fragmenty?cisloStranky=${page}`,
    });
    return parseFragments(json);
  });
}

// ---------- rendering, time versions, whole-act paging ----------

/**
 * The act's text, fragment by fragment. A § opens after a blank line with its
 * own label ("§ 1"); the zkracenaCitace heading ("§ 1 zákona č. 89/2012
 * Sb.") that used to precede it repeated that label at ~25 characters a
 * section. Pure — unit-tested.
 */
export function renderFragments(fragments: EsbirkaFragment[]): string[] {
  const out: string[] = [];
  for (const fragment of fragments) {
    if (!fragment.text) continue;
    out.push(fragment.kodTypuFragmentu === "Paragraf" ? `\n${fragment.text}` : fragment.text);
  }
  return out;
}

/**
 * Cut rendered fragments into pages of at most `max` characters, breaking
 * only between fragments; a single fragment longer than a page is split on
 * its own. Pure — unit-tested.
 */
export function chunkFragments(pieces: string[], max = DOC_PAGE_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    const text = current.trim();
    if (text) chunks.push(text);
    current = "";
  };
  for (const piece of pieces) {
    if (piece.length > max) {
      flush();
      for (let at = 0; at < piece.length; at += max) {
        const part = piece.slice(at, at + max).trim();
        if (part) chunks.push(part);
      }
      continue;
    }
    if (current && current.length + 1 + piece.length > max) flush();
    current += (current ? "\n" : "") + piece;
  }
  flush();
  return chunks.length ? chunks : [""];
}

export interface ActTextPage {
  text: string;
  page: number;
  totalPages: number;
  /** False while later upstream pages are unread — totalPages is then an estimate. */
  totalPagesExact: boolean;
  hasMore: boolean;
}

/** Upstream fragment pages fetched at once when a deep page needs those before it. */
const FRAGMENT_PAGE_BATCH = 5;

/**
 * Page `page` (1-based) of the whole act, in pages of at most DOC_PAGE_CHARS.
 * e-Sbírka serves fixed fragment pages of ~120 000 characters (the Civil
 * Code has 11); handed out 1:1 one of them overflowed what a client accepts
 * (measured: 120 658 characters in one answer). Every upstream page is cut
 * at fragment boundaries; reaching page N reads the upstream pages before it
 * — cached, so walking on costs nothing new.
 */
export async function getActText(staleUrl: string, page: number): Promise<ActTextPage> {
  const first = await getFragmentsPage(staleUrl, 0);
  const upstreamPages = Math.max(1, first.totalPages);
  const chunksOf = new Map<number, string[]>([[0, chunkFragments(renderFragments(first.fragments))]]);
  // A deep page needs every upstream page before it: fetch them in parallel
  // batches up front instead of one round trip each.
  const perUpstream = Math.max(1, chunksOf.get(0)!.length);
  const lastNeeded = Math.min(upstreamPages - 1, Math.floor((page - 1) / perUpstream));
  for (let from = 1; from <= lastNeeded; from += FRAGMENT_PAGE_BATCH) {
    const batch: number[] = [];
    for (let u = from; u <= Math.min(lastNeeded, from + FRAGMENT_PAGE_BATCH - 1); u++) batch.push(u);
    const pages = await Promise.all(batch.map((u) => getFragmentsPage(staleUrl, u)));
    pages.forEach((result, i) => chunksOf.set(batch[i], chunkFragments(renderFragments(result.fragments))));
  }
  let before = 0;
  for (let u = 0; u < upstreamPages; u++) {
    let chunks = chunksOf.get(u);
    if (!chunks) {
      chunks = chunkFragments(renderFragments((await getFragmentsPage(staleUrl, u)).fragments));
      chunksOf.set(u, chunks);
    }
    const lastUpstream = u === upstreamPages - 1;
    if (page <= before + chunks.length || lastUpstream) {
      // Past the end: the last page, as charPage does.
      const index = Math.min(page - before, chunks.length) - 1;
      const known = before + chunks.length;
      return {
        text: chunks[index],
        page: before + index + 1,
        totalPages: lastUpstream ? known : Math.max(known + 1, Math.round((known / (u + 1)) * upstreamPages)),
        totalPagesExact: lastUpstream,
        hasMore: index < chunks.length - 1 || !lastUpstream,
      };
    }
    before += chunks.length;
  }
  throw new SourceError(SOURCE, "PARSE_DRIFT", `e-Sbírka returned no text pages for ${staleUrl}.`, "Run dawmain_probe_sources.");
}

export interface ActVersion {
  /** Canonical staleUrl of the version, e.g. "/sb/2012/89/2026-01-01". */
  staleUrl: string;
  /** The version's key date ("2026-01-01"; "0000-00-00" = as announced). */
  date?: string;
  /** In force from / until (until absent = open-ended). */
  from?: string;
  to?: string;
  /** AKTUALNI, MINULE, BUDOUCI, VYHLASENE… */
  type?: string;
}

/**
 * The time version e-Sbírka serves for an act and a date: without a date the
 * one in force today, otherwise the one in force on that date. The REST
 * detail resolves either — /sb/2006/262/2015-06-01 answers as the version
 * /sb/2006/262/2015-01-01 (in force 2015-01-01 – 2015-09-30), /sb/1993/1 as
 * the current one. The open-data "má-poslední-znění" is NOT that: for the
 * Civil Code it points at the version from 2027-01-01, not yet in force.
 */
export async function resolveVersion(
  collection: string,
  year: number,
  number: number,
  date?: string,
): Promise<ActVersion> {
  const requested = buildStaleUrl(collection, year, number, date);
  const detail = await getAct(requested);
  const staleUrl = detail.staleUrl || requested;
  const key = /\/(\d{4}-\d{2}-\d{2})$/.exec(staleUrl)?.[1];
  return {
    staleUrl,
    ...(key ? { date: key } : {}),
    ...(detail.datumUcinnostiZneniOd ? { from: detail.datumUcinnostiZneniOd } : {}),
    ...(detail.datumUcinnostiZneniDo ? { to: detail.datumUcinnostiZneniDo } : {}),
    ...(detail.typZneni ? { type: detail.typZneni } : {}),
  };
}

/** Effective dates of published versions not yet in force (BUDOUCI), ascending. */
export async function futureVersions(collection: string, year: number, number: number): Promise<string[]> {
  const history = await getHistory(buildStaleUrl(collection, year, number));
  return history
    .filter((version) => version.typZneni === "BUDOUCI" && version.datumUcinnostiOd)
    .map((version) => version.datumUcinnostiOd as string)
    .sort();
}

// ---------- one § or one článek ----------

/** "§ 12", "§12", "12" → the paragraph number as written after the sign. */
export function normalizeSectionLabel(section: string): string {
  return section.replace(/^§\s*/u, "").trim();
}

export type SectionLabel = { kind: "paragraph"; value: string } | { kind: "article"; value: string };

/**
 * "§ 12", "12", "3a" → a paragraph; "čl. 36", "Čl. I", "článek 10a" → an
 * article (Ústava, Listina, ústavní zákony, the articles of amending acts).
 * The value feeds regexes, so only the shapes Czech acts use pass. Pure.
 */
export function parseSectionLabel(section: string): SectionLabel | null {
  const trimmed = section.trim();
  const article = /^čl(?:ánek)?\.?\s*([0-9]{1,3}[a-z]{0,2}|[ivxlc]{1,8})\.?$/iu.exec(trimmed);
  if (article) {
    const value = /^[ivxlc]+$/i.test(article[1]) ? article[1].toUpperCase() : article[1].toLowerCase();
    return { kind: "article", value };
  }
  const paragraph = normalizeSectionLabel(trimmed);
  return /^[0-9]{1,4}[a-z]{0,3}$/i.test(paragraph) ? { kind: "paragraph", value: paragraph } : null;
}

/** "Čl. 36" / "Článek 36" alone on a line — an article heading, never a cross-reference. */
const ARTICLE_LINE_RE = /^(?:Čl\.|ČL\.|Článek)\s*([0-9]{1,3}[a-z]{0,2}|[IVXLC]{1,8})\.?$/u;
/** Headings that close an article: the next part, hlava, oddíl or díl. */
const STRUCTURE_LINE_RE = /^(?:ČÁST|Část|HLAVA|Hlava|ODDÍL|Oddíl|DÍL|Díl|PODODDÍL|Pododdíl)(?:\s|$)/u;

/**
 * One article out of an act's rendered text: from its own "Čl. N" line to
 * the next article or structural heading. `closed` says a following heading
 * was seen — an article cut by the end of the text read so far may go on.
 * Pure — unit-tested.
 */
export function extractArticle(text: string, label: string): { text: string; closed: boolean } | null {
  const lines = text.split("\n");
  const wanted = label.toLowerCase();
  const start = lines.findIndex((line) => ARTICLE_LINE_RE.exec(line.trim())?.[1].toLowerCase() === wanted);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end].trim();
    if (ARTICLE_LINE_RE.test(line) || STRUCTURE_LINE_RE.test(line)) break;
    end++;
  }
  return { text: lines.slice(start, end).join("\n").trim(), closed: end < lines.length };
}

/** Fragment pages read at most when looking for an article. */
const ARTICLE_SCAN_MAX_PAGES = 20;

/**
 * Articles have no per-fragment designation to scan for — in the Listina
 * every fragment's zkracenaCitace is the act's own citation, and the open
 * data returned no designations at all — so the article is cut out of the
 * rendered text, where each one opens with its own "Čl. N" line.
 */
async function getArticleViaText(staleUrl: string, label: string): Promise<string | null> {
  const first = await getFragmentsPage(staleUrl, 0);
  const total = Math.min(first.totalPages, ARTICLE_SCAN_MAX_PAGES);
  const pieces = renderFragments(first.fragments);
  let found = extractArticle(pieces.join("\n"), label);
  for (let from = 1; from < total && !found?.closed; from += FRAGMENT_PAGE_BATCH) {
    const batch: number[] = [];
    for (let u = from; u < Math.min(total, from + FRAGMENT_PAGE_BATCH); u++) batch.push(u);
    const pages = await Promise.all(batch.map((u) => getFragmentsPage(staleUrl, u)));
    for (const result of pages) pieces.push(...renderFragments(result.fragments));
    found = extractArticle(pieces.join("\n"), label);
  }
  return found?.text || null;
}

function sectionSparql(versionIri: string, paragraph: string): string {
  return `
SELECT ?ord ?ozn ?text WHERE {
  BIND(<${versionIri}> AS ?zneni)
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

/**
 * The open-data fast path for one §, for an EXACT version (its key date).
 * Best-effort: in 2026-09 it answered no fragments even for canonical
 * version IRIs (…/sb/2012/89/2026-01-01), and the REST scan below did the
 * work. It is never asked for the "latest" version — that is a future one.
 */
async function getSectionViaSparql(
  collection: string,
  year: number,
  number: number,
  versionDate: string,
  paragraph: string,
): Promise<string | null> {
  // Defence in depth: the tool schema constrains `collection`, but this IRI is
  // interpolated into a SPARQL query — a ">" here would close it and hand the
  // caller control of the triple patterns we send to a .gov.cz endpoint.
  if (!/^[A-Za-z0-9-]{1,8}$/.test(collection)) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${collection}" is not a collection code.`,
      "Use 'sb' (Sbírka zákonů) or 'sm' (mezinárodní smlouvy).",
    );
  }
  const versionIri = `https://opendata.eselpoint.gov.cz/esel-esb/eli/cz/${collection}/${year}/${number}/${versionDate}`;
  const query = sectionSparql(versionIri, paragraph);
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
  const matchesOf = (result: EsbirkaFragmentsPage) =>
    result.fragments
      .filter((f) => f.zkracenaCitace && sectionRe.test(f.zkracenaCitace))
      .map((f) => f.text);

  const first = await getFragmentsPage(staleUrl, 0);
  const totalPages = Math.min(first.totalPages, SECTION_SCAN_MAX_PAGES);
  const collected = matchesOf(first);

  // Fragments of one § are contiguous, so a later page with zero matches
  // (once something was collected) ends the scan. Pages come in small
  // parallel batches — same request count, a fraction of the wall clock;
  // at worst one batch overshoots past the section's end.
  let done = false;
  for (let start = 1; start < totalPages && !done; start += SECTION_SCAN_BATCH) {
    const pageNumbers = [];
    for (let page = start; page < Math.min(start + SECTION_SCAN_BATCH, totalPages); page++) {
      pageNumbers.push(page);
    }
    const results = await Promise.all(pageNumbers.map((page) => getFragmentsPage(staleUrl, page)));
    for (const result of results) {
      const found = matchesOf(result);
      collected.push(...found);
      if (collected.length && !found.length) {
        done = true;
        break;
      }
    }
  }
  return collected.length ? collected.join("\n") : null;
}

export interface SectionResult {
  text: string;
  via: "sparql" | "scan" | "text";
  /** The time version quoted — null only when e-Sbírka's detail did not answer. */
  version: ActVersion | null;
}

export async function getSection(
  collection: string,
  year: number,
  number: number,
  date: string | undefined,
  section: string,
): Promise<SectionResult> {
  const label = parseSectionLabel(section);
  if (!label) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${section}" is not a valid section label.`,
      'Pass a section as "§ 12" or just "12" (letter suffixes like "3a" are fine), or an article as "čl. 36" or "čl. I".',
    );
  }
  // Settle WHICH version is being read before reading it: without a date the
  // one in force today — never the latest published one, which may not be
  // in force yet. If the detail does not answer, read what the plain
  // staleUrl serves (the current version, or the one in force on `date`).
  const version = await resolveVersion(collection, year, number, date).catch(() => null);
  const staleUrl = version?.staleUrl ?? buildStaleUrl(collection, year, number, date);

  if (label.kind === "article") {
    const text = await getArticleViaText(staleUrl, label.value);
    if (text) return { text, via: "text", version };
    throw new SourceError(
      SOURCE,
      "NOT_FOUND",
      `Article čl. ${label.value} was not found in ${staleUrl} (searched the text of the first ${ARTICLE_SCAN_MAX_PAGES} fragment pages for its "Čl. ${label.value}" heading).`,
      "Verify the article exists in this act and time version, or read the act page by page (omit 'section').",
    );
  }

  const paragraph = label.value;
  if (version?.date && version.date !== "0000-00-00") {
    try {
      const viaSparql = await getSectionViaSparql(collection, year, number, version.date, paragraph);
      if (viaSparql) return { text: viaSparql, via: "sparql", version };
    } catch {
      // SPARQL is best-effort — fall through to the REST scan.
    }
  }
  const viaScan = await getSectionViaScan(staleUrl, paragraph);
  if (viaScan) return { text: viaScan, via: "scan", version };
  throw new SourceError(
    SOURCE,
    "NOT_FOUND",
    `Section § ${paragraph} was not found in ${staleUrl} (searched via SPARQL and the first ${SECTION_SCAN_MAX_PAGES} fragment pages).`,
    "Verify the section exists in this act and time version, or fetch the whole act page by page (omit 'section').",
  );
}
