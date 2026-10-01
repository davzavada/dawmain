import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import type { CheerioAPI } from "cheerio";
import { loadHtml } from "./shared/html";
import { SEARCH_OPERATORS, czechToIso, parseCaseNumber } from "./shared/text";
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
/**
 * Counts print thousands with a space ("50 454"). Only a space followed by
 * three digits continues the number: "[\d\s]+" also swallowed the next line
 * when nothing followed the count on its own ("… z 2" + "1 Cdo 1/2024" read
 * as 21).
 */
const NS_COUNT = String.raw`(\d+(?:[ \u00a0]\d{3})*)(?!\d)`;
const TRUNCATED_RE = new RegExp(String.raw`Podmínce vyhovuje:\s*${NS_COUNT}`);
const COUNT_RE = new RegExp(String.raw`Výsledky\s+\d+\s*-\s*\d+\s+z\s+${NS_COUNT}`);
/** Exactly one match gets its own banner (live, 2026-09) instead of "Výsledky 1 - 1 z 1". */
const SINGLE_RE = /Byl nalezen jeden výsledek/;

export interface NsSearchInput {
  query?: string;
  caseNumber?: string;
  category?: string; // kategorie rozhodnutí A–E
  /** [TypRozhodnuti]: "Rozsudek" | "Usnesení" | "Stanovisko". */
  type?: string;
  /**
   * [SoudCreate]: "Nejvyšší soud", "Vrchní soud v Praze", "Krajský soud v
   * Brně"… The database is not NS-only — decisions of lower courts are in it
   * because they were selected for the Sbírka, so the default is no filter.
   */
  court?: string;
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
 * Shares the parser with rozhodnuti.justice.cz; what is ours: [spzn2] is
 * indexed lowercase, a leading "sp. zn." / "č. j." is dropped (the decision's
 * own text never carries it), and a TWO-digit year is accepted — the 1990s
 * značky ("20 Cdo 2018/98", many of them Sbírka [A] decisions) are indexed
 * with the year as written: measured live, [spzn1]=20 AND [spzn2]=cdo AND
 * [spzn3]=2018 AND [spzn4]=98 found exactly that decision, while the phrase
 * fallback listed 251 decisions citing it without it. justice.cz keeps the
 * shared four-digit rule. Pure — unit-tested.
 */
export function parseSpisovaZnacka(raw: string): SpisovaZnacka | null {
  const bare = raw.replace(/^\s*(?:sp\.\s*zn\.|č\.\s*j\.)\s*/iu, "");
  const parts =
    parseCaseNumber(bare) ??
    (() => {
      const m = /^\s*(?:(\d{1,3})\s+)?(\p{L}+)\s+(\d+)\s*\/\s*(\d{2})(?!\d)/u.exec(bare);
      return m ? { senate: m[1] ?? null, registry: m[2], number: m[3], year: m[4] } : null;
    })();
  if (!parts) return null;
  return {
    senate: parts.senate,
    mark: parts.registry.toLowerCase(),
    number: parts.number,
    year: parts.year,
  };
}

/**
 * A spisová značka inside a free-text query — "31 Cdo 1945/2010",
 * "29 ICdo 41/2014", "Pl. ÚS 24/10", "I. ÚS 1234/20". It must stay one
 * phrase: split into words and AND-ed it would also match decisions that
 * merely contain the senate, the registry and the number somewhere apart.
 * A senate number (or the ÚS form) is required on purpose: "Zákon 89/2012"
 * must NOT be frozen into a phrase no decision contains.
 */
const NS_CASE_MARK_RE =
  /(?<![\p{L}\p{N}])(?:\d{1,3}\s+\p{Lu}\p{L}{0,5}|(?:Pl|IV|I{1,3})\.\s*ÚS)\s+\d{1,6}\s*\/\s*\d{2,4}(?!\p{N})/gu;

/**
 * Turn the caller's full-text query into the Domino expression we send.
 *
 * Domino reads several words without an operator as ONE EXACT PHRASE —
 * measured live: `nájemce výpověď` matched 1 decision, `nájemce AND
 * výpověď` 1 501; `výpověď z nájmu bez výpovědní doby` 1 vs 409 with AND.
 * A research query written as plain words means "all of these words", so
 * bare words are joined with AND. So is a "quoted phrase" next to them: the
 * same quirk read `"dobré mravy" nájem` as the one phrase "dobré mravy
 * nájem" (live: 0 decisions, against 119 for `"dobré mravy" AND nájem`),
 * so phrases are pulled out as units first. What the caller composed —
 * parentheses, & | !, an operator word outside a phrase — goes up
 * untouched: they asked for exactly that. Spisové značky stay phrases,
 * tokens with inner punctuation ("1945/2010", "89/2012") are quoted so
 * Domino keeps them together, and one-character words (z, v, a, o…) are
 * dropped: as AND terms they only cost time. A word ending in "?" is asked
 * both ways, `(platná OR platná?)`: the "?" of a question typed verbatim
 * would otherwise demand one more character and zero the search (live:
 * "je výpověď z nájmu platná?" 0 decisions, 255 without the "?"), while
 * "nájm?" is a working one-letter wildcard (≥ 1 000 decisions, "nájm"
 * alone 0) that must keep working. Pure — unit-tested.
 */
export function nsFullText(raw: string): string {
  const text = sanitizeNsFullText(raw);
  if (!text) return text;
  const units: string[] = [];
  const addUnit = (unit: string) => {
    if (!units.includes(unit)) units.push(unit);
  };
  // Phrases first — an operator word or a bracket INSIDE one is part of the
  // phrase ("not guilty"), not a sign that the caller composed the query.
  const unquoted = text.replace(/"[^"]+"/g, (phrase) => {
    addUnit(phrase);
    return " ";
  });
  const composed =
    /[()&|!]/.test(unquoted) ||
    unquoted.split(" ").some((token) => SEARCH_OPERATORS.has(token.toUpperCase()));
  if (composed) return text;

  const rest = unquoted.replace(NS_CASE_MARK_RE, (mark) => {
    addUnit(`"${mark.replace(/\s*\/\s*/, "/").replace(/\s+/g, " ")}"`);
    return " ";
  });
  for (const token of rest.split(/\s+/)) {
    const word = token.replace(/^[^\p{L}\p{N}*?]+|[^\p{L}\p{N}*?]+$/gu, "");
    if ([...word.replace(/[*?]/g, "")].length < 2) continue;
    const stem = word.replace(/\?+$/u, "");
    // A wildcard inside a quoted token is meaningless — the "?" just goes.
    if (/[^\p{L}\p{N}*?]/u.test(stem)) addUnit(`"${stem}"`);
    else if (stem !== word) addUnit(`(${stem} OR ${word})`);
    else addUnit(word);
  }
  return units.length ? units.join(" AND ") : text;
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
 * Domino answers those with a syntax error, not with results. Czech
 * typographic quotes („…“) are the same phrase marks as "…". "§" goes
 * everywhere, operator expressions included: Domino never indexes it, so
 * it matches nothing. Pure.
 */
