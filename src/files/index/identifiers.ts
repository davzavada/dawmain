/**
 * Identifier keys: the normalized form of case numbers, ECLIs, § references,
 * act numbers, ISBNs and DOIs, stored in chunks.ident_keys / documents.
 * ident_keys (GIN, matched with &&) and recomputed from the query, so
 * "25 Cdo 1234/19" in a footnote finds "sp. zn. 25 Cdo 1234/2019" and
 * "§ 2913 OZ" finds "§ 2913 o. z.". Stems can't do this: tokenizing a case
 * number loses what makes it one.
 *
 * Keys (lowercase, folded, no spaces):
 *   sz:25cdo1234-2019    spisová značka (senate, registry, number, year;
 *                        short years: 00–40 → 20xx, else 19xx; NSS list
 *                        number "-45" dropped)
 *   sz:2us1234-2020      ÚS (roman senate → arabic), sz:plus5-2020 plenum,
 *                        sz:plusst1-2005 plenary opinion (Pl. ÚS-st.)
 *   sz:c-123-2020        CJEU / General Court (C-123/20, T-12/19)
 *   r:51/2011            Sbírka soudních rozhodnutí a stanovisek (R, Rc)
 *   sbnss:1234/2007      Sbírka rozhodnutí NSS
 *   sbnu:n45/37          Sbírka nálezů a usnesení ÚS (N/U číslo/svazek)
 *   ecli:cz:ns:2020:21.cdo.1234.2020.1
 *   par:2913, par:2913a, par:2913/2 (odst. 2)
 *   parz:89/2012/2913    § with its act (an act within 40 chars after the
 *                        reference, or the commented act of a commentary)
 *   zak:89/2012          "zákon č. 89/2012 Sb.", "89/2012 Sb."
 *   isbn:9788074001234   ISBN-13 (ISBN-10 converted; checksums validated)
 *   doi:10.1000/xyz
 *
 * findIdentSpans also returns WHERE each identifier sits, so the highlighter
 * marks identifier matches with the same regexes that produced the keys.
 *
 * Pure — unit-tested (tests/files-identifiers.test.ts).
 */

import { ACT_ABBREVIATIONS, ACT_NUMBER_RE, resolveAct, zakId } from "@/src/files/index/acts";
import { foldWord } from "@/src/files/text/analyze";

/** Keys per extractIdentKeys call. */
export const MAX_IDENT_KEYS = 200;
/** How far after a § reference its act may be named ("§ 2913 odst. 2 o. z."). */
const ACT_REACH = 40;

export interface IdentSpan {
  start: number;
  end: number;
  keys: string[];
}

// Letters/digits boundary (\b does not know Czech letters).
const NB = "(?<![\\p{L}\\p{N}])";
const NA = "(?![\\p{L}\\p{N}])";
const DASH = "[-‐‑‒–—−]";
/** Spaces that PDF and Word put inside "25 Cdo" / "§ 2913" / "sp. zn.". */
const ODD_SPACES = /[     ]/g;

/** Two-digit year → four digits: 00–40 → 20xx, else 19xx. */
export function fullYear(year: string, pivot = 40): string {
  if (year.length === 4) return year;
  const n = Number(year);
  return String(n <= pivot ? 2000 + n : 1900 + n);
}

const num = (s: string) => String(Number(s));

// ---------------------------------------------------------------------------
// Court registries.

