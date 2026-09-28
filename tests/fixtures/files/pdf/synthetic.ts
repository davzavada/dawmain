/**
 * Hand-built PdfDocInput pages for the layout tests: a tiny "typesetter"
 * that turns lines of text into pdf.js-like items (one item per word,
 * width ≈ 0.5 em per character, viewport coordinates with y = baseline
 * from the top). `{12}` right after a word draws a superscript "12".
 */

import type { PdfDocInput, PdfItem, PdfPageInput } from "@/src/files/convert/pdf/types";

export const PAGE = { width: 595, height: 842 };
export const LEFT = 70;
export const RIGHT = 525;
export const BODY = 10;
export const GAP = 13;

export interface SynLine {
  y: number;
  text: string;
  x?: number;
  size?: number;
  bold?: boolean;
  font?: string;
  /** Stretch word spacing so the line ends at RIGHT (justified text). */
  justify?: boolean;
  /** Right edge used by `justify` (default RIGHT). */
  right?: number;
  rotated?: boolean;
  /** One item for the whole line instead of one per word. */
  single?: boolean;
}

const charW = (size: number) => 0.5 * size;

/** Items of one line. */
export function lineItems(l: SynLine): PdfItem[] {
  const size = l.size ?? BODY;
  const font = l.font ?? (l.bold ? "Serif-Bold" : "Serif");
  const base = { size, h: size, font, ...(l.bold ? { bold: true } : {}), ...(l.rotated ? { rotated: true } : {}) };
  if (l.single) {
    return [{ str: l.text, x: l.x ?? LEFT, y: l.y, w: l.text.length * charW(size), ...base }];
  }
  const words = l.text.split(" ").filter(Boolean);
  const tokens = words.map((w) => {
    const m = /^(.*?)\{([^}]+)\}(.*)$/.exec(w);
    return m ? { word: m[1], sup: m[2], after: m[3] } : { word: w, sup: null, after: "" };
  });
  const supSize = Math.round(size * 0.6 * 100) / 100;
  const widthOf = (t: (typeof tokens)[number]) => (t.word.length + t.after.length) * charW(size) + (t.sup ? t.sup.length * charW(supSize) : 0);
  const natural = tokens.reduce((n, t) => n + widthOf(t), 0);
  const space = charW(size) * 0.5;
  let gap = space;
  const x0 = l.x ?? LEFT;
  if (l.justify && tokens.length > 1) gap = Math.max(space, ((l.right ?? RIGHT) - x0 - natural) / (tokens.length - 1));
  const items: PdfItem[] = [];
  let x = x0;
  for (const t of tokens) {
    if (t.word) {
      items.push({ str: t.word, x, y: l.y, w: t.word.length * charW(size), ...base });
      x += t.word.length * charW(size);
    }
    if (t.sup) {
      items.push({ str: t.sup, x, y: l.y - 0.35 * size, w: t.sup.length * charW(supSize), size: supSize, h: supSize, font });
      x += t.sup.length * charW(supSize);
    }
    if (t.after) {
      items.push({ str: t.after, x, y: l.y, w: t.after.length * charW(size), ...base });
      x += t.after.length * charW(size);
    }
    x += gap;
  }
  return items;
}

export function synPage(ord: number, lines: SynLine[], size = PAGE): PdfPageInput {
  return { ord, width: size.width, height: size.height, items: lines.flatMap(lineItems) };
}

export function synDoc(pages: PdfPageInput[], extra: Partial<PdfDocInput> = {}): PdfDocInput {
  return { pages, pageLabels: null, outline: [], info: {}, ocr: false, ...extra };
}

/**
 * A paragraph: consecutive lines `GAP` apart from `y`, justified except the
 * last; `indent` shifts the first line. Returns the lines and the next y.
 */
export function para(y: number, lines: string[], opts: { indent?: number; size?: number; gap?: number; x?: number; last?: "short" | "full" } = {}): SynLine[] {
  const size = opts.size ?? BODY;
  const gap = opts.gap ?? (GAP * size) / BODY;
  return lines.map((text, i) => ({
    y: y + i * gap,
    text,
    size,
    x: (opts.x ?? LEFT) + (i === 0 ? (opts.indent ?? 0) : 0),
    justify: i < lines.length - 1 || opts.last === "full",
  }));
}

/** Filler body text: `n` justified lines of plain Czech prose starting at y. */
export function filler(y: number, n: number, seed = 0, opts: { size?: number; x?: number; right?: number } = {}): SynLine[] {
  const words = "soud dovodil že odpovědnost za škodu vzniká porušením povinnosti a musí být prokázána příčinná souvislost mezi jednáním a vzniklou újmou".split(" ");
  const size = opts.size ?? BODY;
  const out: SynLine[] = [];
  for (let i = 0; i < n; i++) {
    const w: string[] = [];
    let k = (seed * 7 + i * 3) % words.length;
    const max = Math.floor(((opts.right ?? RIGHT) - (opts.x ?? LEFT)) / charW(size)) - 12;
    while (w.join(" ").length < max) w.push(words[k++ % words.length]);
    out.push({ y: y + i * ((GAP * size) / BODY), text: w.join(" "), size, x: opts.x, justify: true, right: opts.right });
  }
  return out;
}
