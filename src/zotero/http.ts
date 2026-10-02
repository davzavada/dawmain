import "server-only";
import { createHash } from "node:crypto";
import { SourceError } from "@/src/sources/shared/errors";
import { API_ORIGIN, LIMITS, SOURCE, ZOTERO_UA } from "./config";
import type { ZoteroCreds } from "./types";

/**
 * The one door to api.zotero.org. Deliberately NOT fetchUpstream
 * (src/sources/shared/http.ts): that follows redirects — and would carry the
 * Zotero-API-Key header on to the storage host a file download redirects
 * to —, ignores Backoff / Retry-After, sends a browser UA and records a
 * user's own 403/404 as the health of a public source.
 *
 * - Only API_ORIGIN; the key travels in a header, never in the URL.
 * - Redirects are returned, never followed (downloadPdf in ./client.ts
 *   follows the one it trusts, without the key).
 * - Bodies are read HERE, under a byte cap counted while streaming and
 *   inside the concurrency slot: a caller can neither forget to release a
 *   slot nor buffer an unbounded body.
 * - Politeness per Zotero user (Zotero allows 5 concurrent requests per
 *   user, shared with the user's desktop sync): at most
 *   LIMITS.concurrencyPerUser at a time on this instance, one retry of a GET
 *   — or of a POST that carries a Zotero-Write-Token — after a short
 *   Retry-After, and a 429's Retry-After remembered as the
 *   user's not-before time, so queued and later requests do not go straight
 *   back (a short one is waited out, a long one fails fast).
 * - Politeness per instance: Backoff (and a 503's Retry-After) speaks of
 *   Zotero's load, not of one user, so it holds every request of this
 *   instance — one IP and one UA to Zotero.
 * - A key Zotero rejected ("Invalid key") is remembered by fingerprint and
 *   never sent again from this instance: requests of the same key waiting
 *   for a slot, a retry and later calls fail here without a request, so a
 *   revoked key costs at most the requests already in flight.
 * - Invalid keys trip an instance-wide breaker: Zotero blocks the WHOLE IP
 *   (Vercel's, shared with every other user) after more than 5 invalid keys
 *   in 300 s, so after LIMITS.breakerInvalidKeys DISTINCT rejected keys this
 *   instance stops calling Zotero for LIMITS.breakerMs. Counting keys, not
 *   responses, keeps one user's revoked key from pausing Zotero for all.
 *
 * Nothing here records source health (a user's private library is not a
 * public source's status), and no message carries the key or a URL.
 */

/** A connected user's credentials, or a bare key before its user id is known (GET /keys/current). */
export type ZoteroAuth = ZoteroCreds | { key: string; userID?: number };

export interface ZoteroFetchOptions {
  method?: "GET" | "DELETE" | "POST";
  /**
   * POST only: a JSON body (sent as application/json). A POST is repeated
   * after a short 429/503 only when it carries a Zotero-Write-Token header:
   * Zotero applies a token at most once (a repeat of a write it already
   * applied answers 412), so the retry cannot create a second item.
   */
  json?: unknown;
  /** Extra request headers (If-Modified-Since-Version…). They cannot replace the key, the API version or the UA. */
  headers?: Record<string, string>;
  /** The caller's budget (a tool call's), combined with the per-request timeout. */
  signal?: AbortSignal;
  /** Byte cap for the body (default LIMITS.maxJsonBytes). */
  maxBytes?: number;
}

/** A finished exchange: the body is already read (empty for 204, 304 and redirects). */
export interface ZoteroResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  /** The body as UTF-8 text. */
  text(): string;
  /** The body as JSON; SourceError PARSE_DRIFT when it is not JSON. */
  json(): unknown;
}

/** Zotero answered 403 "Invalid key": the key was deleted or revoked on zotero.org. Never retried. */
export class ZoteroKeyInvalidError extends SourceError {
  constructor() {
    super(
      SOURCE,
      "NOT_ENTITLED",
      `${SOURCE}: zotero.org rejected the connected API key — it was deleted or revoked there.`,
      "The user has to connect Zotero again in Dawmain (menu → Zotero). Do not call zotero_* again in this conversation.",
    );
    this.name = "ZoteroKeyInvalidError";
  }
}

