import { z } from "zod";
import { SourceError, asSourceError, toToolError } from "@/src/sources/shared/errors";
import { DOC_PAGE_CHARS, type DocumentView } from "@/src/sources/shared/text";

/**
 * What every tool file needs and none should restate. These are not just
 * constants: the descriptions are prompt text the model reads before every
 * call, so a copy that drifts in one tool teaches the model two different
 * contracts for the same behaviour.
 */

/** Nothing here writes anywhere; the databases are somebody else's. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * The files_* tools read the caller's own uploaded documents (Vlastní
 * zdroje): nothing outside this deployment is touched, so openWorld is false.
 */
export const PRIVATE_READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Whether a YYYY-MM-DD string names a day that exists (no 2025-02-30). */
export function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * The shape check alone let "2025-02-30" and "2025-06-31" (a model's typical
 * end of month) through to the courts, and each mishandled it silently: NSS
 * dropped the bound, NS matched nothing, NALUS returned hits outside the
 * range — all reported as successes. The refine keeps the regex, so the
 * JSON Schema pattern the client sees is unchanged.
 */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use ISO format YYYY-MM-DD")
  .refine(isCalendarDate, "Not a real calendar date (YYYY-MM-DD), e.g. 2025-02-28")
  .describe("ISO date (YYYY-MM-DD).");

/**
 * The text of an INPUT_INVALID answer for an inverted range, or null. Every
 * court answers an inverted range with zero hits, which reads as "no case
 * law" — so the call is refused before any upstream request is spent on it.
 * ISO dates compare correctly as strings.
 */
export function dateRangeError(from: string | undefined, to: string | undefined, label = "date"): string | null {
  if (!from || !to || from <= to) return null;
  return `${label}_from ${from} is after ${label}_to ${to} — the range is inverted; swap the two dates.`;
}

/** Throw dateRangeError's refusal as INPUT_INVALID — called first in a
 * handler's try, so the tool's own failure mapping answers it. */
export function assertDateRange(source: string, from: string | undefined, to: string | undefined, label = "date"): void {
  const message = dateRangeError(from, to, label);
  if (message) throw new SourceError(source, "INPUT_INVALID", message, `Swap ${label}_from and ${label}_to (or drop one) and call again.`);
}

/** Turn anything thrown into the MCP error result, tagged with its source. */
export function toolFailure(source: string): (error: unknown) => ReturnType<typeof toToolError> {
  return (error) => toToolError(error instanceof SourceError ? error : asSourceError(source, error));
}

/** `find` — the same parameter, and the same promise, on every *_get_* tool. */
export const FIND_DESCRIPTION =
  "Return only excerpts around matches of this term (diacritics-insensitive) instead of pages — the cheap way to locate specific passages in a long text.";

/** Tail of every *_get_* tool's description. Built from DOC_PAGE_CHARS so the
 * number the model is told matches the number the pager actually uses. */
export const READING_DESCRIPTION = `Long texts come in ~${Math.round(DOC_PAGE_CHARS / 1000)}k-character pages. 'find' returns excerpts around a term — for locating passages and screening. A decision you rely on (quote it, cite it as authority) you read WHOLE: page 1, then every page to the last. Continue on your own — never ask the user whether to keep reading.`;

/** What a paged answer ends with when there is more — empty when there is
 * not, and in `find` (excerpt) mode: a truncated excerpt answer already says
 * how to go on, and "page 1/1 — continue: page: 2" there would contradict it. */
export function continuationHint(
  paged: Pick<DocumentView, "page" | "total_pages" | "has_more"> & Partial<Pick<DocumentView, "mode">>,
): string {
  if (!paged.has_more || paged.mode === "excerpt") return "";
  return `\n\n(page ${paged.page}/${paged.total_pages} — continue without asking the user: page: ${paged.page + 1}. A decision you rely on is read to its last page; to locate one passage instead, use find: "term".)`;
}

/**
 * What a window of a BOUNDED read ends with when the requested range has more
 * — empty on its last window. `locator` repeats the call's own range
 * parameters (`section: "§ 2913", mn: "14"`; "" for a whole short text), so
 * the next call reads the next window of the same range and nothing beyond
 * it: the continuation of a section read stops where the section ends, and
 * a model following it never pages on through a whole book. Pure.
 */
export function rangeContinuationHint(locator: string, window: number, totalWindows: number): string {
  if (!(window >= 1) || window >= totalWindows) return "";
  const call = [locator.trim(), `page: ${window + 1}`].filter(Boolean).join(", ");
  return `\n\n(okno ${window}/${totalWindows} — pokračuj bez ptaní: ${call}. The requested range ends with window ${totalWindows}: stop there, never read on through the whole document.)`;
}

/** `read_top` on the search tools that preview their best hits. */
export const readTopSchema = z
  .number()
  .int()
  .min(0)
  .max(3)
  .default(0)
  .describe("Fetch the N best hits' texts in parallel and return excerpts around the query.");
