import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asSourceError } from "@/src/sources/shared/errors";

/**
 * Keyed API → keyless gateway, inside the 60 s function budget. Measured
 * before the fix (stubbed hosts that never answer): one getAct took 63 s with
 * both hosts hanging, and every request paid ~31 s while only the keyed host
 * hung. Fake timers drive fetchUpstream's timeout and retry delay.
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

describe("a hanging keyed host (finding 2)", () => {
  it("costs one short try, then the breaker sends requests straight to the gateway", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: string, init?: { signal?: AbortSignal }) => {
      calls.push(String(input));
      return String(input).includes(KEYED) ? hang(init) : Promise.resolve(new Response(act("/sb/2012/89")));
    });
    const { getAct, getFragmentsPage } = await import("@/src/sources/esbirka");
    const first = await settle(getAct("/sb/2012/89"));
    expect(first.value?.nazev).toBe("Občanský zákoník");
    expect(first.at).toBeLessThan(11_000);
    expect(calls.filter((url) => url.includes(KEYED))).toHaveLength(1); // no retry on a non-last channel

    calls.length = 0;
    vi.stubGlobal("fetch", (input: string, init?: { signal?: AbortSignal }) => {
      calls.push(String(input));
      if (String(input).includes(KEYED)) return hang(init);
      return Promise.resolve(new Response(JSON.stringify({ pocetStranek: 1, seznam: [] })));
    });
    const page = await settle(getFragmentsPage("/sb/2012/89", 0));
    expect(page.at).toBeLessThan(1_000);
    expect(calls.some((url) => url.includes(KEYED))).toBe(false);

    // Past the breaker window the keyed host is tried again.
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    await settle(getFragmentsPage("/sb/2012/89", 1));
    expect(calls.some((url) => url.includes(KEYED))).toBe(true);
  });

  it("fails inside the 60 s budget when both hosts hang", async () => {
    vi.stubGlobal("fetch", (_input: string, init?: { signal?: AbortSignal }) => hang(init));
    const { getAct } = await import("@/src/sources/esbirka");
    const outcome = await settle(getAct("/sb/2012/89"));
    expect(outcome.error).toBeDefined();
    expect(asSourceError("e-Sbírka", outcome.error).kind).toBe("UPSTREAM_UNREACHABLE");
    // 10 s keyed + 15 s gateway + ≤1.5 s retry delay + 15 s gateway retry.
    expect(outcome.at).toBeLessThan(45_000);
  });

  it("does not trip the breaker on a 404 — that is about the document, not the host", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      calls.push(String(input));
      return String(input).includes("99999") ? new Response("missing", { status: 404 }) : new Response(act("/sb/2012/89"));
    });
    const { getAct } = await import("@/src/sources/esbirka");
    const missing = await settle(getAct("/sb/2012/99999"));
    expect(missing.error).toMatchObject({ kind: "NOT_FOUND" });
    calls.length = 0;
    await settle(getAct("/sb/2012/89"));
    expect(calls[0]).toContain(KEYED);
  });
  it("does not trip the breaker on a 5xx to the search POST — measured, a query can cause that", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (init?.method === "POST") return new Response("boom", { status: 500 });
      return new Response(act("/sb/2012/89"));
    });
    const { getAct, searchActs } = await import("@/src/sources/esbirka");
    const failed = await settle(searchActs("zákon č. 89/2012 Sb.", 0, 10));
    expect(failed.error).toMatchObject({ kind: "UPSTREAM_ERROR" });
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(2); // keyed, then the gateway
    calls.length = 0;
    await settle(getAct("/sb/2012/89"));
    expect(calls[0]).toContain(KEYED);
  });
});

describe("resolveVersion failures are not paid twice (finding 2)", () => {
  it("a missing act (404) reads no fragments", async () => {
    delete process.env.ESBIRKA_API_KEY;
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
    delete process.env.ESBIRKA_API_KEY;
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
    delete process.env.ESBIRKA_API_KEY;
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

  it("is PARSE_DRIFT, not 'did not respond', when the gateway serves it", async () => {
    delete process.env.ESBIRKA_API_KEY;
    vi.stubGlobal("fetch", async () => html());
    const { getAct } = await import("@/src/sources/esbirka");
    const outcome = await settle(getAct("/sb/2012/89"));
    expect(outcome.error).toMatchObject({ kind: "PARSE_DRIFT" });
    expect((outcome.error as Error).message).toContain("non-JSON body");
  });

  it("hands the request to the gateway when the keyed host serves it — and trips the breaker", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      calls.push(String(input));
      return String(input).includes(KEYED) ? html() : new Response(act("/sb/2012/89"));
    });
    const { getAct } = await import("@/src/sources/esbirka");
    expect((await settle(getAct("/sb/2012/89"))).value?.nazev).toBe("Občanský zákoník");
    expect(calls.filter((url) => url.includes(GATEWAY))).toHaveLength(1);
    calls.length = 0;
    await settle(getAct("/sb/2012/90"));
    expect(calls.some((url) => url.includes(KEYED))).toBe(false);
  });

  it("a body that stalls past the timeout stays a network failure, retried on the next channel", async () => {
    const stalling = (init?: { signal?: AbortSignal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"nazev":'));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
          },
        }),
      );
    vi.stubGlobal("fetch", async (input: string, init?: { signal?: AbortSignal }) =>
      String(input).includes(KEYED) ? stalling(init) : new Response(act("/sb/2012/89")),
    );
    const { getAct } = await import("@/src/sources/esbirka");
    expect((await settle(getAct("/sb/2012/89"))).value?.nazev).toBe("Občanský zákoník");

    delete process.env.ESBIRKA_API_KEY;
    vi.resetModules();
    vi.stubGlobal("fetch", async (_input: string, init?: { signal?: AbortSignal }) => stalling(init));
    const fresh = await import("@/src/sources/esbirka");
    const outcome = await settle(fresh.getAct("/sb/2012/89"));
    expect(outcome.error).toBeDefined();
    expect(asSourceError("e-Sbírka", outcome.error).kind).toBe("UPSTREAM_UNREACHABLE");
  });
});
