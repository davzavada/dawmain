/**
 * The strict DMD parser — the one place that turns the canonical text of an
 * uploaded document into its structure (pages, blocks, sections, footnotes,
 * marginal numbers). The browser runs it for the preview and the price; the
 * server re-runs it on ingest and trusts nothing else the client sent.
 *
 * Contract (grammar in ./types.ts):
 * - input is NORMALIZED DMD (normalizeDmd); offsets are UTF-16 indices into it;
 * - linear time: one pass over the lines, one global regex pass for the
 *   inline tokens (merged with the line walk, never re-scanned), per-label
 *   stacks for footnote binding and an explicit stack for the section tree;
 * - only the safety caps (DMD_LIMITS) throw, as DmdLimitError; a structural
 *   anomaly — a converter bug, a marker-looking string — stays text and is
 *   reported as a DmdProblem, so it can never block an upload.
 *
 * The line grammar and the inline tokens are exported for render.ts and for
 * stripMarkup, so the three readings of the text can never drift apart.
 * Isomorphic and pure — unit-tested (tests/files-dmd-parse.test.ts).
 */

import type { AnchorLabel } from "../types";
import {
  DMD_LIMITS,
  DmdLimitError,
  FOOTNOTE_LABEL_SOURCE,
  PAGE_FLAGS,
  PAGE_LABEL_RE,
  type BlockKind,
  type DmdBlock,
  type DmdFootnote,
  type DmdPage,
  type DmdProblem,
  type DmdRef,
  type DmdSection,
  type ParsedDoc,
  type SectionKind,
} from "./types";

const SPACE = 0x20;
const HASH = 0x23;
const GT = 0x3e;
const PIPE = 0x7c;
const BACKSLASH = 0x5c;
const OPEN = 0x5b;
const CLOSE = 0x5d;

/** Problems kept per document — the stats carry the full counts. */
export const MAX_PROBLEMS = 1_000;
/** References kept per document (a safety cap on memory; reported as maxFootnotes). */
export const MAX_REFS = DMD_LIMITS.maxFootnotes * 2;

// ─────────────────────────────────────────────────────────────── lines

export type LineKind = "blank" | "page" | "heading" | "fndef" | "quote" | "table" | "text";

/** One line of DMD as the grammar reads it, without any document context. */
export interface DmdLine {
  kind: LineKind;
  /** Line span, without the "\n". */
  start: number;
  end: number;
  /** First character after the line's markup prefix ("## ", "[^1]: ", "> ", "[m. č. 3] ", a leading "\"). */
  contentStart: number;
  /** heading: 1–6. */
  level: number;
  /** page: the page label; fndef: the footnote label. */
  label: string | null;
  /** text: the marginal number the line opens with. */
  anchor: string | null;
  /** Starts with 4+ spaces — a footnote definition's continuation when one is open. */
  indented: boolean;
  /** A `#`-line that would be a heading but is longer than DMD_LIMITS.maxHeadingChars (kept as text). */
  headingTooLong: boolean;
}

const FNDEF_RE = new RegExp(String.raw`^\[\^(${FOOTNOTE_LABEL_SOURCE})\]:(?: |$)`);
const MN_RE = /^\[m\. č\. (\d{1,4}[a-z]?)\](?: |$)/;
/** Longest possible page-marker line: "[s. " + 12-char label + "]". */
const MAX_PAGE_LINE = 17;

/**
 * Classify the line text[start, end) — `end` is the index of its "\n" (or
 * the text end). Context-free: whether a page line really starts a page
 * (paged documents only) and whether an indented line continues a footnote
 * are decided by the caller. Pure.
 */
