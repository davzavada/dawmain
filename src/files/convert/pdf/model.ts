/**
 * Internal model of the PDF layout engine — the stages hand these to each
 * other: runs (text items) → rows (one baseline across the page) → lines
 * (one row within one column) → segments (a column of a band) → pages.
 * Coordinates as in ./types.ts (viewport space, y = baseline from the top).
 * Types only.
 */

export interface Run {
  str: string;
  x: number;
  x1: number;
  y: number;
  size: number;
  font: string;
  bold: boolean;
  /** Raised and (usually) smaller than its line — a superscript. */
  sup: boolean;
  /** The extracted string had a leading / trailing space (its width includes it). */
  spaceBefore: boolean;
  spaceAfter: boolean;
}

export interface Row {
  page: number;
  /** Sorted by x; superscripts included (sup = true). */
  runs: Run[];
  /** Baseline of the row's dominant runs. */
  y: number;
  /** Dominant (character-weighted) size of the non-superscript runs. */
  size: number;
  x0: number;
  x1: number;
}

/** A footnote reference, a superscript that is not one, or plain text. */
export type Part =
  | { t: "text"; s: string }
  | { t: "sup"; s: string }
  | { t: "ref"; label: string; raw: string; note: Note | null };

export interface Line {
  page: number;
  /** Index of the segment (column of a band) within the page. */
  seg: number;
  parts: Part[];
  /** Text with superscripts, one line. */
  text: string;
  /** Text without superscripts (for patterns). */
  plain: string;
  x0: number;
  x1: number;
  y: number;
  size: number;
  bold: boolean;
  font: string;
  /** The column the line sits in. */
  colLeft: number;
  colRight: number;
  /** Marginal number printed in the margin next to the line. */
  mn: string | null;
  /** Starts with a bold number followed by regular text ("14 Text…") — an inline m. č. candidate. */
  boldLead: string | null;
  /** The last run is a number set far right of the text (a table-of-contents page number). */
  gapTail: boolean;
  /** Set by the heading stage. */
  heading: HeadingMark | null;
  /** Merged into the heading on the line above. */
  headingCont: boolean;
  /** Statute wording after a § heading — emitted as a "> " quote. */
  quote: boolean;
}

export interface HeadingMark {
  level: number;
  source: "outline" | "styles" | "patterns";
  /** Section kind the heading was recognised as (drives levels and § checks). */
  kind: "par" | "cl" | "part" | "chapter" | "special" | "style" | "outline";
  /** Full heading text (merged lines), without superscripts. */
  text: string;
  /** Parts of all merged lines (references kept, for their definitions). */
  parts: Part[];
}

export interface Note {
  label: string;
  /** Page the note starts on. */
  page: number;
  /** Lines of the note; the first one with its label removed. Continuations from later pages appended. */
  lines: Line[];
  /** Bound to a reference (the reference part holds the note). */
  bound: boolean;
}

export interface Segment {
  band: number;
  col: number;
  left: number;
  right: number;
  lines: Line[];
}

export interface PageModel {
  ord: number;
  width: number;
  height: number;
  label: string;
  flags: number;
  /** Body in reading order: bands top to bottom, columns left to right. */
  segments: Segment[];
  /** Notes starting on this page (bound or not). */
  notes: Note[];
  /** Footnote-zone text kept as body text at the page end (unsure zone, orphan continuation). */
  endText: Line[];
  /** The page held nothing but the continuation of the previous page's note (moved into it). */
  noteOnly?: boolean;
  /** Running heads (header/footer text without the page number). */
  heads: string[];
  /** In the selected page range (emitted). */
  kept: boolean;
}
