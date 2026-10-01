import { excerptTerms, previewExcerpt } from "@/src/sources/shared/text";

/**
 * read_top support shared by the search tools: fetch the texts of the leading
 * hits in parallel and preview them around the query terms. A failed preview
 * skips silently — it must never sink the search itself; the full read stays
 * one *_get_* call away (and hits the 10-min document cache).
 */

export interface ToolPreview {
  id: string;
  caseNumber: string;
  matches: number;
  excerpt: string;
}

export const PREVIEW_DEADLINE_MS = 15_000;

/**
 * Reject when `ms` elapses. The underlying request keeps running until its own
 * AbortSignal fires (the source clients own those); the timer is cleared on
 * settle so a fast call leaves nothing pending.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export async function buildPreviews<T extends { id: string; caseNumber: string }>(
  targets: T[],
  /** Takes the whole target, not just its id: an id is not unique across
   * sources, so a caller that had to look the target back up by id could
   * preview the wrong document. */
  getText: (target: T) => Promise<string>,
  terms: string[],
): Promise<Array<T & { matches: number; excerpt: string }> | undefined> {
  if (!targets.length) return undefined;
  // The caller's terms are search expressions, not document text — a quoted
  // phrase or a wildcard would match nothing verbatim.
  const needles = excerptTerms(terms);
  // Nothing to excerpt around (a case-number, date or filter-only search):
  // fetching the texts only to print "the query terms do not occur" for
  // every hit cost a document request each and told the reader nothing.
  // The caller says so instead (noTermsNote); ns_search and us_search show
  // their own query-less previews (výrok, právní věta).
  if (!needles.length) return undefined;
  const settled = await Promise.all(
    targets.map(async (target) => {
      try {
        const text = await withDeadline(getText(target), PREVIEW_DEADLINE_MS);
        return { ...target, ...previewExcerpt(text, needles) };
      } catch {
        return null;
      }
    }),
  );
  const previews: Array<T & { matches: number; excerpt: string }> = [];
  for (const preview of settled) if (preview) previews.push(preview);
  return previews.length ? previews : undefined;
}

/** The line a search answer carries when read_top was asked for but there
 * were no query terms to excerpt around (buildPreviews fetched nothing). */
export function noTermsNote(readTop: number, terms: string[], detailTool: string): string[] {
  if (!readTop || excerptTerms(terms).length) return [];
  return ["", `(read_top previews need query/queries — they are excerpts around the query terms; skipped. Read the hits via ${detailTool}.)`];
}

export function renderPreviews(
  previews: ToolPreview[] | undefined,
  detailTool: string,
): string[] {
  if (!previews?.length) return [];
  return ["", ...previews.map((preview) => previewBlock(preview, detailTool))];
}

/** One preview; a hit whose text never mentions the terms gets one line, not its head. */
export function previewBlock(preview: Pick<ToolPreview, "caseNumber" | "matches" | "excerpt">, detailTool: string): string {
  if (!preview.matches) {
    return `— NO PREVIEW ${preview.caseNumber}: the query terms do not occur verbatim in its text (the search may have matched another word form) — judge it by its hit line, or read it via ${detailTool}.`;
  }
  return `— PREVIEW ${preview.caseNumber} (${preview.matches}× query terms):\n${preview.excerpt}\n(excerpt only — the whole decision via ${detailTool})`;
}
