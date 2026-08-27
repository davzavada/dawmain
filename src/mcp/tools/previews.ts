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
  getText: (id: string) => Promise<string>,
  terms: string[],
): Promise<Array<T & { matches: number; excerpt: string }> | undefined> {
  if (!targets.length) return undefined;
  const settled = await Promise.all(
    targets.map(async (target) => {
      try {
        const text = await withDeadline(getText(target.id), PREVIEW_DEADLINE_MS);
        // The caller's terms are search expressions, not document text —
        // a quoted phrase or a wildcard would match nothing verbatim.
        return { ...target, ...previewExcerpt(text, excerptTerms(terms)) };
      } catch {
        return null;
      }
    }),
  );
  const previews: Array<T & { matches: number; excerpt: string }> = [];
  for (const preview of settled) if (preview) previews.push(preview);
  return previews.length ? previews : undefined;
}

export function renderPreviews(
  previews: ToolPreview[] | undefined,
  detailTool: string,
): string[] {
  if (!previews?.length) return [];
  return [
    "",
    ...previews.map(
      (preview) =>
        `— PREVIEW ${preview.caseNumber} (${preview.matches ? `${preview.matches}× query terms` : "document head"}):\n${preview.excerpt}\n(excerpt only — full text via ${detailTool})`,
    ),
  ];
}
