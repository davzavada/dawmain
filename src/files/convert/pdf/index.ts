/**
 * PDF conversion entry point for the browser (and node tests): read the
 * PDF with pdf.js, lay it out as DMD. The two halves are exported too, so
 * the upload preview can read a file once and re-run only the pure layout
 * when the user flips a toggle (bez poznámek, jednosloupcová sazba…).
 */

import type { ConvertOptions, ConvertResult } from "../types";
import { layoutToDmd } from "./layout";
import { readPdf } from "./pdfjs";

export { layoutToDmd, PDF_CONVERTER } from "./layout";
export type { PdfDocInput, PdfItem, PdfOutlineEntry, PdfPageInput } from "./layout";
export { readPdf } from "./pdfjs";

/**
 * PDF bytes → ConvertResult. Only the pages of `opts.pageRange` are
 * extracted. Throws ConvertError ("encrypted", "broken", "scan",
 * "too_large"). `onProgress(done, total)` per page read.
 */
export async function convertPdf(
  data: ArrayBuffer,
  opts: ConvertOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<ConvertResult> {
  const doc = await readPdf(data, onProgress, { pageRange: opts.pageRange ?? null });
  return layoutToDmd(doc, opts);
}