/** Registries of the Nejvyšší soud. */
const NS_REGISTRIES = new Set([
  "cdo", "odo", "tdo", "tz", "tcu", "ntd", "nd", "cpjn", "tpjn", "cpj", "tpj", "nscr", "icdo", "cdon", "tvo", "ncu",
]);
/** Registries of the Nejvyšší správní soud. */
const NSS_REGISTRIES = new Set([
  "as", "afs", "ads", "ars", "azs", "aps", "ao", "aos", "ans", "aprk", "konf", "komp", "nad", "na", "nao", "kse", "ksz", "kseo",
  "kss", "pst", "vol",
]);
/** Registries that appear without a senate number (plenary / grand panel). */
const SENATELESS = new Set(["cpjn", "tpjn", "cpj", "tpj", "konf", "komp"]);
/** Capitalized words that look like a registry but are not one. */
const NOT_REGISTRIES = new Set(["sb", "sbnu", "sbnss", "r", "rc", "n", "u", "cl", "odst", "zn", "str", "us"]);
/** Display spelling of registries whose folded key loses case or háčky. */
const REGISTRY_DISPLAY: Record<string, string> = { nscr: "NSČR", icdo: "ICdo", ins: "INS", icm: "ICm", exe: "EXE", vsph: "VSPH" };

function registryDisplay(folded: string): string {
  return REGISTRY_DISPLAY[folded] ?? folded.charAt(0).toUpperCase() + folded.slice(1);
}

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4 };
const ROMAN_OUT = ["", "I", "II", "III", "IV"];

// ---------------------------------------------------------------------------
// Patterns. Each is global; they run over text with odd spaces replaced by
// " " (same length, so offsets stay valid).

/** ÚS: "II. ÚS 1234/20", "Pl. ÚS 5/20", "Pl. ÚS-st. 1/05", "IV.ÚS 12/05" (also "US"). */
const US_RE = new RegExp(
  `${NB}(Pl|I{1,3}|IV)\\.\\s*[ÚU]S(\\s*${DASH}\\s*st\\.)?\\s*(\\d{1,5})\\s*\\/\\s*(\\d{4}|\\d{2})(?![\\p{N}])`,
  "gu",
);
/** Generic sp. zn.: "25 Cdo 1234/2019", "4 As 12/2019-45", "29 NSČR 12/2019", "Cpjn 1/2020". */
const SZ_RE = new RegExp(
  `${NB}(?:(\\d{1,3})\\s*)?(\\p{Lu}\\p{L}{0,5})\\s*(\\d{1,6})\\s*\\/\\s*(\\d{4}|\\d{2})(?![\\p{N}/])(?:\\s*${DASH}\\s*\\d{1,4}(?![\\p{N}/]))?`,
  "gu",
);
/** CJEU: "C-123/20", "T‑12/19 P". */
const EU_CASE_RE = new RegExp(`${NB}([CTF])\\s?${DASH}\\s?(\\d{1,4})\\s*\\/\\s*(\\d{2})(?![\\p{N}])`, "gu");
const R_RE = /(?<![\p{L}\p{N}.]|\d\s)Rc?\s(\d{1,4})\s*\/\s*(\d{4}|\d{2})(?![\p{N}])/gu;
const SBNSS_RE =
  /(?<![\p{L}\p{N}])(?:č\.\s*)?(\d{1,5})\s*\/\s*(\d{4})\s*Sb\.\s*NSS|Sb\.\s*NSS\s*(?:č\.\s*)?(\d{1,5})\s*\/\s*(\d{4})(?![\p{N}])/gu;
