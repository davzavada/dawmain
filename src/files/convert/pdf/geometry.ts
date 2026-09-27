/**
 * Geometry stage of the PDF layout engine: text items → runs → rows (one
 * baseline) with superscripts attached, document statistics (body size,
 * line spacing, bold share, text edges), marginal-number candidates, the
 * two-column split (one gutter per band) and the lines of each column.
 * Pure — unit-tested (tests/files-convert-pdf-geometry.test.ts) and through
 * layoutToDmd.
 */

import type { Line, Part, Row, Run, Segment } from "./model";
import type { PdfPageInput } from "./types";
import { cleanText, collectHyphenated, splitSuperscripts } from "./text";

/** A string that can be a footnote label when raised: "12", "4)", "a", "*", "†". */
const LABELISH_RE = /^(?:\d{1,4}\)?|[a-zA-Z]{1,2}\)?|\*{1,3}|†{1,2})$/;
const MARGIN_NUMBER_RE = /^\d{1,3}[a-z]?$/;

// ─────────────────────────────────────────────────────────────── rows

export interface RowsResult {
  rows: Row[];
  /** Rotated / vertical items dropped (watermarks, spine text). */
  rotated: number;
  /** Characters of all non-empty items (scan check). */
  rawChars: number;
  /** All item text, joined (stop-word and private-use checks). */
  rawText: string;
}

/**
 * Items of one page → rows sorted top to bottom. Empty and off-page items
 * are dropped, rotated ones counted and dropped (never indexed: they are
 * watermarks or spine text), text drawn twice for fake bold is deduplicated.
 * A run joins the row whose baseline is within 0.3 × size; a raised run —
 * smaller than its line and lifted ≥ 0.12 × the line size, or label-like
 * and lifted ≥ 0.25 × — is a superscript, also when it formed a row of its
 * own right above the line (then it moves into that line). Pure.
 */
export function buildRows(page: PdfPageInput): RowsResult {
  let rotated = 0;
  let rawChars = 0;
  const texts: string[] = [];
  const runs: Run[] = [];
  for (const it of page.items) {
    const raw = typeof it.str === "string" ? it.str : "";
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const size = it.size > 0 && Number.isFinite(it.size) ? it.size : it.h > 0 ? it.h : 0;
    if (!size || !Number.isFinite(it.x) || !Number.isFinite(it.y)) continue;
    if (it.rotated) {
      rotated++;
      continue;
    }
    const w = Number.isFinite(it.w) && it.w > 0 ? it.w : trimmed.length * size * 0.5;
    if (it.x > page.width + 2 || it.x + w < -2 || it.y < -2 || it.y - size > page.height + 2) continue;
    rawChars += trimmed.length;
    texts.push(trimmed);
    runs.push({
      str: cleanText(trimmed),
      x: it.x,
      x1: it.x + w,
      y: it.y,
      size,
      font: it.font || "",
      bold: it.bold === true || /bold|black|heavy|semibold|demi/i.test(it.font || ""),
      sup: false,
      spaceBefore: /^\s/.test(raw),
      spaceAfter: /\s$/.test(raw),
    });
  }

  runs.sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: Run[][] = [];
  let rowY = 0;
  let rowSize = 0;
  for (const run of runs) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(run.y - rowY) <= 0.3 * Math.max(run.size, rowSize)) {
      last.push(run);
      if (run.size > rowSize) {
        rowSize = run.size;
        rowY = run.y;
      }
    } else {
      groups.push([run]);
      rowY = run.y;
      rowSize = run.size;
    }
  }

  let rows = groups.map((g) => makeRow(page.ord, g));
  rows = attachSuperscriptRows(rows);
  return { rows, rotated, rawChars, rawText: texts.join(" ") };
}

/** Row from runs: dominant size and baseline, superscripts marked, fake-bold duplicates removed. */
function makeRow(page: number, runs: Run[]): Row {
  const size = dominantSize(runs);
  const main = runs.filter((r) => Math.abs(r.size - size) <= 0.5);
  const ys = main.map((r) => r.y).sort((a, b) => a - b);
  const y = ys.length ? ys[Math.floor(ys.length / 2)] : runs[0].y;
  for (const r of runs) r.sup = isRaised(r, y, size);
  const sorted = dedupe([...runs].sort((a, b) => a.x - b.x));
  return { page, runs: sorted, y, size, x0: sorted[0].x, x1: Math.max(...sorted.map((r) => r.x1)) };
}

