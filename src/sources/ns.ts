import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { htmlToText, loadHtml } from "./shared/html";
import { czechToIso, isoToCzech } from "./shared/text";
import { DOCUMENT_TTL_MS, SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";

/**
 * Nejvyšší soud — rozhodnuti.nsoud.cz (IBM Domino classic web).
 *
 * Search is a GET against the Domino full-text view `$$WebSearch1`; the
 * decision detail is the WebSearch/WebPrint page for a 32-hex UNID (the only
 * stable identity — spisová značka is NOT unique). No session, no JSON.
 * Hard limit: any query addresses only its first 900 documents; the true
 * count appears as "(Podmínce vyhovuje: N)". Dates: query literals are
 * DD.MM.YYYY, WebSearch detail prints "20. 5. 2026", WebPrint prints
 * MM/DD/YYYY. See docs/research/cz-sources.json.
 */

const SOURCE = "Nejvyšší soud";
const BASE = "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf";

/** Result anchors: a.odk linking to /WebSearch/{32-hex UNID}?openDocument. */
const UNID_HREF_RE = /\/WebSearch\/([0-9A-Fa-f]{32})\?openDocument/;
const EMPTY_MARKER = "Nebyly nalezeny žádné výsledky";
const TRUNCATED_RE = /Podmínce vyhovuje:\s*([\d\s]+)/;
const COUNT_RE = /Výsledky\s+\d+\s*-\s*\d+\s+z\s+(\d[\d\s]*)/;

export interface NsSearchInput {
  query?: string;
  caseNumber?: string;
  category?: string; // kategorie rozhodnutí A–E
  /** [TypRozhodnuti]: "Rozsudek" | "Usnesení" | "Stanovisko". */
  type?: string;
  dateFrom?: string; // ISO — [datum_rozhodnuti]
  dateTo?: string; // ISO — [datum_rozhodnuti]
  publishedFrom?: string; // ISO — [datum_predani_na_web]
  publishedTo?: string; // ISO — [datum_predani_na_web]
}

export interface SpisovaZnacka {
  /** Senát — absent in marks that carry none (Cpjn, Tpjn…). */
  senate: string | null;
  /** Rejstříková značka, lowercased for the [spzn2] field. */
  mark: string;
  number: string;
  year: string;
}

/**
 * Split "23 Cdo 116/2017" into the four fields Domino indexes separately.
 * Trailing decorations ("- II.", "-1") are ignored: they are not part of the
 * indexed značka. Pure — unit-tested.
 */
export function parseSpisovaZnacka(raw: string): SpisovaZnacka | null {
  const m = /^\s*(?:(\d{1,3})\s+)?(\p{L}+)\s+(\d+)\s*\/\s*(\d{4})/u.exec(raw);
  if (!m) return null;
  return { senate: m[1] ?? null, mark: m[2].toLowerCase(), number: m[3], year: m[4] };
}

/** Balanced-delimiter check for the FT sanitizer. Pure. */
function balancedParens(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === "(") depth += 1;
    else if (char === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Keep the Domino full-text operators the caller may legitimately use —
 * AND/OR/NOT, "exact phrases", (grouping), wildcards, proximity — while
 * removing what would break out of the `[ARozhodnutiRT]=((…))` wrapper.
 * Square brackets and braces go unconditionally: they are how Domino names
 * fields, and a caller who could write them would own the whole query.
 * Unbalanced quotes or parentheses are dropped rather than passed on —
 * Domino answers those with a syntax error, not with results. Pure.
 */
export function sanitizeNsFullText(raw: string): string {
  let text = raw.replace(/[[\]{}\\]/g, " ");
  if ((text.match(/"/g)?.length ?? 0) % 2 === 1) text = text.replace(/"/g, " ");
  if (!balancedParens(text)) text = text.replace(/[()]/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

/** Build the Domino FT query string from tool inputs. Pure — unit-tested. */
export function buildNsQuery(input: NsSearchInput): string {
  const clauses: string[] = [];
  if (input.caseNumber) {
    // Domino indexes the značka in four fields. Matching them exactly is what
    // separates "this decision" from "every decision that CITES it" — the
    // phrase form used to return both.
    const sz = parseSpisovaZnacka(input.caseNumber);
    if (sz) {
      if (sz.senate) clauses.push(`[spzn1]=${sz.senate}`);
      clauses.push(`[spzn2]=${sz.mark}`, `[spzn3]=${sz.number}`, `[spzn4]=${sz.year}`);
    } else {
      // Not a značka we can split — fall back to a phrase, with quotes and
      // grouping stripped so the caller cannot close it and inject selectors.
      const sanitized = input.caseNumber.replace(/[()[\]"{}\\]/g, " ").replace(/\s+/g, " ").trim();
      clauses.push(`"${sanitized}"`);
    }
  }
  if (input.query) {
    clauses.push(`[ARozhodnutiRT]=((${sanitizeNsFullText(input.query)}))`);
  }
  if (input.category) clauses.push(`[kategorie_rozhodnuti1]=${input.category.toUpperCase()}`);
  if (input.type) clauses.push(`[TypRozhodnuti]=${input.type}`);
  if (input.dateFrom) clauses.push(`[datum_rozhodnuti]>=${isoToCzech(input.dateFrom)}`);
  if (input.dateTo) clauses.push(`[datum_rozhodnuti]<=${isoToCzech(input.dateTo)}`);
  if (input.publishedFrom) clauses.push(`[datum_predani_na_web]>=${isoToCzech(input.publishedFrom)}`);
  if (input.publishedTo) clauses.push(`[datum_predani_na_web]<=${isoToCzech(input.publishedTo)}`);
  if (!clauses.length) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "NS search needs at least one criterion.",
      "Provide query (full-text), case_number, or a date range.",
    );
  }
  return clauses.join(" AND ");
}

/** ISO date `days` back from `now` (default: today). Pure — unit-tested. */
export function isoDaysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The Domino box answers HTTP 500 to unbounded queries (capacity, not
 * syntax) — apply a default window when the caller gave no dates. Pure.
 */
export function withDefaultWindow(
  input: NsSearchInput,
  days: number,
  now = Date.now(),
): { input: NsSearchInput; appliedWindowFrom: string | null } {
  if (input.dateFrom || input.dateTo || input.publishedFrom || input.publishedTo) {
    return { input, appliedWindowFrom: null };
  }
  const from = isoDaysAgo(days, now);
  return { input: { ...input, dateFrom: from }, appliedWindowFrom: from };
}

export interface NsSearchHit {
  unid: string;
  caseNumbers: string[];
  url: string;
}

/** Domino FT operators — never worth highlighting. */
const FT_OPERATORS = new Set([
  "AND",
  "OR",
  "NOT",
  "NEAR",
  "SENTENCE",
  "PARAGRAPH",
  "ACCRUE",
  "EXACTCASE",
  "TERMWEIGHT",
]);

/**
 * Domino highlights the query terms inside a document when the link carries
 * `Highlight=0,<term>,<term>` — the reader lands on the passage instead of
 * page one of a 40-page rozsudek. Terms only, no operators; Domino ignores
 * what it cannot match. Pure — unit-tested.
 */
export function withHighlight(url: string, queries: Array<string | undefined>): string {
  const words: string[] = [];
  for (const query of queries) {
    for (const word of (query ?? "").split(/[^\p{L}\p{N}*]+/u)) {
      if (word.length < 3 || FT_OPERATORS.has(word.toUpperCase())) continue;
      if (!words.includes(word)) words.push(word);
    }
  }
  if (!words.length) return url;
  return `${url}&Highlight=0,${words.slice(0, 8).map(encodeURIComponent).join(",")}`;
}

export interface NsSearchPage {
  hits: NsSearchHit[];
  /** Count reported by the banner (window-capped at 900 addressable docs). */
  total: number | null;
  /** True count when the result set exceeds the 900-document window. */
  matched: number | null;
  truncated: boolean;
  empty: boolean;
}

/** Parse a $$WebSearch1 result page. Pure — unit-tested against fixtures. */
export function parseNsSearch(html: string): NsSearchPage {
  // Banners often arrive with Czech letters as HTML entities (V&yacute;sledky)
  // — match the count markers against decoded text, the rows against raw HTML.
  const decoded = htmlToText(html);
  if (decoded.includes(EMPTY_MARKER)) {
    return { hits: [], total: 0, matched: 0, truncated: false, empty: true };
  }
  const hits: NsSearchHit[] = [];
  const $ = loadHtml(html);
  $("a.odk").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const match = UNID_HREF_RE.exec(href);
    if (!match) return;
    const unid = match[1].toUpperCase();
    // The anchor may stack several spisové značky separated by <br/>.
    const caseNumbers = htmlToText($(el).html() ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    hits.push({
      unid,
      caseNumbers,
      url: `${BASE}/WebSearch/${unid}?openDocument`,
    });
  });

  const truncatedMatch = TRUNCATED_RE.exec(decoded);
  const countMatch = COUNT_RE.exec(decoded);
  const parseNumber = (raw: string) => Number(raw.replace(/\s+/g, ""));
  const matched = truncatedMatch ? parseNumber(truncatedMatch[1]) : null;
  const total = countMatch ? parseNumber(countMatch[1]) : matched;

  if (!hits.length && total === null) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "NS result page contains neither result rows nor a count banner.",
      "The site layout may have changed — run dawmain_probe_sources (canary 'ns') with include_raw.",
    );
  }
  return { hits, total, matched, truncated: matched !== null && matched > 900, empty: false };
}

export interface NsDecision {
  unid: string;
  metadata: Record<string, string>;
  text: string;
  url: string;
}

/** Labels of the metadata table (both WebSearch and WebPrint variants). */
const META_LABELS = [
  "Soud",
  "Datum rozhodnutí",
  "Spisová značka",
  "ECLI",
  "Typ rozhodnutí",
  "Heslo",
  "Dotčené předpisy",
  "Kategorie rozhodnutí",
  "Právní věta",
  "Zveřejněno na webu",
];

/** Parse a WebSearch/WebPrint decision page. Pure — unit-tested. */
export function parseNsDecision(html: string, unid: string): NsDecision {
  const $ = loadHtml(html);
  const metadata: Record<string, string> = {};

  // Preferred: td.left-part / td.right-part rows (WebSearch + modern
  // WebPrint). The first WebSearch row pairs the case number with citace
  // popup links (td.right-part.links) — skip it, it is not a field.
  $("td.left-part").each((_, el) => {
    const label = $(el).text().replace(/:\s*$/, "").trim();
    const valueCell = $(el).siblings("td.right-part").first();
    if (valueCell.hasClass("links")) return;
    const value = valueCell.text().trim();
    if (label && value) metadata[label] = value.replace(/\s+/g, " ");
  });

  // Fallback: any table row whose first cell is a known label (legacy
  // WebPrint has no left-part/right-part classes).
  if (!Object.keys(metadata).length) {
    $("tr").each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length < 2) return;
      const label = $(cells[0]).text().replace(/:\s*$/, "").trim();
      if (META_LABELS.includes(label)) {
        metadata[label] = $(cells[1]).text().replace(/\s+/g, " ").trim();
      }
    });
  }

  // Ústavní stížnost outcomes live in a table nested inside the metadata
  // table on both renditions — decisive "is this still good law" metadata.
  const usComplaints: string[] = [];
  $("table table tr").each((_, row) => {
    const cells = $(row)
      .find("td")
      .toArray()
      .map((cell) => $(cell).text().replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (cells.some((cell) => /ÚS\s*\d+\/\d+/u.test(cell))) usComplaints.push(cells.join(" | "));
  });
  if (usComplaints.length) metadata["Ústavní stížnost"] = usComplaints.join("; ");

  // Body: strip the metadata tables and chrome from the DOM, then take the
  // text of what remains. Do NOT key on font faces: modern pages set the
  // body in font[face="Times New Roman"], but 2013-era pages set it in
  // plain <tt><font size="4"> while Times New Roman marks only the metadata
  // table — a face-based selector then "extracts" the metadata instead of
  // the judgment (live case: 23 Cdo 3375/2011).
  $("head, script, style").remove();
  $(".tlacitko, .list-intro-heading").remove();
  $("table#tabl, table#box-table-a").remove();
  $("table")
    .filter((_, table) => $(table).find("td.left-part").length > 0)
    .remove();
  let text = htmlToText($.html());
  // Older decisions (≲2013) open with "Nejvyšší soud České republiky rozhodl".
  const start = text.search(/Nejvyšší soud(?: České republiky)? (?:rozhodl|jako soud)/);
  if (start > 0) text = text.slice(start);
  // The citation-format note PRECEDES the body on WebSearch pages and closes
  // WebPrint pages — cut it only when it trails the text.
  const end = text.lastIndexOf("Citace rozhodnutí");
  if (end > text.length / 2) text = text.slice(0, end);
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  if (!text && !Object.keys(metadata).length) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      `NS decision page for ${unid} yielded neither metadata nor text.`,
      "The document may not exist, or the layout changed — verify the UNID from a fresh ns_search.",
    );
  }

  // Normalize the decision date (WebPrint prints US MM/DD/YYYY, WebSearch Czech).
  const rawDate = metadata["Datum rozhodnutí"];
  if (rawDate) {
    // WebPrint prints US MM/DD/YYYY (slashes); WebSearch prints Czech "20. 5. 2026".
    const iso = rawDate.includes("/")
      ? (usToIso(rawDate) ?? czechToIso(rawDate))
      : (czechToIso(rawDate) ?? usToIso(rawDate));
    if (iso) metadata["Datum rozhodnutí"] = iso;
  }

  return { unid, metadata, text, url: `${BASE}/WebSearch/${unid}?openDocument` };
}

