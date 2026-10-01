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
 *   POST /rozsirena-vyhledavani                        full-text search (the
 *        simple /jednoducha-vyhledavani does not require all words)
 *   GET  /dokumenty-sbirky/{enc}                       act metadata
 *   GET  /dokumenty-sbirky/{enc}/historie              time versions
 *   GET  /dokumenty-sbirky/{enc}/fragmenty?cisloStranky=N   text fragments
 * Single-§ retrieval has no REST endpoint: a fragment-page scan finds the §
 * by its designation, with the keyless open-data SPARQL endpoint raced
 * alongside while it answers at all.
 */

const SOURCE = "e-Sbírka";
/**
 * The open-data SPARQL endpoint is another host with its own availability.
 * Its requests are recorded under their own name, so that its refusals (a
 * WAF 403 since 2026-09) never mark e-Sbírka as down on the status page
 * while the REST API answers — racing the scan, its 403 can land last.
 */
const SPARQL_SOURCE = "e-Sbírka open data (SPARQL)";
const SPARQL_ENDPOINT = "https://opendata.eselpoint.gov.cz/sparql";
const ESB = "https://slovník.gov.cz/datový/sbírka/pojem/";
/** Fragment pages the section scan reads, at most, while looking for the § (each page is one request). */
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

/**
 * A channel with another one behind it gets one shorter try and no retry:
 * the next channel is its retry. With fetchUpstream's defaults (15 s, one GET
 * retry) a hanging channel cost ~31 s before the next was asked, and with
 * both hosts hanging one request took 63 s (measured with a stub) — past the
 * 60 s function limit, so the model got no error text at all. 10 s still
 * covers a ~1 MB fragments page: the timeout runs over the body read too.
 */
const NEXT_CHANNEL_AFTER_MS = 10_000;
/**
 * After the keyed channel fails AS A CHANNEL — unreachable, timed out,
 * 5xx/429 (to a GET), 401/403, a redirect, a body that is not JSON — requests go
 * straight to the gateway for this long instead of paying that failure again
 * on every detail, page and history request. Never after a 404 or a `chyby`
 * rejection: those are about one request, not about the host.
 */
const KEYED_BREAKER_MS = 5 * 60 * 1000;
let keyedDownUntil = 0;

/** Release a body nobody will read — unread, it holds its connection until GC. */
function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