export function classifyLine(text: string, start: number, end: number): DmdLine {
  const line: DmdLine = {
    kind: "text",
    start,
    end,
    contentStart: start,
    level: 0,
    label: null,
    anchor: null,
    indented: false,
    headingTooLong: false,
  };
  let i = start;
  while (i < end && text.charCodeAt(i) === SPACE) i++;
  if (i === end) {
    line.kind = "blank";
    return line;
  }
  if (i > start) {
    // Leading spaces: never markup, but 4+ of them may continue a footnote.
    line.indented = i - start >= 4;
    return line;
  }
  switch (text.charCodeAt(start)) {
    case OPEN: {
      if (text.startsWith("[s. ", start)) {
        if (end - start <= MAX_PAGE_LINE && text.charCodeAt(end - 1) === CLOSE) {
          const label = text.slice(start + 4, end - 1);
          if (PAGE_LABEL_RE.test(label)) {
            line.kind = "page";
            line.label = label;
            line.contentStart = end;
          }
        }
      } else if (text.startsWith("[^", start)) {
        const m = FNDEF_RE.exec(text.slice(start, Math.min(end, start + 10)));
        if (m) {
          line.kind = "fndef";
          line.label = m[1];
          line.contentStart = start + m[0].length;
        }
      } else if (text.startsWith("[m. č. ", start)) {
        const m = MN_RE.exec(text.slice(start, Math.min(end, start + 16)));
        if (m) {
          line.anchor = m[1];
          line.contentStart = start + m[0].length;
        }
      }
      return line;
    }
    case HASH: {
      let k = start;
      while (k < end && k - start < 7 && text.charCodeAt(k) === HASH) k++;
      const level = k - start;
      if (level <= 6 && k < end && text.charCodeAt(k) === SPACE) {
        const content = text.slice(k + 1, end).trim();
        if (content.length > DMD_LIMITS.maxHeadingChars) line.headingTooLong = true;
        else if (content.length > 0) {
          line.kind = "heading";
          line.level = level;
          line.contentStart = k + 1;
        }
      }
      return line;
    }
    case GT:
      if (end === start + 1 || text.charCodeAt(start + 1) === SPACE) {
        line.kind = "quote";
        line.contentStart = Math.min(end, start + 2);
      }
      return line;
    case PIPE:
      line.kind = "table";
      return line;
    case BACKSLASH: {
      // A leading `\#`, `\>`, `\|` is text; the backslash is the escape.
      const next = start + 1 < end ? text.charCodeAt(start + 1) : -1;
      if (next === HASH || next === GT || next === PIPE) line.contentStart = start + 1;
      return line;
    }
  }
  return line;
}

// ─────────────────────────────────────────────────────────────── inline tokens

/**
 * Every inline construct, in one alternation so a single global scan finds
 * them in order: an escape (`\[s. `, `\[^`, `\[m. č. ` — consumed whole so
 * the escaped bracket can never start a token), a footnote reference, a
 * page-marker-looking bracket (validated later: label and word boundaries),
 * and a marginal-number-looking bracket (markup only as a line prefix).
 * No alternative can match "\n", so a token never spans lines.
 */
const INLINE_SOURCE = String.raw`\\\[(?:s\. |\^|m\. č\. )|\[\^(${FOOTNOTE_LABEL_SOURCE})\]|\[s\. ([^\[\]\n]{1,30})\]|\[m\. č\. (\d{1,4}[a-z]?)\]`;

/**
 * Inline tokens of a text, handed out line by line in increasing order.
 * The regex runs once over the whole text (lazily), so asking for the
 * tokens of every line is linear overall — a per-line `exec` from the line
 * start would rescan the gap to the next token for each line.
 */
export class InlineCursor {
  private readonly re = new RegExp(INLINE_SOURCE, "g");
  private match: RegExpExecArray | null;

  constructor(private readonly text: string) {
    this.match = this.re.exec(text);
  }

  /** Tokens starting in [from, to). Tokens before `from` are dropped for good. */
  take(from: number, to: number): RegExpExecArray[] {
    const out: RegExpExecArray[] = [];
    while (this.match && this.match.index < from) this.match = this.re.exec(this.text);
    while (this.match && this.match.index < to) {
      out.push(this.match);
      this.match = this.re.exec(this.text);
    }
    return out;
  }
}

export type InlineToken =
  | { kind: "escape"; at: number }
  | { kind: "ref"; at: number; end: number; label: string }
  | { kind: "page"; at: number; end: number; label: string }
  | { kind: "text"; at: number; problem: "bad_page_label" | "escaped_marker" | null };

/**
 * What one inline match means on its line. Page markers are markup only in
 * a paged document, outside headings, with a valid label and bounded by a
 * space (or the line edge) on both sides; a mid-line `[m. č. N]` is text.
 * Pure.
 */
export function readInline(text: string, m: RegExpExecArray, line: DmdLine, paged: boolean): InlineToken {
  const at = m.index;
  if (text.charCodeAt(at) === BACKSLASH) return { kind: "escape", at };
  const end = at + m[0].length;
  if (m[1] !== undefined) return { kind: "ref", at, end, label: m[1] };
  if (m[2] !== undefined) {
    if (!paged || line.kind === "heading") return { kind: "text", at, problem: null };
    if (!PAGE_LABEL_RE.test(m[2])) return { kind: "text", at, problem: "bad_page_label" };
    const before = at === line.start || text.charCodeAt(at - 1) === SPACE;
    const after = end === line.end || text.charCodeAt(end) === SPACE;
    if (!before || !after) return { kind: "text", at, problem: "escaped_marker" };
    return { kind: "page", at, end, label: m[2] };
  }
  return { kind: "text", at, problem: "escaped_marker" };
}

