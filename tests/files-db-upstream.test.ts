import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setScopeRunner, withScope } from "@/src/files/db/client";
import { addUpstreamStats, p95Bound, pruneUpstream, upstreamSummary } from "@/src/files/db/upstream";
import { emptyCounters, type UpstreamCounters } from "@/src/sources/shared/limits";
import { createTestDb, type TestDb } from "./helpers/pglite";

/** The per-day upstream counters in system_state, on PGlite, as dawmain_app. */

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

describe("upstream counters in system_state", () => {
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

  it("sums a window of days and leaves older days and other keys out", async () => {
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    await t.owner.query(
      `INSERT INTO system_state (key, value) VALUES
         ($1, '{"Nejvyšší soud":{"requests":5,"outcomes":{"ok":4,"http403":1},"maxInflight":7}}'),
         ($2, '{"Nejvyšší soud":{"requests":100,"outcomes":{"ok":100}}}'),
         ('upstreamish', '{"x":1}')`,
      [`upstream:${day(6)}`, `upstream:${day(7)}`],
    );
    const [ns] = await withScope([], (db) => upstreamSummary(db, 7));
    expect(ns).toMatchObject({ requests: 25, http403: 1, maxInflight: 7, lastRefusalDay: new Date().toISOString().slice(0, 10) });
  });

  it("drops days past the retention, and nothing else", async () => {
    const old = new Date(Date.now() - 91 * 86_400_000).toISOString().slice(0, 10);
    await t.owner.query(`INSERT INTO system_state (key, value) VALUES ($1, '{}')`, [`upstream:${old}`]);
    expect(await withScope([], (db) => pruneUpstream(db))).toBe(1);
    const left = await t.owner.query("SELECT key FROM system_state WHERE key = 'upstreamish'");
    expect(left.rows).toHaveLength(1);
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