/** A body over the caller's byte cap; downloadPdf turns it into "too-large". */
export class ZoteroBodyTooLargeError extends SourceError {
  constructor(maxBytes: number) {
    super(
      SOURCE,
      "UPSTREAM_ERROR",
      `${SOURCE}: the answer is larger than ${formatMb(maxBytes)} and was not read.`,
      "Narrow the request (fewer items, a smaller page, one collection).",
    );
    this.name = "ZoteroBodyTooLargeError";
  }
}

/** Reserved headers the caller cannot set. */
const RESERVED_HEADERS = new Set(["zotero-api-key", "zotero-api-version", "user-agent", "authorization", "content-type"]);
/** Zotero-Write-Token: 32 hex characters (the write_requests docs). */
const WRITE_TOKEN_RE = /^[0-9a-f]{32}$/;
/** An "Invalid key" 403 is a short sentence; this much is enough to recognise it. */
const FORBIDDEN_BODY_BYTES = 4 * 1024;

// ---------------------------------------------------------------------------
// Per-instance state: slots, pauses, rejected keys and the invalid-key breaker

interface Gate {
  active: number;
  waiting: Array<() => void>;
}

const gates = new Map<string, Gate>();
/**
 * Epoch ms before which no request may start: per user (a 429's
 * Retry-After) and under INSTANCE for everyone (Backoff, a 503's Retry-After).
 */
const notBefore = new Map<string, number>();
/** The notBefore entry that holds every user (politeness keys start with "u:" or "k:"). */
const INSTANCE = "*";
/**
 * Fingerprints of keys Zotero rejected → epoch ms until which they are not
 * sent again. As long as the breaker's window, so each key counts at most
 * once in it. Beyond that the caller marks the connection revoked
 * (markRevoked in ./store.ts) and the tool gate never hands the key here.
 */
const rejectedKeys = new Map<string, number>();
/** Bound on rejectedKeys (the breaker trips long before; this only caps memory). */
const MAX_REJECTED_KEYS = 1_000;
/** When each distinct rejected key within the last breakerMs was first rejected. */
let invalidKeysAt: number[] = [];
let breakerUntil = 0;

/** Whether the invalid-key breaker currently stops every call to Zotero (the tool gate checks it before any work). */
export function zoteroBreakerOpen(now = Date.now()): boolean {
  return breakerUntil > now;
}

export function __resetZoteroHttpForTests(): void {
  gates.clear();
  notBefore.clear();
  rejectedKeys.clear();
  invalidKeysAt = [];
  breakerUntil = 0;
}

/**
 * A key's fingerprint: never the key itself, which must not sit in a map
 * that a heap snapshot or a debug dump could show.
 */
function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function keyRejected(fp: string, now = Date.now()): boolean {
  const until = rejectedKeys.get(fp);
  if (until === undefined) return false;
  if (until > now) return true;
  rejectedKeys.delete(fp);
  return false;
}

/**
 * Zotero rejected this key: remember it, and count it towards the breaker
 * once — the other requests of the same key that were already in flight
 * come back rejected too, and counting those would let one user's revoked
 * key pause Zotero for every user of the instance.
 */
function noteInvalidKey(fp: string, now = Date.now()): void {
  if (keyRejected(fp, now)) return;
  if (rejectedKeys.size >= MAX_REJECTED_KEYS) {
    for (const [other, until] of rejectedKeys) if (until <= now) rejectedKeys.delete(other);
    // Still full: drop the oldest (a Map iterates in insertion order).
    const oldest = rejectedKeys.keys().next();
    if (rejectedKeys.size >= MAX_REJECTED_KEYS && !oldest.done) rejectedKeys.delete(oldest.value);
  }
  rejectedKeys.set(fp, now + LIMITS.breakerMs);
  invalidKeysAt = invalidKeysAt.filter((at) => now - at < LIMITS.breakerMs);
  invalidKeysAt.push(now);
  if (invalidKeysAt.length >= LIMITS.breakerInvalidKeys) {
    breakerUntil = now + LIMITS.breakerMs;
    // The keys that tripped it are spent; a fresh run of rejected keys is needed to trip it again.
    invalidKeysAt = [];
  }
}

/** Who a request counts against: the Zotero user id when known, else the key's fingerprint. */
function politenessKey(auth: ZoteroAuth, fp: string): string {
  if (typeof auth.userID === "number" && Number.isSafeInteger(auth.userID) && auth.userID > 0) return `u:${auth.userID}`;
  return `k:${fp}`;
}

