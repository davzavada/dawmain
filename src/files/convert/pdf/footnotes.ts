/**
 * Footnotes of the PDF layout engine:
 * - the document's footnote size: the character-weighted mode of sizes of
 *   0.6–0.92 × the body size found below the last body line of a page, on
 *   ≥ 8 % of the text pages (else the document has no footnotes);
 * - per page, the zone: the lines at the bottom of each column of the last
 *   band set in that size, separated from the body above by ≥ a line gap;
 * - notes: a zone line starts a note when it opens with a label — a
 *   superscript, "12 " or "4) " when it is 1, the previous label + 1 or the
 *   label of a reference on the page; zone lines before the first label
 *   continue the previous page's last note;
 * - references: superscripts that read as labels (also "¹²", "4)", "1,2"),
 *   plus digits glued to a word when they equal a still-unmatched note
 *   label on the page (superior figures set without raise);
 * - binding: each note to the first unbound reference with its label on
 *   the page. A page binding < 50 % with labels that do not run
 *   consecutively is unsure: nothing is split, the zone stays text at the
 *   page end (flag FN_UNSURE). A small-type block with no label-like line
 *   start is not a zone at all (no flag) unless it continues an open note.
 * Pure — unit-tested through layoutToDmd (tests/files-convert-pdf-layout.test.ts).
 */

import type { Line, Note, Part, Row } from "./model";
import { endsTerminal, normalizeLabel, refLabels } from "./text";

/** The footnote font size of the document, or null. Pure. */
export function footnoteSize(pages: Row[][], bodySize: number): number | null {
  const weights = new Map<number, number>();
  let fnPages = 0;
  let textPages = 0;
  for (const rows of pages) {
    if (!rows.length) continue;
    textPages++;
    let lastBody = -1;
    for (let i = 0; i < rows.length; i++) if (Math.abs(rows[i].size - bodySize) <= 0.5) lastBody = i;
    if (lastBody < 0) continue;
    let found = false;
    for (const row of rows.slice(lastBody + 1)) {
      if (row.size < 0.6 * bodySize || row.size > 0.92 * bodySize) continue;
      found = true;
      const key = Math.round(row.size * 4) / 4;
      const chars = row.runs.reduce((n, r) => n + r.str.length, 0);
      weights.set(key, (weights.get(key) ?? 0) + chars);
    }
    if (found) fnPages++;
  }
  if (!fnPages || fnPages < 0.08 * textPages) return null;
  let best = 0;
  let bestW = -1;
  for (const [size, w] of weights) if (w > bestW) [best, bestW] = [size, w];
  return best;
}

/** Line set in the footnote size. */
export function isNoteSized(line: Line, fnSize: number): boolean {
  return Math.abs(line.size - fnSize) <= Math.max(0.6, 0.08 * fnSize);
}

/**
 * Candidate zone of a page: in each segment (a column of a band), the
 * trailing lines set in the footnote size, when nothing but note-size text
 * lies below them in their column's x-range anywhere on the page (notes
 * under two columns, or per column), and the nearest body line above them
 * is ≥ 0.98 × lineGap higher. Returns [segment index, first zone line
 * index] pairs; nothing is removed. Pure.
 */
export function zoneCandidates(
  segments: Array<{ left: number; right: number; lines: Line[] }>,
  fnSize: number,
  lineGap: number,
): Array<[number, number]> {
  const all = segments.flatMap((s) => s.lines);
  const out: Array<[number, number]> = [];
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    let k = seg.lines.length;
    while (k > 0 && isNoteSized(seg.lines[k - 1], fnSize)) k--;
    if (k === seg.lines.length) continue;
    const top = seg.lines[k].y;
    const overlaps = (l: Line) => l.x1 > seg.left && l.x0 < seg.right;
    if (all.some((l) => l.y > top && overlaps(l) && !isNoteSized(l, fnSize))) continue;
    let above: Line | null = k > 0 ? seg.lines[k - 1] : null;
    if (!above) {
      for (const l of all) if (l.y < top && !isNoteSized(l, fnSize) && (!above || l.y > above.y)) above = l;
    }
    if (!above || top - above.y < 0.98 * lineGap) continue;
    out.push([si, k]);
  }
  return out;
}

