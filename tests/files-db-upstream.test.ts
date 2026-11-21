import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setScopeRunner, withScope } from "@/src/files/db/client";
import { addUpstreamStats, p95Bound, pruneUpstream, upstreamSummary } from "@/src/files/db/upstream";
import { emptyCounters, type UpstreamCounters } from "@/src/sources/shared/limits";
import { createTestDb, type TestDb } from "./helpers/pglite";

/** upstream_daily (migration 0009) on PGlite, as dawmain_app. */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  setScopeRunner(t.runner);
});
afterAll(async () => {
  setScopeRunner(null);
  await t.close();
});

function counters(over: Partial<UpstreamCounters> & { ok?: number; http429?: number } = {}): UpstreamCounters {
  const c = emptyCounters();
  c.outcomes.ok = over.ok ?? 0;
  c.outcomes.http429 = over.http429 ?? 0;
  c.requests = c.outcomes.ok + c.outcomes.http429;
  c.latencyMs = over.latencyMs ?? 0;
  c.latency = over.latency ?? c.latency;
  c.queued = over.queued ?? 0;
  c.queueMs = over.queueMs ?? 0;
  c.maxInflight = over.maxInflight ?? 0;
  return c;
}

describe("upstream_daily", () => {
  it("adds flushes up per day and source, keeps the maxima, and summarises", async () => {
    await withScope([], (db) =>
      addUpstreamStats(db, new Map([["Nejvyšší soud", counters({ ok: 10, latencyMs: 5000, latency: [2, 8, 0, 0, 0], maxInflight: 3, queued: 2, queueMs: 400 })]])),
    );
    await withScope([], (db) =>
      addUpstreamStats(db, new Map([["Nejvyšší soud", counters({ ok: 9, http429: 1, latencyMs: 15000, latency: [0, 6, 4, 0, 0], maxInflight: 2 })]])),
    );
    const [ns] = await withScope([], (db) => upstreamSummary(db, 7));
    expect(ns).toMatchObject({ source: "Nejvyšší soud", requests: 20, ok: 19, http429: 1, avgMs: 1000, maxInflight: 3, queued: 2, avgQueueMs: 200 });
    expect(ns.p95UnderMs).toBe(3000);
    expect(ns.lastRefusalDay).toBe(new Date().toISOString().slice(0, 10));
  });

  it("drops rows past the retention", async () => {
    await t.owner.query(`INSERT INTO upstream_daily (day, source, requests) VALUES ((now() AT TIME ZONE 'UTC')::date - 91, 'old', 1)`);
    expect(await withScope([], (db) => pruneUpstream(db))).toBe(1);
  });
});

describe("p95Bound", () => {
  it("names the bucket bound under which 95 % finished", () => {
    expect(p95Bound([0, 0, 0, 0, 0])).toBeNull();
    expect(p95Bound([100, 0, 0, 0, 0])).toBe(250);
    expect(p95Bound([90, 10, 0, 0, 0])).toBe(1000);
    expect(p95Bound([90, 0, 0, 0, 10])).toBeNull();
  });
});