export function sanitizeNsFullText(raw: string): string {
  let text = raw.replace(/[[\]{}\\]/g, " ").replace(/§+/g, " ").replace(/[„“”]/g, '"');
  if ((text.match(/"/g)?.length ?? 0) % 2 === 1) text = text.replace(/"/g, " ");
  if (!balancedParens(text)) text = text.replace(/[()]/g, " ");
  // A phrase that held only "§" (or blanks) would reach Domino as "".
  text = text.replace(/"([^"]*)"/g, (_, inner: string) => (inner.trim() ? `"${inner.trim()}"` : " "));
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Domino date literal in the form the NS search page itself sends:
 * zero-padded DD.MM.YYYY (01.06.2025, not 1.6.2025). Pure.
 */
function nsDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Not an ISO date: ${iso}`);
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/**
 * Build the Domino FT query string from tool inputs. Pure — unit-tested.
 *
 * The shape mirrors what rozhodnuti.nsoud.cz sends for the same search, down
 * to the padding and the clause order: field conditions first, the full-text
 * condition last as `([ARozhodnutiRT]=(…))`. That is not cosmetic — a query
 * this box refuses when we compose it our own way goes through when it is
 * written the way the form writes it.
 */
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
  if (input.category) clauses.push(`[kategorie_rozhodnuti1]=${input.category.toUpperCase()}`);
  if (input.type) clauses.push(`[TypRozhodnuti]=${input.type}`);
  if (input.court) {
    const sanitized = input.court.replace(/[()[\]"{}\\]/g, " ").replace(/\s+/g, " ").trim();
    clauses.push(`[SoudCreate]="${sanitized}"`);
  }
  if (input.dateFrom) clauses.push(`[datum_rozhodnuti]>=${nsDate(input.dateFrom)}`);
  if (input.dateTo) clauses.push(`[datum_rozhodnuti]<=${nsDate(input.dateTo)}`);
  if (input.publishedFrom) clauses.push(`[datum_predani_na_web]>=${nsDate(input.publishedFrom)}`);
  if (input.publishedTo) clauses.push(`[datum_predani_na_web]<=${nsDate(input.publishedTo)}`);
  // Last, exactly as the form writes it.
  if (input.query) clauses.push(`([ARozhodnutiRT]=(${nsFullText(input.query)}))`);
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

export interface NsSearchHit {
  unid: string;
  caseNumbers: string[];
  /** "Nejvyšší soud", or the lower court whose decision made the Sbírka. */
  court?: string;
  /** Kategorie rozhodnutí A–E (A = Sbírka, E = procedural) — the cheapest authority signal. */
  category?: string;
  url: string;
}

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
      if (word.length < 3 || SEARCH_OPERATORS.has(word.toUpperCase())) continue;
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
  /** True when `matched` is only a floor: relevance order caps the count at SearchMax. */
  matchedIsMinimum?: boolean;
  truncated: boolean;
  empty: boolean;
}

/** htmlToText's whitespace rules, for text read off an already-parsed DOM. */
function normalizeNsText(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * htmlToText on a DOM we already hold: the same removals, the same line
 * breaks after block elements, the same whitespace — without serialising
 * and parsing the page again. A 900-row result page used to be parsed twice
 * plus once per hit (measured 160 ms against 69 ms for one parse; a 224 kB
 * decision 33 ms against 21 ms). Mutates `$`: block elements gain their
 * "\n", which later reads of the same DOM rely on (stacked značky split at
 * <br>).
 */
function nsDomText($: CheerioAPI): string {
  $("script, style, noscript").remove();
  $("p, div, br, tr, li, h1, h2, h3, h4, h5, h6").each((_, el) => {
    $(el).append("\n");
  });
  return normalizeNsText($.root().text());
}

/** Parse a $$WebSearch1 result page. Pure — unit-tested against fixtures. */
export function parseNsSearch(html: string): NsSearchPage {
  // Banners often arrive with Czech letters as HTML entities (V&yacute;sledky)
  // — match the count markers against decoded text, the rows against the DOM.
  const $ = loadHtml(html);
  const decoded = nsDomText($);
  if (decoded.includes(EMPTY_MARKER)) {
    return { hits: [], total: 0, matched: 0, truncated: false, empty: true };
  }
  const hits: NsSearchHit[] = [];
  const seen = new Set<string>();
  $("a.odk").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const match = UNID_HREF_RE.exec(href);
    if (!match) return;
    const unid = match[1].toUpperCase();
    // A decision filed under two categories can come back as two rows
    // (seen with date ordering) — one hit per document.
    if (seen.has(unid)) return;
    seen.add(unid);
    // The anchor may stack several spisové značky separated by <br/> — the
    // "\n" nsDomText appended to each <br> splits them.
    const caseNumbers = normalizeNsText($(el).text())
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    // The same row carries the court and the category (live markup,
    // 2026-09: td.td-short-wrap = Soud, td.category = Kategorie).
    const row = $(el).closest("tr");
    const court = row.find("td.td-short-wrap").first().text().replace(/\s+/g, " ").trim();
    const category = row.find("td.category").first().text().trim().toUpperCase();
    hits.push({
      unid,
      caseNumbers,
      ...(court ? { court } : {}),
      ...(/^[A-E]$/.test(category) ? { category } : {}),
      url: `${BASE}/WebSearch/${unid}?openDocument`,
    });
  });

  const truncatedMatch = TRUNCATED_RE.exec(decoded);
  const countMatch = COUNT_RE.exec(decoded);
  const parseNumber = (raw: string) => Number(raw.replace(/\s+/g, ""));
  const matched = truncatedMatch ? parseNumber(truncatedMatch[1]) : null;
  const total = countMatch ? parseNumber(countMatch[1]) : SINGLE_RE.test(decoded) ? 1 : matched;

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
  /**
   * WebPrint carried no body and the WebSearch rendition could not be read
   * (failed, or no time left in the call) — "no body" is unconfirmed. Such a
   * result is never cached.
   */
  bodyUnverified?: true;
}

/**
 * How far into the extracted text the judgment's opening may sit. What
 * precedes it on either rendition — citation note, case-number line,
 * headings — is ≈ 600 characters; a lower court's reasoning that quotes
 * "Nejvyšší soud …" lies further in.
 */
const NS_OPENING_REACH = 2_000;

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
  // Its dates come as WebPrint's US 02/26/2014 or WebSearch's 26.2.2014 —
  // both go out as ISO, like Datum rozhodnutí (03/04/2015 read the Czech way
  // is 3 April), each labelled by its column so the filing date is not taken
  // for the day ÚS decided.
  const usComplaints: string[] = [];
  $("table table tr").each((_, row) => {
    const raw = $(row)
      .find("td")
      .map((_, cell) => $(cell).text().replace(/\s+/g, " ").trim())
      .get();
    if (!raw.some((cell) => /ÚS\s*\d+\/\d+/u.test(cell))) return;
    const header = $(row)
      .closest("table")
      .find("tr")
      .first()
      .find("td")
      .map((_, cell) => $(cell).text().replace(/\s+/g, " ").trim())
      .get();
    const cells = raw.map((cell, i) => {
      // Slashes are US, dots Czech — never the other way round.
      const iso = /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(cell)
        ? usToIso(cell)
        : /^\d{1,2}\.\s*\d{1,2}\.\s*\d{4}$/.test(cell)
          ? czechToIso(cell)
          : null;
      if (!iso) return cell;
      const label = header[i]?.toLowerCase() ?? "";
      return /datum/.test(label) ? `${label} ${iso}` : iso;
    });
    usComplaints.push(cells.filter(Boolean).join(" | "));
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
  let text = nsDomText($);
  // Cut what precedes the judgment's opening — on WebSearch the citation
  // note and the headings, on WebPrint the case-number line and headings
  // (≈ 600 characters at most). The opening is "Nejvyšší soud" + a lowercase
  // word at the start of a line: "… rozhodl", "… jako soud dovolací", but
  // also "… projednal v neveřejném zasedání … a rozhodl takto:" (criminal
  // Tdo, ~5 % of the decisions of Q1 2025) and "… v senátě složeném".
  // Looked for in the head only: searched over the whole text, the old
  // verb list missed those openings and cut at point 16 of the reasoning
  // ("Nejvyšší soud jako soud dovolací (§ 265c tr. řádu) zkoumal", live:
  // 4 Tdo 466/2026) — výrok and history gone, the rest reported as no body.
  // No opening in the head (a lower court's Sbírka decision), no cut — nor
  // when a výrok ("… takto:") precedes the match: then the match is a short
  // lower-court body quoting NS, and the cut would take its výrok.
  const opening = /(?:^|\n)[ \t]*(Nejvyšší soud(?: České republiky| ČR)?,?\s+)\p{Ll}/u.exec(
    text.slice(0, NS_OPENING_REACH),
  );
  const start = opening ? opening.index + opening[0].indexOf(opening[1]) : -1;
  if (start > 0 && !/takto\s*:/iu.test(text.slice(0, start))) text = text.slice(start);
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

/**
 * NS is one Domino box, and it answers a burst the way it answers an
 * oversized result set: HTTP 500, for minutes, even to a query that matches
 * three documents. Our own fan-out is the likeliest source of such a burst —
 * three `queries` variants plus `read_top` documents leave in the same tick —
 * so every NS request queues behind this gate. It lives in module scope, so
 * it bounds every call on this warm instance together; other instances are
 * on their own.
 *
 * A freed slot passes straight to the next waiter: freed first and handed
 * over a tick later, it could be taken by a newcomer in between, and a third
 * request reached the box. A waiter leaves the queue when its call's
 * deadline comes — a request nobody will wait for is never sent — and the
 * retry back-off is slept outside the gate, so one refused request does not
 * hold a slot idle for 2 s while others queue behind it.
 */
const NS_CONCURRENCY = 2;
let nsInFlight = 0;
const nsWaiting: Array<() => void> = [];

/** One NS request never waits longer than this (the shared fetchUpstream default). */
const NS_REQUEST_TIMEOUT_MS = 15_000;
/** With less time than this left in the call, a request is not worth sending. */
const NS_MIN_ATTEMPT_MS = 3_000;
/**
 * Deadline of a call that names none. Every caller runs inside the MCP
 * route's 60 s maxDuration; without a deadline, three variants queued behind
 * two slow 500s (attempt, back-off, retry) finished at ~60 s — measured with
 * fake timers — and the platform killed the call together with the variants
 * that had answered.
 */
export const NS_DEFAULT_BUDGET_MS = 45_000;

export interface NsCallOptions {
  /**
   * Epoch ms by which NS must have answered. Queueing at the gate, every
   * request and the retry all count against it.
   */
  deadlineAt?: number;
}

/** The call's deadline, not NS, ended this request — never retried. */
class NsOutOfTime extends SourceError {}

function nsOutOfTime(): NsOutOfTime {
  return new NsOutOfTime(
    SOURCE,
    "UPSTREAM_UNREACHABLE",
    "NS was not asked: this call's time ran out while earlier NS requests were being answered.",
    "Ask again with fewer query variants or a smaller read_top, or in a minute; the other courts are unaffected.",
  );
}

/** Wait for a gate slot until shortly before the deadline. */
function nsQueue(deadlineAt: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const take = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(
      () => {
        const index = nsWaiting.indexOf(take);
        if (index >= 0) nsWaiting.splice(index, 1);
        reject(nsOutOfTime());
      },
      Math.max(0, deadlineAt - Date.now() - NS_MIN_ATTEMPT_MS),
    );
    nsWaiting.push(take);
  });
}

async function nsGate<T>(deadlineAt: number, run: (timeoutMs: number) => Promise<T>): Promise<T> {
  if (nsInFlight < NS_CONCURRENCY) nsInFlight += 1;
  else await nsQueue(deadlineAt); // the releasing request handed its slot over
  try {
    const left = deadlineAt - Date.now();
    if (left < NS_MIN_ATTEMPT_MS) throw nsOutOfTime();
    return await run(Math.min(NS_REQUEST_TIMEOUT_MS, left));
  } finally {
    const next = nsWaiting.shift();
    if (next) next();
    else nsInFlight -= 1;
  }
}

/**
 * One NS request through the gate, with one spaced retry, and no more:
 * hammering a box that is already refusing is exactly what we should not do
 * to a court that publishes its case law for free. fetchUpstream's own retry
 * is off — it would sleep while holding the gate and knows nothing of the
 * deadline. The retry goes out only while the call still has time for it.
 * `retryUnreachable` also retries a network error or timeout (the document
 * renditions, as fetchUpstream's GET retry did); a search that timed out is
 * not re-sent, as before — the box is still busy with the first one.
 */
async function nsFetch(url: string, deadlineAt: number, retryUnreachable: boolean): Promise<Response> {
  const send = () =>
    nsGate(deadlineAt, (timeoutMs) =>
      fetchUpstream(SOURCE, url, {
        headers: { referer: "https://rozhodnuti.nsoud.cz/" },
        retry: false,
        timeoutMs,
      }),
    );
  try {
    return await send();
  } catch (error) {
    const retryable =
      error instanceof SourceError &&
      !(error instanceof NsOutOfTime) &&
      (error.kind === "UPSTREAM_ERROR" || (retryUnreachable && error.kind === "UPSTREAM_UNREACHABLE"));
    const backoff = 1500 + Math.random() * 1000;
    if (!retryable || deadlineAt - Date.now() - backoff < NS_MIN_ATTEMPT_MS) throw error;
    await new Promise((resolve) => setTimeout(resolve, backoff));
    return send();
  }
}

/**
 * Smallest Count worth sending. Domino answers HTTP 500 to this view when
 * Count is small — measured: the identical search returns 2 hits at Count=20
 * and 500 at Count=3, and the same query alternated between working and
 * failing all morning purely by the caller's limit. (The view has the same
 * allergy to a small SearchMax, which is why SearchMax stays at 1000.) So we
 * always ask for a full page and cut the result to size locally; a smaller
 * limit costs the court nothing extra.
 */
export const NS_MIN_COUNT = 20;

/** Count to send upstream for a caller's page size. Pure — unit-tested. */
export function nsFetchCount(count: number): number {
  return Math.max(count, NS_MIN_COUNT);
}

/** "Podmínce vyhovuje" never exceeds this under relevance order. */
export const NS_SEARCH_MAX = 1000;
/** Rows 0–99 of a relevance list: the first block (see nsRelevanceCount). */
const NS_RELEVANCE_BLOCK = 100;
/** Everything deeper: one block over the whole 900-document window. */
const NS_RELEVANCE_WINDOW = 900;

/**
 * The deepest block a relevance-ordered page needs. Domino's relevance order
 * (SearchOrder=1) serves rows ONLY from the top of the list — measured live
 * 2026-09: Start=21, 101 and 401 each came back as an empty table under a
 * banner claiming that very range, while Start=0 with Count=900 returned the
 * rows. So every relevance page is read from the top and sliced here. The
 * ranking itself depends on Count: rows 96–100 of "výpověď z nájmu" were five
 * different decisions at Count=100 and at Count=200 (live, 2026-09), so a
 * list read from blocks growing by 100 repeated hits across pages and never
 * showed others. Two tiers instead: rows 0–99 always come from the Count=100
 * block — pages 1–5 of every query, and the block caselaw_search's NS lane
 * reads, share it — and anything deeper from ONE Count=900 block, the first
 * block's documents taken out, cached for every deeper page. Pure —
 * unit-tested.
 */
export function nsRelevanceCount(start: number, count: number): number {
  return start + count <= NS_RELEVANCE_BLOCK ? NS_RELEVANCE_BLOCK : NS_RELEVANCE_WINDOW;
}

/** Parsed result pages by exact upstream URL — relevance pages share blocks. */
const upstreamCache = new TtlCache<NsSearchPage>(SEARCH_TTL_MS);

const NS_REFUSED_HINT =
  "The NS server refused this search and a retry did not help. Try a narrower query — add a term, a date range, type or category — or come back to it in a minute; the other courts are unaffected, so finish the rešerše there and say in the memo that NS did not answer.";

async function fetchNsResults(url: string, deadlineAt: number): Promise<NsSearchPage> {
  // (The morning's flood of 500s was our own small Count — NS_MIN_COUNT —
  // not the court's capacity; with a full page they have not recurred.)
  let response: Response;
  try {
    response = await nsFetch(url, deadlineAt, false);
  } catch (error) {
    if (error instanceof SourceError && error.kind === "UPSTREAM_ERROR") {
      // Measured: a full-text term combined with a [datum_predani_na_web]
      // range dies on windows the same query survives on [datum_rozhodnuti]
      // ("31 Cdo 1945/2010" over 2016: 500 vs 22 hits). The publication date
      // is for listing what NS put up lately, not for full-text research.
      throw new SourceError(SOURCE, "UPSTREAM_ERROR", error.message, NS_REFUSED_HINT);
    }
    throw error;
  }
  // fetchUpstream throws only on 429/5xx. Any other refusal parsed as a
  // result page came out as PARSE_DRIFT — "the layout may have changed" —
  // and sent the model after a layout change that never happened.
  if (!response.ok) {
    const tooLong = [400, 413, 414].includes(response.status);
    throw new SourceError(
      SOURCE,
      tooLong ? "INPUT_INVALID" : "UPSTREAM_ERROR",
      `NS refused the search (HTTP ${response.status}).`,
      tooLong
        ? "Shorten the query or split it into 'queries' variants, and check its quotes and operators."
        : "Try again in a minute; the other courts are unaffected.",
    );
  }
  return parseNsSearch(await response.text());
}

async function runNsSearch(
  input: NsSearchInput,
  start: number,
  count: number,
  deadlineAt: number,
): Promise<NsSearchPage> {
  const query = buildNsQuery(input);
  // Full text is ordered by relevance. The view order (4) used before is the
  // order of internal UNIDs — measured, the first 20 of 1 501 matches were a
  // random mix of 1999–2023, criminal cases included, for a civil question.
  // A field-only listing has no ranking to offer, so it keeps the view order,
  // which pages with Start and reports the true count.
  const relevance = Boolean(input.query);
  const urlFor = (first: number, rows: number) =>
    `${BASE}/$$WebSearch1?SearchView&Query=${encodeURIComponent(query)}` +
    // SearchMax must stay large: SearchMax=1 provokes HTTP 500 upstream.
    `&SearchMax=${NS_SEARCH_MAX}&SearchOrder=${relevance ? 1 : 4}&Start=${first}&Count=${rows}&pohled=1`;
  const fetchPage = (url: string) => upstreamCache.through(url, () => fetchNsResults(url, deadlineAt));

  if (!relevance) {
    // Domino's Start is 1-based (Start=0 reads as 1): offset 20 is Start=21.
    // Start=offset repeated page 1's last hit at the top of page 2, and every
    // later hit was numbered one too high (live, 2026-09).
    const page = await fetchPage(urlFor(start + 1, nsFetchCount(count)));
    // We asked for a full page even when the caller wanted three rows.
    return { ...page, hits: page.hits.slice(0, count), matchedIsMinimum: false };
  }

  const top = await fetchPage(urlFor(0, NS_RELEVANCE_BLOCK));
  let ranked = top.hits;
  const moreThanBlock =
    top.hits.length >= NS_RELEVANCE_BLOCK || (top.total ?? 0) > NS_RELEVANCE_BLOCK;
  if (nsRelevanceCount(start, count) > NS_RELEVANCE_BLOCK && moreThanBlock) {
    const deep = await fetchPage(urlFor(0, NS_RELEVANCE_WINDOW));
    const shown = new Set(top.hits.map((hit) => hit.unid));
    ranked = [...top.hits, ...deep.hits.filter((hit) => !shown.has(hit.unid))];
  }
  // Under relevance the banner counts at most SearchMax matches. Hit URLs
  // stay plain: the highlighted link comes from ns_get_decision with `find`,
  // opening at the very passage a memo quotes — search-term highlights on
  // every hit cost ~80 characters apiece and were rarely the cited link.
  const matchedIsMinimum = top.matched !== null && top.matched >= NS_SEARCH_MAX;
  return { ...top, hits: ranked.slice(start, start + count), matchedIsMinimum };
}

const searchCache = new TtlCache<NsSearchPage>(SEARCH_TTL_MS);
const decisionCache = new TtlCache<NsDecision>(DOCUMENT_TTL_MS, 24);

/**
 * Every search runs exactly as the caller wrote it, across the whole
 * database. There used to be a rescue here that silently re-ran a refused
 * dateless query inside a 12-month and then a 90-day window; it was a
 * workaround for HTTP 500s that turned out to be our own small Count (see
 * NS_MIN_COUNT), and once that was fixed it only stood to hide the archive
 * from a rešerše without being asked. A refusal is now reported as one.
 */
export async function searchNs(
  input: NsSearchInput,
  start: number,
  count: number,
  options: NsCallOptions = {},
): Promise<NsSearchPage> {
  const deadlineAt = options.deadlineAt ?? Date.now() + NS_DEFAULT_BUDGET_MS;
  return searchCache.through(memoKey("ns-search", [input, start, count]), () =>
    runNsSearch(input, start, count, deadlineAt),
  );
}

export async function getNsDecision(unid: string, options: NsCallOptions = {}): Promise<NsDecision> {
  if (!/^[0-9A-Fa-f]{32}$/.test(unid)) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${unid}" is not a Domino UNID.`,
      "Pass the 32-character hexadecimal id returned by ns_search.",
    );
  }
  const deadlineAt = options.deadlineAt ?? Date.now() + NS_DEFAULT_BUDGET_MS;
  const key = memoKey("ns-doc", [unid.toUpperCase()]);
  const decision = await decisionCache.through(key, async () => {
    // WebPrint yields the cleanest HTML. Should its markup ever defeat the
    // extraction (a metadata echo instead of a body), try the WebSearch
    // document view — the same page the hit URL points at — and keep the
    // longer text. A pure safety net; both renditions carry the body.
    const webPrint = await fetchNsRendition(unid, "WebPrint", deadlineAt);
    if (!nsBodyMissing(webPrint.text)) return webPrint;
    // Only a failure that may pass (refused, unreachable, out of time) leaves
    // "no body" unverified. A WebSearch page that was read but carries
    // nothing (PARSE_DRIFT, NOT_FOUND) confirms it — "call again in a
    // minute" would only send the model back for the same answer.
    const webSearch = await fetchNsRendition(unid, "WebSearch", deadlineAt).catch((error: unknown) => {
      const read = error instanceof SourceError && (error.kind === "PARSE_DRIFT" || error.kind === "NOT_FOUND");
      return read ? null : ("unread" as const);
    });
    if (webSearch === "unread") return { ...webPrint, bodyUnverified: true as const };
    if (!webSearch) return webPrint;
    if (webSearch.text.length > webPrint.text.length) {
      // Metadata from WebPrint wins where both renditions carry a field.
      return { ...webSearch, metadata: { ...webSearch.metadata, ...webPrint.metadata } };
    }
    return webPrint;
  });
  // WebSearch was never read, so "no body" is a guess — cached, it was
  // asserted as fact for ten minutes although the next call may well get
  // the body.
  if (decision.bodyUnverified) decisionCache.delete(key);
  return decision;
}

async function fetchNsRendition(
  unid: string,
  rendition: "WebPrint" | "WebSearch",
  deadlineAt: number,
): Promise<NsDecision> {
  const response = await nsFetch(`${BASE}/${rendition}/${unid}?openDocument`, deadlineAt, true);
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