/**
 * Turn label-like superscripts of body lines into reference parts, in
 * reading order. Returns the reference parts. Mutates `lines[i].parts`.
 */
export function collectRefs(lines: Line[]): Array<Extract<Part, { t: "ref" }>> {
  const refs: Array<Extract<Part, { t: "ref" }>> = [];
  for (const line of lines) {
    const parts: Part[] = [];
    for (const p of line.parts) {
      const labels = p.t === "sup" ? refLabels(p.s) : null;
      if (p.t !== "sup" || !labels) {
        parts.push(p);
        continue;
      }
      const raw = labels.length === 1 ? p.s : null;
      for (const label of labels) {
        const ref = { t: "ref" as const, label, raw: raw ?? label, note: null };
        parts.push(ref);
        refs.push(ref);
      }
    }
    line.parts = parts;
  }
  return refs;
}

interface LabelStart {
  label: string;
  rest: Part[];
  sup: boolean;
}

/**
 * The label a zone line starts with, if it may start a note here: a
 * superscript label always; a same-size "12 " / "4) " / "* " only when it
 * is 1, the previous label + 1, the label of a reference on the page, or
 * (`glued`) digits glued to a word of the page's text. Pure.
 */
export function labelStart(
  line: Line,
  prevLabel: string | null,
  pageRefLabels: ReadonlySet<string>,
  glued: (label: string) => boolean = () => false,
): LabelStart | null {
  const [first, ...more] = line.parts;
  if (!first) return null;
  if (first.t === "sup" || first.t === "ref") {
    const labels = first.t === "sup" ? refLabels(first.s) : [first.label];
    if (labels?.length !== 1) return null;
    return { label: labels[0], rest: trimStart(more), sup: true };
  }
  if (first.t !== "text") return null;
  // "12 Srov.", "4) Viz", "4)Viz", "* Autor…" — no lookbehind (older Safari runs this too).
  const m = /^\s*(\d{1,4}\)|\d{1,4}(?=\s)|\*{1,3}(?=\s)|†{1,2}(?=\s))\s*/.exec(first.s);
  if (!m) return null;
  const label = normalizeLabel(m[1]);
  if (!label) return null;
  const expected =
    pageRefLabels.has(label) ||
    label === "1" ||
    (prevLabel !== null && /^\d+$/.test(prevLabel) && /^\d+$/.test(label) && Number(label) === Number(prevLabel) + 1) ||
    (/^\d{1,3}$/.test(label) && glued(label));
  if (!expected) return null;
  const rest: Part[] = [{ t: "text", s: first.s.slice(m[0].length) }, ...more];
  return { label, rest: trimStart(rest), sup: false };
}

function trimStart(parts: Part[]): Part[] {
  const out = [...parts];
  while (out.length && out[0].t === "text" && !out[0].s.trim()) out.shift();
  if (out[0]?.t === "text") out[0] = { t: "text", s: out[0].s.replace(/^\s+/, "") };
  return out;
}

export interface PageNotes {
  /** Notes starting on this page (bound or dangling). */
  notes: Note[];
  /** Zone text kept as body text at the page end. */
  endText: Line[];
  /** The zone was accepted (its lines leave the body). */
  zone: boolean;
  /** Page flag FN_UNSURE. */
  unsure: boolean;
  /** Notes that started with a label (for the document score), and how many were bound. */
  labelled: number;
  bound: number;
  /** Labels ran 1, 2, 3… (or continued the previous page). */
  consecutive: boolean;
}

/**
 * Resolve one page: split the zone into notes, bind them to the page's
 * references (`refs`, reading order), apply the unsure rule, continue the
 * previous page's note. `body` are the page's body lines (for glued-digit
 * references). Mutates reference parts, `prev.lines` and body parts (glued
 * references). Pure otherwise.
 */
