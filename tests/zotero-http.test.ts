import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_ORIGIN, LIMITS, ZOTERO_UA } from "@/src/zotero/config";
import {
  ZoteroBodyTooLargeError,
  ZoteroKeyInvalidError,
  __resetZoteroHttpForTests,
  zoteroBreakerOpen,
  zoteroFetch,
} from "@/src/zotero/http";
import { SourceError } from "@/src/sources/shared/errors";

/**
 * zoteroFetch (src/zotero/http.ts) — the only code that talks to
 * api.zotero.org. What it protects is not visible in a happy-path test: the
 * key must stay in a header and never follow a redirect, and the shared
 * Vercel IP must not be blocked by Zotero for invalid keys or impatience.
 * fetch is stubbed; api.zotero.org is never reached.
 */

const CREDS = { userID: 475425, key: "SecretKeyValue1234567890" };
const PATH = "/users/475425/items?limit=1&start=0";
/** Another Zotero user on the same instance. */
const OTHER = { userID: 1, key: "OtherKey000000000000000" };

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(answer: (call: Call, n: number) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return answer(call, calls.length);
  });
  return calls;
}

const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A streamed body without Content-Length — the cap must count bytes, not trust a header. */
function streamed(size: number, chunk = 64 * 1024): Response {
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= size) return controller.close();
        const n = Math.min(chunk, size - sent);
        sent += n;
        controller.enqueue(new Uint8Array(n).fill(0x20));
      },
    }),
    { status: 200 },
  );
}

/** The error a promise rejects with (or a failure when it resolves). */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => __resetZoteroHttpForTests());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("zoteroFetch: what goes out", () => {
  it("sends the key, the API version and an honest UA as headers, and never follows a redirect", async () => {
    const calls = stubFetch(() => json([]));
    const res = await zoteroFetch(CREDS, PATH);
    expect(res.status).toBe(200);
    expect(res.json()).toEqual([]);
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("zotero-api-key")).toBe(CREDS.key);
    expect(headers.get("zotero-api-version")).toBe("3");
    expect(headers.get("user-agent")).toBe(ZOTERO_UA);
    expect(headers.get("user-agent")).not.toContain("Zotero/");
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].url).toBe(`${API_ORIGIN}${PATH}`);
  });

  it("never puts the key into a URL, and refuses a path that carries one", async () => {
    const calls = stubFetch(() => json([]));
    await zoteroFetch(CREDS, PATH);
    await zoteroFetch({ key: CREDS.key }, "/keys/current");
    for (const call of calls) {
      expect(call.url).not.toMatch(/[?&]key=/i);
      expect(call.url).not.toContain(CREDS.key);
    }
    await expect(zoteroFetch(CREDS, `/users/475425/items?key=${CREDS.key}`)).rejects.toThrow(/header/);
    await expect(zoteroFetch(CREDS, "/users/475425/items?KEY=x")).rejects.toThrow(/header/);
    expect(calls).toHaveLength(2);
  });

  it("lets the caller add headers but not replace the key, the version or the UA", async () => {
    const calls = stubFetch(() => new Response(null, { status: 304 }));
    const res = await zoteroFetch(CREDS, PATH, {
      headers: { "If-Modified-Since-Version": "1200", "Zotero-API-Key": "other", "zotero-api-version": "2", "User-Agent": "Zotero/7" },
    });
    expect(res.status).toBe(304);
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("if-modified-since-version")).toBe("1200");
    expect(headers.get("zotero-api-key")).toBe(CREDS.key);
    expect(headers.get("zotero-api-version")).toBe("3");
    expect(headers.get("user-agent")).toBe(ZOTERO_UA);
  });

  it("rejects absolute URLs and other hosts without calling fetch", async () => {
    const calls = stubFetch(() => json([]));
    for (const bad of ["https://evil.example/users/1/items", "//evil.example/x", "evil.example/x", "", "http://api.zotero.org/x"]) {
      await expect(zoteroFetch(CREDS, bad)).rejects.toThrow(/api\.zotero\.org/);
    }
    expect(calls).toHaveLength(0);
  });

  it("sends DELETE when asked", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    const res = await zoteroFetch(CREDS, "/keys/current", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(calls[0].init.method).toBe("DELETE");
  });
});

