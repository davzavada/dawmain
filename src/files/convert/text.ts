/**
 * TXT / Markdown → DMD, plus the DMD-writing helpers every converter shares
 * (escaping text that imitates markup, template placeholders, footnote
 * definitions, line-length safety). Isomorphic and pure — no DOM, no I/O —
 * unit-tested in tests/files-convert-text.test.ts.
 *
 * What survives from the source (grammar in src/files/dmd/types.ts):
 * - Markdown: ATX and setext headings, `> ` quotations and `|` table rows
 *   (DMD reads them the same way); everything else is text.
 * - TXT: everything is text — a line that happens to start with "#", ">" or
 *   "|" is escaped, never promoted.
 * - Both: pandoc-style footnotes. `[^x]` references and `[^x]: …`
 *   definitions (anywhere in the file, with indented or lazy continuation
 *   lines) become DMD notes numbered 1..n in order of first reference, the
 *   definition moved right after the block that cites it. A reference
 *   without a definition, and a definition nobody cites, stay visible as
 *   escaped text: text is never dropped.
 */

import { DMD_LIMITS } from "../dmd/types";
import { normalizeDmd } from "../dmd/normalize";
import type { ConversionQuality } from "../types";
import type { ConvertResult } from "./types";

// ─────────────────────────────────────────────────────────── shared DMD writing

/** Inline strings the DMD grammar reads as markup anywhere in a line. */
const INLINE_MARKER_RE = /\[(?=s\. |\^|m\. č\. )/g;
/** Characters that are markup at the start of a line. */
const LEADING_MARKER_RE = /^[#>|]/;

/**
 * Escape inline text that imitates DMD markup: `[s. `, `[^` and `[m. č. `
 * get a backslash (unescapeDmd removes it for display), so a document can
 * never forge a page break, a footnote or a marginal number. Pure.
 */
export function escapeInline(text: string): string {
  return text.replace(INLINE_MARKER_RE, "\\[");
}

/** Escape a line that starts with `#`, `>` or `|` (heading, quote, table row). Pure. */
export function escapeLineStart(line: string): string {
  return LEADING_MARKER_RE.test(line) ? `\\${line}` : line;
}

/** Both escapes — for one line of plain text. Pure. */
export function escapeTextLine(line: string): string {
  return escapeLineStart(escapeInline(line));
}

/**
 * Fill-in lines of templates (vzory): runs of 4+ underscores, 5+ dots or
 * ellipses (optionally spaced ". . . . ."), 2+ ellipsis characters and
 * the 3+ en spaces Word shows for an empty FORMTEXT field.
 */
const FILL_RE = /_{4,}|(?:[.…](?:[  ](?=[.…]))?){5,}|…{2,}| {3,}/g;
export const FILL_PLACEHOLDER = "[____]";

/**
 * Normalize template placeholders in raw text (before escaping): fill lines
 * → `[____]`, "☑" → "☒"; `[●]`, "☐" and "☒" are kept as they are. Also
 * turns Word's non-breaking hyphen (U+2011) into "-" so words stay
 * searchable. Returns the text and how many placeholders it now holds. Pure.
 */
export function normalizePlaceholders(text: string): { text: string; count: number } {
  const out = text.replace(FILL_RE, FILL_PLACEHOLDER).replace(/☑/g, "☒").replace(/‑/g, "-");
  return { text: out, count: countPlaceholders(out) };
}

const PLACEHOLDER_COUNT_RE = /\[____\]|\[●\]|[☐☒]/g;

/** `[____]`, `[●]`, `☐`, `☒` occurrences. Pure. */
export function countPlaceholders(text: string): number {
  return text.match(PLACEHOLDER_COUNT_RE)?.length ?? 0;
}

/** Longest line a converter writes — well under DMD_LIMITS.maxLineChars (30k). */
export const MAX_LINE_CHARS = 20_000;

/**
 * Split an over-long line into lines of ≤ `max` chars, at the last space
 * before the limit (else a hard cut that never splits a surrogate pair).
 * DMD continues a paragraph over consecutive lines, so the block survives;
 * the parser would otherwise reject the whole document. Pure.
 */
export function wrapLongLine(line: string, max = MAX_LINE_CHARS): string[] {
  if (line.length <= max) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) {
      cut = max;
      // Never cut through an escape or a `[^12]` token near the limit…
      const near = rest.slice(cut - 12, cut);
      const k = Math.max(near.lastIndexOf("["), near.lastIndexOf("\\"));
      if (k >= 0) cut = cut - 12 + k;
      if (rest[cut - 1] === "\\") cut--;
      // …or through a surrogate pair.
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--;
    }
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  // A continuation line must not start a heading, quote or table row.
  return out.map((piece, i) => (i ? escapeLineStart(piece) : piece));
}

/** Budget for one definition's text; DMD_LIMITS.maxFootnoteChars counts the lines after `[^L]: `. */
const MAX_DEF_CHARS = DMD_LIMITS.maxFootnoteChars - 200;

/**
 * One footnote definition as DMD lines: `[^L]: first` and each further
 * paragraph as a continuation line indented by 4 spaces. `paragraphs` are
 * already escaped, single-line and non-empty. A definition longer than the
 * parser's cap keeps its head; the rest is returned as `overflow` (plain
 * paragraph text the caller emits right after the definitions) so nothing
 * is lost and the document still parses. Pure.
 */
export function definitionLines(label: string, paragraphs: string[]): { lines: string[]; overflow: string[] } {
  const kept: string[] = [];
  const overflow: string[] = [];
  let used = 0;
  for (const paragraph of paragraphs) {
    for (let piece of wrapLongLine(paragraph)) {
      if (overflow.length) {
        overflow.push(piece);
        continue;
      }
      // A continuation line adds "\n" and a 4-space indent.
      const extra = kept.length ? 5 : 0;
      if (used + extra + piece.length <= MAX_DEF_CHARS) {
        kept.push(piece);
        used += extra + piece.length;
        continue;
      }
      // Keep what still fits (cut at a space), the rest overflows.
      const room = MAX_DEF_CHARS - used - extra;
      if (room > 0) {
        let cut = piece.lastIndexOf(" ", room);
        if (cut <= 0) cut = room;
        const code = piece.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) cut--;
        const head = piece.slice(0, cut).trimEnd();
        if (head) {
          kept.push(head);
          used += extra + head.length;
        }
        piece = piece.slice(cut).trimStart();
      }
      if (piece) overflow.push(piece);
    }
  }
  const head = `[^${label}]:` + (kept.length ? ` ${kept[0]}` : "");
  return { lines: [head, ...kept.slice(1).map((l) => `    ${l}`)], overflow };
}