/** Take one of the user's slots; the returned release hands it straight to the next waiter. */
async function acquire(who: string, signal: AbortSignal | undefined): Promise<() => void> {
  let gate = gates.get(who);
  if (!gate) {
    gate = { active: 0, waiting: [] };
    gates.set(who, gate);
  }
  const g = gate;
  if (g.active < LIMITS.concurrencyPerUser) {
    g.active++;
  } else {
    if (signal?.aborted) throw cancelled();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = g.waiting.indexOf(wake);
        if (i >= 0) g.waiting.splice(i, 1);
        reject(cancelled());
      };
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      g.waiting.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // The releaser handed its slot over without decrementing `active`.
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = g.waiting.shift();
    if (next) next();
    else if (--g.active === 0 && gates.get(who) === g) gates.delete(who);
  };
}

/** Hold requests under `scope` (a user, or INSTANCE) for `ms` from now; an earlier, longer pause stands. */
function pause(scope: string, ms: number): void {
  if (!(ms > 0)) return;
  const now = Date.now();
  for (const [other, until] of notBefore) if (until <= now) notBefore.delete(other);
  const until = now + ms;
  if (until > (notBefore.get(scope) ?? 0)) notBefore.set(scope, until);
}

/**
 * Wait out a short pause (the user's or the instance's, whichever ends
 * later); refuse a long one with the time left, so the model can tell the
 * user. Re-checked after every sleep: while this request slept, another one
 * of the user's slot holders may have come back with a 429 (Retry-After 60)
 * or a Backoff / 503 — going out then would walk straight into it.
 */
async function honourPause(who: string, signal: AbortSignal | undefined): Promise<void> {
  for (;;) {
    const wait = Math.max(notBefore.get(who) ?? 0, notBefore.get(INSTANCE) ?? 0) - Date.now();
    if (wait <= 0) return;
    if (wait > LIMITS.maxBackoffWaitMs) {
      const seconds = Math.ceil(wait / 1000);
      throw new SourceError(
        SOURCE,
        "UPSTREAM_ERROR",
        `${SOURCE} asked this server to pause for another ${seconds} s (Backoff / Retry-After) — it is under load or got too many requests.`,
        `Wait about ${seconds} s before calling zotero_* again, and make fewer calls; tell the user if they are waiting.`,
      );
    }
    await sleep(wait, signal);
  }
}

// ---------------------------------------------------------------------------
// The request

/**
 * One request to api.zotero.org, answered with its body already read.
 * Returns 2xx, 3xx (never followed), 304 and 4xx other than 403 to the
 * caller; throws SourceError for everything this layer decides on its own:
 * 403 (ZoteroKeyInvalidError or NOT_ENTITLED), 429/503 after at most one
 * retry, other 5xx, network failures and timeouts, an oversized body, an
 * open breaker, a long pause (Backoff / Retry-After) and a key Zotero
 * already rejected (ZoteroKeyInvalidError without a request).
 */
