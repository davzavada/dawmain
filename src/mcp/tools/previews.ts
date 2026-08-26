import { previewExcerpt } from "@/src/sources/shared/text";

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

const PREVIEW_DEADLINE_MS = 15_000;

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
  ]);
}

export async function buildPreviews(
  targets: Array<{ id: string; caseNumber: string }>,
  getText: (id: string) => Promise<string>,
  terms: string[],
): Promise<ToolPreview[] | undefined> {
  if (!targets.length) return undefined;
  const settled = await Promise.all(
    targets.map(async (target) => {
      try {
        const text = await withDeadline(getText(target.id), PREVIEW_DEADLINE_MS);
        return { ...target, ...previewExcerpt(text, terms) };
      } catch {
        return null;
      }
    }),
  );
  const previews = settled.filter((preview): preview is ToolPreview => preview !== null);
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