/**
 * The markup span of an inline page marker: the token plus ONE of the
 * spaces around it (the following one, else the preceding one when that
 * one is still unconsumed — `cursor` is where the previous strip ended), so
 * "povinnost [s. 246] škody" projects to "povinnost škody". Pure.
 */
export function pageMarkerSpan(text: string, at: number, end: number, line: DmdLine, cursor: number): [number, number] {
  if (end < line.end && text.charCodeAt(end) === SPACE) return [at, end + 1];
  if (at - 1 >= Math.max(cursor, line.start) && text.charCodeAt(at - 1) === SPACE) return [at - 1, end];
  return [at, end];
}

// ─────────────────────────────────────────────────────────────── helpers

/** Lowercase, diacritics removed — for matching heading words. Pure. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const ESCAPE_ANYWHERE_RE = /\\(?=\[(?:s\. |\^|m\. č\. ))/g;
const ESCAPE_LEADING_RE = /(^|\n)\\(?=[#>|])/g;

/** Remove DMD escape backslashes (for rendering inside the fence). Pure. */
export function unescapeDmd(s: string): string {
  return s.replace(ESCAPE_ANYWHERE_RE, "").replace(ESCAPE_LEADING_RE, "$1");
}

// No lookbehind: the parser also runs in older browsers (Safari < 16.4).
const REF_IN_TEXT_RE = new RegExp(String.raw`(\\)?\s?\[\^(?:${FOOTNOTE_LABEL_SOURCE})\]`, "g");

/** Heading text for display: refs dropped (escaped ones kept), escapes removed, one line. */
function cleanHeading(raw: string): string {
  const withoutRefs = raw.replace(REF_IN_TEXT_RE, (match, escape: string | undefined) => (escape ? match : ""));
  return unescapeDmd(withoutRefs).replace(/\s+/g, " ").trim();
}

const ROMAN_RE = /^[ivxlcdm]{1,8}$/i;
const ROMAN_VALUES: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

/** Value of a Roman numeral, null when it is not a well-formed one ("IIII", "IC"). Pure. */
export function romanValue(s: string): number | null {
  const lower = s.toLowerCase();
  if (!ROMAN_RE.test(lower)) return null;
  let total = 0;
  for (let i = 0; i < lower.length; i++) {
    const v = ROMAN_VALUES[lower[i]];
    const next = i + 1 < lower.length ? ROMAN_VALUES[lower[i + 1]] : 0;
    total += v < next ? -v : v;
  }
  return toRoman(total) === lower ? total : null;
}

function toRoman(n: number): string {
  if (n <= 0 || n >= 4000) return "";
  const table: Array<[number, string]> = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  for (const [v, r] of table) while (n >= v) { out += r; n -= v; }
  return out;
}

/** Sort number of "2913" / "2913a" / "III": the letter suffix adds 0.01 per step (a = .01, z = .26). */
function designatorNum(num: string, suffix: string): number {
  let ord = 0;
  for (const ch of suffix.toLowerCase()) ord = ord * 27 + (ch.charCodeAt(0) - 96);
  return Number(num) + Math.min(ord, 99) / 100;
}

// ─────────────────────────────────────────────────────────────── section keys

const PART_WORDS = new Set(["cast", "hlava", "dil", "oddil", "pododdil"]);
const ORDINAL_WORDS = new Set([
  "prvni", "druha", "druhy", "treti", "ctvrta", "ctvrty", "pata", "paty", "sesta", "sesty", "sedma", "sedmy",
  "osma", "osmy", "devata", "devaty", "desata", "desaty", "jedenacta", "dvanacta", "trinacta", "ctrnacta",
  "patnacta", "sestnacta", "sedmnacta", "osmnacta", "devatenacta", "dvacata", "obecna", "zvlastni",
  "spolecna", "zaverecna", "uvodni", "prechodna",
]);

const TOC_RE = /^(?:podrobny |strucny )?obsah(?: (?:knihy|svazku|dila|publikace|komentare))?$/;
const INDEX_RE = /^(?:vecny |jmenny |pojmovy |heslovy )?rejstrik(?: (?:judikatury|pojmu|predpisu|autoru|rozhodnuti|hesel))?$/;
const ABBREV_RE = /^(?:(?:seznam|prehled) (?:pouzitych )?zkratek|(?:pouzite )?zkratky)$/;
const BIBLIO_RE =
  /^(?:(?:seznam )?(?:pouzite |doporucene |vybrane |zakladni )?literatury|(?:pouzita |doporucena |vybrana |zakladni )?literatura|bibliografie|vyber (?:z )?literatury|prameny a literatura|literatura a prameny|pouzite prameny)$/;
