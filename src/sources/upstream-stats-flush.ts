import "server-only";
import { withScope } from "@/src/files/db/client";
import { addUpstreamStats } from "@/src/files/db/upstream";
import { effectiveMode } from "@/src/files/guards";
import { restoreUpstreamStats, takeUpstreamStats } from "@/src/sources/shared/limits";

/**
 * Writes the per-source counters of src/sources/shared/limits.ts to the
 * files database once a minute, from the web process (started by
 * instrumentation.ts). Bookkeeping only: a failed write puts the counters
 * back for the next minute and is never an error anywhere; nothing is
 * written where the files database is off or unconfigured. The mirror
 * crawler (CT 102) never loads this file — it has no files database.
 */

export const FLUSH_INTERVAL_MS = 60_000;

const KEY = Symbol.for("dawmain.upstream-flush");

export async function flushUpstreamStats(): Promise<void> {
  const stats = takeUpstreamStats();
  if (stats.size === 0) return;
  try {
    const mode = await effectiveMode();
    if (mode === "off" || mode === "unconfigured") return;
    await withScope([], (db) => addUpstreamStats(db, stats));
  } catch {
    restoreUpstreamStats(stats);
  }
}

/** Start the minute timer once per process; it never keeps the process alive. */
export function startUpstreamStatsFlush(): void {
  const g = globalThis as { [KEY]?: ReturnType<typeof setInterval> };
  if (g[KEY]) return;
  g[KEY] = setInterval(() => void flushUpstreamStats(), FLUSH_INTERVAL_MS);
  g[KEY].unref?.();
  // No flush on SIGTERM: Next exits right away, so a restart loses at most the last minute.
}
