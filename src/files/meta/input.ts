/**
 * What the metadata proposal reads of an uploaded document (plan §7): not
 * the whole text — a 1,000-page commentary is ~4 M characters — but the
 * parts that carry bibliographic data, capped at 16k characters in total:
 *
 *   front          physical pages 1–8 without footnote definitions (≤ 9k);
 *                  author notes ([^*]: …) are kept — articles print the
 *                  author's affiliation there. Unpaged documents (DOCX,
 *                  TXT): the first 12k characters.
 *   colophon       the best one or two pages among the first 8 and the last
 *                  4 that look like a tiráž (ISBN, ©, Vydal, vydání, Tisk…)
 *                  or like the closing page of a decision ("předseda
 *                  senátu") — Czech books often print the tiráž at the end
 *                  (≤ 3k)
 *   authorsPage    "Autorský kolektiv" / "Autoři" among the first 15 pages (≤ 3k)
 *   outline        headings of levels ≤ 2 with the § ranges below them (≤ 3k)
 *   runningHeads   distinct running heads, most frequent first — they carry
 *                  the journal, issue and year of an article (≤ 0.8k)
 *
 * Text is markup-stripped (page markers, [^n] refs, [m. č. N] prefixes,
 * escapes) with each block on one line; headings keep a "# " prefix and
 * every page starts with a "--- s. <label> ---" line, so the heuristics and
 * the model can still see what was a heading and where a page began. A page
 * already included whole in `front` is not repeated in `colophon` or
 * `authorsPage`.
 *
 * Everything here is document-derived and untrusted: it goes to the model
 * inside a <document> wrapper and is never rendered as tool prose.
 *
 * Pure — unit-tested (tests/files-meta-input.test.ts).
 */

import { sanitizeLine } from "@/src/files/dmd/normalize";
import { stripMarkup } from "@/src/files/dmd/parse";
import type { DmdBlock, ParsedDoc } from "@/src/files/dmd/types";
import type { AnchorLabel, DocType, UploadHints } from "@/src/files/types";

/** Structural facts the parser already knows — cheap signals for the heuristics. */
export interface MetaFacts {
  paged: boolean;
  physicalPages: number;
  /** Printed label of the first / last page (null for unpaged documents). */
  firstPageLabel: string | null;
  lastPageLabel: string | null;
  /** § sections and čl. sections in the whole document. */
  parSections: number;
  clSections: number;
  footnotes: number;
  /** The marginal-number label the parser detected. */
  anchorLabel: AnchorLabel | null;
  /** Template placeholders ([●], [____], ☐, ☒) in the whole text. */
  placeholders: number;
}

export interface MetaInput {
  fileName: string;
  docTypeHint: DocType | null;
  pdfInfo: Record<string, string>;
  front: string;
  colophon: string;
  authorsPage: string;
  outline: string;
  runningHeads: string;
  /** Optional so that a MetaInput can be written by hand (tests, re-proposals). */
  facts?: MetaFacts;
}

/** Character caps (plan §7). The part caps add up to more than `total` on purpose — see fitParts. */
export const META_INPUT_LIMITS = {
  total: 16_000,
  front: 9_000,
  frontUnpaged: 12_000,
  colophon: 3_000,
  authorsPage: 3_000,
  outline: 3_000,
  runningHeads: 800,
  /** Each PDF info value, and the file name. */
  infoValue: 200,
} as const;

/** Pages scanned for the front, the colophon (first N and last M) and the author page. */
const FRONT_PAGES = 8;
const COLOPHON_FIRST = 8;
const COLOPHON_LAST = 4;
const AUTHOR_PAGES = 15;

/** One signal per alternative — a page scores the number of DISTINCT signals it shows. */
const COLOPHON_SIGNALS: RegExp[] = [
  /\bISBN\b/,
  /\bISSN\b/,
  /©|\(c\)\s*\d{4}|\bCopyright\b/i,
  /\bVyda(?:l|la|lo|li|vatel)\b/,
  /\bNakladatel/i,
  /(?<![\p{L}])vydání(?![\p{L}])/iu,
  /\bTisk(?:l|la|lo|árna)?\b|\bVytiskl/,
  /\bRecenz/i,
  /\bSazba\b/,
  /Všechna práva vyhrazena/i,
  // The closing page of a decision: place, date and the presiding judge.
  /\bPoučení\s*:/,
  /předsed(?:a|kyně|ající)\s+senátu|soudce\s+zpravodaj/i,
];

