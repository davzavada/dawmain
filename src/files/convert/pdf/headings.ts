/**
 * Headings of the PDF layout engine. Sources, in order of trust:
 * 1. the PDF outline, matched to a line of the destination page by text
 *    (an entry without a matching line is navigation only — no heading
 *    text is ever invented);
 * 2. style: a short, isolated line without a final period set larger than
 *    the body or in bold (when bold is rare in the body);
 * 3. patterns: § N, ČÁST / HLAVA / DÍL / ODDÍL / Pododdíl, Čl. N,
 *    Kapitola N — accepted only on a short line that is isolated, centred
 *    or styled, without a dot leader or a trailing page number, and never
 *    on table-of-contents / index pages (≥ 40 % of lines end in a leader
 *    and a number). § numbers must increase through the document (reset by
 *    a chapter): a § heading that does not is left as text.
 * Levels: parts by rank, § one level below the enclosing structural
 * heading, commentary internals ("I.", "A.", "1.") below the §. The
 * statute wording right after a § heading, set smaller than the body, is
 * marked as a quote. Pure — unit-tested through layoutToDmd.
 */

import { PAGE_FLAGS } from "../../dmd/types";
import type { HeadingMark, Line, PageModel } from "./model";
import { foldText } from "./text";
import type { PdfOutlineEntry } from "./types";

export interface HeadingStats {
  bodySize: number;
  lineGap: number;
  boldShare: number;
}

export interface HeadingReport {
  /** Dominant source, for ConversionQuality.headings_from. */
  from: "outline" | "styles" | "patterns" | "none";
  count: number;
  /** § headings left as text because their number did not increase. */
  rejectedPar: number;
  tocPages: Set<number>;
}

const PAR_RE = /^§\s*(\d{1,4})\s?([a-z]{0,2})(?![\p{L}\d])/u;
const PART_RE = /^(ČÁST|HLAVA|DÍL|ODDÍL|PODODDÍL|Pododdíl|Část|Hlava|Díl|Oddíl)(?:\s+(\S+))?/u;
const CL_RE = /^(?:Čl\.|ČL\.|Článek|ČLÁNEK)\s*(\d{1,3}[a-z]?|[IVXLC]{1,7})(?![\p{L}\d])/u;
const KAP_RE = /^(?:Kapitola|KAPITOLA)\s+(\d{1,3}|[IVXLC]{1,7})(?![\p{L}\d])|^\d{1,2}\.\s*(?:kapitola|KAPITOLA)(?![\p{L}])/u;
const SPECIAL_RE = /^(?:obsah|podrobny obsah|(?:vecny |jmenny )?rejstrik|seznam (?:pouzitych )?zkratek|predmluva|seznam literatury|bibliografie)$/;
const LEADER_RE = /(?:\.{2,}|…|·{2,}|_{3,}|(?:\. ){2,}\.?)\s*[\divxlc]{1,5}\s*$/i;
// Anchored at the end only: a leading "\p{L}.*" would backtrack quadratically on every line.
const INDEX_RE = /\s\d{1,4}(?:\s*[,–-]\s*\d{1,4})+\s*$/;
const TRAILING_NUM_RE = /\s\d{1,4}\s*$/;
const ORDINALS = new Set([
  "prvni", "druha", "druhy", "treti", "ctvrta", "ctvrty", "pata", "paty", "sesta", "sesty", "sedma", "sedmy", "osma", "osmy",
  "devata", "devaty", "desata", "desaty", "obecna", "zvlastni", "spolecna", "zaverecna", "uvodni", "prechodna",
]);
const PART_ORDER = ["cast", "hlava", "dil", "oddil", "pododdil"];
/** Bold marks a heading only while it is rare in the body text. */
const BOLD_RARE = 0.4;

/** "Č Á S T  P R V N Í" → "ČÁST PRVNÍ": runs of ≥ 3 single letters. Pure. */
export function collapseLetterSpacing(s: string): string {
  return s
    .split(/\s{2,}/)
    .map((chunk) => (/^\S(?: \S){2,}$/u.test(chunk) ? chunk.replace(/ /g, "") : chunk))
    .join(" ");
}

