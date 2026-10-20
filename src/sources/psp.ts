import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { decodeHtmlBody, htmlToText, loadHtml, looksLikeHtml } from "./shared/html";
import { DOCUMENT_TTL_MS, SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";
import { foldText } from "./shared/text";
import { callDeadline } from "./shared/clock";
import type { CheerioAPI } from "cheerio";

/**
 * www.psp.cz — Poslanecká sněmovna Parlamentu ČR: sněmovní tisky (bills with
 * their důvodová zpráva, rozdílová tabulka, RIA, platné znění s vyznačením
 * změn, committee resolutions, amendments) and the legislative history of
 * each (historie.sqw: readings, committees, Senát, prezident, Sbírka).
 * Keyless, public, HTML only — the Chamber publishes no search API; its
 * open data (hp.sqw?k=1300) are whole-database ZIP dumps, which this server
 * does not download per call.
 *
 * Addresses, as the site has published them for years (verbatim patterns
 * seen on live pages; o = volební období, t/CT = číslo tisku, CT1 = podčíslo
 * of the tisk's parts, idd = id of an attached original document):
 *   listing + search form   /sqw/tisky.sqw?o=9
 *   one tisk, its history   /sqw/historie.sqw?o=9&t=1234
 *   text of a tisk part     /sqw/text/tiskt.sqw?O=9&CT=1234&CT1=0
 *   attached original file  /sqw/text/orig2.sqw?idd=123456  (+&pdf=1 = PDF rendition)
 *
 * Written against those patterns without a live capture (psp.cz was not
 * reachable from the development sandbox), so the parsers lean on what
 * cannot drift — the anchors' hrefs — rather than on ids or table layout,
 * and the search form's field names are READ FROM THE FORM at run time
 * instead of being assumed. dawmain_probe_sources (canary `psp`, and
 * `discover` for the form dump) verifies them from the deployment; the
 * synthetic fixtures in tests/psp.test.ts are to be replaced by captures.
 * See docs/research/cz-sources.json.
 */

export const SOURCE = "Poslanecká sněmovna (psp.cz)";
const ORIGIN = "https://www.psp.cz";

/** Volební období of the Chamber, as psp.cz numbers them (`o=`). */
export const PSP_PERIODS: ReadonlyArray<{ period: number; from: number; to: number | null }> = [
  { period: 1, from: 1993, to: 1996 },
  { period: 2, from: 1996, to: 1998 },
  { period: 3, from: 1998, to: 2002 },
  { period: 4, from: 2002, to: 2006 },
  { period: 5, from: 2006, to: 2010 },
  { period: 6, from: 2010, to: 2013 },
  { period: 7, from: 2013, to: 2017 },
  { period: 8, from: 2017, to: 2021 },
  { period: 9, from: 2021, to: 2025 },
  { period: 10, from: 2025, to: null },
];
export const CURRENT_PERIOD = PSP_PERIODS[PSP_PERIODS.length - 1].period;

/** "9. volební období (2021–2025)". Pure. */
export function periodLabel(period: number): string {
  const row = PSP_PERIODS.find((p) => p.period === period);
  const years = row ? ` (${row.from}–${row.to ?? "dosud"})` : "";
  return `${period}. volební období${years}`;
}

/**
 * The periods a calendar year falls in — two when the Chamber was elected
 * that year (1996, 1998, 2002 …): the old one sat until the election, the
 * new one from it. 1993 (the ČNR elected in 1992 became the Chamber) and
 * later only. Pure — unit-tested.
 */
export function periodsForYear(year: number): number[] {
  return PSP_PERIODS.filter((p) => p.from <= year && (p.to === null || year <= p.to)).map((p) => p.period);
}

export function tiskUrl(period: number, number: number): string {
  return `${ORIGIN}/sqw/historie.sqw?o=${period}&t=${number}`;
}

export function tiskTextUrl(period: number, number: number, part = 0): string {
  return `${ORIGIN}/sqw/text/tiskt.sqw?O=${period}&CT=${number}&CT1=${part}`;
}

export function documentUrl(id: number, pdf = false): string {
  return `${ORIGIN}/sqw/text/orig2.sqw?idd=${id}${pdf ? "&pdf=1" : ""}`;
}

export function listingUrl(period: number): string {
  return `${ORIGIN}/sqw/tisky.sqw?o=${period}`;
}

// ---------- parse (pure) ----------

/** A query-string value by case-insensitive name (sqw takes o= and O= alike). */
function param(url: URL, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of url.searchParams) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

function absolute(href: string, base: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface PspHit {
  period: number;
  number: number;
  /** Název tisku as the listing shows it. */
  title: string;
  /** The row's other cells (druh tisku, stav projednávání, předkladatel …), as printed. */
  cells: string[];
  url: string;
}

/**
 * The tisky rows of a listing page: every anchor to historie.sqw with a
 * tisk number, one hit per (period, number). The title is the anchor's own
 * text unless that is just the number — then the longest cell of the row.
 * Pure — unit-tested.
 */
export function parseListing(html: string, pageUrl: string, fallbackPeriod: number): PspHit[] {
  const $ = loadHtml(html);
  const byKey = new Map<string, PspHit>();
  $('a[href*="historie.sqw"]').each((_, el) => {
    const href = $(el).attr("href");
    const url = href ? absolute(href, pageUrl) : null;
    if (!url) return;
    const number = Number(param(url, "t"));
    if (!Number.isInteger(number) || number <= 0) return;
    const period = Number(param(url, "o")) || fallbackPeriod;
    const key = `${period}/${number}`;
    const row = $(el).closest("tr, li, article, p");
    const cells = (row.length ? row.find("td, th") : $())
      .map((_, cell) => clean($(cell).text()))
      .get()
      .filter(Boolean);
    const anchorText = clean($(el).text());
    const numberOnly = /^\d+(?:\/\d+)?$/.test(anchorText) || !anchorText;
    const longest = cells.reduce((best, cell) => (cell.length > best.length ? cell : best), "");
    const title = numberOnly ? longest || anchorText : anchorText;
    const rest = cells.filter((cell) => cell !== title && !/^\d+(?:\/\d+)?$/.test(cell));
    const hit: PspHit = { period, number, title, cells: rest, url: tiskUrl(period, number) };
    const seen = byKey.get(key);
    // Two anchors per row (number and title): keep the fuller record.
    if (!seen || (seen.title.length < hit.title.length && !numberOnly)) byKey.set(key, hit);
  });
  return [...byKey.values()];
}

/** Links to further listing pages: page number → absolute href. Pure — unit-tested. */
export function parsePageLinks(html: string, pageUrl: string): Map<number, string> {
  const $ = loadHtml(html);
  const out = new Map<number, string>();
  $('a[href*="tisky.sqw"]').each((_, el) => {
    const text = clean($(el).text());
    if (!/^\d{1,4}$/.test(text)) return;
    const href = $(el).attr("href");
    const url = href ? absolute(href, pageUrl) : null;
    if (url && !out.has(Number(text))) out.set(Number(text), url.href);
  });
  return out;
}

export interface ListingForm {
  action: string;
  method: "GET" | "POST";
  /** Every field with its current value (hidden inputs, selected options, texts). */
  fields: Record<string, string>;
  /** Field names the labels identified; absent when no label matched. */
  nameField?: string;
  periodField?: string;
  numberField?: string;
}

/**
 * The search form of the listing page, read rather than assumed: its action
 * and fields, with the field for "název" and the one for "období" found by
 * their labels (<label for>, the enclosing label, or the text of the
 * preceding cell). Null when the page has no form with such a field. Pure —
 * unit-tested.
 */
export function parseListingForm(html: string, pageUrl: string): ListingForm | null {
  const $ = loadHtml(html);
  let best: ListingForm | null = null;
  $("form").each((_, form) => {
    const $form = $(form);
    const actionAttr = $form.attr("action") ?? "";
    const action = absolute(actionAttr || pageUrl, pageUrl)?.href ?? pageUrl;
    const method = ($form.attr("method") ?? "get").toUpperCase() === "POST" ? "POST" : "GET";
    const fields: Record<string, string> = {};
    const candidate: ListingForm = { action, method, fields };
    $form.find("input, select, textarea").each((__, el) => {
      const $el = $(el);
      const name = $el.attr("name");
      if (!name) return;
      const type = ($el.attr("type") ?? el.tagName).toLowerCase();
      if (type === "submit" || type === "button" || type === "image" || type === "reset") return;
      if (type === "checkbox" || type === "radio") {
        if ($el.is("[checked]")) fields[name] = $el.attr("value") ?? "on";
        return;
      }
      if (el.tagName.toLowerCase() === "select") {
        const selected = $el.find("option[selected]").first();
        fields[name] = (selected.length ? selected : $el.find("option").first()).attr("value") ?? "";
      } else {
        fields[name] = $el.attr("value") ?? "";
      }
      // A hidden field is never the one the user types a title into.
      if (type === "hidden") return;
      // The label first, the field's own name second (na/nazev, o/obdobi, ct/cislo are what the site has used).
      const label = foldText(labelOf($, el));
      const fname = foldText(name);
      if (!candidate.nameField && (/nazev|nazv/.test(label) || /^na(zev)?$/.test(fname))) candidate.nameField = name;
      else if (!candidate.periodField && (/obdobi/.test(label) || /^o$|obdobi/.test(fname))) candidate.periodField = name;
      else if (!candidate.numberField && (/cislo/.test(label) || /^ct$|cislo/.test(fname))) candidate.numberField = name;
    });
    if (candidate.nameField && !best) best = candidate;
  });
  return best;
}

/** The text that labels a form control, best effort. */
function labelOf($: CheerioAPI, el: Parameters<CheerioAPI>[0]): string {
  const $el = $(el);
  const id = $el.attr("id");
  if (id) {
    const explicit = $(`label[for="${id.replace(/"/g, "")}"]`).first();
    if (explicit.length) return clean(explicit.text());
  }
  const wrapping = $el.closest("label");
  if (wrapping.length) return clean(wrapping.text());
  const cell = $el.closest("td, th, div, p, li");
  if (cell.length) {
    const prev = cell.prev();
    const own = clean(cell.clone().find("input, select, textarea").remove().end().text());
    // A short text is a label; a long one is the container the field sits in.
    if (own && own.length <= 80) return own;
    if (prev.length) return clean(prev.text()).slice(0, 80);
  }
  return $el.attr("placeholder") ?? $el.attr("title") ?? "";
}

/** The main content of a psp.cz page: the first known container, else the body stripped of chrome. */
function mainContent($: CheerioAPI): string {
  $("script, style, noscript, iframe").remove();
  for (const selector of ["main", "#main", "#content", "#main-content", "[role=main]", ".content", "#page-content"]) {
    const node = $(selector).first();
    if (node.length && clean(node.text()).length > 80) return node.html() ?? "";
  }
  $("nav, header, footer, form, .menu, #menu, .navigation, #navigation, .nav, .breadcrumb, .breadcrumbs").remove();
  return $("body").html() ?? $.root().html() ?? "";
}

export type PspDocumentKind =
  | "návrh zákona"
  | "důvodová zpráva"
  | "rozdílová tabulka"
  | "RIA"
  | "platné znění s vyznačením změn"
  | "usnesení"
  | "pozměňovací návrhy"
  | "stanovisko"
  /** The tisk's own text (part 0) when its label says no more than its number. */
  | "text tisku"
  | "dokument";

/** What a document is, from the words psp.cz labels it with. Pure — unit-tested. */
export function classifyDocument(label: string): PspDocumentKind {
  const f = foldText(label);
  if (/rozdilov/.test(f)) return "rozdílová tabulka";
  if (/duvodov/.test(f)) return "důvodová zpráva";
  if (/\bria\b|hodnoceni dopad|dopad/.test(f)) return "RIA";
  if (/platn[eé]\s*zn|vyznacen/.test(f)) return "platné znění s vyznačením změn";
  if (/pozmenovac|pozmen\./.test(f)) return "pozměňovací návrhy";
  if (/usnesen/.test(f)) return "usnesení";
  if (/stanovisk/.test(f)) return "stanovisko";
  if (/navrh zakona|navrh ustavniho|zneni navrhu|text navrhu|\bzn\b/.test(f)) return "návrh zákona";
  return "dokument";
}

export interface PspDocument {
  /** The link's own words (with the enclosing line when the link says only "PDF"). */
  label: string;
  kind: PspDocumentKind;
  /** "HTML" (tiskt.sqw) | "PDF" | "soubor" (an original .doc/.docx/.rtf) */
  format: "HTML" | "PDF" | "soubor";
  url: string;
  /** For tiskt.sqw links: how psp_get_text addresses them. */
  part?: { period: number; number: number; part: number };
  /** For orig2.sqw links: the idd psp_get_text takes as document_id. */
  documentId?: number;
}

export interface PspTisk {
  period: number;
  number: number;
  title: string;
  url: string;
  /** The page's text: the process stages with their dates, as printed. */
  text: string;
  documents: PspDocument[];
}

const DOCUMENT_HREF = /tiskt\.sqw|orig2\.sqw|text2\.sqw|\.pdf(?:$|[?#])|\.docx?(?:$|[?#])|\.rtf(?:$|[?#])/i;

/** The historie.sqw page of one tisk. Pure — unit-tested. */
export function parseTisk(html: string, pageUrl: string, period: number, number: number): PspTisk {
  const $ = loadHtml(html);
  const h1 = clean($("h1").first().text());
  const title = h1 || clean($("title").text());
  const documents: PspDocument[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!DOCUMENT_HREF.test(href)) return;
    const url = absolute(href, pageUrl);
    if (!url || seen.has(url.href)) return;
    seen.add(url.href);
    const own = clean($(el).text());
    const line = clean($(el).closest("li, tr, p, div").first().text()).slice(0, 200);
    const generic = !own || own.length < 12 || /^(pdf|doc|docx|html|text|dokument|soubor|zde|odkaz)$/i.test(own);
    const label = generic && line ? line : own || line || url.pathname;
    const doc: PspDocument = {
      label,
      kind: classifyDocument(label),
      format: /tiskt\.sqw|text2\.sqw/i.test(url.pathname) ? "HTML" : /pdf/i.test(url.href) ? "PDF" : "soubor",
      url: url.href,
    };
    if (/tiskt\.sqw/i.test(url.pathname)) {
      const ct = Number(param(url, "ct"));
      if (Number.isInteger(ct) && ct > 0) {
        doc.part = { period: Number(param(url, "o")) || period, number: ct, part: Number(param(url, "ct1")) || 0 };
        if (doc.kind === "dokument" && doc.part.part === 0) doc.kind = "text tisku";
      }
    } else if (/orig2\.sqw/i.test(url.pathname)) {
      const idd = Number(param(url, "idd"));
      if (Number.isInteger(idd) && idd > 0) doc.documentId = idd;
    }
    documents.push(doc);
  });
  const text = htmlToText(mainContent($));
  if (!documents.length && !/tisk/i.test(text)) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      `The page of sněmovní tisk ${number} (${periodLabel(period)}) has neither document links nor the word "tisk" — not a tisk page as known.`,
      `Open ${pageUrl} to check the tisk exists; if it does, psp.cz changed its layout — run dawmain_probe_sources with fetch_url on that address.`,
    );
  }
  return { period, number, title, url: pageUrl, text, documents };
}