function isRaised(run: Run, lineY: number, lineSize: number): boolean {
  const lift = lineY - run.y;
  if (run.size <= 0.85 * lineSize && lift >= 0.12 * lineSize && lift <= 0.8 * lineSize) return true;
  return run.size <= lineSize + 0.01 && lift >= 0.25 * lineSize && lift <= 0.8 * lineSize && LABELISH_RE.test(run.str.trim());
}

/** Text drawn twice (fake bold, shadow): same string within 1 pt. */
function dedupe(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const dup = out.some((o) => o.str === r.str && Math.abs(o.x - r.x) < 1 && Math.abs(o.y - r.y) < 1);
    if (!dup) out.push(r);
  }
  return out;
}

/** Character-weighted mode of run sizes in 0.25 pt buckets (ties → the larger). */
export function dominantSize(runs: Array<{ str: string; size: number }>): number {
  const weights = new Map<number, number>();
  for (const r of runs) {
    const b = Math.round(r.size * 4) / 4;
    weights.set(b, (weights.get(b) ?? 0) + Math.max(1, r.str.length));
  }
  let best = 0;
  let bestW = -1;
  for (const [b, w] of weights) if (w > bestW || (w === bestW && b > best)) [best, bestW] = [b, w];
  return best;
}

/**
 * A row made only of small raised-looking runs right above a line (within
 * 0.75 × its size, horizontally inside it) is that line's superscripts.
 */
function attachSuperscriptRows(rows: Row[]): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const next = rows[i + 1];
    if (next) {
      const lift = next.y - row.y;
      const stays: Run[] = [];
      for (const run of row.runs) {
        const small = run.size <= 0.85 * next.size || (run.size <= next.size + 0.01 && LABELISH_RE.test(run.str.trim()));
        const liftOk = lift >= 0.12 * next.size && lift <= 0.75 * next.size;
        // A note label may sit well left of its line's text (label, then a tab).
        const inside = run.x >= next.x0 - 2.5 * next.size && run.x <= next.x1 + next.size;
        if (small && liftOk && inside) {
          run.sup = true;
          next.runs.push(run);
        } else stays.push(run);
      }
      if (stays.length !== row.runs.length) {
        next.runs = dedupe(next.runs.sort((a, b) => a.x - b.x));
        next.x0 = Math.min(next.x0, next.runs[0].x);
        next.x1 = Math.max(next.x1, ...next.runs.map((r) => r.x1));
        if (!stays.length) continue;
        rows[i] = makeRow(row.page, stays);
      }
    }
    out.push(rows[i]);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── text of runs

/** A space between two runs: the extracted text had one, or the gap is wider than ~0.18 em. */
export function needsSpace(prev: Run, next: Run): boolean {
  if (prev.spaceAfter || next.spaceBefore) return true;
  const gap = next.x - prev.x1;
  if (next.sup) return gap > 0.3 * prev.size;
  const size = prev.sup ? next.size : Math.max(prev.size, next.size);
  return gap > 0.18 * size;
}

/** Plain text of runs in x order (superscripts included unless `withSup` is false). Pure. */
export function runsText(runs: Run[], withSup = true): string {
  let out = "";
  let prev: Run | null = null;
  for (const r of runs) {
    if (!withSup && r.sup) continue;
    if (prev && needsSpace(prev, r)) out += " ";
    out += r.str.trim();
    prev = r;
  }
  return out.trim();
}

/**
 * Runs → parts: text with spaces by geometry, superscript runs and Unicode
 * superscript digits as `sup` parts (adjacent ones merged). Pure.
 */
export function runsToParts(runs: Run[]): Part[] {
  const parts: Part[] = [];
  const pushText = (s: string) => {
    if (!s) return;
    const last = parts[parts.length - 1];
    if (last?.t === "text") last.s += s;
    else parts.push({ t: "text", s });
  };
  const pushSup = (s: string) => {
    const last = parts[parts.length - 1];
    if (last?.t === "sup") last.s += s;
    else parts.push({ t: "sup", s });
  };
  let prev: Run | null = null;
  for (const r of runs) {
    if (prev && needsSpace(prev, r)) pushText(" ");
    const s = r.str.trim();
    if (r.sup) pushSup(s);
    else for (const piece of splitSuperscripts(s)) piece.sup ? pushSup(piece.s) : pushText(piece.s);
    prev = r;
  }
  return parts;
}