export function resolvePageNotes(args: {
  page: number;
  zone: Line[];
  body: Line[];
  refs: Array<Extract<Part, { t: "ref" }>>;
  prev: Note | null;
}): PageNotes {
  const { page, zone, body, refs, prev } = args;
  const none: PageNotes = { notes: [], endText: [], zone: false, unsure: false, labelled: 0, bound: 0, consecutive: true };
  if (!zone.length) return none;

  const refSet = new Set(refs.map((r) => r.label));
  const bodyText = body.flatMap((l) => l.parts.map((p) => (p.t === "text" ? p.s : " "))).join(" ");
  const glued = (label: string) => gluedRe(label).test(bodyText);
  const pre: Line[] = [];
  const notes: Note[] = [];
  let prevLabel = prev?.label ?? null;
  for (const line of zone) {
    const start = labelStart(line, prevLabel, refSet, glued);
    if (start) {
      notes.push({ label: start.label, page, lines: [{ ...line, parts: start.rest }], bound: false });
      prevLabel = start.label;
    } else if (notes.length) notes[notes.length - 1].lines.push(line);
    else pre.push(line);
  }

  if (!notes.length) {
    const last = prev?.lines[prev.lines.length - 1];
    if (prev && last && !endsTerminal(last.plain)) {
      prev.lines.push(...zone);
      return { ...none, zone: true };
    }
    return none; // small type at the page bottom without labels: body text, not a zone
  }

  let bound = 0;
  for (const note of notes) {
    const ref = refs.find((r) => r.label === note.label && r.note === null);
    if (ref) {
      ref.note = note;
      note.bound = true;
      bound++;
    }
  }
  for (const note of notes) {
    if (note.bound || !/^\d{1,3}$/.test(note.label)) continue;
    const ref = gluedRef(body, note.label);
    if (ref) {
      ref.note = note;
      note.bound = true;
      bound++;
    }
  }

  const consecutive = notes.every((n, i) => {
    const before = i > 0 ? notes[i - 1].label : prev?.label ?? null;
    if (!/^\d+$/.test(n.label)) return true;
    return before === null || !/^\d+$/.test(before) ? true : Number(n.label) === Number(before) + 1 || n.label === "1";
  });

  if (bound / notes.length < 0.5 && !consecutive) {
    for (const r of refs) if (r.note && notes.includes(r.note)) r.note = null;
    for (const n of notes) n.bound = false;
    return { notes: [], endText: zone, zone: true, unsure: true, labelled: notes.length, bound: 0, consecutive };
  }

  let unsure = notes.some((n) => !n.bound);
  const endText: Line[] = [];
  if (pre.length) {
    if (prev) prev.lines.push(...pre);
    else {
      endText.push(...pre);
      unsure = true;
    }
  }
  return { notes, endText, zone: true, unsure, labelled: notes.length, bound, consecutive };
}

/**
 * A reference printed as digits glued to the end of a word ("škody12")
 * with the size of the text: split it out of the first body text part
 * where it occurs. Only called for a note label still unmatched.
 */
function gluedRe(label: string): RegExp {
  return new RegExp(String.raw`(\p{L}{2,}[.,;:]?|[)"”’])(${label})(?=$|[\s.,;:)!?])`, "u");
}

function gluedRef(body: Line[], label: string): Extract<Part, { t: "ref" }> | null {
  const re = gluedRe(label);
  for (const line of body) {
    for (let i = 0; i < line.parts.length; i++) {
      const p = line.parts[i];
      if (p.t !== "text") continue;
      const m = re.exec(p.s);
      if (!m) continue;
      const cut = m.index + m[1].length;
      const ref = { t: "ref" as const, label, raw: label, note: null };
      const pieces: Part[] = [{ t: "text", s: p.s.slice(0, cut) }, ref];
      const after = p.s.slice(cut + label.length);
      if (after) pieces.push({ t: "text", s: after });
      line.parts.splice(i, 1, ...pieces);
      return ref;
    }
  }
  return null;
}
