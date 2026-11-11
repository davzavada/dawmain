import { waitUntil } from "@vercel/functions";
import { withScope } from "@/src/files/db/client";
import { recordToolCall, type CallerKey } from "@/src/files/db/usage";
import { effectiveMode } from "@/src/files/guards";
import { callerFromCtx } from "./caller";

/**
 * Usage overview (/soukromi, bod 2): every tool call adds one to today's
 * counter of its caller and tool (usage_daily, 'calls:<who>:<tool>'); the
 * operator page sums them. Counts only — never the arguments of a call.
 *
 * Bookkeeping, never in the way of the answer: written after the handler
 * returns, kept alive past the response with waitUntil, and every failure
 * is swallowed. It lives in the files database, so it follows that
 * database's switches: nothing is written where it is unconfigured, where
 * FILES_MODE=off, or once the guards turned the feature off (the compute
 * hours of the month are spent — each write would wake the database).
 */

/** The counter key of the caller in a tool handler's ctx. */
export function callerKey(ctx: unknown): CallerKey {
  const caller = callerFromCtx(ctx);
  return caller.kind === "user" ? caller.userId : caller.kind === "shared-token" ? "shared" : "anon";
}

async function write(who: CallerKey, tool: string): Promise<void> {
  try {
    const mode = await effectiveMode();
    if (mode === "off" || mode === "unconfigured") return;
    await withScope([], (db) => recordToolCall(db, who, tool));
  } catch {
    // A missed count is not worth an error anywhere.
  }
}

/** Count one call of `tool` in the background. Returns the pending write (tests await it). */
export function trackToolCall(tool: string, ctx: unknown): Promise<void> {
  const pending = write(callerKey(ctx), tool);
  try {
    waitUntil(pending);
  } catch {
    // Outside a Vercel request the promise simply runs on.
  }
  return pending;
}
