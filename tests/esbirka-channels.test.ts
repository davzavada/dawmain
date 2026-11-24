import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asSourceError } from "@/src/sources/shared/errors";

/**
 * e-Sbírka goes through the registered API only — never the SPA's keyless
 * gateway (sbr-cache) — and still answers inside the 60 s function budget.
 * Fake timers drive fetchUpstream's timeout and retry delay.
 */

const KEYED = "api.e-sbirka.gov.cz";
const GATEWAY = "sbr-cache";
const act = (staleUrl: string) => JSON.stringify({ nazev: "Občanský zákoník", staleUrl });

/** A host that never answers: the request ends only when its signal aborts. */
function hang(init?: { signal?: AbortSignal }): Promise<Response> {
  return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
}

/** Run `promise` on the fake clock; when it settled, in fake ms. */
async function settle<T>(promise: Promise<T>, budgetMs = 120_000): Promise<{ at: number; value?: T; error?: unknown }> {
  const started = Date.now();
  let outcome: { at: number; value?: T; error?: unknown } | undefined;
  promise.then(
    (value) => (outcome = { at: Date.now() - started, value }),
    (error: unknown) => (outcome = { at: Date.now() - started, error }),
  );
  for (let t = 0; t < budgetMs && !outcome; t += 100) await vi.advanceTimersByTimeAsync(100);
  if (!outcome) throw new Error(`still pending after ${budgetMs} ms`);
  return outcome;
}

beforeEach(() => {
  process.env.ESBIRKA_API_KEY = "test-key";
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // AbortSignal.timeout runs on Node's own timers — put it on the fake clock.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms);
    return controller.signal;
  });
});
afterEach(() => {
  delete process.env.ESBIRKA_API_KEY;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the registered API only", () => {
  it("never asks the keyless gateway, whatever the API answers", async () => {
    const calls: string[] = [];
    for (const answer of [() => new Response("no", { status: 401 }), () => new Response("boom", { status: 500 })]) {
      vi.stubGlobal("fetch", async (input: string) => {
        calls.push(String(input));
        return answer();
      });
      const { getAct } = await import("@/src/sources/esbirka");
      const outcome = await settle(getAct("/sb/2012/89"));
      expect(outcome.error).toMatchObject({ kind: "UPSTREAM_ERROR" });
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((url) => url.includes(KEYED))).toBe(true);
    expect(calls.some((url) => url.includes(GATEWAY))).toBe(false);
  });

  it("sends the key and never follows a redirect while carrying it", async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_input: string, init: RequestInit) => {
      inits.push(init);
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } });
    });
    const { getAct } = await import("@/src/sources/esbirka");
    const outcome = await settle(getAct("/sb/2012/89"));
    expect(outcome.error).toMatchObject({ kind: "UPSTREAM_ERROR" });
    expect(inits).toHaveLength(1);
    expect(inits[0].redirect).toBe("manual");
    expect((inits[0].headers as Record<string, string>)["esel-api-access-key"]).toBe("test-key");
  });

  it("without a key says e-Sbírka is not configured and makes no request", async () => {
    delete process.env.ESBIRKA_API_KEY;
    const fetchSpy = vi.fn(async () => new Response(act("/sb/2012/89")));
    vi.stubGlobal("fetch", fetchSpy);
    const { getAct } = await import("@/src/sources/esbirka");
    const outcome = await settle(getAct("/sb/2012/89"));
    expect((outcome.error as Error).message).toContain("not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails inside the 60 s budget when the API hangs", async () => {
    vi.stubGlobal("fetch", (_input: string, init?: { signal?: AbortSignal }) => hang(init));
    const { getAct } = await import("@/src/sources/esbirka");
    const outcome = await settle(getAct("/sb/2012/89"));
    expect(asSourceError("e-Sbírka", outcome.error).kind).toBe("UPSTREAM_UNREACHABLE");
    // 15 s + ≤1.5 s retry delay + 15 s retry.
    expect(outcome.at).toBeLessThan(35_000);
  });

  it("a 404 is NOT_FOUND, asked once", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      calls.push(String(input));
      return new Response("missing", { status: 404 });
    });
    const { getAct } = await import("@/src/sources/esbirka");
    const missing = await settle(getAct("/sb/2012/99999"));
    expect(missing.error).toMatchObject({ kind: "NOT_FOUND" });
    expect(calls).toHaveLength(1);
  });
});

describe("resolveVersion failures are not paid twice (finding 2)", () => {
  it("a missing act (404) reads no fragments", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      calls.push(decodeURIComponent(String(input)));
      return new Response("missing", { status: 404 });
    });
    const { getSection } = await import("@/src/sources/esbirka");
    const outcome = await settle(getSection("sb", 2012, 99999, undefined, "§ 1"));
    expect(outcome.error).toMatchObject({ kind: "NOT_FOUND" });
    expect(calls.some((url) => url.includes("/fragmenty"))).toBe(false);
  });

  it("an unreachable service reads no fragments", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: string, init?: { signal?: AbortSignal }) => {
      calls.push(decodeURIComponent(String(input)));
      return hang(init);
    });
    const { getSection } = await import("@/src/sources/esbirka");
    const outcome = await settle(getSection("sb", 2012, 89, undefined, "§ 1"));
    expect(asSourceError("e-Sbírka", outcome.error).kind).toBe("UPSTREAM_UNREACHABLE");
    expect(calls.some((url) => url.includes("/fragmenty"))).toBe(false);
  });

  it("a detail that answers with an error still leaves the plain staleUrl readable", async () => {
    vi.stubGlobal("fetch", async (input: string) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("/sparql?")) return new Response("blocked", { status: 403 });
      if (url.includes("/fragmenty")) {
        return new Response(
          JSON.stringify({
            pocetStranek: 1,
            seznam: [{ kodTypuFragmentu: "Paragraf", zkracenaCitace: "§ 1 zákona č. 89/2012 Sb.", xhtml: "§ 1" }],
          }),
        );
      }
      return new Response(JSON.stringify({ chyby: [{ popis: "Neplatné datum" }] }));
    });
    const { getSection } = await import("@/src/sources/esbirka");
    const outcome = await settle(getSection("sb", 2012, 89, undefined, "§ 1"));
    expect(outcome.value).toMatchObject({ text: "§ 1", version: null });
  });
});

describe("a 200 that is not JSON (finding 11)", () => {
  const html = () => new Response("<!DOCTYPE html><html><body>e-Sbírka</body></html>", { headers: { "content-type": "text/html" } });

  it("is PARSE_DRIFT, not 'did not respond'", async () => {
    vi.stubGlobal("fetch", async () => html());
    const { getAct } = await import("@/src/sources/esbirka");
    const outcome = await settle(getAct("/sb/2012/89"));
    expect(outcome.error).toMatchObject({ kind: "PARSE_DRIFT" });
    expect((outcome.error as Error).message).toContain("non-JSON body");
  });

  it("a body that stalls past the timeout stays a network failure", async () => {
    const stalling = (init?: { signal?: AbortSignal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"nazev":'));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
          },
        }),
      );
    vi.stubGlobal("fetch", async (_input: string, init?: { signal?: AbortSignal }) => stalling(init));
    const { getAct } = await import("@/src/sources/esbirka");
    const outcome = await settle(getAct("/sb/2012/89"));
    expect(outcome.error).toBeDefined();
    expect(asSourceError("e-Sbírka", outcome.error).kind).toBe("UPSTREAM_UNREACHABLE");
  });
});