// ─────────────────────────────────────────────────────────────── statistics

export interface BodyStats {
  /** Font size of the body text. */
  bodySize: number;
  /** Baseline distance of consecutive body lines. */
  lineGap: number;
  /** Share of body-size characters set in bold (bold headings need it low). */
  boldShare: number;
}

/**
 * Body size (character-weighted mode of run sizes), line spacing (mode of
 * baseline gaps between consecutive body-size rows) and bold share, over at
 * most `sample` pages spread through the document. Pure.
 */
export function bodyStats(pages: Row[][], sample = 60): BodyStats {
  const withText = pages.filter((rows) => rows.length);
  const step = Math.max(1, withText.length / sample);
  const picked: Row[][] = [];
  for (let i = 0; i < withText.length && picked.length < sample; i += step) picked.push(withText[Math.floor(i)]);

  const allRuns = picked.flat().flatMap((row) => row.runs.filter((r) => !r.sup));
  const bodySize = allRuns.length ? dominantSize(allRuns) : 10;

  const gaps = new Map<number, number>();
  for (const rows of picked) {
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      if (Math.abs(a.size - bodySize) > 0.5 || Math.abs(b.size - bodySize) > 0.5) continue;
      const gap = b.y - a.y;
      if (gap < 0.8 * bodySize || gap > 2.5 * bodySize) continue;
      const key = Math.round(gap * 4) / 4;
      gaps.set(key, (gaps.get(key) ?? 0) + 1);
    }
  }
  let lineGap = 0;
  let best = 0;
  for (const [gap, n] of gaps) if (n > best || (n === best && gap < lineGap)) [lineGap, best] = [gap, n];
  if (!lineGap) lineGap = Math.round(bodySize * 1.2 * 4) / 4;

  let bodyChars = 0;
  let boldChars = 0;
  for (const r of allRuns) {
    if (Math.abs(r.size - bodySize) > 0.5) continue;
    bodyChars += r.str.length;
    if (r.bold) boldChars += r.str.length;
  }
  return { bodySize, lineGap, boldShare: bodyChars ? boldChars / bodyChars : 0 };
}

export interface Edges {
  left: number;
  right: number;
}

/**
 * Left and right edges of the text block per page parity (books mirror
 * their margins): the 20th percentile of line starts and the 80th of line
 * ends, over body-size rows with ≥ 20 characters, ignoring runs without a
 * letter (marginal numbers). A parity with fewer than 12 such rows uses
 * both parities; a document without any uses each page's own extent. Pure.
 */
export function textEdges(pages: Array<{ ord: number; rows: Row[]; width: number }>, bodySize: number): (ord: number) => Edges {
  const starts: [number[], number[]] = [[], []];
  const ends: [number[], number[]] = [[], []];
  for (const p of pages) {
    for (const row of p.rows) {
      if (Math.abs(row.size - bodySize) > 0.6) continue;
      const main = row.runs.filter((r) => !r.sup && /\p{L}/u.test(r.str));
      if (main.reduce((n, r) => n + r.str.length, 0) < 20) continue;
      starts[p.ord % 2].push(Math.min(...main.map((r) => r.x)));
      ends[p.ord % 2].push(Math.max(...main.map((r) => r.x1)));
    }
  }
  const pct = (xs: number[], q: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  };
  const both = { s: [...starts[0], ...starts[1]], e: [...ends[0], ...ends[1]] };
  const byParity: Array<Edges | null> = [0, 1].map((k) => {
    const s = starts[k].length >= 12 ? starts[k] : both.s;
    const e = ends[k].length >= 12 ? ends[k] : both.e;
    return s.length ? { left: pct(s, 0.2), right: pct(e, 0.8) } : null;
  });
  const own = new Map(pages.map((p) => [p.ord, p]));
  return (ord: number) => {
    const edges = byParity[ord % 2];
    if (edges) return edges;
    const page = own.get(ord);
    const runs = (page?.rows ?? []).flatMap((r) => r.runs.filter((x) => /\p{L}/u.test(x.str)));
    if (!runs.length) return { left: 0, right: page?.width ?? 0 };
    return { left: Math.min(...runs.map((r) => r.x)), right: Math.max(...runs.map((r) => r.x1)) };
  };
}

