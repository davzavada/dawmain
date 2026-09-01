import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUpstream } from "@/src/sources/shared/http";
import { SourceError } from "@/src/sources/shared/errors";
import { allSourceResults } from "@/src/sources/shared/health";

/**
 * fetchUpstream is the one piece of I/O every source client runs through —
 * its retry budget, its size guard and the health it records are what keep a
 * misbehaving court site from taking the whole function down. None of it was
 * covered, so a change here could silently double the load on a box that is
 * already refusing.
 */

const ok = (body = "{}") => new Response(body, { status: 200 });

function health(source: string) {
  return allSourceResults().find((entry) => entry.source === source);
}

describe("fetchUpstream", () => {
  // Fake timers so the retry back-off (up to ~3 s of real waiting) costs the
  // suite nothing; `settle` drives the pending delay forward by hand.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Await a fetchUpstream call, running its back-off timers to completion. */
  async function settle<T>(promise: Promise<T>): Promise<T> {
    const guarded = promise.catch((error) => ({ __thrown: error }) as never);
    await vi.runAllTimersAsync();
    const value = (await guarded) as T & { __thrown?: unknown };
    if (value && typeof value === "object" && "__thrown" in value) throw value.__thrown;
    return value;
  }

  it("sends a browser-like UA and the caller's headers", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push(init);
      return ok();
    });
    await settle(
      fetchUpstream("UA-src", "https://example.test/", { headers: { referer: "https://x.test/" } }),
    );
    const headers = seen[0].headers as Record<string, string>;
    expect(headers["user-agent"]).toMatch(/^Mozilla\/5\.0 /);
    expect(headers.referer).toBe("https://x.test/");
  });

  it("retries a GET once on 5xx and returns the recovered response", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return calls === 1 ? new Response("boom", { status: 503 }) : ok('{"fine":true}');
    });
    const response = await settle(fetchUpstream("Retry-src", "https://example.test/"));
    expect(calls).toBe(2);
    expect(await response.json()).toEqual({ fine: true });
    expect(health("Retry-src")?.ok).toBe(true);
  });

  it("gives up after the retry and records the failure", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response("boom", { status: 500 });
    });
    await expect(settle(fetchUpstream("Down-src", "https://example.test/"))).rejects.toThrow(SourceError);
    expect(calls).toBe(2);
    expect(health("Down-src")).toMatchObject({ ok: false, detail: "HTTP 500" });
  });

  it("does NOT retry a POST by default — a repeated write is the caller's call", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response("boom", { status: 500 });
    });
    await expect(
      settle(fetchUpstream("Post-src", "https://example.test/", { method: "POST", body: "x" })),
    ).rejects.toThrow(SourceError);
    expect(calls).toBe(1);
  });

  it("retries a network error once, then reports it as unreachable", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    await expect(settle(fetchUpstream("Dead-src", "https://example.test/"))).rejects.toMatchObject({
      kind: "UPSTREAM_UNREACHABLE",
    });
    expect(calls).toBe(2);
    expect(health("Dead-src")?.detail).toBe("timeout");
  });

  it("refuses an oversized body before anyone reads it into memory", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response("x", { status: 200, headers: { "content-length": String(20 * 1024 * 1024) } }),
    );
    await expect(settle(fetchUpstream("Big-src", "https://example.test/"))).rejects.toThrow(
      /over the 12 MB limit/,
    );
    // The source ANSWERED — our own guard tripped, so the light stays green.
    expect(health("Big-src")?.ok).toBe(true);
  });

  it("passes a 404 through: only 429/5xx are errors here", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    const response = await settle(fetchUpstream("NotFound-src", "https://example.test/"));
    expect(response.status).toBe(404);
    expect(health("NotFound-src")).toMatchObject({ ok: false, detail: "HTTP 404" });
  });
});