const ANNEX_RE = /^priloh[ay](?![\p{L}\d])/u;
const FRONT_RE = /^(?:predmluva(?![\p{L}\d]).*|uvod k .*vydani|uvodem|slovo (?:uvodem|autora|autoru)|o autorech|autorsky kolektiv|seznam autoru)$/u;

/** "Č Á S T  P R V N Í" → "ČÁST PRVNÍ": runs of ≥ 3 single letters separated by single spaces. */
function collapseLetterSpacing(s: string): { text: string; collapsed: boolean } {
  let collapsed = false;
  const text = s
    .split(/\s{2,}/)
    .map((chunk) => {
      if (/^\S(?: \S){2,}$/u.test(chunk)) {
        collapsed = true;
        return chunk.replace(/ /g, "");
      }
      return chunk;
    })
    .join(" ");
  return { text, collapsed };
}

function isDesignator(foldedWord: string): boolean {
  const w = foldedWord.replace(/\.$/, "");
  return /^\d{1,3}[a-z]?$/.test(w) || romanValue(w) !== null || ORDINAL_WORDS.has(w);
}

/**
 * Heading text → section kind and key:
 * "§ 2913 [Porušení…]" → par "par:2913" 2913; "§ 2913a" → "par:2913a" 2913.01;
 * "Čl. III" / "Článek 3" → cl "cl:III" / "cl:3" (keyNum 3); ČÁST / HLAVA /
 * DÍL / ODDÍL / Pododdíl → part "part:hlava-iii"; "Kapitola 3" → chapter
 * "ch:3"; Obsah → toc, (Věcný) rejstřík → index, Seznam zkratek → abbrev,
 * Literatura & co. → biblio, Příloha → annex, Předmluva / Úvod k … vydání →
 * front; any other level-1 heading → chapter, else sub. Letter-spaced
 * headings ("Č Á S T") are collapsed first. Pure.
 */
export function sectionKeyOf(heading: string, level: number): { kind: SectionKind; key: string | null; keyNum: number | null } {
  const { text, collapsed } = collapseLetterSpacing(cleanHeading(heading));
  const folded = fold(text).replace(/[\s:.]+$/, "");

  const par = /^§§?\s*(\d{1,4})([a-z]{0,2})(?![\p{L}\d])/iu.exec(text);
  if (par) {
    const suffix = par[2].toLowerCase();
    return { kind: "par", key: `par:${par[1]}${suffix}`, keyNum: designatorNum(par[1], suffix) };
  }

  const cl = /^(?:čl\.|cl\.|článek|clanek)\s*(\d{1,3})([a-z]{0,2})(?![\p{L}\d])|^(?:čl\.|cl\.|článek|clanek)\s*([ivxlcdm]{1,8})(?![\p{L}\d])/iu.exec(text);
  if (cl) {
    if (cl[1] !== undefined) {
      const suffix = cl[2].toLowerCase();
      return { kind: "cl", key: `cl:${cl[1]}${suffix}`, keyNum: designatorNum(cl[1], suffix) };
    }
    const value = romanValue(cl[3]);
    if (value !== null) return { kind: "cl", key: `cl:${cl[3].toUpperCase()}`, keyNum: value };
  }

  const words = folded.split(/\s+/);
  let first = words[0] ?? "";
  let second = words[1] ?? "";
  if (collapsed && !PART_WORDS.has(first) && first !== "kapitola") {
    // "ČÁSTPRVNÍ" — a heading letter-spaced with single spaces only.
    const glued = /^(pododdil|cast|hlava|dil|oddil|kapitola)(.+)$/.exec(first);
    if (glued && isDesignator(glued[2])) [first, second] = [glued[1], glued[2]];
  }
  if (PART_WORDS.has(first)) {
    const designator = second && isDesignator(second) ? second.replace(/\.$/, "") : "";
    return { kind: "part", key: designator ? `part:${first}-${designator}` : `part:${first}`, keyNum: null };
  }
  if (first === "kapitola" && second && isDesignator(second) && !ORDINAL_WORDS.has(second.replace(/\.$/, ""))) {
    return { kind: "chapter", key: `ch:${chapterKey(second)}`, keyNum: null };
  }
  const numbered = /^(\d{1,3})\.?\s+kapitola$/.exec(`${first} ${second}`.trim());
  if (numbered) return { kind: "chapter", key: `ch:${numbered[1]}`, keyNum: null };

  if (TOC_RE.test(folded)) return { kind: "toc", key: null, keyNum: null };
  if (INDEX_RE.test(folded)) return { kind: "index", key: null, keyNum: null };
  if (ABBREV_RE.test(folded)) return { kind: "abbrev", key: null, keyNum: null };
  if (BIBLIO_RE.test(folded)) return { kind: "biblio", key: null, keyNum: null };
  if (ANNEX_RE.test(folded)) return { kind: "annex", key: null, keyNum: null };
  if (FRONT_RE.test(folded)) return { kind: "front", key: null, keyNum: null };
  return { kind: level <= 1 ? "chapter" : "sub", key: null, keyNum: null };
}