/** Lower-case Roman numeral (1 → "i"). */
export function toRoman(n: number): string {
  const table: Array<[number, string]> = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  for (const [v, r] of table) while (n >= v) { out += r; n -= v; }
  return out;
}

/** 1 → "a", 26 → "z", 27 → "aa" (bijective base 26). */
function toLetters(n: number): string {
  let out = "";
  while (n > 0) {
    n--;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

/** Roman labels fit the DMD label grammar ([a-z]{1,4}) only up to xvii. */
export const MAX_ROMAN_ENDNOTES = 17;

/**
 * DMD label of the n-th endnote (1-based): "i", "ii" … when the document
 * has ≤ 17 endnotes (the parser then reads them as endnotes); beyond that
 * Roman numerals outgrow the 4-letter label grammar ("xviii"), so every
 * endnote gets a letter label "a", "b" … "z", "aa" … instead. Pure.
 */
export function endnoteLabel(n: number, total: number): string {
  return total <= MAX_ROMAN_ENDNOTES ? toRoman(n) : toLetters(n);
}

/** DMD label of the n-th footnote: 1..9999, then wrapping (binding is nearest-earlier, so repeats bind). Pure. */
export function footnoteLabel(n: number): string {
  return String(((n - 1) % 9999) + 1);
}

/** Result scaffolding shared by the unpaged converters (DOCX, TXT, MD). */
export function unpagedResult(args: {
  kind: ConvertResult["kind"];
  converter: string;
  dmd: string;
  quality: ConversionQuality;
  warnings: string[];
}): ConvertResult {
  const dmd = normalizeDmd(args.dmd).text;
  const warnings = [...args.warnings];
  if (dmd.length > DMD_LIMITS.maxChars) {
    warnings.push(
      `Text má ${formatCount(dmd.length)} znaků, najednou lze nahrát nejvýš ${formatCount(DMD_LIMITS.maxChars)} — vyberte rozsah oddílů.`,
    );
  }
  return {
    kind: args.kind,
    converter: args.converter,
    dmd,
    quality: args.quality,
    hints: {},
    labelSource: "none",
    physicalPages: null,
    pageFlags: [],
    pageLabels: [],
    warnings,
  };
}

/** "7 000 000" — Czech thousands separator (NBSP-free so it survives sanitizing). */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// ─────────────────────────────────────────────────────────── decoding

export type TextEncodingName = "utf-8" | "utf-16le" | "utf-16be" | "windows-1250";

/**
 * Bytes of a .txt / .md file → string. BOMs decide UTF-16 / UTF-8; otherwise
 * strict UTF-8, and when that fails (Czech files saved by old Windows
 * software) windows-1250. Throws a plain Error when the bytes look binary
 * (NUL bytes outside UTF-16) — the caller turns it into a ConvertError. Pure.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncodingName } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "utf-16le" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes), encoding: "utf-16be" };
  }
  const probe = Math.min(bytes.length, 65_536);
  for (let i = 0; i < probe; i++) if (bytes[i] === 0) throw new Error("binary");
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1250").decode(bytes), encoding: "windows-1250" };
  }
}

// ─────────────────────────────────────────────────────────── TXT / MD

/** Pandoc footnote definition line: up to 3 spaces, `[^label]:`. */
const PANDOC_DEF_RE = /^ {0,3}\[\^([^\]\s]{1,100})\]:(?: +|$)(.*)$/;
/** Pandoc reference; one preceded by a backslash is a literal (pandoc's escape). */
const PANDOC_REF_RE = /\[\^([^\]\s]{1,100})\]/g;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ ]+(.*?))?(?:[ ]+#+)?[ ]*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ ]*$/;
const HR_RE = /^ {0,3}(?:(?:\*[ ]*){3,}|(?:-[ ]*){3,}|(?:_[ ]*){3,})$/;
const QUOTE_RE = /^ {0,3}>[ ]?/;

interface PandocDef {
  label: string;
  /** Raw paragraphs (continuation lines joined by a space). */
  paragraphs: string[];
}

/** A source line, or the place where a definition stood. */
type SourceItem = { kind: "line"; text: string; code: boolean } | { kind: "def"; def: PandocDef; first: boolean };

/**
 * Split the source into body lines and pandoc definitions. A definition
 * runs over lazy continuation lines (no blank line in between) and over
 * later paragraphs indented by 4+ spaces; code fences are opaque. The
 * first definition of a label wins (as in pandoc); `first` marks it.
 */
function splitDefinitions(lines: string[]): { items: SourceItem[]; defs: Map<string, PandocDef> } {
  const items: SourceItem[] = [];
  const defs = new Map<string, PandocDef>();
  let fence: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);
    if (fence !== null || fenceMatch) {
      if (fence === null) fence = fenceMatch![1];
      else if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      items.push({ kind: "line", text: line, code: true });
      i++;
      continue;
    }
    const m = PANDOC_DEF_RE.exec(line);
    if (!m) {
      items.push({ kind: "line", text: line, code: false });
      i++;
      continue;
    }
    const paragraphs: string[] = [];
    let current: string[] = m[2].trim() ? [m[2].trim()] : [];
    let blank = false;
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (!next.trim()) {
        blank = true;
        i++;
        continue;
      }
      if (PANDOC_DEF_RE.test(next) || FENCE_RE.test(next)) break;
      const indented = /^ {4,}/.test(next);
      if (blank && !indented) break;
      if (blank && current.length) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      blank = false;
      current.push(next.trim());
      i++;
    }
    if (current.length) paragraphs.push(current.join(" "));
    const def: PandocDef = { label: m[1], paragraphs };
    const first = !defs.has(m[1]);
    if (first) defs.set(m[1], def);
    items.push({ kind: "def", def, first });
    // The blank lines the definition swallowed still end the block before it.
    if (blank) items.push({ kind: "line", text: "", code: false });
  }
  return { items, defs };
}