describe("zoteroFetch: what comes back", () => {
  it("returns a 302 as it is, without following it", async () => {
    const calls = stubFetch(() => new Response("redirect", { status: 302, headers: { location: "https://s3.amazonaws.com/zotero/abc?sig=1" } }));
    const res = await zoteroFetch(CREDS, "/users/475425/items/PDFA2345/file");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://s3.amazonaws.com/zotero/abc?sig=1");
    expect(res.bytes.byteLength).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("returns a 404 to the caller", async () => {
    stubFetch(() => new Response("Not found", { status: 404 }));
    const res = await zoteroFetch(CREDS, "/users/475425/items/ABCD2345");
    expect(res.status).toBe(404);
    expect(res.text()).toBe("Not found");
  });

  it("reports a body that is not JSON as PARSE_DRIFT", async () => {
    stubFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const res = await zoteroFetch(CREDS, PATH);
    const e = await rejection(Promise.resolve().then(() => res.json()));
    expect(e).toBeInstanceOf(SourceError);
    expect((e as SourceError).kind).toBe("PARSE_DRIFT");
  });

  it("caps a streamed body by counting bytes (no Content-Length)", async () => {
    stubFetch(() => streamed(300_000));
    const e = await rejection(zoteroFetch(CREDS, PATH, { maxBytes: 100_000 }));
    expect(e).toBeInstanceOf(ZoteroBodyTooLargeError);
    expect((e as SourceError).kind).toBe("UPSTREAM_ERROR");
    // Under the cap the same stream is read whole.
    stubFetch(() => streamed(90_000));
    expect((await zoteroFetch(CREDS, PATH, { maxBytes: 100_000 })).bytes.byteLength).toBe(90_000);
  });

  it("refuses a declared Content-Length over the cap before reading", async () => {
    let pulled = 0;
    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled++;
              controller.enqueue(new Uint8Array(10));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-length": String(LIMITS.maxJsonBytes + 1) } },
        ),
    );
    await expect(zoteroFetch(CREDS, PATH)).rejects.toBeInstanceOf(ZoteroBodyTooLargeError);
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("turns a network error into UPSTREAM_UNREACHABLE without the key in the message", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError(`fetch failed for ${CREDS.key}`);
    });
    const e = (await rejection(zoteroFetch(CREDS, PATH))) as SourceError;
    expect(e).toBeInstanceOf(SourceError);
    expect(e.kind).toBe("UPSTREAM_UNREACHABLE");
    expect(`${e.message} ${e.hint}`).not.toContain(CREDS.key);
  });

  it("times out a request after LIMITS.requestTimeoutMs", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    );
    const pending = rejection(zoteroFetch(CREDS, PATH));
    await vi.advanceTimersByTimeAsync(LIMITS.requestTimeoutMs);
    const e = (await pending) as SourceError;
    expect(e.kind).toBe("UPSTREAM_UNREACHABLE");
    expect(e.message).toContain("timed out");
  });

  it("gives a 5xx without Retry-After as UPSTREAM_ERROR", async () => {
    const calls = stubFetch(() => new Response("down", { status: 502 }));
    const e = (await rejection(zoteroFetch(CREDS, PATH))) as SourceError;
    expect(e.kind).toBe("UPSTREAM_ERROR");
    expect(e.message).toContain("502");
    expect(calls).toHaveLength(1);
  });
});