/** A line of a table of contents or an index: leader + number, a far-right number, or a list of pages. Pure. */
export function isTocLine(line: Pick<Line, "plain" | "gapTail">): boolean {
  if (line.gapTail || LEADER_RE.test(line.plain)) return true;
  return (INDEX_RE.test(line.plain) || TRAILING_NUM_RE.test(line.plain)) && /\p{L}/u.test(line.plain);
}

interface Ctx {
  line: Line;
  prev: Line | null;
  next: Line | null;
  seg: Line[];
  idx: number;
  page: PageModel;
}

/** Every body line of the kept pages in reading order, with its neighbours in the segment. */
function* walk(pages: PageModel[]): Generator<Ctx> {
  for (const page of pages) {
    if (!page.kept) continue;
    for (const seg of page.segments) {
      for (let idx = 0; idx < seg.lines.length; idx++) {
        yield { line: seg.lines[idx], prev: seg.lines[idx - 1] ?? null, next: seg.lines[idx + 1] ?? null, seg: seg.lines, idx, page };
      }
    }
  }
}

/** Detect headings on the kept pages; marks `line.heading` / `line.headingCont` / `line.quote`. Pure (mutates the model). */
export function detectHeadings(pages: PageModel[], outline: PdfOutlineEntry[], stats: HeadingStats): HeadingReport {
  const tocPages = new Set<number>();
  for (const page of pages) {
    const lines = page.segments.flatMap((s) => s.lines);
    if (lines.length >= 4 && lines.filter(isTocLine).length >= 0.4 * lines.length) tocPages.add(page.ord);
  }

  let outlineCount = 0;
  const byPage = new Map<number, PdfOutlineEntry[]>();
  for (const e of outline) byPage.set(e.page, [...(byPage.get(e.page) ?? []), e]);
  for (const page of pages) {
    if (!page.kept) continue;
    for (const entry of byPage.get(page.ord) ?? []) if (matchOutline(page, entry, stats)) outlineCount++;
  }

  const counts = { styles: 0, patterns: 0 };
  for (const ctx of walk(pages)) {
    const { line } = ctx;
    if (line.heading || line.headingCont) continue;
    const mark = classify(ctx, stats, tocPages.has(ctx.page.ord));
    if (!mark) continue;
    line.heading = mark;
    mergeFollowing(ctx, stats);
    counts[mark.source === "styles" ? "styles" : "patterns"]++;
  }

  const rejectedPar = checkParOrder(pages);
  assignLevels(pages);
  markQuotes(pages, stats);

  let count = 0;
  const bySource = { outline: 0, styles: 0, patterns: 0 };
  for (const { line } of walk(pages)) {
    if (!line.heading) continue;
    count++;
    bySource[line.heading.source]++;
  }
  const from = count === 0 ? "none" : (Object.entries(bySource).sort((a, b) => b[1] - a[1])[0][0] as HeadingReport["from"]);
  return { from, count, rejectedPar, tocPages };
}

// ─────────────────────────────────────────────────────────────── outline

const norm = (s: string) => foldText(s).replace(/[^\p{L}\p{N}]+/gu, "");

/** Mark the line(s) of `page` matching an outline entry's title. Returns whether one matched. */
function matchOutline(page: PageModel, entry: PdfOutlineEntry, stats: HeadingStats): boolean {
  const title = norm(collapseLetterSpacing(entry.title));
  if (title.length < 2) return false;
  const lines = page.segments.flatMap((s) => s.lines.map((line, idx) => ({ line, idx, seg: s.lines })));
  const candidates = lines
    .filter(({ line }) => !line.heading && !line.headingCont)
    .map((c) => ({ ...c, text: norm(collapseLetterSpacing(c.line.plain)) }))
    .filter((c) => c.text.length >= 2 && (title.startsWith(c.text) || (c.text.startsWith(title) && c.line.plain.length <= 160)))
    .sort((a, b) => dist(a.line, entry, stats) - dist(b.line, entry, stats));
  for (const c of candidates) {
    let acc = c.text;
    const merged: Line[] = [];
    for (let k = c.idx + 1; acc.length < title.length && k < c.seg.length && merged.length < 3; k++) {
      const next = norm(collapseLetterSpacing(c.seg[k].plain));
      if (!next || !title.startsWith(acc + next)) break;
      acc += next;
      merged.push(c.seg[k]);
    }
    if (acc !== title && !acc.startsWith(title)) continue;
    const level = Math.min(6, Math.max(1, entry.level + 1));
    c.line.heading = mark(c.line, merged, level, "outline", "outline");
    for (const m of merged) m.headingCont = true;
    return true;
  }
  return false;
}

