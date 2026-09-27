/**
 * Page furniture of the PDF layout engine: running heads and footers found
 * by GEOMETRY (a row at a stable y in the top or bottom band, set off from
 * the body by a gap, on ≥ 50 % of the pages — its text may change from
 * page to page, like chapter titles and § ranges), the printed page number
 * they carry, and repeated lines that are watermarks (the buyer's name and
 * e-mail) — never kept, never indexed. Pure — unit-tested through
 * layoutToDmd and tests/files-convert-pdf-geometry.test.ts.
 */

import { runsText } from "./geometry";
import type { Row } from "./model";
import { foldText, fromRoman, WATERMARK_RE } from "./text";

export interface PageRows {
  ord: number;
  width: number;
  height: number;
  rows: Row[];
}

export interface PrintedNumber {
  /** Arabic value, or null for a Roman numeral. */
  value: number | null;
  roman: string | null;
}

export interface Furniture {
  /** Rows removed as running heads / footers (with their page numbers). */
  removed: Set<Row>;
  /** Pure-number rows at the top or bottom edge not confirmed by the cluster: removed only if they match the label. */
  loose: Map<Row, PrintedNumber>;
  /** Printed page numbers read per physical page (a head and a footer may both carry one). */
  numbers: Map<number, PrintedNumber[]>;
  /** Running-head text per page (page number removed, watermarks excluded). */
  heads: Map<number, string[]>;
  /** Watermark rows removed (count). */
  watermarks: number;
}

const BAND = 0.16;

/**
 * Header/footer detection. Candidates per page: the top rows (≤ 2) above
 * the first gap ≥ 1.4 × lineGap inside the top 16 % of the page, and the
 * same at the bottom — not larger than the body text and not an outline
 * heading (`isHeading`). Candidates are clustered by y (± tolerance, 1.5 pt;
 * 3 pt for OCR); a cluster present on ≥ 50 % of the text pages (or of the
 * pages of one parity; at least 2) is furniture. Two pages are weak
 * evidence: then every row must carry a page number, or all repeat the
 * same text (digits masked). A bottom candidate that looks like the start of a footnote needs its
 * digit-masked text to repeat as well. Watermark text in the band is always
 * removed. Pure.
 */
export function detectFurniture(
  pages: PageRows[],
  lineGap: number,
  opts: { bodySize: number; tolerance?: number; isHeading?: (page: number, text: string) => boolean },
): Furniture {
  const tolerance = opts.tolerance ?? 1.5;
  // Running heads are set at or below the body size; a larger row at the
  // same y on every page is a heading that opens each page (short documents).
  const eligible = (page: number, row: Row) => row.size <= opts.bodySize + 0.5 && !opts.isHeading?.(page, runsText(row.runs));
  type Cand = { page: number; row: Row; band: "top" | "bottom" };
  const cands: Cand[] = [];
  const textPages = pages.filter((p) => p.rows.length);
  const removed = new Set<Row>();
  let watermarks = 0;

  for (const p of textPages) {
    const rows = p.rows;
    const gap = 1.4 * lineGap;
    const top: Row[] = [];
    for (let k = 0; k < Math.min(2, rows.length); k++) {
      if (rows[k].y > BAND * p.height) break;
      const below = k + 1 < rows.length ? rows[k + 1].y - rows[k].y : Infinity;
      if (below >= gap) {
        top.push(...rows.slice(0, k + 1));
        break;
      }
    }
    const bottom: Row[] = [];
    for (let k = 0; k < Math.min(2, rows.length); k++) {
      const idx = rows.length - 1 - k;
      if (rows[idx].y < (1 - BAND) * p.height) break;
      const above = idx > 0 ? rows[idx].y - rows[idx - 1].y : Infinity;
      if (above >= gap) {
        bottom.push(...rows.slice(idx));
        break;
      }
    }
    for (const row of top) if (eligible(p.ord, row)) cands.push({ page: p.ord, row, band: "top" });
    for (const row of bottom) if (!top.includes(row) && eligible(p.ord, row)) cands.push({ page: p.ord, row, band: "bottom" });
  }

  const loose = new Map<Row, PrintedNumber>();
  const numbers = new Map<number, PrintedNumber[]>();
  const heads = new Map<number, string[]>();
  const accept = (c: Cand) => {
    if (removed.has(c.row)) return;
    removed.add(c.row);
    const text = runsText(c.row.runs);
    if (WATERMARK_RE.test(text)) {
      watermarks++;
      return;
    }
    const num = pageNumberIn(text);
    if (num) numbers.set(c.page, [...(numbers.get(c.page) ?? []), num.number]);
    const head = (num ? num.rest : text).trim();
    if (head && /\p{L}/u.test(head)) heads.set(c.page, [...(heads.get(c.page) ?? []), head]);
  };

  const total = textPages.length;
  const byParity = [0, 1].map((k) => textPages.filter((p) => p.ord % 2 === k).length);
  for (const band of ["top", "bottom"] as const) {
    const list = cands.filter((c) => c.band === band).sort((a, b) => a.row.y - b.row.y);
    let i = 0;
    while (i < list.length) {
      let j = i;
      while (j < list.length && list[j].row.y - list[i].row.y <= 2 * tolerance) j++;
      const cluster = list.slice(i, j);
      i = j;
      const pagesIn = new Set(cluster.map((c) => c.page));
      const parity = new Set(cluster.map((c) => c.page % 2));
      const need = Math.max(2, Math.ceil(0.5 * total));
      const needParity = parity.size === 1 ? Math.max(2, Math.ceil(0.5 * byParity[[...parity][0]])) : Infinity;
      const masked = new Map<string, number>();
      for (const c of cluster) {
        const key = foldText(runsText(c.row.runs)).replace(/\d+/g, "#");
        masked.set(key, (masked.get(key) ?? 0) + 1);
      }
      let supported = pagesIn.size >= need || pagesIn.size >= needParity;
      if (supported && pagesIn.size < 3) {
        supported = cluster.every((c) => pageNumberIn(runsText(c.row.runs))) || [...masked.values()].some((n) => n === cluster.length);
      }
      for (const c of cluster) {
        const text = runsText(c.row.runs);
        if (WATERMARK_RE.test(text)) {
          accept(c);
          continue;
        }
        const num = pageNumberIn(text);
        if (supported) {
          const noteLike = band === "bottom" && (c.row.runs[0]?.sup || /^\d{1,4}\)?\s+\p{L}/u.test(text));
          const repeated = (masked.get(foldText(text).replace(/\d+/g, "#")) ?? 0) >= Math.max(2, 0.5 * cluster.length);
          if (!noteLike || repeated || (num && !num.rest.trim())) accept(c);
        } else if (num && !num.rest.trim()) loose.set(c.row, num.number);
      }
    }
  }
  return { removed, loose, numbers, heads, watermarks };
}