/** Labels referenced from body text (code excluded) — decides which definitions become notes. */
function referencedLabels(items: SourceItem[]): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    if (item.kind !== "line" || item.code) continue;
    PANDOC_REF_RE.lastIndex = 0;
    for (let m = PANDOC_REF_RE.exec(item.text); m; m = PANDOC_REF_RE.exec(item.text)) {
      if (m.index === 0 || item.text[m.index - 1] !== "\\") out.add(m[1]);
    }
  }
  return out;
}

/** One unit of a block after Markdown classification. */
type Unit =
  | { kind: "heading"; level: number; raw: string }
  | { kind: "line"; raw: string; code: boolean; quote: boolean; table: boolean };

/**
 * Classify the lines of one block. Markdown: ATX headings, setext headings
 * (the text lines above a `===` / `---` underline), thematic breaks
 * (dropped), quotes and table rows. TXT: every line is a plain line.
 */
function classifyBlock(lines: Array<{ text: string; code: boolean }>, md: boolean): Unit[] {
  const units: Unit[] = [];
  let paragraphStart = 0; // index in `units` where the current run of plain lines starts
  for (const { text, code } of lines) {
    if (!md || code) {
      units.push({ kind: "line", raw: text, code, quote: false, table: false });
      continue;
    }
    const atx = ATX_RE.exec(text);
    if (atx) {
      units.push({ kind: "heading", level: atx[1].length, raw: atx[2] ?? "" });
      paragraphStart = units.length;
      continue;
    }
    const setext = SETEXT_RE.exec(text);
    const run = units.slice(paragraphStart);
    if (setext && run.length && run.every((u) => u.kind === "line" && !u.code && !u.quote && !u.table)) {
      const raw = run.map((u) => (u.kind === "line" ? u.raw.trim() : "")).join(" ");
      units.length = paragraphStart;
      units.push({ kind: "heading", level: setext[1][0] === "=" ? 1 : 2, raw });
      paragraphStart = units.length;
      continue;
    }
    if (HR_RE.test(text)) {
      paragraphStart = units.length;
      continue;
    }
    units.push({ kind: "line", raw: text, code: false, quote: QUOTE_RE.test(text), table: /^ {0,3}\|/.test(text) });
  }
  return units;
}