function dist(line: Line, entry: PdfOutlineEntry, stats: HeadingStats): number {
  if (entry.y === null) return line.y;
  // The destination usually points at the top of the heading, a little above its baseline.
  return Math.abs(line.y - (entry.y + 0.8 * stats.lineGap));
}

function mark(line: Line, merged: Line[], level: number, source: HeadingMark["source"], kind: HeadingMark["kind"]): HeadingMark {
  const all = [line, ...merged];
  return {
    level,
    source,
    kind,
    text: all.map((l) => l.plain.trim()).join(" ").replace(/\s+/g, " ").trim(),
    parts: all.flatMap((l, i) => (i ? [{ t: "text" as const, s: " " }, ...l.parts] : l.parts)),
  };
}

// ─────────────────────────────────────────────────────────────── style & patterns

function classify(ctx: Ctx, stats: HeadingStats, tocPage: boolean): HeadingMark | null {
  const { line, prev } = ctx;
  const text = collapseLetterSpacing(line.plain.trim());
  if (text.length < 1 || text.length > 160 || !/[\p{L}§]/u.test(text)) return null;
  if (line.mn !== null || line.boldLead !== null) return null;
  if (LEADER_RE.test(text) || line.gapTail) return null;

  const scale = Math.max(1, line.size / stats.bodySize);
  const gapAbove = prev ? line.y - prev.y : Infinity;
  const isolated = gapAbove >= 1.25 * stats.lineGap * scale;
  const colWidth = line.colRight - line.colLeft;
  const indentL = line.x0 - line.colLeft;
  const indentR = line.colRight - line.x1;
  const centered = indentL > 1.5 * line.size && Math.abs(indentR - indentL) <= 2.5 * line.size;
  const larger = line.size >= 1.1 * stats.bodySize;
  const bold = line.bold && stats.boldShare < BOLD_RARE;
  const styled = larger || bold;
  // A wrapped body line: the line above runs on into it.
  const runOn = !!prev && !isolated && !/[.:;!?)\]]["”]?$/.test(prev.plain.trim()) && prev.size <= line.size + 0.5;
  const standOut = isolated || styled || centered;

  if (!tocPage) {
    const par = PAR_RE.exec(text);
    if (par) {
      const rest = text.slice(par[0].length).trim();
      // "§ 12 se zrušuje.", "§ 2913 odst. 2": a sentence or a citation, not a heading.
      if (/\d$/.test(rest) || /[,;:]$/.test(text) || /^\p{Ll}/u.test(rest) || rest.length > 120) return null;
      if (!standOut || (runOn && !styled && !centered)) return null;
      return mark(line, [], 1, "patterns", "par");
    }
    const part = PART_RE.exec(text);
    if (part && text.length <= 90 && standOut && !runOn) {
      const word = foldText(part[1]);
      const designator = part[2] ? foldText(part[2]).replace(/[.:]$/, "") : "";
      const upper = part[1] === part[1].toUpperCase();
      if ((!designator && upper) || /^\d{1,3}$/.test(designator) || /^[ivxlc]{1,7}$/.test(designator) || ORDINALS.has(designator)) {
        if (PART_ORDER.includes(word)) return mark(line, [], 1, "patterns", "part");
      }
    }
    const cl = CL_RE.exec(text);
    if (cl && text.length <= 100 && standOut && !runOn && !/[.,;:]$/.test(text) && !/^\p{Ll}/u.test(text.slice(cl[0].length).trim())) {
      return mark(line, [], 1, "patterns", "cl");
    }
    if (KAP_RE.test(text) && text.length <= 120 && standOut && !runOn) return mark(line, [], 1, "patterns", "chapter");
  }

  const folded = foldText(text).replace(/[\s:.]+$/, "");
  if (SPECIAL_RE.test(folded) && (styled || (isolated && text.length <= 40))) return mark(line, [], 1, styled ? "styles" : "patterns", "special");

  if (tocPage || !styled || text.length > 120) return null;
  if (!isolated && prev) return null;
  if (/[.,;:]$/.test(text) && !/^[IVXLC]{1,6}\.$/.test(text)) return null;
  if (/^[\p{Ll}]/u.test(text)) return null;
  const next = ctx.next;
  const gapBelow = next ? next.y - line.y : Infinity;
  if (line.x1 - line.x0 > 0.9 * colWidth && gapBelow < 1.2 * stats.lineGap * scale) return null;
  return mark(line, [], 1, "styles", "style");
}