function chapterKey(foldedDesignator: string): string {
  const w = foldedDesignator.replace(/\.$/, "");
  return romanValue(w) !== null ? w.toUpperCase() : w;
}

// ─────────────────────────────────────────────────────────────── stripMarkup

/**
 * Projection of `text` without markup: page-marker lines and inline markers
 * (with one adjacent space), `[^n]` references, the `[m. č. N] ` prefix,
 * the `[^n]: ` definition prefix, the `#…# ` and `> ` prefixes and the
 * escape backslashes. `map[i]` is the offset in `text` of projected char i
 * (strictly increasing; the length equals the projected text's). Map a
 * projected match [s, e) back with { start: map[s], end: map[e - 1] + 1 }.
 * Context-free (every page marker counts, as in a paged document) so it
 * works on any slice that starts at a line start. Pure.
 */
export function stripMarkup(text: string): { text: string; map: Int32Array } {
  const spans: number[] = [];
  let total = 0;
  const keep = (a: number, b: number) => {
    if (b <= a) return;
    total += b - a;
    if (spans.length && spans[spans.length - 1] === a) spans[spans.length - 1] = b;
    else spans.push(a, b);
  };
  const cursor = new InlineCursor(text);
  const n = text.length;
  let s = 0;
  while (s <= n) {
    let e = text.indexOf("\n", s);
    if (e === -1) e = n;
    const line = classifyLine(text, s, e);
    if (line.kind !== "page") {
      let c = line.contentStart;
      if (line.kind !== "blank") {
        for (const m of cursor.take(line.contentStart, e)) {
          const tok = readInline(text, m, line, true);
          if (tok.kind === "escape") {
            keep(c, tok.at);
            c = tok.at + 1;
          } else if (tok.kind === "ref") {
            keep(c, tok.at);
            c = tok.end;
          } else if (tok.kind === "page") {
            const [a, b] = pageMarkerSpan(text, tok.at, tok.end, line, c);
            keep(c, a);
            c = b;
          }
        }
      } else c = s;
      keep(c, e);
    }
    if (e < n) keep(e, e + 1);
    s = e + 1;
  }
  const map = new Int32Array(total);
  const parts: string[] = [];
  let k = 0;
  for (let i = 0; i < spans.length; i += 2) {
    const a = spans[i];
    const b = spans[i + 1];
    parts.push(text.slice(a, b));
    for (let j = a; j < b; j++) map[k++] = j;
  }
  return { text: parts.join(""), map };
}

// ─────────────────────────────────────────────────────────────── parser

const AUTHOR_RE = /^(?:Zpracoval[ai]?|Zpracovaly|Autor(?:ka)?|Autoři|Autor oddílu)\s*:\s*(\S[^\n]{1,150})$/u;

/**
 * Parse normalized DMD. Throws DmdLimitError on a safety-cap violation;
 * every structural anomaly becomes text plus a DmdProblem.
 * - Paged document: its first non-blank line is a page marker; every marker
 *   line then starts a DmdPage, and so does an inline ` [s. N] `. Unpaged
 *   documents have pages = [] and page 0 everywhere.
 * - Footnotes: a definition binds to the nearest earlier unbound reference
 *   with the same label, so numbering that restarts per page or chapter
 *   binds correctly; an unbound definition is dangling (refAt null, page and
 *   section of the definition).
 * - Sections: each heading opens one, closed by the next heading of level ≤
 *   its own; a section ends with its last content block (page-marker lines
 *   before the next heading are not part of it). § keys must not decrease
 *   among siblings ('par_not_monotonic'); sections inside toc/index are not
 *   indexed.
 * - Marginal numbers: `[m. č. N] ` at a paragraph start; within the nearest
 *   § / čl. section (else the top-level section, else the document) they
 *   must increase ('mn_sequence', the anchor is still recorded).
 */
export function parseDmd(text: string, opts: { anchorLabel?: AnchorLabel | null } = {}): ParsedDoc {
  if (text.length > DMD_LIMITS.maxChars) {
    throw new DmdLimitError("maxChars", `Dokument má ${text.length} znaků, nejvýše lze ${DMD_LIMITS.maxChars}.`);
  }
  return new Parser(text).run(opts.anchorLabel ?? null);
}

class Parser {
  private readonly n: number;
  private readonly cursor: InlineCursor;
  private paged = false;

  private readonly pages: DmdPage[] = [];
  private readonly pageHasText: boolean[] = [false];
  private readonly pageLabels = new Set<string>();
  private curPage = 0;