// ─────────────────────────────────────────────────────────────── margins

/**
 * Take marginal-number candidates out of the rows: a run of 1–3 digits
 * (optionally a letter) lying entirely outside the text edges. A row made
 * only of such runs is attached to the nearest row within 0.8 × its size.
 * Returns the number per row; the runs are removed from the rows. Other
 * margin text stays in its row (text is never dropped). Pure.
 */
export function takeMarginNumbers(rows: Row[], edges: Edges): Map<Row, { value: string; side: "left" | "right" }> {
  const found = new Map<Row, { value: string; side: "left" | "right" }>();
  const orphans: Array<{ y: number; size: number; value: string; side: "left" | "right" }> = [];
  for (const row of rows) {
    const keep: Run[] = [];
    let mn: { value: string; side: "left" | "right" } | null = null;
    for (const r of row.runs) {
      const s = r.str.trim();
      const side = r.x1 < edges.left - 3 ? "left" : r.x > edges.right + 3 ? "right" : null;
      if (side && !r.sup && !mn && MARGIN_NUMBER_RE.test(s)) mn = { value: s, side };
      else keep.push(r);
    }
    if (!mn) continue;
    row.runs = keep;
    if (keep.length) {
      row.x0 = keep[0].x;
      row.x1 = Math.max(...keep.map((r) => r.x1));
      found.set(row, mn);
    } else orphans.push({ y: row.y, size: row.size, ...mn });
  }
  const live = rows.filter((r) => r.runs.length);
  for (const o of orphans) {
    let best: Row | null = null;
    for (const row of live) {
      const d = Math.abs(row.y - o.y);
      if (d <= 0.8 * Math.max(o.size, row.size) && !found.has(row) && (!best || d < Math.abs(best.y - o.y))) best = row;
    }
    if (best) found.set(best, { value: o.value, side: o.side });
    else {
      // Nothing beside it: keep the number as a text row of its own.
      live.push({ page: rows[0]?.page ?? 0, runs: [numberRun(o)], y: o.y, size: o.size, x0: 0, x1: 0 });
    }
  }
  rows.length = 0;
  rows.push(...live.sort((a, b) => a.y - b.y));
  return found;
}

function numberRun(o: { y: number; size: number; value: string }): Run {
  return { str: o.value, x: 0, x1: o.value.length * o.size * 0.5, y: o.y, size: o.size, font: "", bold: false, sup: false, spaceBefore: false, spaceAfter: false };
}

// ─────────────────────────────────────────────────────────────── columns

export interface ColumnResult {
  /** Row groups in reading order; a two-column band yields two segments. */
  segments: Array<{ band: number; col: number; left: number; right: number; rows: Array<{ row: Row; runs: Run[] }> }>;
  columns: boolean;
  /** A split was made on weak evidence (< 60 % of the band's rows have text on both sides). */
  unsure: boolean;
}

/** Row → covered x-intervals, bridging word gaps narrower than 0.8 em. */
function spans(row: Row): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const r of row.runs) {
    const last = out[out.length - 1];
    if (last && r.x - last[1] < 0.8 * row.size) last[1] = Math.max(last[1], r.x1);
    else out.push([r.x, r.x1]);
  }
  return out;
}

/**
 * Two-column detection (one vertical gutter per band): the x in the middle
 * 40 % of the text block covered by the fewest rows is the gutter
 * candidate; rows crossing it cut the page into bands; a band of ≥ 3 rows
 * with a gutter ≥ max(7 pt, 0.8 em), ≥ 3 rows on each side, a right
 * column with a common left edge, and text on both sides — in ≥ 30 % of
 * its rows, or (baselines of the columns not aligned) in two blocks side
 * by side — is read left column first. Pure.
 */
