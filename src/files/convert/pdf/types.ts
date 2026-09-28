/**
 * Input of the PDF layout engine (./layout.ts): what the pdf.js adapter
 * (./pdfjs.ts) extracts from a PDF, reduced to plain data so the layout is
 * a pure function that tests can feed with hand-built pages.
 *
 * Coordinates are in the page's VIEWPORT space at scale 1 — the page as it
 * is displayed (its /Rotate and crop box applied): x grows to the right
 * from the left edge, y grows DOWNWARD from the top edge, in PDF points.
 * An item's y is its text BASELINE, so a superscript has a smaller y than
 * the line it sits on and footnotes have the largest y on a page.
 */

export interface PdfItem {
  /** Text of one pdf.js text item (a text-show run), as extracted. */
  str: string;
  /** Left edge of the run. */
  x: number;
  /** Baseline, measured from the page top. */
  y: number;
  /** Advance width of the run. */
  w: number;
  /** Glyph box height as pdf.js reports it (≈ font size). */
  h: number;
  /** Font size (vertical scale of the text matrix). */
  size: number;
  /** Font name: the real PostScript name (subset prefix removed) when known, else pdf.js's loadedName. */
  font: string;
  /** Bold, when known (from the font object on sampled pages, or the font name). */
  bold?: boolean;
  /** Text not running left-to-right on the displayed page (vertical, rotated, mirrored). */
  rotated?: boolean;
}

export interface PdfPageInput {
  /** 1-based physical page. */
  ord: number;
  width: number;
  height: number;
  items: PdfItem[];
}

export interface PdfOutlineEntry {
  title: string;
  /** 1-based physical page the entry points at. */
  page: number;
  /** Destination y in viewport space (from the top), null when the destination has none. */
  y: number | null;
  /** 0-based depth in the outline tree. */
  level: number;
}

export interface PdfDocInput {
  pages: PdfPageInput[];
  /** PDF /PageLabels (one per physical page) or null. */
  pageLabels: string[] | null;
  outline: PdfOutlineEntry[];
  /** Document information dictionary (Title, Author, Producer, …) — string values only. */
  info: Record<string, string>;
  /** An OCR text layer was detected by the adapter (producer, GlyphLessFont…). */
  ocr: boolean;
}