  private readonly blocks: DmdBlock[] = [];
  private cur: DmdBlock | null = null;
  private sawBlank = false;

  private readonly sections: DmdSection[] = [];
  private readonly stack: number[] = [];
  private readonly lastParNum = new Map<number, number>();
  private awaitAuthor = -1;
  private lastContentEnd = 0;
  private lastContentPage = 0;

  private readonly footnotes: DmdFootnote[] = [];
  private curDef: DmdFootnote | null = null;
  private readonly refs: DmdRef[] = [];
  private readonly refPage: number[] = [];
  private readonly refSection: number[] = [];
  private readonly refAnchor: Array<string | null> = [];
  private readonly unbound = new Map<string, number[]>();

  private effAnchor: string | null = null;
  private readonly lastMn = new Map<number, number>();
  private marginalNumbers = 0;

  private markup = 0;
  private readonly problems: DmdProblem[] = [];

  constructor(private readonly text: string) {
    this.n = text.length;
    this.cursor = new InlineCursor(text);
  }

  run(anchorLabel: AnchorLabel | null): ParsedDoc {
    const { text, n } = this;
    this.paged = this.detectPaged();
    let s = 0;
    while (s <= n) {
      let e = text.indexOf("\n", s);
      if (e === -1) e = n;
      if (e - s > DMD_LIMITS.maxLineChars) {
        throw new DmdLimitError("maxLineChars", `Řádek na pozici ${s} má ${e - s} znaků, nejvýše lze ${DMD_LIMITS.maxLineChars}.`);
      }
      this.line(classifyLine(text, s, e));
      s = e + 1;
    }
    return this.finish(anchorLabel);
  }

  private detectPaged(): boolean {
    let s = 0;
    while (s <= this.n) {
      let e = this.text.indexOf("\n", s);
      if (e === -1) e = this.n;
      const line = classifyLine(this.text, s, e);
      if (line.kind !== "blank") return line.kind === "page";
      s = e + 1;
    }
    return false;
  }

  private problem(code: DmdProblem["code"], at: number, detail?: string): void {
    if (this.problems.length >= MAX_PROBLEMS) return;
    this.problems.push(detail === undefined ? { code, at } : { code, at, detail });
  }

  private get section(): number {
    return this.stack.length ? this.stack[this.stack.length - 1] : -1;
  }

  // ── line dispatch

  private line(line: DmdLine): void {
    if (line.kind === "blank") {
      this.sawBlank = true;
      return;
    }
    const afterBlank = this.sawBlank;
    this.sawBlank = false;

    if (line.kind === "page") {
      if (this.paged) {
        this.curDef = null;
        return this.pageLine(line);
      }
      this.problem("unpaged_start", line.start, line.label ?? undefined);
      line = { ...line, kind: "text", contentStart: line.start, label: null };
    }
    if (line.kind === "text" && line.indented && this.curDef) return this.defContinuation(line);
    this.curDef = null;
    if (line.headingTooLong) this.problem("heading_too_long", line.start);

    switch (line.kind) {
      case "heading":
        return this.heading(line);
      case "fndef":
        return this.definition(line);
      case "quote":
        return this.content(line, "quote", afterBlank);
      case "table":
        return this.content(line, "table", afterBlank);
      default:
        return this.content(line, "para", afterBlank);
    }
  }

  private openBlock(kind: BlockKind, line: DmdLine, extra: Partial<DmdBlock> = {}): DmdBlock {
    const block: DmdBlock = { kind, start: line.start, end: line.end, page: this.curPage, section: this.section, ...extra };
    this.blocks.push(block);
    this.cur = block;
    return block;
  }

  private touch(line: DmdLine): void {
    if (this.cur) this.cur.end = line.end;
    this.lastContentEnd = line.end;
    this.pageHasText[this.curPage] = true;
  }

  // ── pages

  private newPage(label: string, at: number): void {
    if (this.pages.length >= DMD_LIMITS.maxPages) {
      throw new DmdLimitError("maxPages", `Dokument má víc než ${DMD_LIMITS.maxPages} stran.`);
    }
    if (this.pages.length) this.pages[this.pages.length - 1].end = at;
    const ord = this.pages.length + 1;
    this.pages.push({ ord, label, start: at, end: this.n, flags: 0 });
    this.pageHasText.push(false);
    if (this.pageLabels.has(label)) this.problem("duplicate_page_label", at, label);
    else this.pageLabels.add(label);
    this.curPage = ord;
  }

  private pageLine(line: DmdLine): void {
    this.cur = null;
    this.markup += line.end - line.start;
    this.newPage(line.label!, line.start);
    this.blocks.push({ kind: "page", start: line.start, end: line.end, page: this.curPage, section: this.section });
  }