export function splitColumns(rows: Row[], edges: Edges, enabled: boolean): ColumnResult {
  const single = (): ColumnResult => ({
    segments: rows.length ? [{ band: 0, col: 0, left: edges.left, right: edges.right, rows: rows.map((row) => ({ row, runs: row.runs })) }] : [],
    columns: false,
    unsure: false,
  });
  const width = edges.right - edges.left;
  if (!enabled || rows.length < 4 || width <= 0) return single();

  const rowSpans = rows.map(spans);
  const covers = (i: number, x: number) => rowSpans[i].some(([a, b]) => a - 0.5 <= x && x <= b + 0.5);
  const lo = Math.ceil(edges.left + 0.3 * width);
  const hi = Math.floor(edges.left + 0.7 * width);
  // Fast path (almost every page of a book): most rows run through the whole middle.
  const through = rowSpans.filter((sp) => sp.some(([a, b]) => a - 0.5 <= lo && hi <= b + 0.5)).length;
  if (through >= 0.8 * rows.length) return single();
  const mid = edges.left + width / 2;
  // Rows NOT covering each x of [lo, hi], from the gaps between spans (a difference array).
  const open = new Int32Array(hi - lo + 2);
  for (const sp of rowSpans) {
    const gaps: Array<[number, number]> = [[-Infinity, sp[0][0]], ...sp.slice(1).map((s, k): [number, number] => [sp[k][1], s[0]]), [sp[sp.length - 1][1], Infinity]];
    for (const [a, b] of gaps) {
      const from = Math.max(lo, Math.floor(a + 0.5) + 1);
      const to = Math.min(hi, Math.ceil(b - 0.5) - 1);
      if (from > to) continue;
      open[from - lo]++;
      open[to - lo + 1]--;
    }
  }
  let gx = -1;
  let gCover = Infinity;
  for (let x = lo, run = 0; x <= hi; x++) {
    run += open[x - lo];
    const c = rows.length - run;
    if (c < gCover || (c === gCover && Math.abs(x - mid) < Math.abs(gx - mid))) [gx, gCover] = [x, c];
  }
  if (gx < 0 || gCover >= 0.8 * rows.length) return single();

  type Seg = ColumnResult["segments"][number];
  const segments: Seg[] = [];
  let columns = false;
  let unsure = false;
  let band = 0;
  const flat: Array<{ row: Row; runs: Run[] }> = [];
  const flushFlat = () => {
    if (!flat.length) return;
    segments.push({ band: band++, col: 0, left: edges.left, right: edges.right, rows: flat.splice(0) });
  };

  let i = 0;
  while (i < rows.length) {
    if (covers(i, gx)) {
      flat.push({ row: rows[i], runs: rows[i].runs });
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && !covers(j, gx)) j++;
    const bandRows = rows.slice(i, j);
    const split = bandRows.length >= 3 ? tryGutter(bandRows, gx) : null;
    if (split) {
      flushFlat();
      columns = true;
      if (split.unsure) unsure = true;
      segments.push({ band, col: 0, left: edges.left, right: split.leftEnd, rows: split.left });
      segments.push({ band: band++, col: 1, left: split.rightStart, right: edges.right, rows: split.right });
    } else for (const row of bandRows) flat.push({ row, runs: row.runs });
    i = j;
  }
  flushFlat();
  return { segments, columns, unsure };
}

function tryGutter(rows: Row[], gx: number) {
  let leftEnd = -Infinity;
  let rightStart = Infinity;
  let both = 0;
  let leftRows = 0;
  let rightRows = 0;
  const left: Array<{ row: Row; runs: Run[] }> = [];
  const right: Array<{ row: Row; runs: Run[] }> = [];
  let size = 0;
  for (const row of rows) {
    const l = row.runs.filter((r) => (r.x + r.x1) / 2 < gx);
    const r = row.runs.filter((r) => (r.x + r.x1) / 2 >= gx);
    size = Math.max(size, row.size);
    if (l.length) {
      leftRows++;
      leftEnd = Math.max(leftEnd, ...l.map((x) => x.x1));
      left.push({ row, runs: l });
    }
    if (r.length) {
      rightRows++;
      rightStart = Math.min(rightStart, ...r.map((x) => x.x));
      right.push({ row, runs: r });
    }
    if (l.length && r.length) both++;
  }
  const ratio = both / rows.length;
  // Two lines whose wide word gaps happen to line up are not a column.
  if (leftRows < 3 || rightRows < 3 || rightStart - leftEnd < Math.max(7, 0.8 * size)) return null;
  // Side by side, not one block above the other: the two sides' vertical
  // extents overlap (baselines of the columns need not line up).
  const extent = (side: Array<{ row: Row }>) => [side[0].row.y, side[side.length - 1].row.y];
  const [lTop, lBottom] = extent(left);
  const [rTop, rBottom] = extent(right);
  const overlap = Math.min(lBottom, rBottom) - Math.max(lTop, rTop);
  if (ratio < 0.3 && overlap < 0.5 * Math.min(lBottom - lTop, rBottom - rTop)) return null;
  // A real right column has a common left edge (paragraph indents aside); a
  // loosely justified short line split at a wide word gap does not.
  const aligned = right.filter(({ runs }) => Math.min(...runs.map((r) => r.x)) - rightStart <= 1.5 * size).length;
  if (aligned < 0.6 * right.length) return null;
  return { left, right, leftEnd, rightStart, unsure: ratio < 0.3 ? overlap < 0.8 * Math.min(lBottom - lTop, rBottom - rTop) : ratio < 0.6 };
}

