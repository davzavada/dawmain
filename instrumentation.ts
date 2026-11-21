/**
 * Runs once when the Next server starts (Next's instrumentation hook). Starts
 * the minute flush of the per-source upstream counters
 * (src/sources/upstream-stats-flush.ts) — Node runtime only.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startUpstreamStatsFlush } = await import("./src/sources/upstream-stats-flush");
  startUpstreamStatsFlush();
}
