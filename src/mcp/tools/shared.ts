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

/** What a tool's reader hands back: the text every client reads, and the structured half the registration boundary strips (./index.ts). */
export type ToolAnswer = { content: Array<{ type: "text"; text: string }>; isError?: boolean; structuredContent?: unknown };

/*
 * Lenient inputs. Every refused input is an isError answer, and Claude.ai
 * shows the user nothing of it but "This tool could not complete its
 * request" — for a call whose meaning was plain: per_source_limit: 20,
 * a fourth query variant, read_top: "2", queries or sources sent as one
 * string (a client holding an older schema, or a model writing the array
 * as JSON text). These preprocessors read such values as they were meant;
 * the JSON Schema the client sees is the inner schema's, unchanged.
 */

/** A number sent as a string ("5") or outside [min, max] (20 where 10 is the most) → the integer, clamped. Anything else as it is. Pure. */
export function clampedInt(min: number, max: number): (value: unknown) => unknown {
  return (value) => {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : value;
    if (typeof n !== "number" || !Number.isFinite(n)) return value;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
}

/** An integer parameter in [min, max] with a default, read leniently (clampedInt). */
export function lenientInt(min: number, max: number, fallback: number) {
  return z.preprocess(clampedInt(min, max), z.number().int().min(min).max(max).default(fallback));
}

/** "true" / "false" (any case) → the boolean; anything else as it is. Pure. */
export function booleanFromString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim().toLowerCase();
  return text === "true" ? true : text === "false" ? false : value;
}

/** A boolean parameter with a default, read leniently (booleanFromString). */
export function lenientBool(fallback: boolean) {
  return z.preprocess(booleanFromString, z.boolean().default(fallback));
}

/**
 * Query variants as sent: a JSON array written as text ('["a", "b"]'), or a
 * single string, become an array; entries that are not strings or are
 * shorter than 2 characters are dropped, and only the first `cap` are kept
 * (the caller asked for more variants than are searched — the answer lists
 * the ones that were). An empty result is undefined (as if not sent). Pure.
 */
export function queriesFromInput(cap: number): (value: unknown) => unknown {
  return (value) => {
    let list = value;
    if (typeof list === "string") {
      const text = list.trim();
      list = [text];
      if (text.startsWith("[")) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (Array.isArray(parsed)) list = parsed;
        } catch {
          /* one variant after all */
        }
      }
    }
    if (!Array.isArray(list)) return value;
    const kept = list
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
      .slice(0, cap);
    return kept.length ? kept : undefined;
  };
}

/**
 * Source names as sent: a string ('ns, us', '["ns","us"]') becomes a list;
 * every name is lowercased and stripped of diacritics ("ÚS" → "us"), and the
 * aliases map to the ids ("cjeu", "curia", "sd eu"…). Unknown names stay, so
 * the enum still refuses them by name. An empty list is undefined. Pure.
 */
export function sourcesFromInput(aliases: Record<string, string>): (value: unknown) => unknown {
  return (value) => {
    let list = value;
    if (typeof list === "string") {
      const text = list.trim();
      let parsed: unknown = null;
      if (text.startsWith("[")) {
        try {
          parsed = JSON.parse(text);
        } catch {
          /* split below */
        }
      }
      list = Array.isArray(parsed) ? parsed : text.replace(/[[\]"']/g, " ").split(/[\s,;]+/);
    }
    if (!Array.isArray(list)) return value;
    const ids = list
      .map((item) => (typeof item === "string" ? item.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase() : item))
      .filter((item) => item !== "")
      .map((item) => (typeof item === "string" ? (aliases[item] ?? item) : item));
    const unique = [...new Set(ids)];
    return unique.length ? unique : undefined;
  };
}