const AUTHOR_PAGE_RE = /Autorský kolektiv|Kolektiv autorů|Seznam autorů|\bAutoři\b|\bAutorky\b|\bZpracoval[ai]?\b|\bO autor/iu;
/** Academic degrees — many of them on a page mean a list of people. */
const DEGREE_RE = /\b(?:JUDr|Mgr|PhDr|Ing|Bc|RNDr|MUDr|doc|prof|Dr)\.|\bPh\.\s?D\.|\bLL\.\s?M\.|\bCSc\./g;
/** An author note: [^*]: … (affiliation, "Článek vznikl v rámci…"). */
const AUTHOR_NOTE_LABEL_RE = /^[*†]{1,3}$/;
const PLACEHOLDER_RE = /\[●\]|\[_{2,}\]|[☐☒]/g;
/** A running head that is only a page number: "417", "s. 417", "xii". */
const BARE_PAGE_NUMBER_RE = /^(?:s\.\s*)?(?:\d{1,5}|(?=[ivxlc])(?:c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))$/i;
const MAX_PLACEHOLDERS = 10_000;

/**
 * The metadata input of a parsed document (see the header). `hints` come
 * from the client and are sanitized here; `fileName` is the original file
 * name. Pure.
 */
export function buildMetaInput(parsed: ParsedDoc, hints: UploadHints, fileName: string, docTypeHint: DocType | null): MetaInput {
  const pdfInfo = cleanPdfInfo(hints?.pdf_info);
  const cleanName = sanitizeLine(fileName ?? "", META_INPUT_LIMITS.infoValue);
  const runningHeads = buildRunningHeads(hints?.running_heads);
  const outline = buildOutline(parsed);
  const facts = buildFacts(parsed);

  let front: string;
  let colophon = "";
  let authorsPage = "";
  if (parsed.paged && parsed.pages.length) {
    const pages = pageTexts(parsed);
    const built = buildFront(parsed, pages);
    front = built.text;
    colophon = buildColophon(parsed, pages, built.whole);
    authorsPage = buildAuthorsPage(parsed, pages, built.whole);
  } else {
    const built = unpagedFront(parsed);
    front = clip(built.text, META_INPUT_LIMITS.frontUnpaged);
    colophon = unpagedColophon(parsed, built.last);
  }

  const fixed = cleanName.length + Object.entries(pdfInfo).reduce((n, [k, v]) => n + k.length + v.length + 4, 0);
  const fitted = fitParts({ front, colophon, authorsPage, outline, runningHeads }, META_INPUT_LIMITS.total - fixed);
  return { fileName: cleanName, docTypeHint: docTypeHint ?? null, pdfInfo, ...fitted, facts };
}

// ---------------------------------------------------------------------------
// Hints

const PDF_INFO_KEYS = ["title", "author", "subject", "keywords", "producer", "creator"] as const;

function cleanPdfInfo(info: UploadHints["pdf_info"] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!info || typeof info !== "object") return out;
  for (const key of PDF_INFO_KEYS) {
    const value = (info as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    const line = sanitizeLine(value, META_INPUT_LIMITS.infoValue);
    if (line) out[key] = line;
  }
  return out;
}

/** Distinct running heads, most frequent first (first appearance breaks ties); bare page numbers dropped. */
function buildRunningHeads(heads: UploadHints["running_heads"] | undefined): string {
  if (!Array.isArray(heads)) return "";
  const counts = new Map<string, number>();
  for (const head of heads) {
    const raw = head && typeof head === "object" && typeof head.text === "string" ? head.text : null;
    if (!raw) continue;
    const line = sanitizeLine(raw, 160);
    if (!line || BARE_PAGE_NUMBER_RE.test(line)) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([line]) => line);
  return clip(ranked.join("\n"), META_INPUT_LIMITS.runningHeads);
}

// ---------------------------------------------------------------------------
// Blocks → lines

/** Author-note definitions ([^*]: …) by their start offset, for fndefs blocks. */
function authorNotes(parsed: ParsedDoc): Array<{ start: number; end: number }> {
  return parsed.footnotes
    .filter((f) => AUTHOR_NOTE_LABEL_RE.test(f.label))
    .map((f) => ({ start: f.defStart, end: f.defEnd }))
    .sort((a, b) => a.start - b.start);
}

/**
 * One block as one line of plain text: markup stripped, paragraph lines
 * joined (table rows stay on their own lines), headings prefixed "# ".
 * fndefs blocks yield only their author notes ("* …"). Empty → "".
 */
