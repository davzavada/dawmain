/**
 * Text-level helpers of the PDF layout engine: folding, DMD escaping,
 * footnote labels and superscripts, line joining with Czech-aware
 * dehyphenation, Roman numerals, stop-word statistics. No geometry here.
 * Isomorphic and pure — unit-tested (tests/files-convert-pdf-text.test.ts).
 */

import { normalizeDmd } from "../../dmd/normalize";
import { FOOTNOTE_LABEL_SOURCE } from "../../dmd/types";

/** Lowercase, diacritics removed. Pure. */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Extracted text → clean single-line text: DMD normalization (so the
 * reserved ⟦ ⟧ brackets become [ ] BEFORE escaping — escaping first would
 * let "⟦s. 12⟧" turn into a live page marker), whitespace collapsed.
 * Leading/trailing spaces are kept as one space (they separate runs). Pure.
 */
export function cleanText(s: string): string {
  return normalizeDmd(s).text.replace(/\s+/g, " ");
}

// ─────────────────────────────────────────────────────────────── DMD escaping

const INLINE_MARKUP_RE = /\[(?=s\. |\^|m\. č\. )/g;

/**
 * Escape text so it can never be read as DMD markup inside a line: every
 * `[s. `, `[^` and `[m. č. ` gets a backslash. Line-start markup is handled
 * by escapeLineStart. Pure.
 */
export function escapeDmdText(s: string): string {
  return s.replace(INLINE_MARKUP_RE, "\\[");
}

/** A text line starting with `#`, `>` or `|` would be a heading / quote / table row — escape it. Pure. */
export function escapeLineStart(line: string): string {
  return /^[#>|]/.test(line) ? `\\${line}` : line;
}

// ─────────────────────────────────────────────────────────────── footnote labels

const DMD_LABEL_RE = new RegExp(`^(?:${FOOTNOTE_LABEL_SOURCE})$`);

/**
 * A footnote label as printed ("12", "4)", "¹²", "A", "**") → the DMD label
 * ("12", "4", "12", "a", "**"), or null when it is not one: digits lose
 * leading zeros, letters are lowercased, a trailing ")" or "." is dropped.
 * Pure.
 */
export function normalizeLabel(raw: string): string | null {
  let s = fromSuperscript(raw.trim()).replace(/[).]$/, "").trim();
  if (/^\(\d{1,4}$/.test(s)) s = s.slice(1); // "(12)" → "12"
  if (/^\d{1,4}$/.test(s)) s = String(Number(s));
  else s = s.toLowerCase();
  if (s === "0" || !DMD_LABEL_RE.test(s)) return null;
  return s;
}

const SUP_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const SUP_CHARS: Record<string, string> = { "⁾": ")", "⁽": "(", "⁺": "+", "⁻": "-", "ⁱ": "i", "ⁿ": "n" };
const SUPERSCRIPT_RE = /[⁰¹²³⁴-⁹⁾]+/g;
const HAS_SUPERSCRIPT_RE = /[⁰¹²³⁴-⁹⁾]/;

/** "¹²⁾" → "12)". Other characters pass through. Pure. */
export function fromSuperscript(s: string): string {
  let out = "";
  for (const ch of s) {
    const d = SUP_DIGITS.indexOf(ch);
    out += d >= 0 ? String(d) : (SUP_CHARS[ch] ?? ch);
  }
  return out;
}

/** "12)" → "¹²⁾" — how an unbound reference stays readable without merging into a number. Pure. */
export function toSuperscript(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") out += SUP_DIGITS[Number(ch)];
    else if (ch === ")") out += "⁾";
    else if (ch === "(") out += "⁽";
    else out += ch;
  }
  return out;
}

/** Split text at runs of Unicode superscript digits: "škody¹² a" → text "škody", sup "¹²", text " a". Pure. */
export function splitSuperscripts(s: string): Array<{ sup: boolean; s: string }> {
  if (!s) return [];
  if (!HAS_SUPERSCRIPT_RE.test(s)) return [{ sup: false, s }];
  const out: Array<{ sup: boolean; s: string }> = [];
  let last = 0;
  for (const m of s.matchAll(SUPERSCRIPT_RE)) {
    if (m.index > last) out.push({ sup: false, s: s.slice(last, m.index) });
    out.push({ sup: true, s: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ sup: false, s: s.slice(last) });
  return out;
}

/**
 * Labels of a superscript run read as footnote references: "12" → ["12"],
 * "1,2" / "1, 3" → ["1","2"] / ["1","3"], "4)" → ["4"], "a" → ["a"];
 * anything else ("2" is fine, but "10⁶", "st", "1–3") → null. Pure.
 */
export function refLabels(sup: string): string[] | null {
  const parts = fromSuperscript(sup).trim().split(/\s*,\s*/);
  if (parts.length > 6) return null;
  const labels: string[] = [];
  for (const p of parts) {
    const label = normalizeLabel(p);
    // Letter labels beyond "aa" are words ("st", "th"), not references.
    if (label === null || /^[a-z]{3,}$/.test(label)) return null;
    labels.push(label);
  }
  return labels.length ? labels : null;
}

// ─────────────────────────────────────────────────────────────── joining lines

const HYPHENS = "-‐‑­";
const LINE_END_HYPHEN_RE = new RegExp(`([\\p{L}\\p{N}]+)[${HYPHENS}]$`, "u");
const TERMINAL_RE = /[.!?:;…]["'“”„‚‘’»)\]]*$/;

/** The line ends a sentence or a clause (".", "!", "?", ":", ";", "…", optionally closed by quotes). Pure. */
export function endsTerminal(s: string): boolean {
  return TERMINAL_RE.test(s.trimEnd());
}

/** First letter of the text (after opening quotes/brackets) is lowercase. Pure. */
export function startsLower(s: string): boolean {
  const m = /^[\s"'“„‚‘«(\[]*(\p{L})/u.exec(s);
  return !!m && m[1] !== m[1].toUpperCase();
}

/** Words written with a hyphen in the middle of a line ("česko-slovenský"): folded "a-b" keys. */
export type HyphenDict = ReadonlySet<string>;

/** Collect folded "left-right" compounds from a line (not its line-end fragment). Pure. */
export function collectHyphenated(text: string, into: Set<string>): void {
  if (!text.includes("-")) return;
  for (const m of text.matchAll(/(\p{L}+)-(\p{L}+)/gu)) into.add(`${foldText(m[1])}-${foldText(m[2])}`);
}

export interface Join {
  /** The left text, possibly with its final hyphen removed. */
  left: string;
  /** "" (the word was joined across the break) or " ". */
  glue: "" | " ";
  /** The right text, possibly with a Czech repeated hyphen removed. */
  right: string;
}

/**
 * Join two consecutive lines of one paragraph. A line ending in a hyphen
 * (-, U+2010, U+2011, soft hyphen) right after a letter or digit is a split
 * word:
 * - soft hyphen: always dropped;
 * - "česko-" + "-slovenský" (Czech repeats the hyphen of a compound on the
 *   next line): one hyphen kept;
 * - next line starts with a digit or an uppercase letter ("COVID-" "19",
 *   "Rakousko-" "Uhersko"), or the left part is a number or an acronym
 *   ("ČR-", "EU-"): hyphen kept, no space;
 * - the compound occurs hyphenated mid-line elsewhere in the document: kept;
 * - otherwise ("povin-" "nosti"): hyphen dropped.
 * Anything else joins with one space (a spaced dash "–" is not a split word;
 * "2019–" + "2020" joins without one). Pure.
 */
export function joinLines(left: string, right: string, dict: HyphenDict): Join {
  const l = left.replace(/\s+$/, "");
  const r = right.replace(/^\s+/, "");
  const m = HYPHENS.includes(l[l.length - 1] ?? " ") ? LINE_END_HYPHEN_RE.exec(l) : null;
  if (m && r.length) {
    const hyphen = l[l.length - 1];
    const stem = l.slice(0, -1);
    if (hyphen === "­") return { left: stem, glue: "", right: r };
    if (/^[-‐‑]\p{L}/u.test(r)) return { left: l, glue: "", right: r.slice(1) };
    const first = /^[\p{L}\p{N}]/u.exec(r)?.[0];
    if (!first) return { left: l, glue: "", right: r };
    const prefix = m[1];
    if (/\p{N}/u.test(first) || first !== first.toLowerCase()) return { left: l, glue: "", right: r };
    if (/\p{N}/u.test(prefix) || (prefix.length >= 2 && prefix === prefix.toUpperCase())) return { left: l, glue: "", right: r };
    const next = /^\p{L}+/u.exec(r)?.[0] ?? "";
    if (dict.has(`${foldText(prefix)}-${foldText(next)}`)) return { left: l, glue: "", right: r };
    return { left: stem, glue: "", right: r };
  }
  if (/\p{N}[–—]$/u.test(l) && /^\p{N}/u.test(r)) return { left: l, glue: "", right: r };
  return { left: l, glue: l.length && r.length ? " " : "", right: r };
}

// ─────────────────────────────────────────────────────────────── numbers

const ROMAN_TABLE: Array<[number, string]> = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

/** 1..3999 → lowercase Roman numeral ("" outside the range). Pure. */
export function toRoman(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n >= 4000) return "";
  let out = "";
  for (const [v, r] of ROMAN_TABLE) while (n >= v) { out += r; n -= v; }
  return out;
}

/** Well-formed Roman numeral (either case) → value, else null. Pure. */
export function fromRoman(s: string): number | null {
  const lower = s.toLowerCase();
  if (!/^[ivxlcdm]{1,12}$/.test(lower)) return null;
  const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let total = 0;
  for (let i = 0; i < lower.length; i++) {
    const v = values[lower[i]];
    const next = i + 1 < lower.length ? values[lower[i + 1]] : 0;
    total += v < next ? -v : v;
  }
  return toRoman(total) === lower ? total : null;
}

// ─────────────────────────────────────────────────────────────── scan check

/**
 * Frequent function words (folded) of the languages users upload — Czech,
 * Slovak, English, German, French, Polish. A real text layer is ~25–45 %
 * stop words; a broken one (wrong font encoding, garbage OCR) is near 0.
 */
const STOPWORDS = new Set(
  (
    "a v ve se na je ze z s o k do to i pro by jako po za od jsou podle nebo ktery ktera ktere take tak jeho jejich ale pri byt bylo byl neni u jak jen jiz uz " +
    "sa aj zo su alebo pre ako " +
    "the of and to in is that for on with as by be this are or it from at an not " +
    "der die das und zu den von mit ist des sich auf fur nicht ein eine dem im " +
    "le la les de des et en un une du que est pour dans par sur au " +
    "w na sie nie jest przez"
  ).split(" "),
);

/** Share of stop words among the word tokens of `text`, and the token count. Pure. */
export function stopwordRatio(text: string): { ratio: number; tokens: number } {
  let tokens = 0;
  let hits = 0;
  for (const m of foldText(text).matchAll(/\p{L}+/gu)) {
    tokens++;
    if (STOPWORDS.has(m[0])) hits++;
  }
  return { ratio: tokens ? hits / tokens : 0, tokens };
}

/** Private-use-area characters — glyphs without a Unicode mapping (a broken text layer). Pure. */
export function privateUseCount(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0xe000 && c <= 0xf8ff) || c >= 0xf0000) n++;
  }
  return n;
}

// ─────────────────────────────────────────────────────────────── misc patterns

/**
 * Header/footer or margin lines that identify the buyer or the download —
 * social-DRM watermarks. They are removed and never kept as hints.
 */
export const WATERMARK_RE =
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}|licen[cč]\p{L}* (?:pro|pouze)|licensed to|zakoupen|staženo|stažen[oa]? (?:uživatel|z )|vytištěn\p{L}* (?:uživatel|pro)|downloaded (?:by|from)|purchased by|pro osobní potřebu|objednávk\p{L}* č/iu;

/** Czech plural of "strana" in the locative ("na 1 straně", "na 2 stranách"). Pure. */
export function pagesLoc(n: number): string {
  return n === 1 ? "1 straně" : `${n} stranách`;
}

/** Czech count phrase: plural(1, "řádek", "řádky", "řádků") → "1 řádek"; 3 → "3 řádky"; 5 → "5 řádků". Pure. */
export function plural(n: number, one: string, few: string, many: string): string {
  return `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
}

/** "s. 3, 5, 12 a další" — at most `max` labels. Pure. */
export function labelList(labels: string[], max = 8): string {
  const shown = labels.slice(0, max).join(", ");
  return labels.length > max ? `${shown} a další` : shown;
}