interface TextState {
  defs: Map<string, PandocDef>;
  /** Source label → DMD label, assigned at the first reference. */
  labels: Map<string, string>;
  /** Definitions owed after the current block, in reference order. */
  pending: PandocDef[];
  blocks: string[];
  headings: number;
  placeholders: number;
  notes: number;
  overflowed: number;
  danglingRefs: number;
}

/**
 * Raw text → escaped DMD text. With `refs`, pandoc references that have a
 * definition become `[^N]` (the definition is queued for the block); every
 * other `[^x]` stays escaped text.
 */
function renderInline(raw: string, st: TextState, refs: boolean): string {
  const { text, count } = normalizePlaceholders(raw);
  st.placeholders += count;
  if (!refs) return escapeInline(text);
  let out = "";
  let last = 0;
  PANDOC_REF_RE.lastIndex = 0;
  for (let m = PANDOC_REF_RE.exec(text); m; m = PANDOC_REF_RE.exec(text)) {
    if (m.index > 0 && text[m.index - 1] === "\\") continue; // pandoc literal; escapeInline keeps it text
    const def = st.defs.get(m[1]);
    if (!def) {
      st.danglingRefs++;
      continue;
    }
    let label = st.labels.get(m[1]);
    if (!label) {
      label = footnoteLabel(st.labels.size + 1);
      st.labels.set(m[1], label);
    }
    out += escapeInline(text.slice(last, m.index)) + `[^${label}]`;
    last = m.index + m[0].length;
    // Every reference gets its own copy of the definition: DMD binds one
    // reference to one definition, and the label repeats as in pandoc.
    st.pending.push(def);
  }
  return out + escapeInline(text.slice(last));
}

/** Emit the definitions owed by the block just written, as one block after it. */
function flushDefinitions(st: TextState): void {
  if (!st.pending.length) return;
  const lines: string[] = [];
  const overflow: string[] = [];
  for (const def of st.pending) {
    const paragraphs = def.paragraphs.map((p) => renderInline(p, st, false)).filter(Boolean);
    const rendered = definitionLines(st.labels.get(def.label)!, paragraphs);
    lines.push(...rendered.lines);
    if (rendered.overflow.length) {
      st.overflowed++;
      overflow.push(...rendered.overflow.map(escapeLineStart));
    }
    st.notes++;
  }
  st.pending = [];
  st.blocks.push(lines.join("\n"));
  if (overflow.length) st.blocks.push(overflow.join("\n"));
}