/** The text of a tiskt.sqw page (one part of a tisk). Pure — unit-tested. */
export function parseTiskText(html: string): string {
  const $ = loadHtml(html);
  return htmlToText(mainContent($));
}

// ---------- fetch (I/O) ----------

const pageCache = new TtlCache<string>(SEARCH_TTL_MS, 60);
const searchCache = new TtlCache<PspSearchResult>(SEARCH_TTL_MS);
const textCache = new TtlCache<string>(DOCUMENT_TTL_MS, 24);
const tiskCache = new TtlCache<PspTisk>(DOCUMENT_TTL_MS, 24);
const fileCache = new TtlCache<ExtractedDocument>(DOCUMENT_TTL_MS, 6);

async function fetchHtml(url: string, init: { method?: "GET" | "POST"; body?: string } = {}): Promise<{ html: string; url: string; status: number }> {
  const response = await fetchUpstream(SOURCE, url, {
    ...init,
    headers: {
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      "accept-language": "cs,en;q=0.5",
      ...(init.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
  });
  if (response.status === 404) {
    throw new SourceError(SOURCE, "NOT_FOUND", `psp.cz has nothing at ${url} (HTTP 404).`, "Check the period, number and part; psp_search finds the tisk.");
  }
  if (!response.ok) {
    throw new SourceError(SOURCE, "UPSTREAM_ERROR", `psp.cz answered HTTP ${response.status} for ${url}.`, "Try again in a minute; dawmain_probe_sources (canary psp) tells whether the site is up.");
  }
  return { html: await decodeHtmlBody(response), url: response.url || url, status: response.status };
}

const cachedPage = (url: string) => pageCache.through(url, async () => (await fetchHtml(url)).html);

export interface PspSearchInput {
  query?: string;
  /** Exact tisk number — the listing is skipped, the tisk's own page answers. */
  number?: number;
  period: number;
}

export interface PspSearchResult {
  period: number;
  hits: PspHit[];
  /** Listing pages read. */
  pagesScanned: number;
  /** The listing had further pages the scan did not reach (page cap or time). */
  listingTruncated: boolean;
  /** The filter psp.cz was asked to apply, if its form was found. */
  serverFilter: "form" | "query-param";
}

/** Listing pages one search may read; the rest is reported as not scanned. */
export const MAX_LISTING_PAGES = 12;
const LISTING_BATCH = 4;
const SEARCH_BUDGET_MS = 30_000;

/** The query's words as stems: the last two letters optional for long words,
 * the last one for medium ones — "občanský zákoník" meets "občanského
 * zákoníku". A trailing * is an explicit prefix. Pure — unit-tested. */
export function queryStems(query: string): string[] {
  return foldText(query)
    .split(/\s+/)
    .map((word) => word.replace(/[",.;:()]/g, ""))
    .filter(Boolean)
    .map((word) => {
      if (word.endsWith("*")) return word.slice(0, -1);
      if (word.length >= 6) return word.slice(0, -2);
      if (word.length >= 4) return word.slice(0, -1);
      return word;
    })
    .filter(Boolean);
}

/** Whether a hit carries every stem (in its title or other cells). Pure. */
export function matchesQuery(hit: PspHit, stems: string[]): boolean {
  const haystack = foldText([hit.title, ...hit.cells].join(" "));
  return stems.every((stem) => haystack.includes(stem));
}

/** The listing's first page for a query: the site's own form when the page
 * has one (its action and fields, the název and období fields filled), else
 * the plain `?o=&na=` address. */
async function firstListingPage(period: number, query: string): Promise<{ html: string; url: string; serverFilter: "form" | "query-param" }> {
  const home = listingUrl(period);
  const homeHtml = await cachedPage(home);
  const form = parseListingForm(homeHtml, home);
  if (form) {
    const fields = { ...form.fields, [form.nameField!]: query };
    if (form.periodField) fields[form.periodField] = String(period);
    const params = new URLSearchParams(fields);
    if (form.method === "POST") {
      const key = `POST ${form.action} ${params}`;
      const html = await pageCache.through(key, async () => (await fetchHtml(form.action, { method: "POST", body: params.toString() })).html);
      return { html, url: form.action, serverFilter: "form" };
    }
    const url = `${form.action}${form.action.includes("?") ? "&" : "?"}${params}`;
    return { html: await cachedPage(url), url, serverFilter: "form" };
  }
  const url = `${home}&na=${encodeURIComponent(query)}`;
  return { html: await cachedPage(url), url, serverFilter: "query-param" };
}

/**
 * Tisky whose title carries every word of the query, in one period. The
 * listing is asked to filter (its form), and every row is checked here as
 * well — so the answer is right whether or not the site applied the filter,
 * at the price of reading further listing pages when it did not. Pages are
 * read in small parallel batches from the page links the listing prints
 * (never from an assumed page parameter), up to MAX_LISTING_PAGES and the
 * call's budget; `needed` rows end the scan early.
 */
export async function searchPsp(input: PspSearchInput, needed: number): Promise<PspSearchResult> {
  const key = memoKey("psp-search", { ...input, needed });
  return searchCache.through(key, async () => {
    const { period } = input;
    if (input.number !== undefined) {
      const tisk = await getPspTisk(period, input.number);
      return { period, hits: [{ period, number: tisk.number, title: tisk.title, cells: [], url: tisk.url }], pagesScanned: 0, listingTruncated: false, serverFilter: "form" };
    }
    const query = input.query?.trim() ?? "";
    const stems = queryStems(query);
    if (!stems.length) {
      throw new SourceError(SOURCE, "INPUT_INVALID", "The query has no searchable word.", "Pass title words (query) or a tisk number (number).");
    }
    const deadline = callDeadline(SEARCH_BUDGET_MS);
    const first = await firstListingPage(period, query);
    const hits: PspHit[] = [];
    const seen = new Set<string>();
    const take = (page: string, url: string) => {
      for (const hit of parseListing(page, url, period)) {
        const k = `${hit.period}/${hit.number}`;
        if (seen.has(k) || !matchesQuery(hit, stems)) continue;
        seen.add(k);
        hits.push(hit);
      }
    };
    take(first.html, first.url);
    let pagesScanned = 1;
    const links = parsePageLinks(first.html, first.url);
    const done = new Set<number>([1]);
    let listingTruncated = false;
    while (hits.length < needed) {
      const pending = [...links.entries()].filter(([n]) => !done.has(n)).sort((a, b) => a[0] - b[0]);
      if (!pending.length) break;
      if (pagesScanned >= MAX_LISTING_PAGES || Date.now() > deadline) {
        listingTruncated = true;
        break;
      }
      const batch = pending.slice(0, Math.min(LISTING_BATCH, MAX_LISTING_PAGES - pagesScanned));
      const pages = await Promise.all(batch.map(async ([n, url]) => ({ n, url, html: await cachedPage(url) })));
      for (const page of pages) {
        done.add(page.n);
        pagesScanned++;
        take(page.html, page.url);
        for (const [n, url] of parsePageLinks(page.html, page.url)) if (!links.has(n)) links.set(n, url);
      }
    }
    if (!listingTruncated && hits.length >= needed && [...links.keys()].some((n) => !done.has(n))) listingTruncated = true;
    return { period, hits, pagesScanned, listingTruncated, serverFilter: first.serverFilter };
  });
}

/** One tisk: its history page parsed. */
export async function getPspTisk(period: number, number: number): Promise<PspTisk> {
  const url = tiskUrl(period, number);
  return tiskCache.through(url, async () => {
    const page = await fetchHtml(url);
    const tisk = parseTisk(page.html, url, period, number);
    if (!tisk.documents.length && tisk.text.length < 400) {
      throw new SourceError(SOURCE, "NOT_FOUND", `psp.cz shows no sněmovní tisk ${number} in the ${periodLabel(period)}.`, "Check the number and the period (psp_search with year finds the period); the tisk's number is printed as 1234/0 — pass 1234.");
    }
    return tisk;
  });
}

/** The text of one part of a tisk (tiskt.sqw). */
export async function getPspTiskText(period: number, number: number, part: number): Promise<{ url: string; text: string }> {
  const url = tiskTextUrl(period, number, part);
  const text = await textCache.through(url, async () => {
    const page = await fetchHtml(url);
    const text = parseTiskText(page.html);
    if (text.length < 200 && /nenalezen|neexistuje|nebyl nalezen|chyba/i.test(text)) {
      throw new SourceError(SOURCE, "NOT_FOUND", `psp.cz has no text for tisk ${number}/${part} in the ${periodLabel(period)}.`, "psp_get_tisk lists the parts the tisk has (part numbers) and its attached documents (document_id).");
    }
    return text;
  });
  return { url, text };
}

// ---------- attached documents (orig2.sqw): PDF, DOCX, HTML ----------

export type DocumentFormat = "pdf" | "docx" | "doc" | "rtf" | "html" | "unknown";

/** What a downloaded file is, from its first bytes — never from the header. Pure — unit-tested. */
export function sniffDocument(bytes: Uint8Array): DocumentFormat {
  const head = Array.from(bytes.slice(0, 8));
  const ascii = String.fromCharCode(...head);
  if (ascii.startsWith("%PDF")) return "pdf";
  if (ascii.startsWith("PK\u0003\u0004")) return "docx";
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return "doc";
  if (ascii.startsWith("{\\rtf")) return "rtf";
  const text = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
  if (looksLikeHtml(text)) return "html";
  return "unknown";
}

export interface PdfRange {
  text: string;
  pages: number;
  range: [number, number];
  warnings: string[];
}

export type PdfOutcome = PdfRange | { unavailable: "encrypted" | "scan" | "broken" | "too-many-pages" | "timeout" };

/** The converters, injectable for tests; the defaults load lazily (pdf.js and mammoth are heavy). */
export interface DocumentConverters {
  pdf: (bytes: ArrayBuffer, range: [number, number]) => Promise<PdfOutcome>;
  docx: (bytes: ArrayBuffer) => Promise<string>;
}

const defaultConverters: DocumentConverters = {
  pdf: async (bytes, range) => {
    const result = await (await import("@/src/zotero/pdf-text")).pdfText(bytes, { pageRange: range });
    return "unavailable" in result ? result : { text: result.text, pages: result.pages, range: result.pageRange, warnings: result.warnings };
  },
  docx: async (bytes) => {
    const mod = (await import("mammoth")) as typeof import("mammoth") & { default?: typeof import("mammoth") };
    const mammoth = mod.default ?? mod;
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return result.value;
  },
};

export interface ExtractedDocument {
  url: string;
  format: DocumentFormat;
  text: string;
  /** PDF only: the whole file's pages, the pages this text covers, converter warnings. */
  pdf?: { pages: number; range: [number, number]; warnings: string[] };
}

/** PDF pages one call converts at most (a rozdílová tabulka runs to hundreds). */
export const PDF_PAGES_PER_CALL = 60;

async function fetchFile(url: string): Promise<{ bytes: ArrayBuffer; url: string }> {
  const response = await fetchUpstream(SOURCE, url, { headers: { accept: "*/*" }, timeoutMs: 25_000 });
  if (response.status === 404) {
    throw new SourceError(SOURCE, "NOT_FOUND", `psp.cz has no document at ${url} (HTTP 404).`, "The document_id comes from psp_get_tisk's document list.");
  }
  if (!response.ok) {
    throw new SourceError(SOURCE, "UPSTREAM_ERROR", `psp.cz answered HTTP ${response.status} for ${url}.`, "Try again in a minute.");
  }
  return { bytes: await response.arrayBuffer(), url: response.url || url };
}

/**
 * The text of an attached original document: PDF through the Vlastní zdroje
 * converter (page markers ⟦s. N⟧), DOCX through mammoth, HTML as text. A
 * legacy .doc is asked for again as psp.cz's PDF rendition (&pdf=1); when
 * that is not a PDF either, the caller is told to open the file itself.
 */
export async function getPspDocument(
  id: number,
  pdfRange: [number, number] = [1, PDF_PAGES_PER_CALL],
  converters: DocumentConverters = defaultConverters,
): Promise<ExtractedDocument> {
  const key = memoKey("psp-doc", { id, pdfRange });
  return fileCache.through(key, async () => {
    let file = await fetchFile(documentUrl(id));
    let format = sniffDocument(new Uint8Array(file.bytes));
    if (format === "doc" || format === "rtf" || format === "unknown") {
      const rendition = await fetchFile(documentUrl(id, true));
      const renditionFormat = sniffDocument(new Uint8Array(rendition.bytes));
      if (renditionFormat === "pdf") {
        file = rendition;
        format = renditionFormat;
      }
    }
    switch (format) {
      case "pdf": {
        const outcome = await converters.pdf(file.bytes, pdfRange);
        if ("unavailable" in outcome) {
          const why: Record<string, string> = {
            encrypted: "the PDF is encrypted",
            scan: "the PDF is a scan without a text layer",
            broken: "the PDF could not be parsed",
            "too-many-pages": "the PDF has more pages than this server converts",
            timeout: "converting the PDF took too long",
          };
          throw new SourceError(SOURCE, "UPSTREAM_ERROR", `Document ${id}: ${why[outcome.unavailable]}.`, `Open it yourself: ${file.url}`);
        }
        return { url: file.url, format, text: outcome.text, pdf: { pages: outcome.pages, range: outcome.range, warnings: outcome.warnings } };
      }
      case "docx":
        return { url: file.url, format, text: (await converters.docx(file.bytes)).trim() };
      case "html":
        return { url: file.url, format, text: htmlToText(new TextDecoder("utf-8").decode(file.bytes)) };
      default:
        throw new SourceError(
          SOURCE,
          "UPSTREAM_ERROR",
          `Document ${id} is a ${format === "doc" ? "legacy Word (.doc)" : format === "rtf" ? "RTF" : "binary"} file and psp.cz offered no PDF rendition of it.`,
          `This server reads PDF, DOCX and HTML. Open the file yourself: ${documentUrl(id)} — or look for the same document in another format in psp_get_tisk's list.`,
        );
    }
  });
}
