/**
 * Page labels of a PDF — what "[s. N]" says. In order of trust:
 * 1. an explicit calibration from the preview ("PDF s. 1 = tištěná s. 417");
 * 2. the PDF's own /PageLabels, when they are not just 1..n;
 * 3. page numbers printed in the running heads / footers, when one constant
 *    offset from the physical page explains ≥ 70 % of the pages (article
 *    offprints: PDF pages 1–9 are s. 417–425); gaps are filled from the
 *    offset (flag LABEL_GUESSED), front matter before page 1 keeps its
 *    printed Roman numeral;
 * 4. the physical page number.
 * Pure — unit-tested (tests/files-convert-pdf-layout.test.ts).
 */

import type { PageLabelSource } from "../../types";
import { PAGE_FLAGS, PAGE_LABEL_RE } from "../../dmd/types";
import { toRoman } from "./text";
import type { PrintedNumber } from "./zones";

export interface LabelResult {
  /** Label per physical page (index = ord − 1). */
  labels: string[];
  source: PageLabelSource;
  /** LABEL_GUESSED per page (index = ord − 1). */
  flags: number[];
  /** Printed offset used (label = physical + offset), when source is "printed". */
  offset: number | null;
}

/** A /PageLabels entry → a valid DMD page label, or null. Pure. */
export function cleanLabel(raw: string): string | null {
  const s = raw.normalize("NFC").trim().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}.\-–]/gu, "").slice(0, 12);
  return s && PAGE_LABEL_RE.test(s) ? s : null;
}

/**
 * Labels for `count` physical pages. `printed` holds the page numbers read
 * from the page furniture; `textPages` the pages that carry text (the 70 %
 * base). Pure.
 */
export function computeLabels(args: {
  count: number;
  pdfLabels: string[] | null;
  printed: Map<number, PrintedNumber>;
  textPages: number[];
  calibration?: number | null;
}): LabelResult {
  const { count, pdfLabels, printed, textPages } = args;
  const flags = new Array<number>(count).fill(0);
  const byOffset = (offset: number, guess: boolean): string[] =>
    Array.from({ length: count }, (_, i) => {
      const ord = i + 1;
      const n = ord + offset;
      if (n >= 1) {
        if (guess && printed.get(ord)?.value !== n) flags[i] |= PAGE_FLAGS.LABEL_GUESSED;
        return String(n);
      }
      // Front matter before printed page 1: its own Roman numeral when printed, else one by position.
      const roman = printed.get(ord)?.roman;
      if (guess && !roman) flags[i] |= PAGE_FLAGS.LABEL_GUESSED;
      return roman ?? toRoman(ord);
    });

  const cal = args.calibration;
  if (typeof cal === "number" && Number.isInteger(cal) && Math.abs(cal) < 100_000) {
    return { labels: byOffset(cal, false), source: "printed", flags, offset: cal };
  }

  if (pdfLabels && pdfLabels.length === count && count > 0) {
    const cleaned = pdfLabels.map((l) => cleanLabel(String(l ?? "")));
    const valid = cleaned.filter((l) => l !== null).length;
    const trivial = pdfLabels.every((l, i) => String(l).trim() === String(i + 1));
    if (!trivial && valid >= 0.9 * count) {
      return { labels: cleaned.map((l, i) => l ?? String(i + 1)), source: "pdf_labels", flags, offset: null };
    }
  }

  const votes = new Map<number, number>();
  for (const [ord, num] of printed) if (num.value !== null) votes.set(num.value - ord, (votes.get(num.value - ord) ?? 0) + 1);
  let offset = 0;
  let support = 0;
  for (const [d, n] of votes) if (n > support || (n === support && Math.abs(d) < Math.abs(offset))) [offset, support] = [d, n];
  const base = Math.max(1, textPages.length);
  const minSupport = textPages.length <= 2 ? 1 : 2;
  if (support >= minSupport && support >= 0.7 * base) {
    return { labels: byOffset(offset, true), source: "printed", flags, offset };
  }
  return { labels: Array.from({ length: count }, (_, i) => String(i + 1)), source: "physical", flags, offset: null };
}