export async function zoteroFetch(auth: ZoteroAuth, pathAndQuery: string, opts: ZoteroFetchOptions = {}): Promise<ZoteroResponse> {
  const url = apiUrl(pathAndQuery);
  if (typeof auth.key !== "string" || !auth.key) throw new Error("zoteroFetch needs an API key.");
  const method = opts.method ?? "GET";
  if ((method === "POST") !== (opts.json !== undefined)) throw new Error("zoteroFetch: a JSON body goes with POST, and only with POST.");
  const writeToken = Object.entries(opts.headers ?? {}).find(([name]) => name.toLowerCase() === "zotero-write-token")?.[1];
  if (writeToken !== undefined && !WRITE_TOKEN_RE.test(writeToken)) throw new Error("zoteroFetch: a Zotero-Write-Token is 32 hex characters.");
  // Serialized once: a retry sends exactly the same body under the same token.
  const body = opts.json !== undefined ? JSON.stringify(opts.json) : undefined;
  const maxBytes = opts.maxBytes ?? LIMITS.maxJsonBytes;
  const fp = keyFingerprint(auth.key);
  if (keyRejected(fp)) throw new ZoteroKeyInvalidError();
  if (zoteroBreakerOpen()) throw breakerError();

  const who = politenessKey(auth, fp);
  const release = await acquire(who, opts.signal);
  try {
    for (let attempt = 1; ; attempt++) {
      await honourPause(who, opts.signal);
      // While this request waited for its slot (or a pause), another one may
      // have had the same key rejected, or tripped the breaker.
      if (keyRejected(fp)) throw new ZoteroKeyInvalidError();
      if (zoteroBreakerOpen()) throw breakerError();
      const res = await send(url, method, auth.key, opts, maxBytes, body);
      // Backoff: Zotero is overloaded — fewer requests from this instance as a whole, not from one user.
      pause(INSTANCE, (parseSeconds(res.headers.get("backoff")) ?? 0) * 1000);

      if (res.status === 429 || res.status === 503) {
        const waitMs = parseRetryAfter(res.headers.get("retry-after"));
        // Remembered, so the user's queued and later requests wait too (or
        // fail fast on a long wait). A 429 is Zotero's per-user rate limit;
        // a 503 means the API itself is unavailable, for everyone.
        if (waitMs !== null) pause(res.status === 429 ? who : INSTANCE, waitMs);
        // Only a GET, or a POST under a write token, is repeated: a DELETE that Zotero may have applied is the
        // caller's call, and a POST without a token could create its item twice.
        const repeatable = method === "GET" || (method === "POST" && writeToken !== undefined);
        if (attempt === 1 && repeatable && waitMs !== null && waitMs <= LIMITS.maxRetryAfterMs) {
          await sleep(waitMs, opts.signal);
          continue;
        }
        throw overloaded(res.status, waitMs, attempt > 1);
      }
      if (res.status === 403) {
        if (/invalid key/i.test(res.text())) {
          noteInvalidKey(fp);
          throw new ZoteroKeyInvalidError();
        }
        if (method === "POST") {
          throw new SourceError(
            SOURCE,
            "NOT_ENTITLED",
            `${SOURCE} refused the write (HTTP 403): the connected key may not write to this library.`,
            "Nothing was saved. The user can allow saving by connecting Zotero again in Dawmain with „Číst a ukládat“ and leaving write access ticked on zotero.org.",
          );
        }
        throw new SourceError(
          SOURCE,
          "NOT_ENTITLED",
          `${SOURCE} refused access (HTTP 403): the connected key may not read this library, its notes or its files.`,
          "Stay within the libraries the key may read. The user can widen the key's access at zotero.org/settings/keys, or connect Zotero again in Dawmain.",
        );
      }
      if (res.status >= 500) {
        throw new SourceError(
          SOURCE,
          "UPSTREAM_ERROR",
          `${SOURCE} answered HTTP ${res.status}.`,
          "Zotero is having problems. Try again in a minute.",
        );
      }
      return res;
    }
  } finally {
    release();
  }
}

/** Path + query on API_ORIGIN, nothing else; the key may never ride in the URL. */
function apiUrl(pathAndQuery: string): URL {
  if (typeof pathAndQuery !== "string" || !pathAndQuery.startsWith("/") || pathAndQuery.startsWith("//")) {
    throw new Error("zoteroFetch takes a path on api.zotero.org (e.g. /users/1/items), never a URL.");
  }
  const url = new URL(API_ORIGIN + pathAndQuery);
  if (url.origin !== API_ORIGIN) throw new Error("zoteroFetch only calls api.zotero.org.");
  if ([...url.searchParams.keys()].some((name) => name.toLowerCase() === "key")) {
    throw new Error("The Zotero API key travels in the Zotero-API-Key header, never in the URL.");
  }
  return url;
}

