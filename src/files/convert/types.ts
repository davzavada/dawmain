import type { ConversionQuality, FileKind, PageLabelSource, UploadHints } from "../types";

/**
 * Browser conversion contract: File → normalized DMD + quality report. The
 * server never sees the file, only `dmd`; everything else is a hint it
 * re-checks (src/files/upload.ts).
 */

export interface ConvertOptions {
  /** Detect footnotes (default true). */
  footnotes: boolean;
  /** "single" forces one-column reading order. */
  columns: "auto" | "single";
  /** Detect marginal numbers (default true). */
  marginalNumbers: boolean;
  /** "Nahrát jako prostý text": pages, paragraphs and dehyphenation only. */
  plain: boolean;
  /** 1-based inclusive physical page range to keep (PDF). */
  pageRange?: [number, number] | null;
  /** Calibration: printed label = physical page + offset (PDF). */
  labelOffset?: number | null;
}

export const DEFAULT_CONVERT_OPTIONS: ConvertOptions = {
  footnotes: true,
  columns: "auto",
  marginalNumbers: true,
  plain: false,
  pageRange: null,
  labelOffset: null,
};

/**
 * A region the PDF layout recognised on one page, in the page's viewport
 * space at scale 1 (PDF points, y down from the top) — drawn over the page
 * in the preview so a wrong zone shows at a glance.
 */
export interface PageZone {
  /** header/footer: running heads and page numbers left out; footnotes: the note zone; heading: a heading line. */
  kind: "header" | "footer" | "footnotes" | "heading";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ConvertResult {
  kind: FileKind;
  /** Converter id + version, e.g. "pdf@1" — stored with the document. */
  converter: string;
  /** NORMALIZED DMD (normalizeDmd applied). */
  dmd: string;
  quality: ConversionQuality;
  hints: UploadHints;
  labelSource: PageLabelSource;
  physicalPages: number | null;
  /** Per physical page (index = ord − 1): PAGE_FLAGS bits — for the preview strip. */
  pageFlags: number[];
  /** Per physical page: printed label — for the preview and the range picker. */
  pageLabels: string[];
  /** PDF only, per physical page (index = ord − 1): the regions the layout recognised — preview overlays. */
  pageZones?: PageZone[][];
  /** Czech, user-facing consequences ("na 12 stranách budou poznámky jako běžný text"). */
  warnings: string[];
}

export type ConvertErrorCode = "scan" | "encrypted" | "unsupported" | "too_large" | "broken";

export class ConvertError extends Error {
  constructor(
    public readonly code: ConvertErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConvertError";
  }
}