  // ── headings and sections

  private heading(line: DmdLine): void {
    this.cur = null;
    if (this.sections.length >= DMD_LIMITS.maxHeadings) {
      throw new DmdLimitError("maxHeadings", `Dokument má víc než ${DMD_LIMITS.maxHeadings} nadpisů.`);
    }
    const level = line.level;
    while (this.stack.length && this.sections[this.stack[this.stack.length - 1]].level >= level) {
      this.closeSection(this.stack.pop()!);
    }
    const parent = this.stack.length ? this.stack[this.stack.length - 1] : null;
    const heading = cleanHeading(this.text.slice(line.contentStart, line.end));
    const { kind, key, keyNum } = sectionKeyOf(heading, level);
    const indexed = kind !== "toc" && kind !== "index" && (parent === null || this.sections[parent].indexed);
    const ord = this.sections.length;

    if (kind === "par" && keyNum !== null && indexed) {
      const siblingsOf = parent ?? -1;
      const last = this.lastParNum.get(siblingsOf);
      if (last !== undefined && keyNum < last) this.problem("par_not_monotonic", line.start, key ?? undefined);
      this.lastParNum.set(siblingsOf, keyNum);
    }

    this.sections.push({
      ord,
      parent,
      level,
      kind,
      key,
      keyNum,
      heading,
      author: null,
      start: line.start,
      end: line.end,
      pageFrom: this.curPage,
      pageTo: this.curPage,
      indexed,
    });
    this.stack.push(ord);
    this.markup += line.contentStart - line.start;
    this.openBlock("heading", line, { level, section: ord });
    this.cur = null; // a heading is always a block of its own
    this.effAnchor = null;
    this.awaitAuthor = ord;
    this.touch(line);
    this.lastContentPage = this.curPage;
    this.inline(line);
  }

  private closeSection(idx: number): void {
    const section = this.sections[idx];
    section.end = Math.max(section.start, this.lastContentEnd);
    section.pageTo = Math.max(section.pageFrom, this.lastContentPage);
  }