describe("zoteroFetch: Backoff and Retry-After", () => {
  beforeEach(() => vi.useFakeTimers());

  it("waits out a short Backoff before the next request — of any user: Backoff speaks of Zotero's load", async () => {
    const calls = stubFetch((_, n) => json([], n === 1 ? { Backoff: "2" } : {}));
    await zoteroFetch(CREDS, PATH);
    const second = zoteroFetch(CREDS, PATH);
    const other = zoteroFetch(OTHER, "/users/1/items");
    await vi.advanceTimersByTimeAsync(1_900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([second, other]);
    expect(calls).toHaveLength(3);
  });

  it("fails fast on a long Backoff for every user and says how many seconds are left", async () => {
    const calls = stubFetch(() => json([], { Backoff: "120" }));
    await zoteroFetch(CREDS, PATH);
    for (const [auth, path] of [[CREDS, PATH], [OTHER, "/users/1/items"]] as const) {
      const e = (await rejection(zoteroFetch(auth, path))) as SourceError;
      expect(e).toBeInstanceOf(SourceError);
      expect(e.kind).toBe("UPSTREAM_ERROR");
      expect(e.message).toContain("120 s");
    }
    expect(calls).toHaveLength(1);
    // Once it has passed, requests flow again.
    await vi.advanceTimersByTimeAsync(120_000);
    await zoteroFetch(CREDS, PATH);
    expect(calls).toHaveLength(2);
  });

  it("retries a GET once after a short Retry-After (503 and 429)", async () => {
    for (const status of [503, 429]) {
      __resetZoteroHttpForTests();
      const calls = stubFetch((_, n) => (n === 1 ? new Response("busy", { status, headers: { "Retry-After": "2" } }) : json(["ok"])));
      const pending = zoteroFetch(CREDS, PATH);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).json()).toEqual(["ok"]);
      expect(calls).toHaveLength(2);
    }
  });

  it("retries only once", async () => {
    const calls = stubFetch(() => new Response("busy", { status: 503, headers: { "Retry-After": "1" } }));
    const pending = rejection(zoteroFetch(CREDS, PATH));
    await vi.advanceTimersByTimeAsync(5_000);
    const e = (await pending) as SourceError;
    expect(e.kind).toBe("UPSTREAM_ERROR");
    expect(e.message).toContain("even after a retry");
    expect(calls).toHaveLength(2);
  });

  it("fails fast on a long Retry-After and says how long to wait", async () => {
    const calls = stubFetch(() => new Response("slow down", { status: 429, headers: { "Retry-After": "60" } }));
    const e = (await rejection(zoteroFetch(CREDS, PATH))) as SourceError;
    expect(e.kind).toBe("UPSTREAM_ERROR");
    expect(e.message).toContain("60 s");
    expect(calls).toHaveLength(1);
  });

  it("remembers a 429's long Retry-After: the user's queued and later requests stay home, other users do not", async () => {
    const calls = stubFetch(({ url }) =>
      url.includes("/users/1/") ? json([]) : new Response("slow down", { status: 429, headers: { "Retry-After": "60" } }),
    );
    const burst = await Promise.all(Array.from({ length: 6 }, () => rejection(zoteroFetch(CREDS, PATH))));
    expect(burst.every((e) => e instanceof SourceError && e.kind === "UPSTREAM_ERROR")).toBe(true);
    // Only the requests that were already in flight reached Zotero; the queued ones waited for nothing.
    expect(calls).toHaveLength(LIMITS.concurrencyPerUser);
    const later = (await rejection(zoteroFetch(CREDS, PATH))) as SourceError;
    expect(later.message).toMatch(/pause for another (59|60) s/);
    expect(calls).toHaveLength(LIMITS.concurrencyPerUser);
    // Zotero's rate limit is per user: someone else is not held.
    expect((await zoteroFetch(OTHER, "/users/1/items")).status).toBe(200);
    expect(calls).toHaveLength(LIMITS.concurrencyPerUser + 1);
    await vi.advanceTimersByTimeAsync(60_000);
    stubFetch(() => json([]));
    expect((await zoteroFetch(CREDS, PATH)).status).toBe(200);
  });

  it("remembers a 503's long Retry-After for every user: the API itself is down", async () => {
    const calls = stubFetch(() => new Response("maintenance", { status: 503, headers: { "Retry-After": "30" } }));
    await rejection(zoteroFetch(CREDS, PATH));
    const other = (await rejection(zoteroFetch(OTHER, "/users/1/items"))) as SourceError;
    expect(other.message).toMatch(/pause for another (29|30) s/);
    expect(calls).toHaveLength(1);
  });

  it("never retries a DELETE", async () => {
    const calls = stubFetch(() => new Response("busy", { status: 503, headers: { "Retry-After": "1" } }));
    const pending = rejection(zoteroFetch(CREDS, "/keys/current", { method: "DELETE" }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(((await pending) as SourceError).kind).toBe("UPSTREAM_ERROR");
    expect(calls).toHaveLength(1);
  });
});

describe("zoteroFetch: 403 and the invalid-key breaker", () => {
  /** A different user's revoked key, one per `i`. */
  const dead = (i: number) => ({ userID: 100 + i, key: `DeadKey${i}00000000000000` });

  it("throws ZoteroKeyInvalidError on 'Invalid key' without retrying or leaking the key", async () => {
    const calls = stubFetch(() => new Response("Invalid key", { status: 403 }));
    const e = (await rejection(zoteroFetch(CREDS, PATH))) as SourceError;
    expect(e).toBeInstanceOf(ZoteroKeyInvalidError);
    expect(e).toBeInstanceOf(SourceError);
    expect(e.kind).toBe("NOT_ENTITLED");
    expect(`${e.message} ${e.hint}`).not.toContain(CREDS.key);
    expect(calls).toHaveLength(1);
  });

  it("treats any other 403 as a missing permission, not an invalid key", async () => {
    stubFetch(() => new Response("You do not have permission to access notes", { status: 403 }));
    for (let i = 0; i < LIMITS.breakerInvalidKeys + 1; i++) {
      const e = (await rejection(zoteroFetch(CREDS, PATH))) as SourceError;
      expect(e).not.toBeInstanceOf(ZoteroKeyInvalidError);
      expect(e.kind).toBe("NOT_ENTITLED");
    }
    expect(zoteroBreakerOpen()).toBe(false);
  });

  it("opens after LIMITS.breakerInvalidKeys invalid keys, blocks without calling fetch, and closes after breakerMs", async () => {
    vi.useFakeTimers();
    const calls = stubFetch(() => new Response("Invalid key", { status: 403 }));
    for (let i = 0; i < LIMITS.breakerInvalidKeys; i++) {
      expect(zoteroBreakerOpen()).toBe(false);
      await expect(zoteroFetch(dead(i), `/users/${100 + i}/items`)).rejects.toBeInstanceOf(ZoteroKeyInvalidError);
    }
    expect(calls).toHaveLength(LIMITS.breakerInvalidKeys);
    expect(zoteroBreakerOpen()).toBe(true);

    const later = stubFetch(() => json([]));
    const e = (await rejection(zoteroFetch(CREDS, PATH))) as SourceError;
    expect(e).toBeInstanceOf(SourceError);
    expect(e).not.toBeInstanceOf(ZoteroKeyInvalidError);
    expect(e.message).toMatch(/paused/);
    expect(later).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(LIMITS.breakerMs - 1_000);
    expect(zoteroBreakerOpen()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(zoteroBreakerOpen()).toBe(false);
    expect((await zoteroFetch(CREDS, PATH)).status).toBe(200);
  });

  it("counts only invalid keys within breakerMs", async () => {
    vi.useFakeTimers();
    stubFetch(() => new Response("Invalid key", { status: 403 }));
    for (let i = 0; i < LIMITS.breakerInvalidKeys - 1; i++) await rejection(zoteroFetch(dead(i), `/users/${100 + i}/items`));
    await vi.advanceTimersByTimeAsync(LIMITS.breakerMs);
    await rejection(zoteroFetch(dead(9), "/users/109/items"));
    expect(zoteroBreakerOpen()).toBe(false);
  });

  it("makes no request at all while open", async () => {
    stubFetch(() => new Response("Invalid key", { status: 403 }));
    for (let i = 0; i < LIMITS.breakerInvalidKeys; i++) await rejection(zoteroFetch(dead(i), `/users/${100 + i}/items`));
    const calls = stubFetch(() => json([]));
    await rejection(zoteroFetch(CREDS, PATH));
    await rejection(zoteroFetch({ key: "AnotherKey0000000000000" }, "/keys/current"));
    expect(calls).toHaveLength(0);
  });

  it("sends a rejected key no more than the requests already in flight, and never again", async () => {
    // Zotero answers a moment later, as it would: the burst queues behind the user's slots first.
    const calls = stubFetch(({ url }) =>
      url.includes("/users/1/")
        ? json([])
        : new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("Invalid key", { status: 403 })), 5)),
    );
    const burst = await Promise.all(Array.from({ length: 8 }, () => rejection(zoteroFetch(CREDS, PATH))));
    expect(burst.every((e) => e instanceof ZoteroKeyInvalidError)).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(LIMITS.concurrencyPerUser);
    // A later call with the same key — even as a bare key — fails here, without a request.
    expect(await rejection(zoteroFetch(CREDS, PATH))).toBeInstanceOf(ZoteroKeyInvalidError);
    expect(await rejection(zoteroFetch({ key: CREDS.key }, "/keys/current"))).toBeInstanceOf(ZoteroKeyInvalidError);
    const sent = calls.length;
    expect(calls.every((c) => new Headers(c.init.headers).get("zotero-api-key") === CREDS.key)).toBe(true);
    // One user's revoked key, however many requests it had in flight, is one key: the breaker stays closed.
    expect(zoteroBreakerOpen()).toBe(false);
    expect((await zoteroFetch(OTHER, "/users/1/items")).status).toBe(200);
    expect(calls).toHaveLength(sent + 1);
  });

  it("counts a key rejected by several requests in flight once towards the breaker", async () => {
    stubFetch(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("Invalid key", { status: 403 })), 5)));
    for (let i = 0; i < LIMITS.breakerInvalidKeys - 1; i++) {
      await Promise.all(Array.from({ length: LIMITS.concurrencyPerUser }, () => rejection(zoteroFetch(dead(i), `/users/${100 + i}/items`))));
    }
    expect(zoteroBreakerOpen()).toBe(false);
    // The next distinct key is the one that trips it.
    await rejection(zoteroFetch(dead(9), "/users/109/items"));
    expect(zoteroBreakerOpen()).toBe(true);
  });

  it("forgets a rejected key after breakerMs (a revoked key is marked in the store long before)", async () => {
    vi.useFakeTimers();
    const calls = stubFetch(() => new Response("Invalid key", { status: 403 }));
    await rejection(zoteroFetch(CREDS, PATH));
    await vi.advanceTimersByTimeAsync(LIMITS.breakerMs - 1);
    await rejection(zoteroFetch(CREDS, PATH));
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejection(zoteroFetch(CREDS, PATH));
    expect(calls).toHaveLength(2);
  });
});