/**
 * True when a parsed "text" is not a judgment body but a metadata echo: the
 * WebPrint rendition of older decisions omits the body entirely, so the
 * htmlToText fallback yields only the metadata table's text. A real body —
 * even a short refusing usnesení — carries the operative formula or the
 * odůvodnění heading; the metadata table never does. Pure — unit-tested.
 */
export function nsBodyMissing(text: string): boolean {
  const clean = text.trim();
  if (clean.length < 200) return true;
  return !/rozhodl|takto\s*:|o\s*d\s*ů\s*v\s*o\s*d\s*n\s*ě\s*n\s*í|proti (?:rozsudku|usnesení)/iu.test(
    clean,
  );
}

/** MM/DD/YYYY → ISO (WebPrint date quirk). */
export function usToIso(raw: string): string | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(raw);
  if (!m) return null;
  const [month, day] = [Number(m[1]), Number(m[2])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

// ---------- I/O ----------

async function runNsSearch(input: NsSearchInput, start: number, count: number): Promise<NsSearchPage> {
  const query = buildNsQuery(input);
  const url =
    `${BASE}/$$WebSearch1?SearchView&Query=${encodeURIComponent(query)}` +
    // SearchMax must stay large: SearchMax=1 provokes HTTP 500 upstream.
    `&SearchMax=1000&SearchOrder=4&Start=${start}&Count=${count}&pohled=1`;
  // No automatic 5xx retry: NS 500s are deterministic for the given window
  // (capacity, not flakiness) — re-sending the same query just hammers the box;
  // the caller falls back to a narrower window instead.
  const response = await fetchUpstream(SOURCE, url, {
    headers: { referer: "https://rozhodnuti.nsoud.cz/" },
    retry: false,
  });
  const page = parseNsSearch(await response.text());
  if (!input.query) return page;
  return {
    ...page,
    hits: page.hits.map((hit) => ({ ...hit, url: withHighlight(hit.url, [input.query]) })),
  };
}

export interface NsSearchResult extends NsSearchPage {
  /** Set when a default window was applied because no dates were given. */
  appliedWindowFrom: string | null;
}

const searchCache = new TtlCache<NsSearchResult>(SEARCH_TTL_MS);
const decisionCache = new TtlCache<NsDecision>(DOCUMENT_TTL_MS, 24);

export async function searchNs(
  input: NsSearchInput,
  start: number,
  count: number,
): Promise<NsSearchResult> {
  return searchCache.through(memoKey("ns-search", [input, start, count]), () =>
    runSearchNsWindowed(input, start, count),
  );
}

async function runSearchNsWindowed(
  input: NsSearchInput,
  start: number,
  count: number,
): Promise<NsSearchResult> {
  // Explicit dates — and unique keys like a spisová značka — run as-given;
  // the 500-guard window exists for unbounded FULL-TEXT queries. A sp. zn.
  // matches a handful of documents and must find them in ANY year (live
  // case: "23 Cdo 3375/2011" found nothing inside the 12-month window).
  if (input.dateFrom || input.dateTo || input.publishedFrom || input.publishedTo || input.caseNumber) {
    try {
      return { ...(await runNsSearch(input, start, count)), appliedWindowFrom: null };
    } catch (error) {
      if (error instanceof SourceError && error.kind === "UPSTREAM_ERROR") {
        throw new SourceError(
          SOURCE,
          "UPSTREAM_ERROR",
          error.message,
          "The NS server rejects large result sets with HTTP 500 — narrow date_from/date_to and try again.",
        );
      }
      throw error;
    }
  }

  // No dates: the box 500s on unbounded queries — apply 12 months, then 90 days.
  const yearly = withDefaultWindow(input, 365);
  try {
    return {
      ...(await runNsSearch(yearly.input, start, count)),
      appliedWindowFrom: yearly.appliedWindowFrom,
    };
  } catch (error) {
    if (!(error instanceof SourceError && error.kind === "UPSTREAM_ERROR")) throw error;
    const quarterly = withDefaultWindow(input, 90);
    return {
      ...(await runNsSearch(quarterly.input, start, count)),
      appliedWindowFrom: quarterly.appliedWindowFrom,
    };
  }
}

export async function getNsDecision(unid: string): Promise<NsDecision> {
  if (!/^[0-9A-Fa-f]{32}$/.test(unid)) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${unid}" is not a Domino UNID.`,
      "Pass the 32-character hexadecimal id returned by ns_search.",
    );
  }
  return decisionCache.through(memoKey("ns-doc", [unid.toUpperCase()]), async () => {
    // WebPrint yields the cleanest HTML. Should its markup ever defeat the
    // extraction (a metadata echo instead of a body), try the WebSearch
    // document view — the same page the hit URL points at — and keep the
    // longer text. A pure safety net; both renditions carry the body.
    const webPrint = await fetchNsRendition(unid, "WebPrint");
    if (!nsBodyMissing(webPrint.text)) return webPrint;
    const webSearch = await fetchNsRendition(unid, "WebSearch").catch(() => null);
    if (webSearch && webSearch.text.length > webPrint.text.length) {
      // Metadata from WebPrint wins where both renditions carry a field.
      return { ...webSearch, metadata: { ...webSearch.metadata, ...webPrint.metadata } };
    }
    return webPrint;
  });
}

async function fetchNsRendition(unid: string, rendition: "WebPrint" | "WebSearch"): Promise<NsDecision> {
  const response = await fetchUpstream(SOURCE, `${BASE}/${rendition}/${unid}?openDocument`, {
    headers: { referer: "https://rozhodnuti.nsoud.cz/" },
  });
  // fetchUpstream only throws on 429/5xx — a Domino "Entry not found" page
  // comes back as 404 HTML and would otherwise parse into a bogus decision.
  if (response.status === 404) {
    throw new SourceError(
      SOURCE,
      "NOT_FOUND",
      `NS has no document ${unid}.`,
      "The UNID may be stale — re-run ns_search and use a fresh unid.",
    );
  }
  if (!response.ok) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `NS answered HTTP ${response.status} for ${rendition}/${unid}.`,
      "Try again in a moment.",
    );
  }
  return parseNsDecision(await response.text(), unid.toUpperCase());
}
