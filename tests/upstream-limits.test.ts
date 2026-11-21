import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUpstream } from "@/src/sources/shared/http";
import { SourceError } from "@/src/sources/shared/errors";
import { MAX_QUEUE_WAIT_MS, acquireSlot, resetUpstreamLimits, restoreUpstreamStats, takeUpstreamStats } from "@/src/sources/shared/limits";

/** The per-source limiter and counters (src/sources/shared/limits.ts) and how fetchUpstream uses them. */

beforeEach(() => resetUpstreamLimits({ "Lim-src": 2 }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetUpstreamLimits();
});

describe("acquireSlot", () => {
  it("lets `limit` requests through and queues the next one until a slot frees", async () => {
    const a = await acquireSlot("Lim-src");
    const b = await acquireSlot("Lim-src");
    let third = false;
    const c = acquireSlot("Lim-src").then((release) => {
      third = true;
      return release;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    a();
    (await c)();
    expect(third).toBe(true);
    b();
    const stats = takeUpstreamStats().get("Lim-src")!;
    expect(stats.queued).toBe(1);
    expect(stats.maxInflight).toBe(2);
    expect(stats.maxQueue).toBe(1);
  });

  it("serves the queue in order and never exceeds the limit", async () => {
    let open = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 7 }, async (_, i) => {
        const release = await acquireSlot("Lim-src");
        open++;
        peak = Math.max(peak, open);
        order.push(i);
        await new Promise((r) => setTimeout(r, 1));
        open--;
        release();
      }),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("a double release frees one slot only", async () => {
    const a = await acquireSlot("Lim-src");
    a();
    a();
    const b = await acquireSlot("Lim-src");
    const c = await acquireSlot("Lim-src");
    let fourth = false;
    void acquireSlot("Lim-src").then(() => (fourth = true));
    await Promise.resolve();
    expect(fourth).toBe(false);
    b();
    c();
  });

  it("refuses as busy when the queue does not move, and counts it", async () => {
    vi.useFakeTimers();
    const a = await acquireSlot("Lim-src");
    const b = await acquireSlot("Lim-src");
    const waiting = acquireSlot("Lim-src").catch((e) => e);
    await vi.advanceTimersByTimeAsync(MAX_QUEUE_WAIT_MS + 1);
    const error = await waiting;
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).message).toMatch(/busy/);
    // The refused waiter left the queue: a freed slot goes back to the pool.
    a();
    b();
    const stats = takeUpstreamStats().get("Lim-src")!;
    expect(stats.outcomes.busy).toBe(1);
    expect(stats.requests).toBe(0);
    const again = [await acquireSlot("Lim-src"), await acquireSlot("Lim-src")];
    again.forEach((r) => r());
  });

  it("does not limit a source that is not listed", async () => {
    const releases = await Promise.all(Array.from({ length: 20 }, () => acquireSlot("Unlisted-src")));
    releases.forEach((r) => r());
    expect(takeUpstreamStats().get("Unlisted-src")?.queued ?? 0).toBe(0);
  });
});

describe("fetchUpstream counters", () => {
  it("counts outcomes and latency buckets per request, a retry included", async () => {
    vi.useFakeTimers();
    const statuses = [429, 200, 403, 503, 503];
    vi.stubGlobal("fetch", async () => new Response("x", { status: statuses.shift()! }));
    const run = async (p: Promise<unknown>) => {
      const guarded = p.catch((e) => e);
      await vi.runAllTimersAsync();
      return guarded;
    };
    await run(fetchUpstream("Lim-src", "https://example.test/a")); // 429 then 200
    await run(fetchUpstream("Lim-src", "https://example.test/b")); // 403, not retried
    expect(await run(fetchUpstream("Lim-src", "https://example.test/c"))).toBeInstanceOf(SourceError); // 503 twice
    const s = takeUpstreamStats().get("Lim-src")!;
    expect(s.requests).toBe(5);
    expect(s.outcomes).toMatchObject({ ok: 1, http429: 1, http403: 1, http5xx: 2 });
    expect(s.latency.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it("counts a timeout and a network failure apart", async () => {
    vi.useFakeTimers();
    const errors = [Object.assign(new Error("t"), { name: "TimeoutError" }), new TypeError("fetch failed")];
    vi.stubGlobal("fetch", async () => {
      throw errors.shift();
    });
    const p = fetchUpstream("Lim-src", "https://example.test/").catch((e) => e);
    await vi.runAllTimersAsync();
    expect(await p).toBeInstanceOf(SourceError);
    const s = takeUpstreamStats().get("Lim-src")!;
    expect(s.outcomes).toMatchObject({ timeout: 1, network: 1 });
  });

  it("holds at most `limit` requests open against one source", async () => {
    let open = 0;
    let peak = 0;
    vi.stubGlobal("fetch", async () => {
      open++;
      peak = Math.max(peak, open);
      await new Promise((r) => setTimeout(r, 2));
      open--;
      return new Response("{}", { status: 200 });
    });
    await Promise.all(Array.from({ length: 6 }, (_, i) => fetchUpstream("Lim-src", `https://example.test/${i}`)));
    expect(peak).toBe(2);
  });

  it("a busy refusal is not retried and not recorded as the source failing", async () => {
    vi.useFakeTimers();
    const held = [await acquireSlot("Lim-src"), await acquireSlot("Lim-src")];
    const calls = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", calls);
    const p = fetchUpstream("Lim-src", "https://example.test/").catch((e) => e);
    await vi.advanceTimersByTimeAsync(MAX_QUEUE_WAIT_MS + 1);
    const error = await p;
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).message).toMatch(/busy/);
    expect(calls).not.toHaveBeenCalled();
    held.forEach((r) => r());
  });
});

describe("takeUpstreamStats / restoreUpstreamStats", () => {
  it("resets after a take and adds back what a failed write returns", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}"));
    await fetchUpstream("Lim-src", "https://example.test/");
    const first = takeUpstreamStats();
    expect(takeUpstreamStats().size).toBe(0);
    restoreUpstreamStats(first);
    await fetchUpstream("Lim-src", "https://example.test/");
    expect(takeUpstreamStats().get("Lim-src")!.requests).toBe(2);
  });
});