describe("zoteroFetch: concurrency per user", () => {
  it(`never runs more than ${LIMITS.concurrencyPerUser} requests of one user at once; other users are not held`, async () => {
    const open: Array<{ user: string; finish: () => void }> = [];
    const active = new Map<string, number>();
    let peakMine = 0;
    vi.stubGlobal("fetch", (url: string) => {
      const user = /\/users\/(\d+)\//.exec(String(url))![1];
      active.set(user, (active.get(user) ?? 0) + 1);
      if (user === "475425") peakMine = Math.max(peakMine, active.get(user)!);
      return new Promise<Response>((resolve) =>
        open.push({
          user,
          finish: () => {
            active.set(user, active.get(user)! - 1);
            resolve(json([]));
          },
        }),
      );
    });
    const finishOne = (user: string) => {
      const i = open.findIndex((o) => o.user === user);
      open.splice(i, 1)[0].finish();
    };

    const mine = Array.from({ length: 7 }, () => zoteroFetch(CREDS, PATH));
    await vi.waitFor(() => expect(open).toHaveLength(LIMITS.concurrencyPerUser));
    // A different user gets through while this one is saturated.
    const other = zoteroFetch({ userID: 2, key: "OtherKey000000000000000" }, "/users/2/items");
    await vi.waitFor(() => expect(open.filter((o) => o.user === "2")).toHaveLength(1));
    finishOne("2");
    await other;

    for (let done = 0; done < mine.length; done++) {
      await vi.waitFor(() => expect(open.some((o) => o.user === "475425")).toBe(true));
      // Give any wrongly admitted request the chance to start before checking.
      await new Promise((r) => setTimeout(r, 0));
      expect(active.get("475425")).toBeLessThanOrEqual(LIMITS.concurrencyPerUser);
      finishOne("475425");
    }
    await Promise.all(mine);
    expect(peakMine).toBe(LIMITS.concurrencyPerUser);
  });

  it("frees the slot when a request fails", async () => {
    let n = 0;
    stubFetch(() => (++n <= LIMITS.concurrencyPerUser ? new Response("down", { status: 500 }) : json([])));
    const failures = await Promise.all(Array.from({ length: LIMITS.concurrencyPerUser }, () => rejection(zoteroFetch(CREDS, PATH))));
    expect(failures.every((e) => e instanceof SourceError)).toBe(true);
    expect((await zoteroFetch(CREDS, PATH)).status).toBe(200);
  });

  it("lets a waiting request give up when the caller's signal aborts", async () => {
    const open: Array<() => void> = [];
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => open.push(() => resolve(json([])))));
    const busy = Array.from({ length: LIMITS.concurrencyPerUser }, () => zoteroFetch(CREDS, PATH));
    await vi.waitFor(() => expect(open).toHaveLength(LIMITS.concurrencyPerUser));
    const ctrl = new AbortController();
    const waiting = rejection(zoteroFetch(CREDS, PATH, { signal: ctrl.signal }));
    ctrl.abort();
    expect(((await waiting) as SourceError).kind).toBe("UPSTREAM_UNREACHABLE");
    for (const release of open) release();
    await Promise.all(busy);
    expect(open).toHaveLength(LIMITS.concurrencyPerUser);
  });
});