/** One network exchange under the per-request timeout, the body read under the cap. */
async function send(
  url: URL,
  method: "GET" | "DELETE" | "POST",
  key: string,
  opts: ZoteroFetchOptions,
  maxBytes: number,
  body: string | undefined,
): Promise<ZoteroResponse> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    if (!RESERVED_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  if (body !== undefined) headers.set("Content-Type", "application/json");
  headers.set("Zotero-API-Key", key);
  headers.set("Zotero-API-Version", "3");
  headers.set("User-Agent", ZOTERO_UA);

  const timer = new AbortController();
  const timeout = setTimeout(
    () => timer.abort(new DOMException("Zotero request timed out", "TimeoutError")),
    LIMITS.requestTimeoutMs,
  );
  const signal = opts.signal ? AbortSignal.any([opts.signal, timer.signal]) : timer.signal;
  try {
    const response = await fetch(url.href, { method, headers, body, redirect: "manual", signal });
    const status = response.status;
    let bytes: Uint8Array;
    if (status === 204 || status === 304 || (status >= 300 && status < 400) || status === 429 || status >= 500) {
      // Nothing in these bodies is used; dropping them frees the connection.
      await response.body?.cancel().catch(() => undefined);
      bytes = new Uint8Array(0);
    } else if (status === 403) {
      bytes = await readBody(response, FORBIDDEN_BODY_BYTES, "truncate");
    } else {
      bytes = await readBody(response, maxBytes, "throw");
    }
    return buffered(status, response.headers, bytes);
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(
      SOURCE,
      "UPSTREAM_UNREACHABLE",
      `${SOURCE} did not respond (${failureLabel(error, opts.signal)}).`,
      "Try again in a minute; if it keeps failing, zotero.org may be down.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function buffered(status: number, headers: Headers, bytes: Uint8Array): ZoteroResponse {
  let text: string | null = null;
  const asText = () => (text ??= new TextDecoder("utf-8").decode(bytes));
  return {
    status,
    headers,
    bytes,
    text: asText,
    json() {
      try {
        return JSON.parse(asText()) as unknown;
      } catch {
        throw new SourceError(
          SOURCE,
          "PARSE_DRIFT",
          `${SOURCE} answered HTTP ${status} with a body that is not JSON.`,
          "Try again later; if it keeps failing, the Zotero API changed and src/zotero/client.ts needs updating.",
        );
      }
    },
  };
}

/**
 * Read a body chunk by chunk, counting bytes, so an oversized answer is cut
 * off without being buffered whole (Content-Length alone is not trusted —
 * a chunked body has none). "truncate" keeps the first `max` bytes instead
 * of failing.
 */
export async function readBody(response: Response, max: number, over: "throw" | "truncate"): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (over === "throw" && response.headers.has("content-length") && Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    throw new ZoteroBodyTooLargeError(max);
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      await reader.cancel().catch(() => undefined);
      if (over === "throw") throw new ZoteroBodyTooLargeError(max);
      chunks.push(value.subarray(0, max - size));
      size = max;
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers

/** Retry-After: delta-seconds or an HTTP date → ms from now; null when absent or unreadable. */
function parseRetryAfter(value: string | null): number | null {
  const seconds = parseSeconds(value);
  if (seconds !== null) return seconds * 1000;
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function parseSeconds(value: string | null): number | null {
  if (!value || !/^\s*\d{1,7}\s*$/.test(value)) return null;
  return Number(value.trim());
}

function overloaded(status: number, waitMs: number | null, retried: boolean): SourceError {
  const seconds = waitMs === null ? null : Math.max(1, Math.ceil(waitMs / 1000));
  const what = status === 429 ? "too many requests" : "service unavailable";
  return new SourceError(
    SOURCE,
    "UPSTREAM_ERROR",
    `${SOURCE} answered HTTP ${status} (${what})${retried ? " even after a retry" : ""}${seconds !== null ? ` and asked to wait ${seconds} s` : ""}.`,
    seconds !== null
      ? `Wait about ${seconds} s before calling zotero_* again, and make fewer calls.`
      : "Wait a minute before calling zotero_* again, and make fewer calls.",
  );
}

function breakerError(): SourceError {
  const minutes = Math.max(1, Math.ceil((breakerUntil - Date.now()) / 60_000));
  return new SourceError(
    SOURCE,
    "UPSTREAM_ERROR",
    `${SOURCE}: calls to zotero.org are paused on this server for about ${minutes} min after repeated invalid API keys.`,
    "This protects the server's shared address from being blocked by Zotero. Do not call zotero_* again in this conversation; try again later.",
  );
}

/** The caller's budget ran out — also what a caller gets that stops waiting for a load shared with other calls (./client.ts). */
export function cancelled(): SourceError {
  return new SourceError(
    SOURCE,
    "UPSTREAM_UNREACHABLE",
    `${SOURCE}: the request was cancelled (the call's time budget ran out).`,
    "Try again with a narrower request.",
  );
}

/** A log-safe label for a network failure — the error's name, never its text (which may quote the URL). */
function failureLabel(error: unknown, callerSignal: AbortSignal | undefined): string {
  if (callerSignal?.aborted) return "cancelled";
  if (error instanceof Error || error instanceof DOMException) {
    if (error.name === "TimeoutError") return "timed out";
    if (error.name === "AbortError") return "cancelled";
    return error.name;
  }
  return "network error";
}

/** Sleep that a caller's abort cuts short (as a cancellation). */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function formatMb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
}
