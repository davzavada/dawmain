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
 * Addresses (o = volební období, t/T/CT = číslo tisku, CT1 = podčíslo of the
 * tisk's parts, idd = id of an attached original document):
 *   search form            /sqw/sntisk.sqw?o=9  (tabs F=N návrhy zákonů, S smlouvy, R rozpočty, I interpelace, Z zprávy)
 *   search results         /sqw/tisky.sqw?tqb1=2&utq=2&o=9&na=…&tqb25=…&tqa27=on…&ra=20   (captured, HAR 2026-10)
 *   results by Sbírka no.  /sqw/tisky.sqw?tqb1=1&utq=2&o=9&tqb18=221&tqb19=2006&ra=20     (captured: answered tisk 1110 of the 4th period although o=9 — the Sbírka lookup spans periods)
 *   one tisk, its history  /sqw/historie.sqw?o=4&t=1110
 *   text of a tisk part    /sqw/text/tiskt.sqw?O=4&CT=1110&CT1=0  (captured; for older tisky the text is not inline — only "Originál dokumentu" / "Verze PDF" and "Přílohy dokumentu")
 *   attached original file /sqw/text/orig2.sqw?idd=14683  (+&pdf=1 = "Verze PDF", captured)
 * Pages come as text/html; charset=Windows-1250 (header), content in
 * <div id="main-content">. The search form (tisky.sqw, GET) and its fields,
 * a results page and a tiskt.sqw page were captured live (HAR 2026-10,
 * fixtures in tests/fixtures/psp/tisky-search-*.html, tiskt-4-1110.html);
 * the historie.sqw page has NOT been captured yet, so its parser keys on
 * the anchors' hrefs only, and the result-list pagination markup is
 * unseen (ra=100 rows per request keeps most searches on one page).
 * dawmain_probe_sources: canary `psp`, `discover` dumps the live form.
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

/** The search form page (the entry psp.cz links as "sněmovní tisky"). */
export function listingUrl(period: number): string {
  return `${ORIGIN}/sqw/sntisk.sqw?o=${period}`;
}

/**
 * Druh tisku — the checkboxes of the "Vše" tab of the search form, verbatim
 * (captured 2026-10). All on = the form's default.
 */
export const PSP_TYPES = {
  bills: ["tqa27", "návrhy zákonů"],
  treaties: ["tqa28", "mezinárodní smlouvy"],
  budgets: ["tqa29", "rozpočty"],
  eu_documents: ["tqa64", "dokumenty EU"],
  interpellations: ["tqa30", "písemné interpelace"],
  reports: ["tqa31", "zprávy"],
  government_opinions: ["tqa32", "stanoviska vlády"],
  counter_reports: ["tqa63", "oponentní zprávy"],
  committee_resolutions: ["tqa33", "usnesení výborů"],
  amendments: ["tqa34", "pozměňovací návrhy"],
  other_opinions: ["tqa62", "ostatní stanoviska"],
  other: ["tqa35", "další"],
} as const;
export type PspType = keyof typeof PSP_TYPES;

/** Rows one results page shows (the form's `ra`, "Zobrazit N tisků současně"; the site's default is 20). */
export const RESULTS_PER_PAGE = 100;

export interface PspSearchInput {
  /** Název tisku (the form's `na`) — the site's own title filter. */
  query?: string;
  /** Číslo tisku (`tqb25`); `part` = the number after the slash (`tqb26`). */
  number?: number;
  part?: number;
  /** "221/2006" — číslo a rok Sbírky (`tqb18`/`tqb19`, the návrhy-zákonů tab): the tisk an act came from. */
  act?: string;
  /** Volební období the form is opened in (`o`). Hits carry their own period; the act lookup answers across periods. */
  period: number;
  types?: PspType[];
  /** Pouze neukončené (`tqa17`). */
  onlyPending?: boolean;
}

/** "221/2006", "221/2006 Sb.", "č. 221/2006 Sb." → number and year. Pure — unit-tested. */
export function parseActNumber(act: string): { number: string; year: string } {
  const m = /(\d{1,4})\s*\/\s*(\d{4})/.exec(act);
  if (!m) {
    throw new SourceError(SOURCE, "INPUT_INVALID", `"${act}" is not a Sbírka citation.`, 'Pass the act as "221/2006" (číslo/rok Sbírky zákonů).');
  }
  return { number: m[1], year: m[2] };
}

/**
 * The results request, as the browser sends the form (HAR 2026-10) — the
 * "Vše" tab for title/number searches, the "Návrhy zákonů" tab for the
 * Sbírka-number lookup (only that tab has the Číslo sbírky fields; its
 * other criteria are inactive without their tqa* checkbox and are sent with
 * the captured defaults). Pure — unit-tested.
 */
export function buildSearchUrl(input: PspSearchInput): string {
  const params = new URLSearchParams();
  if (input.act) {
    const { number, year } = parseActNumber(input.act);
    params.set("tqb1", "1");
    params.set("utq", "2");
    params.set("o", String(input.period));
    for (const [k, v] of [["tqb2", "0"], ["tqb3", "15"], ["tqb21", "1"], ["tqb7", "1761"], ["tqb23", "1"], ["tqb24", "1"], ["tqb8", "1"], ["tqb9", "1"], ["tqb10", "1"], ["tqb11", "1"], ["tqb12", "1"], ["tqb13", "1"], ["tqb14", "1"], ["tqb20", "1"], ["tqb22", "1"], ["tqb16", "7"]]) {
      params.set(k, v);
    }
    params.set("tqb18", number);
    params.set("tqb19", year);
    if (input.onlyPending) params.set("tqa17", "on");
    params.set("ra", String(RESULTS_PER_PAGE));
    return `${ORIGIN}/sqw/tisky.sqw?${params}`;
  }
  params.set("tqb1", "2");
  params.set("utq", "2");
  params.set("o", String(input.period));
  params.set("na", input.query?.trim() ?? "");
  params.set("tqb25", input.number !== undefined ? String(input.number) : "");
  params.set("tqb26", input.part !== undefined ? String(input.part) : "");
  const types = input.types?.length ? input.types : (Object.keys(PSP_TYPES) as PspType[]);
  for (const type of Object.keys(PSP_TYPES) as PspType[]) if (types.includes(type)) params.set(PSP_TYPES[type][0], "on");
  if (input.onlyPending) params.set("tqa17", "on");
  params.set("ra", String(RESULTS_PER_PAGE));
  return `${ORIGIN}/sqw/tisky.sqw?${params}`;
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
  /** The row's other cells (druh tisku, stav projednávání or the Sbírka number), as printed. */
  cells: string[];
  url: string;
}

export interface PspSearchPage {
  /** "Celkem nalezen N tisk(ů)": the site's own count; null when the page names none. */
  total: number | null;
  hits: PspHit[];
}

/**
 * A tisky.sqw results page: the count the page states, and the rows. A page
 * without either the count line, the "nebyl nalezen žádný tisk" line or
 * the search form is not a results page as known (drift). Pure — unit-tested.
 */
export function parseSearchResults(html: string, pageUrl: string, fallbackPeriod: number): PspSearchPage {
  const hits = parseListing(html, pageUrl, fallbackPeriod);
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  const count = /Celkem\s+nalezen[oay]?\s+(\d+)\s+tisk/i.exec(text);
  if (count) return { total: Number(count[1]), hits };
  if (/nebyl\s+nalezen\s+žádný\s+tisk/i.test(text)) return { total: 0, hits: [] };
  if (!hits.length && !/form-press-search|name="na"/.test(html)) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "The psp.cz results page carries neither a result count nor the search form.",
      "psp.cz may have changed tisky.sqw — run dawmain_probe_sources {discover: true} and compare the form with src/sources/psp.ts.",
    );
  }
  return { total: hits.length ? null : 0, hits };
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
  const script = absolute(pageUrl, pageUrl)?.pathname ?? "";
  $("a[href]").each((_, el) => {
    const target = absolute($(el).attr("href") ?? "", pageUrl);
    if (!target || target.pathname !== script) return;
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
      // A hidden field has no label of its own (its container's text is not one); its name still counts.
      const label = type === "hidden" ? "" : foldText(labelOf($, el));
      const fname = foldText(name);
      if (!candidate.nameField && (/nazev|nazv/.test(label) || /^na(zev)?$/.test(fname))) candidate.nameField = name;
      else if (!candidate.periodField && (/obdobi/.test(label) || /^o$|obdobi/.test(fname))) candidate.periodField = name;
      else if (!candidate.numberField && (/cislo/.test(label) || /^ct$|cislo/.test(fname))) candidate.numberField = name;
      // The captured form (2026-10): "Číslo tisku:" labels tqb25, with tqb26 for the number after the slash.
      else if (!candidate.numberField && fname === "tqb25") candidate.numberField = name;
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

/** Every document link of a page, deduplicated by URL, labelled and classified. */
function extractDocuments($: CheerioAPI, pageUrl: string, period: number, number: number): PspDocument[] {
  const documents: PspDocument[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!DOCUMENT_HREF.test(href)) return;
    const url = absolute(href, pageUrl);
    if (!url || seen.has(url.href)) return;
    seen.add(url.href);
    const own = clean($(el).text());
    // "(DOC, 171.5 KB)" next to the link on tiskt.sqw.
    const info = clean($(el).nextAll(".media-info").first().text());
    const line = clean($(el).closest("li, tr, p, div").first().text()).slice(0, 200);
    const generic = !own || own.length < 12 || /^(pdf|doc|docx|html|text|dokument|soubor|zde|odkaz)$/i.test(own);
    const base = generic && line ? line : own || line || url.pathname;
    const label = info && !base.includes(info) ? `${base} ${info}` : base;
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
  return documents;
}

/** The historie.sqw page of one tisk. Pure — unit-tested. */
export function parseTisk(html: string, pageUrl: string, period: number, number: number): PspTisk {
  const $ = loadHtml(html);
  const h1 = clean($("h1").not(".department-title").first().text());
  const title = h1 || clean($("title").text());
  const documents = extractDocuments($, pageUrl, period, number);
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

export interface PspTiskText {
  /** The h1: "Sněmovní tisk 1110/0, část č. 1/3 Vl.n.z. o …". */
  title: string;
  /** The document's own text — empty when the page only links the original files (older tisky). */
  text: string;
  /** "Originál dokumentu", "Verze PDF", "Přílohy dokumentu" — the files, by document_id. */
  documents: PspDocument[];
}

/**
 * A tiskt.sqw page (one part of a tisk): its title, the text set inline
 * (minus the file boxes) and the original files. Captured 2026-10 (tisk
 * 1110/4): the content sits in #main-content, the files in
 * .document-media and .attachments, and that older tisk has no inline text
 * at all. Pure — unit-tested.
 */
export function parseTiskText(html: string, pageUrl: string, period: number, number: number): PspTiskText {
  const $ = loadHtml(html);
  const title = clean($("h1").not(".department-title").first().text());
  const documents = extractDocuments($, pageUrl, period, number).filter((doc) => doc.documentId !== undefined || doc.format !== "HTML");
  const content = mainContent($);
  const $content = loadHtml(content);
  $content(".document-media, .attachments, .page-title, h1").remove();
  const text = htmlToText($content.root().html() ?? "");
  return { title, text, documents };
}

// ---------- fetch (I/O) ----------

const pageCache = new TtlCache<string>(SEARCH_TTL_MS, 60);
const searchCache = new TtlCache<PspSearchResult>(SEARCH_TTL_MS);
const textCache = new TtlCache<PspTiskText>(DOCUMENT_TTL_MS, 24);
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

export interface PspSearchResult {
  /** The site's own count of matches, when it states one. */
  total: number | null;
  hits: PspHit[];
  /** Results pages read. */
  pagesScanned: number;
  /** Matches the scan did not reach (the site's count exceeds the rows read and no further page could be followed). */
  truncated: boolean;
  /** The request sent (for diagnosis). */
  url: string;
}

/** Results pages one search may read. */
export const MAX_LISTING_PAGES = 6;
const LISTING_BATCH = 3;
const SEARCH_BUDGET_MS = 30_000;

/**
 * Sněmovní tisky matching the form's criteria, as the site answers them —
 * its own title filter (`na`), tisk number, druh tisku, or the Sbírka number
 * of the resulting act. RESULTS_PER_PAGE rows per request; when the site
 * counts more, the page links the results print are followed (never an
 * assumed page parameter) up to MAX_LISTING_PAGES and the call's budget,
 * and whatever is left is reported as truncated.
 */
export async function searchPsp(input: PspSearchInput, needed: number): Promise<PspSearchResult> {
  if (!input.query?.trim() && input.number === undefined && !input.act?.trim()) {
    throw new SourceError(SOURCE, "INPUT_INVALID", "Neither query, number nor act was given.", "Pass title words (query), a tisk number (number) or a Sbírka citation (act).");
  }
  const url = buildSearchUrl(input);
  const key = memoKey("psp-search", { url, needed });
  return searchCache.through(key, async () => {
    const deadline = callDeadline(SEARCH_BUDGET_MS);
    const firstHtml = await cachedPage(url);
    const first = parseSearchResults(firstHtml, url, input.period);
    const hits: PspHit[] = [];
    const seen = new Set<string>();
    const take = (page: PspSearchPage) => {
      for (const hit of page.hits) {
        const k = `${hit.period}/${hit.number}`;
        if (seen.has(k)) continue;
        seen.add(k);
        hits.push(hit);
      }
    };
    take(first);
    let pagesScanned = 1;
    const links = parsePageLinks(firstHtml, url);
    const done = new Set<number>([1]);
    const total = first.total;
    while (hits.length < needed && (total === null || hits.length < total)) {
      const pending = [...links.entries()].filter(([n]) => !done.has(n)).sort((a, b) => a[0] - b[0]);
      if (!pending.length || pagesScanned >= MAX_LISTING_PAGES || Date.now() > deadline) break;
      const batch = pending.slice(0, Math.min(LISTING_BATCH, MAX_LISTING_PAGES - pagesScanned));
      const pages = await Promise.all(batch.map(async ([n, href]) => ({ n, href, html: await cachedPage(href) })));
      for (const page of pages) {
        done.add(page.n);
        pagesScanned++;
        take(parseSearchResults(page.html, page.href, input.period));
        for (const [n, href] of parsePageLinks(page.html, page.href)) if (!links.has(n)) links.set(n, href);
      }
    }
    const truncated = total !== null ? hits.length < total : [...links.keys()].some((n) => !done.has(n));
    return { total, hits, pagesScanned, truncated, url };
  });
}

/** One tisk: its history page parsed. */
export async function getPspTisk(period: number, number: number): Promise<PspTisk> {
  const url = tiskUrl(period, number);
  return tiskCache.through(url, async () => {
    const page = await fetchHtml(url);
    const tisk = parseTisk(page.html, url, period, number);
    if (!tisk.documents.length && tisk.text.length < 400) {
      throw new SourceError(SOURCE, "NOT_FOUND", `psp.cz shows no sněmovní tisk ${number} in the ${periodLabel(period)}.`, "Check the number and the period (psp_search with year or act finds them); the tisk's number is printed as 1234/0 — pass 1234.");
    }
    return tisk;
  });
}

/** The text of one part of a tisk (tiskt.sqw), with the files it links. */
export async function getPspTiskText(period: number, number: number, part: number): Promise<PspTiskText & { url: string }> {
  const url = tiskTextUrl(period, number, part);
  const parsed = await textCache.through(url, async () => {
    const page = await fetchHtml(url);
    const result = parseTiskText(page.html, url, period, number);
    if (!result.text && !result.documents.length) {
      throw new SourceError(SOURCE, "NOT_FOUND", `psp.cz has no text and no files for tisk ${number}/${part} in the ${periodLabel(period)}.`, "psp_get_tisk lists the parts the tisk has (part numbers) and its attached documents (document_id).");
    }
    return result;
  });
  return { url, ...parsed };
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