  /** Nearest § / čl. section, else the top-level one, else -1 (the whole document). */
  private mnScope(): number {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const kind = this.sections[this.stack[i]].kind;
      if (kind === "par" || kind === "cl") return this.stack[i];
    }
    return this.stack.length ? this.stack[0] : -1;
  }

  // ── content blocks

  private content(line: DmdLine, kind: BlockKind, afterBlank: boolean): void {
    const continues = !afterBlank && this.cur?.kind === kind && !(kind === "para" && line.anchor !== null);
    if (!continues) {
      const block = this.openBlock(kind, line);
      if (line.anchor !== null) this.marginalNumber(line, block);
      if (this.awaitAuthor >= 0) {
        const author = kind === "para" && line.anchor === null ? AUTHOR_RE.exec(this.text.slice(line.start, line.end)) : null;
        if (author) this.sections[this.awaitAuthor].author = author[1].replace(/\s+/g, " ").replace(/[.;,]+$/, "").trim();
        this.awaitAuthor = -1;
      }
    }
    this.markup += line.contentStart - line.start;
    this.touch(line);
    this.inline(line);
    this.lastContentPage = this.curPage;
  }

  private marginalNumber(line: DmdLine, block: DmdBlock): void {
    const anchor = line.anchor!;
    block.anchor = anchor;
    this.effAnchor = anchor;
    this.marginalNumbers++;
    const m = /^(\d+)([a-z]?)$/.exec(anchor)!;
    const value = designatorNum(m[1], m[2]);
    const scope = this.mnScope();
    const last = this.lastMn.get(scope);
    if (last !== undefined && value <= last) this.problem("mn_sequence", line.start, anchor);
    this.lastMn.set(scope, value);
  }

  // ── footnotes

  private definition(line: DmdLine): void {
    if (this.footnotes.length >= DMD_LIMITS.maxFootnotes) {
      throw new DmdLimitError("maxFootnotes", `Dokument má víc než ${DMD_LIMITS.maxFootnotes} poznámek.`);
    }
    // Consecutive definitions form one block, also across blank lines.
    if (this.cur?.kind !== "fndefs") this.openBlock("fndefs", line);
    const label = line.label!;
    const refIdx = this.unbound.get(label)?.pop();
    const seq = this.footnotes.length + 1;
    const bound = refIdx !== undefined;
    const fn: DmdFootnote = {
      seq,
      label,
      kind: "f",
      refAt: bound ? this.refs[refIdx].at : null,
      defStart: line.contentStart,
      defEnd: line.end,
      page: bound ? this.refPage[refIdx] : this.curPage,
      section: bound ? this.refSection[refIdx] : this.section,
      anchor: bound ? this.refAnchor[refIdx] : null,
    };
    if (bound) this.refs[refIdx].footnote = seq;
    this.footnotes.push(fn);
    this.curDef = fn;
    this.checkDefLength(fn);
    this.markup += line.contentStart - line.start;
    this.touch(line);
    this.inline(line);
    this.lastContentPage = this.curPage;
  }

  private defContinuation(line: DmdLine): void {
    const fn = this.curDef!;
    fn.defEnd = line.end;
    this.checkDefLength(fn);
    this.touch(line);
    this.inline(line);
    this.lastContentPage = this.curPage;
  }

  private checkDefLength(fn: DmdFootnote): void {
    if (fn.defEnd - fn.defStart > DMD_LIMITS.maxFootnoteChars) {
      throw new DmdLimitError(
        "maxFootnoteChars",
        `Poznámka ${fn.label} (pozice ${fn.defStart}) má víc než ${DMD_LIMITS.maxFootnoteChars} znaků.`,
      );
    }
  }

  // ── inline tokens

  private inline(line: DmdLine): void {
    let stripCursor = line.contentStart;
    for (const m of this.cursor.take(line.contentStart, line.end)) {
      const tok = readInline(this.text, m, line, this.paged);
      switch (tok.kind) {
        case "escape":
          this.markup += 1;
          stripCursor = tok.at + 1;
          break;
        case "ref":
          this.ref(tok.label, tok.at);
          this.markup += tok.end - tok.at;
          stripCursor = tok.end;
          break;
        case "page": {
          const [a, b] = pageMarkerSpan(this.text, tok.at, tok.end, line, stripCursor);
          this.markup += b - a;
          stripCursor = b;
          this.newPage(tok.label, tok.at);
          if (/\S/.test(this.text.slice(b, line.end))) this.pageHasText[this.curPage] = true;
          break;
        }
        case "text":
          if (tok.problem) this.problem(tok.problem, tok.at, m[0]);
          break;
      }
    }
  }

  private ref(label: string, at: number): void {
    if (this.refs.length >= MAX_REFS) {
      throw new DmdLimitError("maxFootnotes", `Dokument má víc než ${MAX_REFS} odkazů na poznámky.`);
    }
    const idx = this.refs.length;
    this.refs.push({ label, at, footnote: null });
    this.refPage.push(this.curPage);
    this.refSection.push(this.section);
    this.refAnchor.push(this.effAnchor);
    const stack = this.unbound.get(label);
    if (stack) stack.push(idx);
    else this.unbound.set(label, [idx]);
  }

  // ── result

  private finish(anchorLabel: AnchorLabel | null): ParsedDoc {
    while (this.stack.length) this.closeSection(this.stack.pop()!);

    // A page-marker line after a section's last content lies outside it:
    // attribute it to the nearest enclosing section that still contains it.
    for (const block of this.blocks) {
      if (block.kind !== "page") continue;
      let idx = block.section;
      while (idx >= 0 && block.start >= this.sections[idx].end) idx = this.sections[idx].parent ?? -1;
      block.section = idx;
    }

    for (const page of this.pages) if (!this.pageHasText[page.ord]) page.flags |= PAGE_FLAGS.BLANK;

    // Endnotes (DOCX: i, ii, iii…) — letter labels are endnotes when every
    // letter label in the document is a Roman numeral.
    const letters = this.footnotes.filter((fn) => /^[a-z]+$/.test(fn.label));
    if (letters.length && letters.every((fn) => romanValue(fn.label) !== null)) {
      for (const fn of letters) fn.kind = "e";
    }

    let danglingRefs = 0;
    for (const ref of this.refs) {
      if (ref.footnote !== null) continue;
      danglingRefs++;
      this.problem("dangling_ref", ref.at, ref.label);
    }
    let danglingDefs = 0;
    for (const fn of this.footnotes) {
      if (fn.refAt !== null) continue;
      danglingDefs++;
      this.problem("dangling_def", fn.defStart, fn.label);
    }

    return {
      text: this.text,
      paged: this.paged,
      pages: this.pages,
      blocks: this.blocks,
      sections: this.sections,
      footnotes: this.footnotes,
      refs: this.refs,
      anchorLabel: anchorLabel ?? (this.marginalNumbers > 0 ? "m. č." : null),
      stats: {
        chars: this.n,
        countedChars: this.n - this.markup,
        physicalPages: this.pages.length,
        headings: this.sections.length,
        footnotes: this.footnotes.length,
        danglingRefs,
        danglingDefs,
        marginalNumbers: this.marginalNumbers,
      },
      problems: this.problems,
    };
  }
}