function blockLine(parsed: ParsedDoc, block: DmdBlock, notes: Array<{ start: number; end: number }>): string {
  if (block.kind === "page") return "";
  if (block.kind === "fndefs") {
    return notes
      .filter((n) => n.start >= block.start && n.end <= block.end)
      .map((n) => `* ${oneLine(stripMarkup(parsed.text.slice(n.start, n.end)).text)}`)
      .filter((s) => s.length > 2)
      .join("\n");
  }
  const plain = stripMarkup(parsed.text.slice(block.start, block.end)).text;
  if (block.kind === "table") {
    return plain
      .split("\n")
      .map((row) => row.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  }
  const line = oneLine(plain);
  if (!line) return "";
  return block.kind === "heading" ? `# ${line}` : line;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function pageHeader(label: string): string {
  return `--- s. ${label} ---`;
}

/**
 * Text of the pages the input can use (the first 15 and the last 4), by
 * page ord. One pass over the blocks; a block belongs to the page it starts on.
 */
function pageTexts(parsed: ParsedDoc): Map<number, string> {
  const n = parsed.pages.length;
  const wanted = (ord: number) => ord <= Math.max(AUTHOR_PAGES, FRONT_PAGES, COLOPHON_FIRST) || ord > n - COLOPHON_LAST;
  const notes = authorNotes(parsed);
  const lines = new Map<number, string[]>();
  for (const block of parsed.blocks) {
    if (!wanted(block.page)) continue;
    const line = blockLine(parsed, block, notes);
    if (!line) continue;
    const list = lines.get(block.page);
    if (list) list.push(line);
    else lines.set(block.page, [line]);
  }
  const out = new Map<number, string>();
  for (const [ord, list] of lines) out.set(ord, list.join("\n"));
  return out;
}

function labelOf(parsed: ParsedDoc, ord: number): string {
  return parsed.pages[ord - 1]?.label ?? String(ord);
}

/** Pages 1–8 in order, each under its page header, until the cap; `whole` = pages included in full. */
function buildFront(parsed: ParsedDoc, pages: Map<number, string>): { text: string; whole: Set<number> } {
  const whole = new Set<number>();
  const parts: string[] = [];
  let used = 0;
  const cap = META_INPUT_LIMITS.front;
  for (let ord = 1; ord <= Math.min(FRONT_PAGES, parsed.pages.length); ord++) {
    const body = pages.get(ord);
    if (!body) continue;
    const piece = `${pageHeader(labelOf(parsed, ord))}\n${body}`;
    const room = cap - used - (parts.length ? 1 : 0);
    if (room <= 40) break;
    if (piece.length <= room) {
      parts.push(piece);
      whole.add(ord);
      used += piece.length + (parts.length > 1 ? 1 : 0);
    } else {
      parts.push(clip(piece, room));
      break;
    }
  }
  return { text: parts.join("\n"), whole };
}

function signalScore(text: string, signals: RegExp[]): { score: number; positions: number[] } {
  let score = 0;
  const positions: number[] = [];
  for (const re of signals) {
    const m = re.exec(text);
    if (m) {
      score++;
      positions.push(m.index);
    }
  }
  return { score, positions };
}

/** The best 1–2 colophon pages among the first 8 and the last 4, in page order. */
function buildColophon(parsed: ParsedDoc, pages: Map<number, string>, inFront: Set<number>): string {
  const n = parsed.pages.length;
  const candidates = new Set<number>();
  for (let ord = 1; ord <= Math.min(COLOPHON_FIRST, n); ord++) candidates.add(ord);
  for (let ord = Math.max(1, n - COLOPHON_LAST + 1); ord <= n; ord++) candidates.add(ord);
  const scored: Array<{ ord: number; score: number; positions: number[]; body: string }> = [];
  for (const ord of candidates) {
    const body = pages.get(ord);
    if (!body) continue;
    const { score, positions } = signalScore(body, COLOPHON_SIGNALS);
    if (score > 0) scored.push({ ord, score, positions, body });
  }
  // Highest score first; on a tie, the later page (a tiráž at the end beats
  // a preface that merely mentions "vydání").
  scored.sort((a, b) => b.score - a.score || b.ord - a.ord);
  const chosen = scored.filter((c, i) => i === 0 || (i === 1 && c.score >= 2)).slice(0, 2);
  if (chosen.some((c) => inFront.has(c.ord))) {
    // The best colophon is already in the front: keep only pages that are not.
    const rest = chosen.filter((c) => !inFront.has(c.ord));
    if (!rest.length) return "";
    chosen.splice(0, chosen.length, ...rest);
  }
  chosen.sort((a, b) => a.ord - b.ord);
  const each = Math.floor(META_INPUT_LIMITS.colophon / chosen.length);
  return chosen
    .map((c) => {
      const header = pageHeader(labelOf(parsed, c.ord));
      return `${header}\n${windowAround(c.body, c.positions, each - header.length - 1)}`;
    })
    .join("\n");
}

/** The page among the first 15 that best looks like a list of authors (+ the next one when it continues the list). */
function buildAuthorsPage(parsed: ParsedDoc, pages: Map<number, string>, inFront: Set<number>): string {
  let best: { ord: number; score: number } | null = null;
  for (let ord = 1; ord <= Math.min(AUTHOR_PAGES, parsed.pages.length); ord++) {
    const body = pages.get(ord);
    if (!body || !AUTHOR_PAGE_RE.test(body)) continue;
    const score = 2 + (body.match(DEGREE_RE)?.length ?? 0);
    if (!best || score > best.score) best = { ord, score };
  }
  if (!best || inFront.has(best.ord)) return "";
  const cap = META_INPUT_LIMITS.authorsPage;
  let text = `${pageHeader(labelOf(parsed, best.ord))}\n${pages.get(best.ord)}`;
  const next = pages.get(best.ord + 1);
  if (next && (next.match(DEGREE_RE)?.length ?? 0) >= 3 && !inFront.has(best.ord + 1)) {
    text += `\n${pageHeader(labelOf(parsed, best.ord + 1))}\n${next}`;
  }
  return clip(text, cap);
}

/** Unpaged: blocks in order until the front cap (clip() makes the final cut); `last` = index of the last block used. */
function unpagedFront(parsed: ParsedDoc): { text: string; last: number } {
  const notes = authorNotes(parsed);
  const lines: string[] = [];
  let used = 0;
  let last = -1;
  for (let i = 0; i < parsed.blocks.length && used <= META_INPUT_LIMITS.frontUnpaged; i++) {
    last = i;
    const line = blockLine(parsed, parsed.blocks[i], notes);
    if (!line) continue;
    lines.push(line);
    used += line.length + 1;
  }
  return { text: lines.join("\n"), last };
}

/**
 * Unpaged: colophon-like paragraphs near the end (a DOCX manuscript with
 * its tiráž last, a decision's closing lines) — blocks within the last
 * ~4 pages' worth of text that show a colophon signal and are not part of
 * the front already.
 */
function unpagedColophon(parsed: ParsedDoc, frontLast: number): string {
  const notes = authorNotes(parsed);
  const tail: string[] = [];
  let used = 0;
  for (let i = parsed.blocks.length - 1; i > frontLast && used < COLOPHON_LAST * 3_600; i--) {
    const line = blockLine(parsed, parsed.blocks[i], notes);
    if (!line) continue;
    used += line.length + 1;
    if (signalScore(line, COLOPHON_SIGNALS).score > 0) tail.unshift(line);
  }
  return clip(tail.join("\n"), META_INPUT_LIMITS.colophon);
}

// ---------------------------------------------------------------------------
// Outline and facts

function parLabel(key: string | null): string | null {
  const m = key ? /^par:(.+)$/.exec(key) : null;
  return m ? m[1] : null;
}

function clLabel(key: string | null): string | null {
  const m = key ? /^cl:(.+)$/.exec(key) : null;
  return m ? m[1] : null;
}

/**
 * Headings of levels ≤ 2 (indented by level, § sections summarized rather
 * than listed) with the § range beneath each, after one summary line per
 * numbered kind: "Oddíly §: § 1–654 (654)", "Články: čl. I–XII (12)".
 */
function buildOutline(parsed: ParsedDoc): string {
  const { sections } = parsed;
  const range = new Map<number, { from: string; to: string; fromNum: number; toNum: number }>();
  let parCount = 0;
  let parFirst: { label: string; num: number } | null = null;
  let parLast: { label: string; num: number } | null = null;
  const cls: string[] = [];
  for (const s of sections) {
    if (s.kind === "cl") {
      const label = clLabel(s.key);
      if (label) cls.push(label);
      continue;
    }
    if (s.kind !== "par" || s.keyNum === null) continue;
    const label = parLabel(s.key);
    if (!label) continue;
    parCount++;
    if (!parFirst || s.keyNum < parFirst.num) parFirst = { label, num: s.keyNum };
    if (!parLast || s.keyNum > parLast.num) parLast = { label, num: s.keyNum };
    // Every ancestor at level ≤ 2 covers this §.
    for (let p = s.parent; p !== null; p = sections[p].parent) {
      if (sections[p].level > 2) continue;
      const r = range.get(p);
      if (!r) range.set(p, { from: label, to: label, fromNum: s.keyNum, toNum: s.keyNum });
      else {
        if (s.keyNum < r.fromNum) Object.assign(r, { from: label, fromNum: s.keyNum });
        if (s.keyNum > r.toNum) Object.assign(r, { to: label, toNum: s.keyNum });
      }
    }
  }
  const lines: string[] = [];
  if (parFirst && parLast) {
    lines.push(`Oddíly §: § ${parFirst.label}${parLast.label !== parFirst.label ? `–${parLast.label}` : ""} (${parCount})`);
  }
  if (cls.length) {
    lines.push(`Články: čl. ${cls[0]}${cls.length > 1 ? `–${cls[cls.length - 1]}` : ""} (${cls.length})`);
  }
  for (const s of sections) {
    if (s.level > 2 || s.kind === "par") continue;
    const r = range.get(s.ord);
    const suffix = r ? ` (§ ${r.from}${r.to !== r.from ? `–${r.to}` : ""})` : "";
    lines.push(`${"  ".repeat(s.level - 1)}${sanitizeLine(s.heading, 160)}${suffix}`);
  }
  return clip(lines.join("\n"), META_INPUT_LIMITS.outline);
}

function buildFacts(parsed: ParsedDoc): MetaFacts {
  let parSections = 0;
  let clSections = 0;
  for (const s of parsed.sections) {
    if (s.kind === "par") parSections++;
    else if (s.kind === "cl") clSections++;
  }
  let placeholders = 0;
  PLACEHOLDER_RE.lastIndex = 0;
  while (placeholders < MAX_PLACEHOLDERS && PLACEHOLDER_RE.exec(parsed.text)) placeholders++;
  PLACEHOLDER_RE.lastIndex = 0;
  const pages = parsed.pages;
  return {
    paged: parsed.paged,
    physicalPages: pages.length,
    firstPageLabel: pages.length ? pages[0].label : null,
    lastPageLabel: pages.length ? pages[pages.length - 1].label : null,
    parSections,
    clSections,
    footnotes: parsed.footnotes.length,
    anchorLabel: parsed.anchorLabel,
    placeholders,
  };
}

// ---------------------------------------------------------------------------
// Clipping

/** Drop a trailing lone high surrogate so a cut never splits a pair. */
function safeCut(s: string, end: number): string {
  const cut = s.slice(0, Math.max(0, end));
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * `s` cut to ≤ max chars: at the last line break when that keeps ≥ 60 % of
 * the budget, else at the last space, else hard (surrogate-safe). Pure.
 */
export function clip(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  const head = safeCut(s, max);
  const nl = head.lastIndexOf("\n");
  if (nl >= max * 0.6) return head.slice(0, nl).trimEnd();
  const sp = head.lastIndexOf(" ");
  if (sp >= max * 0.6) return head.slice(0, sp).trimEnd();
  return head;
}

/**
 * A ≤ max window of `text` around the signal positions: from a little
 * before the first signal, so a tiráž at the bottom of a long page is not
 * cut away. The start moves forward to a line start when one is near and
 * the first signal stays in the window. Pure.
 */
function windowAround(text: string, positions: number[], max: number): string {
  if (text.length <= max) return text;
  const first = positions.length ? Math.min(...positions) : 0;
  let start = Math.min(Math.max(0, first - 300), Math.max(0, text.length - max));
  if (start > 0 && text[start - 1] !== "\n") {
    // Forward only: moving back would push the window's end (often the ISBN) out.
    const next = text.indexOf("\n", start) + 1;
    if (next > 0 && next <= first && next - start <= 200) start = next;
  }
  return clip(text.slice(start), max);
}

type Parts = { front: string; colophon: string; authorsPage: string; outline: string; runningHeads: string };

/**
 * Shrink the parts until they fit `budget`, in an order that keeps what
 * matters most: the front gives way first (its later pages are usually a
 * table of contents), then the outline and the author page, the colophon
 * and running heads last. Each step cuts one part down to a floor.
 */
function fitParts(parts: Parts, budget: number): Parts {
  const out = { ...parts };
  const total = () => out.front.length + out.colophon.length + out.authorsPage.length + out.outline.length + out.runningHeads.length;
  const steps: Array<[keyof Parts, number]> = [
    ["front", 7_000],
    ["outline", 1_500],
    ["authorsPage", 1_500],
    ["front", 5_000],
    ["outline", 600],
    ["colophon", 1_500],
    ["authorsPage", 800],
    ["front", 3_000],
    ["runningHeads", 300],
    ["colophon", 800],
    ["front", 1_000],
    ["outline", 0],
    ["authorsPage", 0],
  ];
  for (const [key, floor] of steps) {
    const over = total() - budget;
    if (over <= 0) break;
    const target = Math.max(floor, out[key].length - over);
    if (target < out[key].length) out[key] = clip(out[key], target);
  }
  return out;
}
