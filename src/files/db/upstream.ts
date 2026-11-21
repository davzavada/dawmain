import "server-only";
import { LATENCY_BOUNDS_MS, emptyCounters, mergeCounters, type UpstreamCounters } from "@/src/sources/shared/limits";
import type { Queryable } from "./client";

/**
 * How the official databases answered, per source and UTC day — counts only,
 * from src/sources/shared/limits.ts. Kept in system_state (no table of its
 * own, no migration): one key per day, `upstream:YYYY-MM-DD`, whose value maps
 * a source label to its counters. A dozen sources a day is a small JSON.
 */

/** Kept long enough to compare a quiet month with a busy one. */
export const UPSTREAM_KEEP_DAYS = 90;

const PREFIX = "upstream:";

/** UTC date `daysAgo` days back, YYYY-MM-DD. */
function utcDay(daysAgo = 0, now = new Date()): string {
  return new Date(now.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

type DayRecord = Record<string, Partial<UpstreamCounters>>;

/** Add one flush's counters to today's record (read under a row lock, merged, written back). */
export async function addUpstreamStats(db: Queryable, stats: Map<string, UpstreamCounters>, now = new Date()): Promise<void> {
  if (stats.size === 0) return;
  const key = PREFIX + utcDay(0, now);
  const { rows } = await db.query<{ value: DayRecord }>("SELECT value FROM system_state WHERE key = $1 FOR UPDATE", [key]);
  const day: DayRecord = rows[0]?.value && typeof rows[0].value === "object" ? rows[0].value : {};
  for (const [source, counters] of stats) {
    const label = source.slice(0, 80);
    day[label] = mergeCounters(mergeCounters(emptyCounters(), day[label] ?? {}), counters);
  }
  await db.query(
    `INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(day)],
  );
}

export interface UpstreamSummary {
  source: string;
  requests: number;
  ok: number;
  http429: number;
  http403: number;
  http4xx: number;
  http5xx: number;
  timeouts: number;
  network: number;
  busy: number;
  avgMs: number | null;
  /** Upper bound of the latency bucket holding the 95th percentile; null = slower than the last bound or no data. */
  p95UnderMs: number | null;
  queued: number;
  avgQueueMs: number | null;
  /** Most requests open against the source at once, on any day of the window. */
  maxInflight: number;
  maxQueue: number;
  /** Last UTC day (YYYY-MM-DD) with a 429 or 403, if any. */
  lastRefusalDay: string | null;
}

/** Totals per source over the last `days` UTC days including today, busiest first. */
export async function upstreamSummary(db: Queryable, days: number, now = new Date()): Promise<UpstreamSummary[]> {
  const span = Math.max(1, Math.floor(days));
  const { rows } = await db.query<{ key: string; value: DayRecord }>(
    "SELECT key, value FROM system_state WHERE starts_with(key, $1) AND key >= $2 ORDER BY key",
    [PREFIX, PREFIX + utcDay(span - 1, now)],
  );
  const totals = new Map<string, { c: UpstreamCounters; lastRefusal: string | null }>();
  for (const row of rows) {
    const dayStr = row.key.slice(PREFIX.length);
    for (const [source, stored] of Object.entries(row.value ?? {})) {
      const day = mergeCounters(emptyCounters(), stored ?? {});
      const t = totals.get(source) ?? { c: emptyCounters(), lastRefusal: null };
      mergeCounters(t.c, day);
      if (day.outcomes.http429 + day.outcomes.http403 > 0) t.lastRefusal = dayStr;
      totals.set(source, t);
    }
  }
  return [...totals.entries()]
    .map(([source, { c, lastRefusal }]) => ({
      source,
      requests: c.requests,
      ok: c.outcomes.ok,
      http429: c.outcomes.http429,
      http403: c.outcomes.http403,
      http4xx: c.outcomes.http4xx,
      http5xx: c.outcomes.http5xx,
      timeouts: c.outcomes.timeout,
      network: c.outcomes.network,
      busy: c.outcomes.busy,
      avgMs: c.requests > 0 ? Math.round(c.latencyMs / c.requests) : null,
      p95UnderMs: p95Bound(c.latency),
      queued: c.queued,
      avgQueueMs: c.queued > 0 ? Math.round(c.queueMs / c.queued) : null,
      maxInflight: c.maxInflight,
      maxQueue: c.maxQueue,
      lastRefusalDay: lastRefusal,
    }))
    .sort((a, b) => b.requests - a.requests || a.source.localeCompare(b.source));
}

/** The bucket bound under which 95 % of the requests finished. */
export function p95Bound(buckets: number[]): number | null {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i];
    if (seen >= total * 0.95) return i < LATENCY_BOUNDS_MS.length ? LATENCY_BOUNDS_MS[i] : null;
  }
  return null;
}

/** Drop day records past UPSTREAM_KEEP_DAYS. Returns how many. */
export async function pruneUpstream(db: Queryable, now = new Date()): Promise<number> {
  const { rows } = await db.query("DELETE FROM system_state WHERE starts_with(key, $1) AND key < $2 RETURNING 1", [
    PREFIX,
    PREFIX + utcDay(UPSTREAM_KEEP_DAYS, now),
  ]);
  return rows.length;
}
