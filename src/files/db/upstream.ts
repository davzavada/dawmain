import "server-only";
import { LATENCY_BOUNDS_MS, type UpstreamCounters } from "@/src/sources/shared/limits";
import type { Queryable } from "./client";
import { num } from "./codec";

/**
 * upstream_daily (migration 0009): how the official databases answered, per
 * source and UTC day — counts only, from src/sources/shared/limits.ts.
 */

/** Kept long enough to compare a quiet month with a busy one. */
export const UPSTREAM_KEEP_DAYS = 90;

const TODAY_UTC = "(now() AT TIME ZONE 'UTC')::date";

/** Column per counter, in the order of the INSERT below. */
const SUM_COLUMNS = [
  "requests",
  "ok",
  "http429",
  "http403",
  "http4xx",
  "http5xx",
  "timeouts",
  "network",
  "busy",
  "latency_ms",
  "lat_250",
  "lat_1000",
  "lat_3000",
  "lat_10000",
  "lat_slow",
  "queued",
  "queue_ms",
] as const;
const MAX_COLUMNS = ["max_inflight", "max_queue"] as const;

function row(c: UpstreamCounters): number[] {
  const o = c.outcomes;
  return [
    c.requests,
    o.ok,
    o.http429,
    o.http403,
    o.http4xx,
    o.http5xx,
    o.timeout,
    o.network,
    o.busy,
    c.latencyMs,
    ...c.latency,
    c.queued,
    c.queueMs,
    c.maxInflight,
    c.maxQueue,
  ];
}

if (LATENCY_BOUNDS_MS.length !== 4) throw new Error("upstream_daily has five latency columns: update migration and SUM_COLUMNS");

/** Add one flush's counters to today's rows (one statement per source). */
export async function addUpstreamStats(db: Queryable, stats: Map<string, UpstreamCounters>): Promise<void> {
  const cols = [...SUM_COLUMNS, ...MAX_COLUMNS];
  const placeholders = cols.map((_, i) => `$${i + 2}`).join(", ");
  const updates = [
    ...SUM_COLUMNS.map((c) => `${c} = upstream_daily.${c} + EXCLUDED.${c}`),
    ...MAX_COLUMNS.map((c) => `${c} = greatest(upstream_daily.${c}, EXCLUDED.${c})`),
  ].join(", ");
  for (const [source, counters] of stats) {
    await db.query(
      `INSERT INTO upstream_daily (day, source, ${cols.join(", ")}) VALUES (${TODAY_UTC}, $1, ${placeholders})
       ON CONFLICT (day, source) DO UPDATE SET ${updates}`,
      [source.slice(0, 80), ...row(counters).map((n) => Math.max(0, Math.round(n)))],
    );
  }
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
  maxInflight: number;
  maxQueue: number;
  /** Last UTC day (YYYY-MM-DD) with a 429 or 403, if any. */
  lastRefusalDay: string | null;
}

/** Totals per source over the last `days` UTC days including today, busiest first. */
export async function upstreamSummary(db: Queryable, days: number): Promise<UpstreamSummary[]> {
  const span = Math.max(1, Math.floor(days));
  const { rows } = await db.query(
    `SELECT source,
            ${SUM_COLUMNS.map((c) => `sum(${c}) AS ${c}`).join(", ")},
            max(max_inflight) AS max_inflight, max(max_queue) AS max_queue,
            to_char(max(day) FILTER (WHERE http429 > 0 OR http403 > 0), 'YYYY-MM-DD') AS last_refusal
       FROM upstream_daily
      WHERE day > ${TODAY_UTC} - $1::int
      GROUP BY source
      ORDER BY sum(requests) DESC, source`,
    [span],
  );
  return rows.map((r) => {
    const requests = num(r.requests);
    const buckets = [num(r.lat_250), num(r.lat_1000), num(r.lat_3000), num(r.lat_10000), num(r.lat_slow)];
    const queued = num(r.queued);
    return {
      source: String(r.source),
      requests,
      ok: num(r.ok),
      http429: num(r.http429),
      http403: num(r.http403),
      http4xx: num(r.http4xx),
      http5xx: num(r.http5xx),
      timeouts: num(r.timeouts),
      network: num(r.network),
      busy: num(r.busy),
      avgMs: requests > 0 ? Math.round(num(r.latency_ms) / requests) : null,
      p95UnderMs: p95Bound(buckets),
      queued,
      avgQueueMs: queued > 0 ? Math.round(num(r.queue_ms) / queued) : null,
      maxInflight: num(r.max_inflight),
      maxQueue: num(r.max_queue),
      lastRefusalDay: r.last_refusal ? String(r.last_refusal) : null,
    };
  });
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

/** Drop rows past UPSTREAM_KEEP_DAYS. Returns how many. */
export async function pruneUpstream(db: Queryable): Promise<number> {
  const { rows } = await db.query(`DELETE FROM upstream_daily WHERE day < ${TODAY_UTC} - $1::int RETURNING 1`, [UPSTREAM_KEEP_DAYS]);
  return rows.length;
}
