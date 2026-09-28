/**
 * Billed ("normované") pages of an upload — ONE formula for every format,
 * because the file kind and the page markers are client-asserted: removing
 * or forging markers, or calling a DOCX a PDF, cannot lower the price.
 * The browser shows it before the upload; the server recomputes it from its
 * own parse (ParsedDoc.stats.countedChars: text without markup, footnotes
 * included). Isomorphic and pure — unit-tested.
 */

import { PAGE_CHARS } from "../config";

/** max(1, ceil(countedChars / PAGE_CHARS)); nonsense input (negative, NaN) bills one page. */
export function billablePages(countedChars: number): number {
  if (!Number.isFinite(countedChars) || countedChars <= 0) return 1;
  return Math.max(1, Math.ceil(countedChars / PAGE_CHARS));
}