const SBNU_RE = /(?<![\p{L}\p{N}])([NU])\s?(\d{1,4})\s*\/\s*(\d{1,3})\s*SbNU(?:\s*\d{1,4})?/gu;
const ECLI_RE = /(?<![\p{L}\p{N}])ECLI:[A-Z]{2}:[A-Z0-9]{1,7}:\d{4}:[A-Z0-9.]{1,40}/giu;
const DOI_RE = /(?<![\p{L}\p{N}])10\.\d{4,9}\/[^\s"'<>⟦⟧]+/gu;
const ISBN_LABELLED_RE = /ISBN(?:[- ]?1[03])?:?\s*([0-9Xx][0-9Xx \-‐‑]{8,20})/gu;
const ISBN_BARE_RE = /(?<![\p{N}\-‐‑])97[89](?:[\-‐‑ ]?\d){9}[\-‐‑ ]?\d(?![\p{N}\-‐‑])/gu;
/** "§ 2913", "§§ 2910 a 2913", "§ 2913a odst. 2", "§2913" — the list is parsed by parseParagraphs. */
const PAR_RE = /§§?\s*(?=\d)/gu;
const CL_RE = /(?<![\p{L}])(?:[čČ]l\.|[čČ]lán(?:ek|ku|kem|ky|ků))\s*([IVXLC]+|\d{1,4})(?![\p{L}\p{N}])/gu;

// ---------------------------------------------------------------------------
// Case numbers.

interface CaseParts {
  kind: "cz" | "us" | "eu";
  senate: string | null; // arabic digits, "pl", or the CJEU court letter
  registry: string; // folded
  number: string;
  year: string; // four digits
}

function caseKey(p: CaseParts): string {
  if (p.kind === "eu") return `sz:${p.senate}-${p.number}-${p.year}`;
  return `sz:${p.senate ?? ""}${p.registry}${p.number}-${p.year}`;
}

function* caseNumbers(t: string): Generator<{ start: number; end: number; parts: CaseParts }> {
  const taken: Array<[number, number]> = [];
  const free = (s: number, e: number) => !taken.some(([a, b]) => s < b && e > a);
  for (const m of t.matchAll(US_RE)) {
    const senate = m[1] === "Pl" ? "pl" : String(ROMAN[m[1].toLowerCase()]);
    const parts: CaseParts = { kind: "us", senate, registry: m[2] ? "usst" : "us", number: num(m[3]), year: fullYear(m[4]) };
    taken.push([m.index, m.index + m[0].length]);
    yield { start: m.index, end: m.index + m[0].length, parts };
  }
  for (const m of t.matchAll(EU_CASE_RE)) {
    const parts: CaseParts = { kind: "eu", senate: m[1].toLowerCase(), registry: "", number: num(m[2]), year: fullYear(m[3], 60) };
    taken.push([m.index, m.index + m[0].length]);
    yield { start: m.index, end: m.index + m[0].length, parts };
  }
  for (const m of t.matchAll(SZ_RE)) {
    const [whole, senate, registryRaw, number, year] = m;
    const registry = foldWord(registryRaw);
    if (NOT_REGISTRIES.has(registry)) continue;
    if (!senate && !SENATELESS.has(registry)) continue;
    const y = fullYear(year);
    if (Number(y) < 1950 || Number(y) > 2099) continue;
    if (!free(m.index, m.index + whole.length)) continue;
    yield {
      start: m.index,
      end: m.index + whole.length,
      parts: { kind: "cz", senate: senate ? num(senate) : null, registry, number: num(number), year: y },
    };
  }
}

// ---------------------------------------------------------------------------
// § references.

interface ParRef {
  n: string; // "2913" or "2913a"
  odst: string[];
}

/**
 * Parse the list after "§"/"§§" starting at `from`: numbers with an attached
 * letter, each optionally "odst. 1 (a|,) 2", joined by ",", "a", "až",
 * "nebo", "resp.", "či" or a dash. A range contributes its endpoints only.
 */
function parseParagraphs(t: string, from: number): { refs: ParRef[]; end: number } {
  const refs: ParRef[] = [];
  const NUM = /(\d{1,4})([a-z])?(?![\p{L}\p{N}])/uy;
  const ODST = /\s*odst\.\s*(\d{1,3})(?![\p{N}])/uy;
  const ODST_MORE = /\s*(?:,|a|nebo|až|či|[-‐‑–])\s*(\d{1,3})(?![\p{N}.]|\s*[§/])/uy;
  const SEP = /\s*(?:,|a|až|nebo|resp\.|či|[-‐‑–])\s*(?=\d)/uy;
  let pos = from;
  for (;;) {
    NUM.lastIndex = pos;
    const m = NUM.exec(t);
    if (!m) break;
    const ref: ParRef = { n: num(m[1]) + (m[2] ?? ""), odst: [] };
    pos = NUM.lastIndex;
    ODST.lastIndex = pos;
    const o = ODST.exec(t);
    if (o) {
      ref.odst.push(num(o[1]));
      pos = ODST.lastIndex;
      for (;;) {
        ODST_MORE.lastIndex = pos;
        const more = ODST_MORE.exec(t);
        if (!more) break;
        ref.odst.push(num(more[1]));
        pos = ODST_MORE.lastIndex;
      }
    }
    refs.push(ref);
    SEP.lastIndex = pos;
    if (!SEP.exec(t)) break;
    pos = SEP.lastIndex;
  }
  return { refs, end: pos };
}

/** "zak:89/2012" → "89/2012"; EU acts have no § (null). */
function parzAct(act: string | null | undefined): string | null {
  const m = act ? /^zak:(\d{1,4}\/\d{4})$/.exec(act) : null;
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// ISBN.

function isbn13Valid(d: string): boolean {
  if (!/^\d{13}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(d[i]) * (i % 2 ? 3 : 1);
  return sum % 10 === 0;
}

function isbn10Valid(d: string): boolean {
  if (!/^\d{9}[\dX]$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (d[i] === "X" ? 10 : Number(d[i])) * (10 - i);
  return sum % 11 === 0;
}

/** ISBN-10 → ISBN-13 (978 prefix, new check digit). */
export function isbn10to13(d: string): string {
  const core = "978" + d.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
  return core + String((10 - (sum % 10)) % 10);
}

/** Digits of an ISBN candidate → the 13-digit ISBN, or null when no checksum holds. */
export function normalizeIsbn(raw: string): string | null {
  const d = raw.toUpperCase().replace(/[^0-9X]/g, "");
  if (d.length >= 13 && isbn13Valid(d.slice(0, 13)) && !d.slice(0, 13).includes("X")) return d.slice(0, 13);
  if (d.length >= 10 && isbn10Valid(d.slice(0, 10))) return isbn10to13(d.slice(0, 10));
  return null;
}

// ---------------------------------------------------------------------------

function trimDoi(doi: string): string {
  let d = doi.replace(/[.,;:!?'"]+$/, "");
  // Drop closing brackets that close nothing inside the DOI.
  for (const [open, close] of [["(", ")"], ["[", "]"]] as const) {
    while (d.endsWith(close) && d.split(open).length <= d.split(close).length - 1) d = d.slice(0, -1).replace(/[.,;:]+$/, "");
  }
  return d;
}

/**
 * Every identifier in `text` with its span and keys, in text order. Pure.
 */
export function findIdentSpans(text: string, ctx?: { commentedAct?: string | null }): IdentSpan[] {
  const t = text.replace(ODD_SPACES, " ");
  const spans: IdentSpan[] = [];
  const push = (start: number, end: number, keys: string[]) => {
    if (keys.length) spans.push({ start, end, keys });
  };

  for (const c of caseNumbers(t)) push(c.start, c.end, [caseKey(c.parts)]);
  for (const m of t.matchAll(R_RE)) push(m.index, m.index + m[0].length, [`r:${num(m[1])}/${fullYear(m[2])}`]);
  for (const m of t.matchAll(SBNSS_RE)) {
    const [n, y] = m[1] ? [m[1], m[2]] : [m[3], m[4]];
    push(m.index, m.index + m[0].length, [`sbnss:${num(n)}/${y}`]);
  }
  for (const m of t.matchAll(SBNU_RE)) push(m.index, m.index + m[0].length, [`sbnu:${m[1].toLowerCase()}${num(m[2])}/${num(m[3])}`]);
  for (const m of t.matchAll(ECLI_RE)) {
    const ecli = m[0].replace(/\.+$/, "");
    push(m.index, m.index + ecli.length, [`ecli:${ecli.slice(5).toLowerCase()}`]);
  }
  for (const m of t.matchAll(ACT_NUMBER_RE)) {
    const [n, y] = m[1] ? [m[1], m[2]] : [m[3], m[4]];
    // "1234/2007 Sb. NSS" is excluded by the pattern itself.
    push(m.index, m.index + m[0].length, [zakId(n, y)]);
  }

  const commented = parzAct(ctx?.commentedAct);
  for (const m of t.matchAll(PAR_RE)) {
    const { refs, end } = parseParagraphs(t, m.index + m[0].length);
    if (!refs.length) continue;
    // The act named right after the reference, unless another § comes first.
    const tail = t.slice(end, end + ACT_REACH);
    const cut = tail.indexOf("§");
    const named = resolveAct(cut === -1 ? tail : tail.slice(0, cut));
    const act = named ? parzAct(named.act) : commented;
    const keys: string[] = [];
    for (const ref of refs) {
      keys.push(`par:${ref.n}`);
      for (const o of ref.odst) keys.push(`par:${ref.n}/${o}`);
      if (act) keys.push(`parz:${act}/${ref.n}`);
    }
    push(m.index, end, keys);
  }

  const isbnSeen = new Set<number>();
  for (const m of t.matchAll(ISBN_LABELLED_RE)) {
    const isbn = normalizeIsbn(m[1]);
    if (!isbn) continue;
    isbnSeen.add(m.index + m[0].indexOf(m[1]));
    push(m.index, m.index + m[0].trimEnd().length, [`isbn:${isbn}`]);
  }
  for (const m of t.matchAll(ISBN_BARE_RE)) {
    if (isbnSeen.has(m.index)) continue;
    const isbn = normalizeIsbn(m[0]);
    if (isbn) push(m.index, m.index + m[0].length, [`isbn:${isbn}`]);
  }
  for (const m of t.matchAll(DOI_RE)) {
    const doi = trimDoi(m[0]);
    push(m.index, m.index + doi.length, [`doi:${doi.toLowerCase()}`]);
  }

  return spans.sort((a, b) => a.start - b.start || b.end - a.end);
}

function dedupe(keys: string[], cap: number): string[] {
  return [...new Set(keys)].slice(0, cap);
}

/**
 * Identifier keys of `text` (see the header), deduplicated, first
 * occurrence first, capped at MAX_IDENT_KEYS. `commentedAct` ("zak:89/2012")
 * turns a bare § of a commentary into parz:89/2012/<n>. Pure.
 */
export function extractIdentKeys(text: string, ctx?: { commentedAct?: string | null }): string[] {
  return dedupe(
    findIdentSpans(text, ctx).flatMap((s) => s.keys),
    MAX_IDENT_KEYS,
  );
}

/**
 * Query side: the keys in the query, the act the query names (number or
 * abbreviation — the act filter), and the § / čl. sections it asks for.
 * An act anywhere in the query applies to its § references:
 * "§ 2913 OZ" → keys [par:2913, parz:89/2012/2913], act zak:89/2012,
 * sections [par:2913]. Pure.
 */
export function queryIdentKeys(query: string): { keys: string[]; act: string | null; sections: string[] } {
  const act = resolveAct(query.replace(ODD_SPACES, " "))?.act ?? null;
  const parz = parzAct(act);
  const spans = findIdentSpans(query, { commentedAct: act });
  const keys: string[] = [];
  const sections: string[] = [];
  for (const span of spans) {
    for (const key of span.keys) {
      keys.push(key);
      const par = /^par:(\d+[a-z]?)$/.exec(key);
      if (par) {
        sections.push(key);
        if (parz) keys.push(`parz:${parz}/${par[1]}`);
      }
    }
  }
  for (const m of query.replace(ODD_SPACES, " ").matchAll(CL_RE)) sections.push(`cl:${m[1]}`);
  return { keys: dedupe(keys, MAX_IDENT_KEYS), act, sections: dedupe(sections, MAX_IDENT_KEYS) };
}

/**
 * The query minus what the identifier channel already covers: identifier
 * spans (case numbers, §§, act numbers, ISBN, DOI, ECLI) and act
 * abbreviations ("OZ", "o. z.") become spaces, so the lexical tsquery does
 * not demand the tokens "cdo", "2019" or "oz" of every chunk. Act NAMES
 * ("zákoník práce") stay — they are words worth searching. Use as
 * buildTsQuery(stripIdentifiers(q)). Pure.
 */
export function stripIdentifiers(query: string): string {
  const chars = query.split("");
  const blank = (start: number, end: number) => {
    for (let i = start; i < end; i++) chars[i] = " ";
  };
  for (const span of findIdentSpans(query)) blank(span.start, span.end);
  const t = query.replace(ODD_SPACES, " ");
  for (const entry of ACT_ABBREVIATIONS) {
    if (!entry.abbreviation) continue;
    for (const m of t.matchAll(new RegExp(entry.pattern.source, `${entry.pattern.flags}g`))) blank(m.index, m.index + m[0].length);
  }
  return chars.join("").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------

const KEY_RE = /^sz:(?:(pl|\d{1,3})?([a-z]+)(\d+)-(\d{4})|([ctf])-(\d+)-(\d{4}))$/;

function courtOf(p: CaseParts): "NS" | "NSS" | "US" | "SDEU" | null {
  if (p.kind === "eu") return "SDEU";
  if (p.kind === "us") return "US";
  if (NS_REGISTRIES.has(p.registry)) return "NS";
  if (NSS_REGISTRIES.has(p.registry)) return "NSS";
  return null;
}

function display(p: CaseParts): string {
  if (p.kind === "eu") return `${p.senate!.toUpperCase()}-${p.number}/${p.year.slice(2)}`;
  if (p.kind === "us") {
    const senate = p.senate === "pl" ? "Pl." : `${ROMAN_OUT[Number(p.senate)] ?? p.senate}.`;
    return `${senate} ÚS${p.registry === "usst" ? "-st." : ""} ${p.number}/${p.year.slice(2)}`;
  }
  return `${p.senate ? `${p.senate} ` : ""}${registryDisplay(p.registry)} ${p.number}/${p.year}`;
}

/**
 * Canonical display of the first case number in `raw` (free text, or an
 * "sz:" key) and the court whose search tool can fetch the official text:
 * NS (Cdo, Odo, Tdo, Cpjn, NSČR, ICdo…), NSS (As, Afs, Ads, Azs, Ao, Konf…),
 * ÚS ("US"), CJEU ("SDEU"); null court for other courts' registries
 * ("12 Co 123/2019"). null when there is no case number. Pure.
 */
export function canonicalCaseNumber(raw: string): { display: string; court: "NS" | "NSS" | "US" | "SDEU" | null } | null {
  const key = KEY_RE.exec(raw.trim());
  let parts: CaseParts | null = null;
  if (key) {
    if (key[5]) parts = { kind: "eu", senate: key[5], registry: "", number: key[6], year: key[7] };
    else if (key[2] === "us" || key[2] === "usst")
      parts = { kind: "us", senate: key[1] ?? null, registry: key[2], number: key[3], year: key[4] };
    else parts = { kind: "cz", senate: key[1] ?? null, registry: key[2], number: key[3], year: key[4] };
  } else {
    // Earliest in the text, whatever the pattern: the generator yields ÚS, then CJEU, then the rest.
    let best: { start: number; parts: CaseParts } | null = null;
    for (const c of caseNumbers(raw.replace(ODD_SPACES, " "))) if (!best || c.start < best.start) best = c;
    parts = best?.parts ?? null;
  }
  if (!parts) return null;
  return { display: display(parts), court: courtOf(parts) };
}