/** Merge the continuation lines of a heading (a wrapped title, or "§ 2913" + "[Porušení…]"). */
function mergeFollowing(ctx: Ctx, stats: HeadingStats): void {
  const { line, seg, idx } = ctx;
  const h = line.heading!;
  const merged: Line[] = [];
  for (let k = idx + 1; k < seg.length && merged.length < 2; k++) {
    const next = seg[k];
    const prev = seg[k - 1];
    const gap = next.y - prev.y;
    const scale = Math.max(1, next.size / stats.bodySize);
    const text = next.plain.trim();
    if (!text || text.length > 120 || next.heading || next.mn !== null) break;
    if (h.kind === "par" || h.kind === "cl" || h.kind === "part" || h.kind === "chapter") {
      if (merged.length || gap > 1.9 * stats.lineGap * scale) break;
      const bracket = /^\[.*\]$/.test(text);
      const styled = next.size >= 1.1 * stats.bodySize || (next.bold && stats.boldShare < BOLD_RARE);
      const indentL = next.x0 - next.colLeft;
      const centered = indentL > 1.5 * next.size && Math.abs(next.colRight - next.x1 - indentL) <= 2.5 * next.size;
      if (!(bracket || styled || centered) || /[.,;]$/.test(text) || PAR_RE.test(text)) break;
      merged.push(next);
      continue;
    }
    // A wrapped style heading: same size and weight, normal line spacing.
    const same = Math.abs(next.size - line.size) <= 0.3 && next.bold === line.bold;
    if (!same || gap > 1.35 * stats.lineGap * scale || PAR_RE.test(text)) break;
    merged.push(next);
  }
  if (!merged.length) return;
  line.heading = mark(line, merged, h.level, h.source, h.kind);
  for (const m of merged) m.headingCont = true;
}

// ─────────────────────────────────────────────────────────────── § order

function parNum(text: string): number | null {
  const m = PAR_RE.exec(collapseLetterSpacing(text));
  if (!m) return null;
  let ord = 0;
  for (const ch of m[2]) ord = ord * 27 + (ch.charCodeAt(0) - 96);
  return Number(m[1]) + Math.min(ord, 99) / 100;
}

/**
 * § numbers must increase (a chapter or a top-level outline entry starts
 * a new act): a detected § heading that does not is text again. Also flags
 * pages whose § headings disagree with the § numbers of their running
 * heads. Returns the number of rejected headings.
 */
function checkParOrder(pages: PageModel[]): number {
  let last: number | null = null;
  let rejected = 0;
  for (const { line, page } of walk(pages)) {
    const h = line.heading;
    if (!h) continue;
    if (h.kind === "chapter" || (h.kind === "outline" && h.level === 1 && parNum(h.text) === null)) last = null;
    const n = h.kind === "par" || (h.kind === "outline" && parNum(h.text) !== null) ? parNum(h.text) : null;
    if (n === null) continue;
    if (h.source !== "outline" && last !== null && n <= last) {
      line.heading = null;
      unmerge(page, line);
      rejected++;
      page.flags |= PAGE_FLAGS.HEADING_UNSURE;
      continue;
    }
    last = n;
    const heads = page.heads.flatMap((t) => [...t.matchAll(/§\s*(\d{1,4})/g)].map((m) => Number(m[1])));
    if (heads.length && (Math.floor(n) < Math.min(...heads) || Math.floor(n) > Math.max(...heads))) page.flags |= PAGE_FLAGS.HEADING_UNSURE;
  }
  return rejected;
}