/** The body as a JSON object (or array), or null when it is not JSON at all. */
function parseJsonBody(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function esbirkaFetch(request: EsbirkaRequest): Promise<unknown> {
  const key = getEsbirkaApiKey();
  const attempts: Array<{ base: string; headers: Record<string, string>; keyed: boolean }> = [];
  if (key && Date.now() >= keyedDownUntil) {
    attempts.push({ base: getEsbirkaApiBase(), headers: { "esel-api-access-key": key }, keyed: true });
  }
  attempts.push({ base: ESBIRKA_CACHE_BASE, headers: {}, keyed: false });

  let lastError: unknown;
  for (const [index, attempt] of attempts.entries()) {
    const isLast = index === attempts.length - 1;
    const channelFailed = (error: unknown) => {
      lastError = error;
      if (attempt.keyed) keyedDownUntil = Date.now() + KEYED_BREAKER_MS;
    };
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
        ...(isLast ? {} : { retry: false, timeoutMs: NEXT_CHANNEL_AFTER_MS }),
      });

      // Any refusal by a channel that is not the last one hands the request to
      // the next channel: a bad key (401/403), a redirect we refuse to follow
      // while carrying the key (3xx under redirect:"manual"), a gateway hiccup.
      // Only 404 is terminal — "no such document" is the same answer on both.
      if (!response.ok && response.status !== 404 && !isLast) {
        discard(response);
        const refusal = new Error(`HTTP ${response.status} from ${attempt.base}`);
        // A refused key or a redirect refuses every request; another 4xx is
        // about this one.
        if (response.status < 400 || response.status === 401 || response.status === 403) channelFailed(refusal);
        else lastError = refusal;
        continue;
      }
      if (response.status === 404) {
        discard(response);
        throw new SourceError(
          SOURCE,
          "NOT_FOUND",
          `e-Sbírka has no document at ${request.path}.`,
          "Check the collection/year/number (e.g. 89/2012 Sb. = year 2012, number 89). For a time version, the date must fall within the act's existence.",
        );
      }
      if (!response.ok) {
        discard(response);
        throw new SourceError(
          SOURCE,
          "UPSTREAM_ERROR",
          `e-Sbírka answered HTTP ${response.status} for ${request.path}.`,
          "Try again; if it persists, run dawmain_probe_sources.",
        );
      }

      // Read first, parse second: a body that stalls or breaks off is a
      // network failure (the catch below treats it as one), while a body that
      // arrives but is not JSON is the service answering with something else —
      // the SPA's index.html, a maintenance page. Retrying will not help that.
      const json = parseJsonBody(await response.text());
      if (!json) {
        const drift = new SourceError(
          SOURCE,
          "PARSE_DRIFT",
          `e-Sbírka answered HTTP ${response.status} with a non-JSON body from ${attempt.base}.`,
          "The service answered, but not with its API data — run dawmain_probe_sources; retrying will not help.",
        );
        if (!isLast) {
          channelFailed(drift);
          continue;
        }
        throw drift;
      }
      // Error shape used by the gateway: {"chyby":[{popis}]}
      if (Array.isArray(json.chyby) && json.chyby.length) {
        const popis = (json.chyby as Array<{ popis?: string }>).map((ch) => ch.popis).join("; ");
        const rejection = new SourceError(
          SOURCE,
          "UPSTREAM_ERROR",
          `e-Sbírka rejected the request: ${popis}`,
          "Adjust the input (identifier or date) and retry.",
        );
        if (!isLast) {
          lastError = rejection;
          continue;
        }
        throw rejection;
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
      // A 5xx to the search POST is the query's, not the host's (measured: a
      // phrase with "č." and "Sb." got HTTP 500 while everything else
      // answered) — it must not send every request to the gateway for minutes.
      if (request.method === "POST" && error instanceof SourceError && error.kind === "UPSTREAM_ERROR") lastError = error;
      else channelFailed(error);
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
  readonly text: string;
  zkracenaCitace?: string;
  kodTypuFragmentu?: string;
  hloubka?: number;
  /**
   * Structural path: "/eli/cz/sb/2012/89/2026-01-01/dokument/…/oddil_1/par_3006",
   * "…/dokument/novela/cl_1/bod_2" (článek I, bod 2 of an amending act).
   */
  eli?: string;
}

export interface EsbirkaFragmentsPage {
  totalPages: number;
  fragments: EsbirkaFragment[];
}

/**
 * htmlToText without the parser for the many fragments that are plain text
 * ("Základní ustanovení", "71"). Without "<" or "&" there is no markup or
 * entity, and without "\r" (the parser folds CR) or NUL (it replaces it) the
 * parser hands the text back verbatim — leading whitespace it drops, trim()
 * drops too — so only htmlToText's whitespace chain applies. Byte for byte:
 * tested against htmlToText. Pure.
 */
export function fragmentText(xhtml: string): string {
  if (/[<&\r\0]/.test(xhtml)) return htmlToText(xhtml);
  return xhtml
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A fragment whose text is converted from its xhtml only when first read. A
 * fragments page holds ~1 100–1 300 fragments and a §-scan filters them by
 * zkracenaCitace alone, so converting every one up front (a cheerio document
 * each, ~75–120 ms a page) was almost all thrown away. Each fragment still
 * gets its own document: one document for a whole page would let one
 * malformed fragment (an unclosed <table>, <textarea> or comment) swallow the
 * fragments after it. The xhtml is dropped once converted, so a cached page
 * never holds both.
 */
class LazyFragment implements EsbirkaFragment {
  #xhtml: string | undefined;
  #text: string | undefined;

  constructor(
    xhtml: string | undefined,
    readonly zkracenaCitace?: string,
    readonly kodTypuFragmentu?: string,
    readonly hloubka?: number,
    readonly eli?: string,
  ) {
    this.#xhtml = xhtml;
  }

  get text(): string {
    if (this.#text === undefined) {
      this.#text = this.#xhtml ? fragmentText(this.#xhtml) : "";
      this.#xhtml = undefined;
    }
    return this.#text;
  }
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
    fragments: data.seznam.map(
      (fragment) =>
        new LazyFragment(
          typeof fragment.xhtml === "string" ? fragment.xhtml : undefined,
          fragment.zkracenaCitace ? String(fragment.zkracenaCitace) : undefined,
          fragment.kodTypuFragmentu ? String(fragment.kodTypuFragmentu) : undefined,
          typeof fragment.hloubka === "number" ? fragment.hloubka : undefined,
          typeof fragment.eli === "string" ? fragment.eli : undefined,
        ),
    ),
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

/**
 * Results `offset` … `offset + limit - 1` of the ranking. e-Sbírka's `start`
 * is a PAGE index in pages of `pocet` rows, not a row offset — measured
 * 2026-09: start 1 with pocet 3 answered ranks 4–6 of the pocet-9 ranking,
 * and start 10 with pocet 10 ranks 101–110 (nothing, for a 50-hit query).
 * So a row offset reads the upstream page of `limit` rows it falls in and,
 * when it is not a multiple of `limit`, the next one too, cut to the window.
 * Paging by offset = k·limit stays one request; each upstream page is cached
 * on its own, so a neighbouring window reuses it.
 */
export async function searchActs(
  query: string,
  offset: number,
  limit: number,
  options: EsbirkaSearchOptions = {},
): Promise<EsbirkaSearchPage> {
  const upstreamPage = (index: number) =>
    searchCache.through(memoKey("esbirka-search", [query, options, index, limit]), () =>
      runSearchActs(query, index, limit, options),
    );
  const first = Math.floor(offset / limit);
  const skip = offset % limit;
  if (!skip) return upstreamPage(first);
  const [head, tail] = await Promise.all([upstreamPage(first), upstreamPage(first + 1)]);
  return { total: head.total, items: [...head.items, ...tail.items].slice(skip, skip + limit) };
}

async function runSearchActs(
  query: string,
  pageIndex: number,
  pageSize: number,
  options: EsbirkaSearchOptions,
): Promise<EsbirkaSearchPage> {
  // Always the advanced endpoint. The simple one (/jednoducha-vyhledavani)
  // does NOT require all words: measured, "zvlášť závažným způsobem nájemce"
  // matched 11 361 acts there (sanctions and covid laws on top) and 50 here
  // with fulltextVsechnaSlova — the občanský zákoník among the first five.
  // Name lookups keep their rank ("občanský zákoník" → 89/2012 first).
  const body: Record<string, unknown> = { start: pageIndex, pocet: pageSize, razeni: ["+relevance"] };
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

/**
 * The version a text read quotes, or null when only its DESCRIPTION failed —
 * the detail answered with an error or an unexpected shape, and the plain
 * staleUrl still reads (the current version, or the one in force on `date`).
 * A missing act or an unreachable service is not that: the text request
 * behind it would wait for, or 404 on, the very same thing a second time.
 */
export async function resolveVersionForRead(
  collection: string,
  year: number,
  number: number,
  date?: string,
): Promise<ActVersion | null> {
  try {
    return await resolveVersion(collection, year, number, date);
  } catch (error) {
    if (error instanceof SourceError && (error.kind === "PARSE_DRIFT" || error.kind === "UPSTREAM_ERROR")) return null;
    throw error;
  }
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

/** "I" → "1", "IV" → "4", "10a" → "10a": the number an article's `cl_N` eli segment carries. Pure. */
export function articleSegment(label: string): string {
  if (!/^[IVXLC]+$/.test(label)) return label.toLowerCase();
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let total = 0;
  for (let i = 0; i < label.length; i++) {
    const value = values[label[i]];
    total += value < (values[label[i + 1]] ?? 0) ? -value : value;
  }
  return String(total);
}

/**
 * The article a fragment belongs to: the FIRST `cl_` segment of its eli, and
 * the path above it ("…/dokument/novela/cl_1/bod_2/frag_7971169" → "1" under
 * "…/dokument/novela"). A quoted „Čl. 56 inside point 2 of an amending act
 * sits under cl_1, so it never passes for článek 56. Pure.
 */
function articleOf(eli: string | undefined): { above: string; segment: string } | null {
  if (!eli) return null;
  const parts = eli.split("/");
  const at = parts.findIndex((part) => part.startsWith("cl_"));
  return at === -1 ? null : { above: parts.slice(0, at).join("/"), segment: parts[at].slice(3).toLowerCase() };
}

/**
 * One article. Amending acts carry a structural designation on every
 * fragment (eli …/novela/cl_1/bod_2, Roman I encoded as 1), and e-Sbírka does
 * NOT serve them in text order: in 71/2012 (version 2013-03-08) "Čl. II
 * Účinnost" comes between point 3 and points 4–13 of čl. I, so cutting the
 * text at the next "Čl." line returned 3 of its 13 points. The article is
 * therefore collected by designation wherever its fragments sit, up to the
 * first later page without any of them. Acts without that designation — the
 * Listina lives in /dokument/prilohy/frag_N with the act's own citation — and
 * any article the designation does not find are cut out of the rendered
 * text, from their own "Čl. N" line to the next heading.
 */
async function getArticle(staleUrl: string, label: string): Promise<{ text: string; via: "scan" | "text" } | null> {
  const segment = articleSegment(label);
  const first = await getFragmentsPage(staleUrl, 0);
  const total = Math.min(first.totalPages, ARTICLE_SCAN_MAX_PAGES);
  const read: EsbirkaFragment[][] = [first.fragments];
  // The first article found fixes the part it sits in: should numbering
  // restart in a later part, that one's cl_1 is another article.
  let above: string | undefined;
  const isHit = (fragment: EsbirkaFragment | undefined) => {
    const at = articleOf(fragment?.eli);
    if (!at || at.segment !== segment) return false;
    above ??= at.above;
    return at.above === above;
  };
  const designated = (fragments: EsbirkaFragment[]) => fragments.some((fragment) => articleOf(fragment.eli));

  const hits = first.fragments.filter(isHit);
  let anyDesignation = designated(first.fragments);
  // The article runs to the end of the page read last — the next page surely
  // continues it, so read on in a batch rather than one page at a time.
  let runsOn = hits.length > 0 && isHit(first.fragments.at(-1));
  let closedInText = !anyDesignation && Boolean(extractArticle(renderFragments(first.fragments).join("\n"), label)?.closed);

  for (let next = 1; next < total && !closedInText; ) {
    const size = hits.length && !runsOn ? 1 : FRAGMENT_PAGE_BATCH;
    const batch: number[] = [];
    for (let u = next; u < Math.min(total, next + size); u++) batch.push(u);
    next += batch.length;
    const pages = await Promise.all(batch.map((u) => getFragmentsPage(staleUrl, u)));
    let ended = false;
    for (const { fragments } of pages) {
      read.push(fragments);
      anyDesignation ||= designated(fragments);
      const found = fragments.filter(isHit);
      if (hits.length && !found.length) {
        ended = true;
        break;
      }
      hits.push(...found);
      runsOn = found.length > 0 && isHit(fragments.at(-1));
    }
    if (ended) break;
    if (!hits.length && !anyDesignation) {
      closedInText = Boolean(extractArticle(read.flatMap(renderFragments).join("\n"), label)?.closed);
    }
  }

  if (hits.length) return { text: renderFragments(hits).join("\n").trim(), via: "scan" };
  const found = extractArticle(read.flatMap(renderFragments).join("\n"), label);
  return found?.text ? { text: found.text, via: "text" } : null;
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

/** Best-effort: one short try without a retry — the REST scan runs alongside it anyway. */
const SPARQL_TIMEOUT_MS = 4_000;
/** How long the SPARQL fast path is skipped once it failed to help. */
const SPARQL_BREAKER_MS = 30 * 60 * 1000;
let sparqlBlockedUntil = 0;
/** Definitive SPARQL answers (text, or none for this version and §); failures are not cached. */
const sparqlCache = new TtlCache<{ text: string | null }>(DOCUMENT_TTL_MS);

interface SparqlAnswer {
  text: string | null;
  /** The endpoint answered, with no fragments — as opposed to not answering. */
  empty: boolean;
}

/**
 * The open-data fast path for one §, for an EXACT version (its key date). It
 * is never asked for the "latest" version — that is a future one. In 2026-09
 * it answered no fragments even for canonical version IRIs
 * (…/sb/2012/89/2026-01-01); since then the production deployment gets HTTP
 * 403 "The request is blocked." (Azure Front Door WAF) for this very query.
 * So it never gates the scan, and any failure — or an empty answer for a §
 * the scan then finds — skips it for SPARQL_BREAKER_MS, after which it is
 * asked again. Never rejects.
 */
async function getSectionViaSparql(
  collection: string,
  year: number,
  number: number,
  versionDate: string,
  paragraph: string,
): Promise<SparqlAnswer> {
  // Defence in depth: the tool schema constrains `collection`, but this IRI is
  // interpolated into a SPARQL query — a ">" here would close it and hand the
  // caller control of the triple patterns we send to a .gov.cz endpoint.
  if (!/^[A-Za-z0-9-]{1,8}$/.test(collection)) return { text: null, empty: false };
  const versionIri = `https://opendata.eselpoint.gov.cz/esel-esb/eli/cz/${collection}/${year}/${number}/${versionDate}`;
  try {
    const { text } = await sparqlCache.through(memoKey("esbirka-sparql", [versionIri, paragraph]), async () => {
      const query = sectionSparql(versionIri, paragraph);
      const response = await fetchUpstream(SPARQL_SOURCE, `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}`, {
        headers: { accept: "application/sparql-results+json, application/json" },
        timeoutMs: SPARQL_TIMEOUT_MS,
        retry: false,
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.includes("json")) {
        discard(response);
        throw new Error(`SPARQL answered HTTP ${response.status} ${contentType}`);
      }
      const json = (await response.json()) as {
        results?: { bindings?: Array<{ text?: { value?: string } }> };
      };
      const joined = (json.results?.bindings ?? [])
        .map((b) => (b.text?.value ? htmlToText(b.text.value) : ""))
        .filter(Boolean)
        .join("\n");
      return { text: joined || null };
    });
    return { text, empty: !text };
  } catch {
    sparqlBlockedUntil = Date.now() + SPARQL_BREAKER_MS;
    return { text: null, empty: false };
  }
}

/** A § number as a sortable key: § 3 < § 3a < § 3b < § 4. */
interface SectionKey {
  num: number;
  suffix: string;
}

function sectionKey(label: string): SectionKey | null {
  const match = /^([0-9]+)([a-z]*)$/i.exec(label);
  return match ? { num: Number(match[1]), suffix: match[2].toLowerCase() } : null;
}

function compareKeys(a: SectionKey, b: SectionKey): number {
  return a.num - b.num || (a.suffix < b.suffix ? -1 : a.suffix > b.suffix ? 1 : 0);
}

function showKey(key: SectionKey): string {
  return `§ ${key.num}${key.suffix}`;
}

/** The § a fragment belongs to, from its zkracenaCitace ("§ 2913 odst. 1 zákona č. 89/2012 Sb." → 2913). */
const CITED_SECTION_RE = /(?:^|[^0-9a-z])§\s*([0-9]+)([a-z]*)/iu;

/** What one fragment page says about the wanted §. */
interface ScannedPage {
  fragments: EsbirkaFragment[];
  /** Positions of the wanted §'s fragments. */
  hits: number[];
  /** Lowest and highest § the page names; `ordered` = its §§ never go down. */
  min?: SectionKey;
  max?: SectionKey;
  ordered: boolean;
  /** Another § starts after the wanted one's last fragment here, and none sits between its fragments: it ends on this page. */
  ends: boolean;
  /** Nothing of another § precedes its first fragment here: it may have begun on the page before. */
  mayBeginBefore: boolean;
  /** The parts of the act (eli segment after /dokument/: "norma", "prilohy" …) its §-fragments sit in. */
  parts: Set<string>;
}

/** The part of the act a fragment sits in: "…/dokument/norma/cast_1/…/par_5" → "norma"; annexes are "prilohy". */
function partOf(eli: string | undefined): string | undefined {
  if (!eli) return undefined;
  const segments = eli.split("/");
  const at = segments.indexOf("dokument");
  return at === -1 ? undefined : segments[at + 1];
}

function scanPage(fragments: EsbirkaFragment[], sectionRe: RegExp): ScannedPage {
  const hits: number[] = [];
  // Fragments of ANOTHER §: a § heading ("Paragraf") or a citation naming another §.
  const foreign: number[] = [];
  let min: SectionKey | undefined;
  let max: SectionKey | undefined;
  let last: SectionKey | undefined;
  let ordered = true;
  const parts = new Set<string>();
  fragments.forEach((fragment, i) => {
    const cite = fragment.zkracenaCitace;
    const hit = Boolean(cite && sectionRe.test(cite));
    if (hit) hits.push(i);
    const cited = cite ? CITED_SECTION_RE.exec(cite) : null;
    if (cited) {
      const key = { num: Number(cited[1]), suffix: cited[2].toLowerCase() };
      if (last && compareKeys(key, last) < 0) ordered = false;
      last = key;
      if (!min || compareKeys(key, min) < 0) min = key;
      if (!max || compareKeys(key, max) > 0) max = key;
      const part = partOf(fragment.eli);
      if (part) parts.add(part);
    }
    if (!hit && (cited || fragment.kodTypuFragmentu === "Paragraf")) foreign.push(i);
  });
  const firstHit = hits[0];
  const lastHit = hits[hits.length - 1];
  const interleaved = hits.length > 0 && foreign.some((i) => i > firstHit && i < lastHit);
  return {
    fragments,
    hits,
    min,
    max,
    ordered,
    ends: hits.length > 0 && !interleaved && foreign.some((i) => i > lastHit),
    mayBeginBefore: hits.length > 0 && (interleaved || !foreign.some((i) => i < firstHit)),
    parts,
  };
}

/**
 * Where the wanted § can still be, judged from the pages read so far, when
 * none of them holds it: the unread pages between the last one wholly below
 * it and the first one wholly above it; or, when there are none, why it does
 * not exist; or null when the §§ read do not run in order — then only a
 * linear scan is safe. Pure.
 */
function placeAmong(pages: Map<number, ScannedPage>, target: SectionKey, totalPages: number): number[] | string | null {
  const keyed = [...pages.entries()].filter(([, page]) => page.min && page.max).sort(([a], [b]) => a - b);
  for (const [i, [, page]] of keyed.entries()) {
    if (!page.ordered) return null;
    if (i > 0 && compareKeys(keyed[i - 1][1].max!, page.min!) > 0) return null;
  }
  let lo = -1;
  let hi = totalPages;
  for (const [u, page] of keyed) {
    if (compareKeys(page.max!, target) < 0) lo = u;
    else if (compareKeys(page.min!, target) > 0) {
      hi = u;
      break;
    } else {
      return `it would sit on fragment page ${u + 1} (${showKey(page.min!)} – ${showKey(page.max!)}), which does not hold it`;
    }
  }
  if (lo < 0) return null;
  const unread: number[] = [];
  for (let u = lo + 1; u < hi; u++) if (!pages.has(u)) unread.push(u);
  if (unread.length) return unread;
  const below = showKey(pages.get(lo)!.max!);
  return hi === totalPages
    ? `the act's last § is ${below} (fragment page ${lo + 1} of ${totalPages})`
    : `it would sit between ${below} (fragment page ${lo + 1}) and ${showKey(pages.get(hi)!.min!)} (page ${hi + 1})`;
}

/** Up to `count` of `pages`, spread evenly — each round of the search narrows the gap several-fold. Pure. */
function spread(pages: number[], count: number): number[] {
  if (pages.length <= count) return pages;
  return Array.from({ length: count }, (_, i) => pages[Math.floor(((i + 1) * pages.length) / (count + 1))]);
}

interface SectionScan {
  text: string | null;
  /** What was searched — for the NOT_FOUND message. */
  searched: string;
}

/**
 * One § by its designation (every fragment's zkracenaCitace names its §).
 * Fragment pages are ~1 MB each, so the scan reads as few as it can:
 * - page 0 first; a § that begins and visibly ends there (the next § starts
 *   after it) is done — measured, § 29 of the Civil Code used to read pages
 *   0–5 to learn that page 1 no longer had it;
 * - a § above page 0's last one, when page 0's §§ run in order, is looked
 *   for near the page its number predicts (§ 2913 of the Civil Code: page 0
 *   ends near § 280, so pages 9–10 of 11; it sits on 9) together with the
 *   last page, then between the nearest pages below and above it. A § that
 *   the ordered pages around it show missing, or past the act's end, is
 *   NOT_FOUND after two rounds instead of 15 pages;
 * - anything out of order falls back to the linear scan of pages 1–14 in
 *   parallel batches, as before;
 * - around the first page holding it, the § is read backwards and forwards
 *   until a page shows where it begins and ends, or holds none of it — so no
 *   part of it is left behind, whichever way the page was found.
 */
async function getSectionViaScan(staleUrl: string, paragraph: string): Promise<SectionScan> {
  const sectionRe = new RegExp(`(^|[^0-9a-z])§\\s*${paragraph}(\\s|$|[^0-9a-z])`, "iu");
  const target = sectionKey(paragraph);
  const first = await getFragmentsPage(staleUrl, 0);
  const totalPages = Math.max(1, first.totalPages);
  const pages = new Map<number, ScannedPage>([[0, scanPage(first.fragments, sectionRe)]]);
  const read = async (wanted: number[]) => {
    const fresh = [...new Set(wanted)].filter((u) => u > 0 && u < totalPages && !pages.has(u)).sort((a, b) => a - b);
    const results = await Promise.all(fresh.map((u) => getFragmentsPage(staleUrl, u)));
    results.forEach((result, i) => pages.set(fresh[i], scanPage(result.fragments, sectionRe)));
  };
  /** The lowest page read (below `limit`) that holds the §. */
  const lowestHit = (limit = totalPages) => {
    let lowest: number | undefined;
    for (const [u, page] of pages) if (u < limit && page.hits.length && (lowest === undefined || u < lowest)) lowest = u;
    return lowest;
  };

  let anchor = lowestHit();
  let absent: string | undefined;
  const zero = pages.get(0)!;
  if (
    anchor === undefined &&
    totalPages > 1 &&
    target &&
    zero.ordered &&
    zero.parts.size <= 1 &&
    zero.max &&
    zero.max.num > 0 &&
    compareKeys(target, zero.max) > 0
  ) {
    // A jump skips pages, so it trusts only pages whose §§ sit in the same
    // part of the act as page 0's: an annex numbering its own §§ from 1
    // again could otherwise serve its § N in place of the body's.
    const body = [...zero.parts][0];
    const sameBody = () => body === undefined || [...pages.values()].every((page) => [...page.parts].every((part) => part === body));
    const guess = Math.min(totalPages - 1, Math.max(1, Math.round(target.num / zero.max.num)));
    await read([guess - 1, guess, guess + 1, totalPages - 1]);
    while (sameBody()) {
      anchor = lowestHit();
      if (anchor !== undefined) break;
      const place = placeAmong(pages, target, totalPages);
      if (place === null) break;
      if (typeof place === "string") {
        absent = place;
        break;
      }
      await read(spread(place, SECTION_SCAN_BATCH));
    }
  }
  if (anchor === undefined && absent === undefined) {
    // The linear scan takes the first page holding the § in page order: a
    // page the jump read further on counts only once the scan gets there (and
    // not at all past its cap — it may be an annex's § of the same number).
    const cap = Math.min(totalPages, SECTION_SCAN_MAX_PAGES);
    for (let start = 1; start < cap && anchor === undefined; start += SECTION_SCAN_BATCH) {
      const end = Math.min(start + SECTION_SCAN_BATCH, cap);
      const batch: number[] = [];
      for (let u = start; u < end; u++) batch.push(u);
      await read(batch);
      anchor = lowestHit(end);
    }
  }

  const coverage = () =>
    pages.size >= totalPages ? `all ${totalPages} fragment pages` : `${pages.size} of its ${totalPages} fragment pages`;
  if (anchor === undefined) {
    return {
      text: null,
      searched: absent ? `its §§ run in order and ${absent}; read ${coverage()}` : `searched ${coverage()}`,
    };
  }

  let from = anchor;
  while (from > 0) {
    if (!pages.has(from - 1)) {
      if (!pages.get(from)!.mayBeginBefore) break;
      await read([from - 1]);
    }
    if (!pages.get(from - 1)!.hits.length) break;
    from -= 1;
  }
  let to = anchor;
  while (to < totalPages - 1) {
    // Once the § visibly ended, a later page's fragments of that number are
    // another § (an annex's, a restarted numbering) — even when the jump
    // happened to read that page already.
    if (pages.get(to)!.ends) break;
    if (!pages.has(to + 1)) await read([to + 1]);
    if (!pages.get(to + 1)!.hits.length) break;
    to += 1;
  }
  const parts: string[] = [];
  for (let u = from; u <= to; u++) {
    const page = pages.get(u)!;
    for (const i of page.hits) parts.push(page.fragments[i].text);
  }
  return { text: parts.join("\n") || null, searched: `searched ${coverage()}` };
}

export interface SectionResult {
  text: string;
  via: "sparql" | "scan" | "text";
  /** The time version quoted — null only when e-Sbírka's detail did not answer. */
  version: ActVersion | null;
}

/**
 * One § or one article of an act. `resolved` passes a version the caller has
 * already settled (resolveVersionForRead) — the tool does, to fetch the
 * version history alongside the read — so the detail is not asked twice.
 */
export async function getSection(
  collection: string,
  year: number,
  number: number,
  date: string | undefined,
  section: string,
  resolved?: { version: ActVersion | null },
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
  const version = resolved ? resolved.version : await resolveVersionForRead(collection, year, number, date);
  const staleUrl = version?.staleUrl ?? buildStaleUrl(collection, year, number, date);

  if (label.kind === "article") {
    const found = await getArticle(staleUrl, label.value);
    if (found) return { text: found.text, via: found.via, version };
    throw new SourceError(
      SOURCE,
      "NOT_FOUND",
      `Article čl. ${label.value} was not found in ${staleUrl} (searched the first ${ARTICLE_SCAN_MAX_PAGES} fragment pages for its designation and for its "Čl. ${label.value}" heading).`,
      "Verify the article exists in this act and time version, or read the act page by page (omit 'section').",
    );
  }

  const paragraph = label.value;
  const sparql =
    version?.date && version.date !== "0000-00-00" && Date.now() >= sparqlBlockedUntil
      ? getSectionViaSparql(collection, year, number, version.date, paragraph)
      : undefined;
  const scan = getSectionViaScan(staleUrl, paragraph);
  let scanned: SectionScan;
  if (sparql) {
    // Whichever answers first with text serves the read; an empty SPARQL
    // answer never ends it — the scan decides then.
    const sparqlText = sparql.then(({ text }) => text ?? new Promise<never>(() => undefined));
    let first: { text: string } | { scanned: SectionScan };
    try {
      first = await Promise.race([sparqlText.then((text) => ({ text })), scan.then((result) => ({ scanned: result }))]);
    } catch (error) {
      // The scan failed; a SPARQL answer can still serve the read.
      const { text } = await sparql;
      if (text) return { text, via: "sparql", version };
      throw error;
    }
    if ("text" in first) {
      scan.catch(() => undefined); // left to finish on its own; its pages are cached for the next read
      return { text: first.text, via: "sparql", version };
    }
    scanned = first.scanned;
    if (scanned.text) {
      // Should SPARQL answer empty for a § the scan found, the fast path is
      // not doing its job — as in 2026-09, before the WAF.
      void sparql.then(({ empty }) => {
        if (empty) sparqlBlockedUntil = Date.now() + SPARQL_BREAKER_MS;
      });
    } else {
      const { text } = await sparql;
      if (text) return { text, via: "sparql", version };
    }
  } else {
    scanned = await scan;
  }
  if (scanned.text) return { text: scanned.text, via: "scan", version };
  throw new SourceError(
    SOURCE,
    "NOT_FOUND",
    `Section § ${paragraph} was not found in ${staleUrl} (${scanned.searched}).`,
    "Verify the section exists in this act and time version, or fetch the whole act page by page (omit 'section').",
  );
}