// ─────────────────────────────────────────────────────────────── lines

/**
 * One row's runs in one column → a Line: parts, text, extent, dominant
 * style, the bold-lead m. č. candidate and the TOC "far page number" cue.
 * Pure.
 */
export function makeLine(page: number, seg: number, runs: Run[], col: { left: number; right: number }, mn: string | null): Line {
  const main = runs.filter((r) => !r.sup);
  const style = main.length ? main : runs;
  const size = dominantSize(style);
  const chars = style.reduce((n, r) => n + r.str.length, 0);
  const boldChars = style.filter((r) => r.bold).reduce((n, r) => n + r.str.length, 0);
  const fonts = new Map<string, number>();
  for (const r of style) fonts.set(r.font, (fonts.get(r.font) ?? 0) + r.str.length);
  const font = [...fonts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const ys = style.map((r) => r.y).sort((a, b) => a - b);

  let boldLead: string | null = null;
  if (main.length >= 2 && main[0].bold && /^\d{1,3}$/.test(main[0].str.trim()) && !main[1].bold) boldLead = main[0].str.trim();

  let gapTail = false;
  if (main.length >= 2) {
    const last = main[main.length - 1];
    const prev = main[main.length - 2];
    gapTail = /^[\divxlcdm]{1,6}$/i.test(last.str.trim()) && last.x - prev.x1 > 2 * size;
  }

  return {
    page,
    seg,
    parts: runsToParts(runs),
    text: runsText(runs, true),
    plain: runsText(runs, false),
    x0: Math.min(...runs.map((r) => r.x)),
    x1: Math.max(...runs.map((r) => r.x1)),
    y: ys[Math.floor(ys.length / 2)] ?? runs[0].y,
    size,
    bold: chars > 0 && boldChars / chars > 0.6,
    font,
    colLeft: col.left,
    colRight: col.right,
    mn,
    boldLead,
    gapTail,
    heading: null,
    headingCont: false,
    quote: false,
  };
}

/** Segments of lines for a page. Pure. */
export function buildSegments(columns: ColumnResult, page: number, mns: Map<Row, { value: string; side: "left" | "right" }>): Segment[] {
  const segments: Segment[] = [];
  const colsOf = new Map<Row, number>();
  for (const s of columns.segments) for (const { row } of s.rows) colsOf.set(row, (colsOf.get(row) ?? 0) + 1);
  for (const s of columns.segments) {
    const seg = segments.length;
    const lines: Line[] = [];
    for (const { row, runs } of s.rows) {
      if (!runs.length) continue;
      const mn = mns.get(row);
      // A row split between two columns: the margin number belongs to the column on its side.
      const own = mn && ((colsOf.get(row) ?? 1) === 1 || (mn.side === "left" ? s.col === 0 : s.col === 1)) ? mn.value : null;
      lines.push(makeLine(page, seg, runs, s, own));
    }
    if (lines.length) segments.push({ band: s.band, col: s.col, left: s.left, right: s.right, lines });
  }
  return segments;
}

/** Hyphenated compounds written mid-line anywhere in the body. Pure. */
export function hyphenDictionary(lines: Iterable<Line>): Set<string> {
  const dict = new Set<string>();
  for (const line of lines) {
    // Leave out the line-end fragment ("povin-"): it is the split word itself.
    const text = line.plain;
    const cut = /[-\u2010\u2011]$/.test(text) ? text.lastIndexOf(" ") + 1 : text.length;
    collectHyphenated(text.slice(0, cut), dict);
  }
  return dict;
}
