import { z } from "zod";
import { SourceError } from "@/src/sources/shared/errors";
import { withDeadline } from "./previews";

/**
 * Query variants (`queries`) are searched in parallel, one upstream request
 * each. What every search tool shares: a variant that fails or outruns its
 * deadline costs only itself — the others still answer and the failure is
 * named in the response — and the per-variant counts travel with the result,
 * so the reader can see which formulation actually found something.
 */

export interface VariantFailure {
  variant: string;
  error: string;
}

export const variantFailureSchema = z
  .array(z.object({ variant: z.string(), error: z.string() }))
  .optional()
  .describe("Variants that failed or timed out — their hits are missing from this page; the other variants answered.");

export const variantTotalsSchema = z
  .array(z.number().nullable())
  .optional()
  .describe("Match count of each variant, in the order searched (null = failed or unknown).");

/** The message a model can act on: what failed and what to try instead. */
export function describeError(error: unknown): string {
  if (error instanceof SourceError) return `${error.message} ${error.hint}`.trim();
  return error instanceof Error ? error.message : String(error);
}

export interface VariantOutcome<T> {
  /** One entry per variant, in variant order; null where the variant failed. */
  values: Array<T | null>;
  failures: VariantFailure[];
}

/**
 * Run one search per variant. Only when EVERY variant fails does the call
 * fail, with the first variant's error — exactly what a single search would
 * have thrown. `deadlineMs` bounds each variant on its own.
 */
export async function runVariants<T>(
  variants: Array<string | undefined>,
  run: (variant: string | undefined) => Promise<T>,
  deadlineMs?: number,
): Promise<VariantOutcome<T>> {
  const settled = await Promise.allSettled(
    variants.map((variant) => (deadlineMs ? withDeadline(run(variant), deadlineMs) : run(variant))),
  );
  const failures: VariantFailure[] = [];
  const values = settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    failures.push({ variant: variants[index] ?? "(no keywords)", error: describeError(result.reason) });
    return null;
  });
  if (failures.length === settled.length) {
    throw (settled[0] as PromiseRejectedResult).reason;
  }
  return { values, failures };
}

/** Text lines naming the variants that did not answer — empty when all did. */
export function failureLines(failures: VariantFailure[]): string[] {
  return failures.map(
    (failure) =>
      `⚠ Variant "${failure.variant}" failed and its hits are missing: ${failure.error} (a shorter, more distinctive formulation usually answers faster).`,
  );
}