/** Lines merged into a rejected heading become body lines again. */
function unmerge(page: PageModel, line: Line): void {
  for (const seg of page.segments) {
    const i = seg.lines.indexOf(line);
    if (i < 0) continue;
    for (let k = i + 1; k < seg.lines.length && seg.lines[k].headingCont; k++) seg.lines[k].headingCont = false;
  }
}

// ─────────────────────────────────────────────────────────────── levels

function styleKey(line: Line): string {
  return `${Math.round(line.size * 2) / 2}|${line.bold ? 1 : 0}`;
}

/** "I. Obecně" → 1, "A. …" → 2, "1. …" → 3 below the §; null without such a prefix. */
function internalRank(text: string): number | null {
  if (/^[IVXLC]{1,6}\.\s/.test(text)) return 1;
  if (/^[A-Z]\.\s/.test(text)) return 2;
  if (/^\d{1,2}\.\s/.test(text)) return 3;
  return null;
}

function assignLevels(pages: PageModel[]): void {
  const headings = [...walk(pages)].filter((c) => c.line.heading).map((c) => c.line);
  const partsPresent = PART_ORDER.filter((w) =>
    headings.some((l) => l.heading!.kind === "part" && foldText(PART_RE.exec(collapseLetterSpacing(l.plain.trim()))?.[1] ?? "") === w),
  );
  const styleKeys = [...new Set(headings.filter((l) => l.heading!.kind === "style").map(styleKey))].sort((a, b) => {
    const [sa, ba] = a.split("|").map(Number);
    const [sb, bb] = b.split("|").map(Number);
    return sb - sa || bb - ba;
  });
  const rank = (l: Line) => styleKeys.indexOf(styleKey(l)) + 1;

  let structural = 0; // level of the last part / chapter / outline heading
  let ctxLevel = 0; // level a § nests under
  let inPar: { level: number; size: number } | null = null;
  for (const line of headings) {
    const h = line.heading!;
    switch (h.kind) {
      case "outline":
        if (parNum(h.text) !== null) inPar = { level: h.level, size: line.size };
        else {
          structural = ctxLevel = h.level;
          inPar = null;
        }
        break;
      case "part": {
        const word = foldText(PART_RE.exec(collapseLetterSpacing(line.plain.trim()))?.[1] ?? "");
        h.level = Math.min(6, partsPresent.indexOf(word) + 1);
        structural = ctxLevel = h.level;
        inPar = null;
        break;
      }
      case "chapter":
      case "special":
        h.level = h.kind === "chapter" ? Math.min(6, (partsPresent.length ? 2 : 1)) : 1;
        structural = ctxLevel = h.level;
        inPar = null;
        break;
      case "par":
      case "cl":
        h.level = Math.min(6, ctxLevel + 1);
        inPar = { level: h.level, size: line.size };
        break;
      case "style":
        if (inPar && line.size <= inPar.size + 0.5) {
          h.level = Math.min(6, inPar.level + (internalRank(h.text) ?? rank(line)));
        } else {
          h.level = Math.min(6, structural + rank(line));
          ctxLevel = h.level;
          inPar = null;
        }
        break;
    }
  }
}

// ─────────────────────────────────────────────────────────────── statute wording

/** Lines right after a § heading set at 0.8–0.97 × the body size are the provision's wording. */
function markQuotes(pages: PageModel[], stats: HeadingStats): void {
  let open = false;
  for (const { line } of walk(pages)) {
    if (line.headingCont) continue;
    if (line.heading) {
      open = line.heading.kind === "par" || (line.heading.kind === "outline" && parNum(line.heading.text) !== null);
      continue;
    }
    if (!open) continue;
    if (line.mn === null && line.size >= 0.8 * stats.bodySize && line.size <= 0.97 * stats.bodySize) line.quote = true;
    else open = false;
  }
}