/**
 * The page number in a running head / footer text: the whole text ("245",
 * "– 245 –", "xii"), "s. 245" / "strana 3 z 10", "3/10", or a number at
 * the start or end ("245 Právní rozhledy", "§ 2913 Porušení… 1245").
 * Returns it with the rest of the text. Pure.
 */
export function pageNumberIn(text: string): { number: PrintedNumber; rest: string } | null {
  const t = text.trim();
  let m = /^[-–—.\s]*(\d{1,4})[-–—.\s]*$/.exec(t);
  if (m) return { number: { value: Number(m[1]), roman: null }, rest: "" };
  m = /^[-–—\s]*([ivxlcdm]{1,7})[-–—.\s]*$/i.exec(t);
  if (m && fromRoman(m[1]) !== null) return { number: { value: null, roman: m[1].toLowerCase() }, rest: "" };
  m = /^(.*?)(?:^|\s)(?:s\.|str\.|strana|page|seite)\s*(\d{1,4})(?:\s*(?:z|\/|of|von)\s*\d{1,4})?\s*$/i.exec(t);
  if (m) return { number: { value: Number(m[2]), roman: null }, rest: m[1] };
  m = /^(\d{1,4})\s*(?:\/|z|of)\s*\d{1,4}$/.exec(t);
  if (m) return { number: { value: Number(m[1]), roman: null }, rest: "" };
  m = /^(\d{1,4})\s+(\S.*)$/.exec(t);
  if (m && !/^(?:odst|písm|zák|Sb|č)\b/.test(m[2])) return { number: { value: Number(m[1]), roman: null }, rest: m[2] };
  m = /^(.*\S)\s+(\d{1,4})$/.exec(t);
  // "Hlava 2", "Kapitola 3", "§ 12", "čl. 4" name a division, not a page.
  if (m && !/(?:^|\s)(?:§|čl\.|odst\.|Sb\.|č\.|hlava|kapitola|díl|část|oddíl|článek|chapter|part|teil)$/iu.test(m[1])) {
    return { number: { value: Number(m[2]), roman: null }, rest: m[1] };
  }
  return null;
}

/**
 * Watermark rows outside the page furniture: the same text (≥ 6 chars,
 * compared folded, digits kept) at the same y (± 3 pt) on ≥ 50 % of the
 * text pages (at least 3), or text that names a licensee / e-mail on ≥ 2
 * pages. Returns the rows to remove. Pure.
 */
export function detectWatermarks(pages: PageRows[], skip: Set<Row>): Set<Row> {
  const byText = new Map<string, Row[]>();
  for (const p of pages) {
    for (const row of p.rows) {
      if (skip.has(row)) continue;
      const text = runsText(row.runs);
      if (text.length < 6) continue;
      const key = foldText(text).replace(/\s+/g, " ");
      byText.set(key, [...(byText.get(key) ?? []), row]);
    }
  }
  const total = pages.filter((p) => p.rows.length).length;
  const out = new Set<Row>();
  for (const [key, rows] of byText) {
    const pagesIn = new Set(rows.map((r) => r.page)).size;
    const ys = rows.map((r) => r.y);
    const stable = Math.max(...ys) - Math.min(...ys) <= 3;
    const flagged = WATERMARK_RE.test(key);
    if ((flagged && pagesIn >= 2) || (stable && pagesIn >= Math.max(3, Math.ceil(0.5 * total)))) for (const r of rows) out.add(r);
  }
  return out;
}