/** Write one block of source lines (plus the definitions it cites). */
function emitBlock(lines: Array<{ text: string; code: boolean }>, st: TextState, md: boolean): void {
  let out: string[] = [];
  const closeParagraph = () => {
    if (out.length) st.blocks.push(out.join("\n"));
    out = [];
  };
  for (const unit of classifyBlock(lines, md)) {
    if (unit.kind === "heading") {
      // A heading is a block of its own; the text above it and its notes come first.
      closeParagraph();
      flushDefinitions(st);
      const text = renderInline(unit.raw.trim().replace(/\s+/g, " "), st, true);
      if (text && text.length <= DMD_LIMITS.maxHeadingChars) {
        st.blocks.push(`${"#".repeat(unit.level)} ${text}`);
        st.headings++;
        flushDefinitions(st);
      } else if (text) {
        for (const piece of wrapLongLine(escapeLineStart(text))) out.push(piece);
      }
      continue;
    }
    // Leading spaces go even in code: after a footnote definition, an
    // indented line would read as the definition's continuation.
    const trimmed = unit.raw.trim();
    if (!trimmed) continue;
    if (unit.quote) {
      // Markdown quotation → DMD quote; every wrapped piece stays a quote line.
      const content = renderInline(trimmed.replace(/^>[ ]?/, "").trim(), st, true);
      if (!content) out.push(">");
      else for (const piece of wrapLongLine(content)) out.push(`> ${piece}`);
      continue;
    }
    let line = renderInline(trimmed, st, !unit.code);
    if (!unit.table) line = escapeLineStart(line);
    for (const piece of wrapLongLine(line)) out.push(piece);
  }
  closeParagraph();
  flushDefinitions(st);
}

/**
 * Convert a decoded TXT or Markdown text to DMD (see the module header).
 * Unpaged: labelSource "none", no page markers. Pure.
 */
export function convertText(text: string, kind: "txt" | "md"): ConvertResult {
  // Tabs first: pandoc indents continuations with a tab; normalizeDmd would make it one space.
  const normalized = normalizeDmd(text.replace(/\t/g, "    ")).text;
  const { items, defs } = splitDefinitions(normalized.split("\n"));
  const referenced = referencedLabels(items);
  const st: TextState = {
    defs: new Map([...defs].filter(([label]) => referenced.has(label))),
    labels: new Map(),
    pending: [],
    blocks: [],
    headings: 0,
    placeholders: 0,
    notes: 0,
    overflowed: 0,
    danglingRefs: 0,
  };
  const md = kind === "md";

  let block: Array<{ text: string; code: boolean }> = [];
  let keptAsText = 0;
  const flushBlock = () => {
    if (block.length) emitBlock(block, st, md);
    block = [];
  };
  for (const item of items) {
    if (item.kind === "def") {
      flushBlock();
      // A cited definition is written after its citing block. One nobody
      // cites (or a repeated label) keeps its place as escaped text.
      if (!item.first || !st.defs.has(item.def.label)) {
        keptAsText++;
        const [head = "", ...rest] = item.def.paragraphs;
        const lines = [`[^${item.def.label}]: ${head}`.trimEnd(), ...rest];
        st.blocks.push(lines.flatMap((l) => wrapLongLine(escapeLineStart(renderInline(l, st, false)))).join("\n"));
      }
      continue;
    }
    if (!item.code && !item.text.trim()) {
      flushBlock();
      continue;
    }
    block.push({ text: item.text, code: item.code });
  }
  flushBlock();

  const warnings: string[] = [];
  if (keptAsText) {
    warnings.push(
      `${keptAsText} ${plural(keptAsText, "poznámka nemá", "poznámky nemají", "poznámek nemá")} odkaz v textu — ${keptAsText === 1 ? "zůstala" : "zůstaly"} jako běžný text.`,
    );
  }
  if (st.danglingRefs) {
    warnings.push(
      `${st.danglingRefs} ${plural(st.danglingRefs, "odkaz", "odkazy", "odkazů")} na poznámku bez jejího textu — ${st.danglingRefs === 1 ? "zůstal" : "zůstaly"} jako běžný text.`,
    );
  }
  if (st.overflowed) {
    warnings.push(
      `${st.overflowed} ${plural(st.overflowed, "poznámka je", "poznámky jsou", "poznámek je")} delší než ${formatCount(DMD_LIMITS.maxFootnoteChars)} znaků — zbytek je za poznámkou jako běžný text.`,
    );
  }

  const quality: ConversionQuality = {
    footnotes: st.notes ? (keptAsText || st.danglingRefs ? "partial" : "linked") : "none",
    linked_ratio: st.notes + keptAsText ? st.notes / (st.notes + keptAsText) : 0,
    columns_pages: 0,
    headings_from: st.headings ? "markdown" : "none",
    mn: 0,
    unsure_pages: [],
  };
  return unpagedResult({ kind, converter: `${kind}@1`, dmd: st.blocks.join("\n\n"), quality, warnings });
}

/** Czech plural: 1 / 2–4 / 5+. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return many;
}
