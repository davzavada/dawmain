import { SourceError } from "./errors";

/**
 * Politeness toward the official databases, and the numbers to tune it by.
 *
 * Everything leaves this server from one home IP address. A limiter per
 * source caps how many requests are open against it at once; the rest wait
 * in a FIFO queue, so a burst of tool calls reaches a court's site as a
 * steady trickle instead of a spike that gets the address blocked. A
 * request that would wait longer than MAX_QUEUE_WAIT_MS is refused with a
 * "busy" error rather than eating the tool call's time budget.
 *
 * The same chokepoint counts, per source, what came back (ok, 429, 403,
 * other 4xx, 5xx, timeout, network failure), how long it took and how much
 * queueing there was. Nothing here makes a request of its own: the figures
 * come from real traffic only. The web process writes them to the files
 * database once a minute (src/sources/upstream-stats-flush.ts) and the
 * Správa → Systém page shows the last days, so the limits below can be
 * raised where a source never pushed back and lowered where it did.
 *
 * State lives on globalThis: Next compiles route handlers, pages and
 * instrumentation into separate module graphs, and one process must share
 * one limiter and one set of counters.
 */

/**
 * Open requests allowed per source label (the SOURCE constant of each
 * client). Conservative starting points, to be tuned from the measurements;
 * never below what one tool call of that source opens at once by itself, so
 * a lone user is not slowed down.
 * A label not listed (the mirror: our own API) has no limit.
 */
export const SOURCE_CONCURRENCY: Readonly<Record<string, number>> = Object.freeze({
  // src/sources/ns.ts keeps its own gate of 2 on top; this one only bounds it from outside.
  "Nejvyšší soud": 3,
  "Nejvyšší správní soud": 3,
  // One deep us_search already opens four "dances" at once (src/sources/nalus.ts).
  "Ústavní soud (NALUS)": 4,
  "rozhodnuti.justice.cz": 3,
  // Fragment pages and section scans are read five at a time (src/sources/esbirka.ts).
  "e-Sbírka": 5,
  "e-Sbírka open data (SPARQL)": 2,
  "EUR-Lex (Cellar)": 4,
  "CJEU (InfoCuria)": 3,
  "Poslanecká sněmovna (psp.cz)": 3,
  "UKAŽ (Univerzita Karlova, Primo)": 3,
  "Slov-Lex (Zbierka zákonov SR)": 3,
  "Slov-Lex (eLegislatíva)": 3,
  "Slov-Lex (súdne rozhodnutia)": 3,
});

/** Longest a request waits for a free slot before it is refused as busy. */
export const MAX_QUEUE_WAIT_MS = 20_000;

/** Upper bounds (ms) of the latency buckets; the last bucket is everything slower. */
export const LATENCY_BOUNDS_MS = [250, 1_000, 3_000, 10_000] as const;

export type UpstreamOutcome = "ok" | "http429" | "http403" | "http4xx" | "http5xx" | "timeout" | "network" | "busy";
export const OUTCOMES: readonly UpstreamOutcome[] = ["ok", "http429", "http403", "http4xx", "http5xx", "timeout", "network", "busy"];

export interface UpstreamCounters {
  /** Requests sent upstream (a retry is a second request). Refused-as-busy ones are not sent and not counted here. */
  requests: number;
  outcomes: Record<UpstreamOutcome, number>;
  /** Sum of the latencies of sent requests, ms. */
  latencyMs: number;
  /** Counts per LATENCY_BOUNDS_MS bucket, plus one for slower. */
  latency: number[];
  /** Requests that had to wait for a slot, and how long they waited in total. */
  queued: number;
  queueMs: number;
  maxInflight: number;
  maxQueue: number;
}

interface Waiter {
  wake: () => void;
}

interface SourceState {
  inflight: number;
  queue: Waiter[];
  /** Since the last takeUpstreamStats(). */
  delta: UpstreamCounters;
}

interface Store {
  sources: Map<string, SourceState>;
  limits: Record<string, number>;
}

const KEY = Symbol.for("dawmain.upstream-limits");

function store(): Store {
  const g = globalThis as { [KEY]?: Store };
  g[KEY] ??= { sources: new Map(), limits: { ...SOURCE_CONCURRENCY } };
  return g[KEY];
}

export function emptyCounters(): UpstreamCounters {
  return {
    requests: 0,
    outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<UpstreamOutcome, number>,
    latencyMs: 0,
    latency: new Array(LATENCY_BOUNDS_MS.length + 1).fill(0),
    queued: 0,
    queueMs: 0,
    maxInflight: 0,
    maxQueue: 0,
  };
}

function state(source: string): SourceState {
  const s = store();
  let one = s.sources.get(source);
  if (!one) {
    one = { inflight: 0, queue: [], delta: emptyCounters() };
    s.sources.set(source, one);
  }
  return one;
}

export function concurrencyLimit(source: string): number | undefined {
  return store().limits[source];
}

/** Tests only: replace the limits (merged over the defaults) and clear all state. */
export function resetUpstreamLimits(limits: Record<string, number> = {}): void {
  const s = store();
  s.sources.clear();
  s.limits = { ...SOURCE_CONCURRENCY, ...limits };
}

function busy(source: string, limit: number): SourceError {
  return new SourceError(
    source,
    "UPSTREAM_ERROR",
    `${source} is busy: Dawmain already has ${limit} requests open against it and the queue did not move for ${MAX_QUEUE_WAIT_MS / 1000} s.`,
    "Many searches are running against this source right now. Wait half a minute and try again, ideally with fewer parallel calls.",
  );
}

/**
 * Wait for a slot of `source` and return its release function (idempotent).
 * Sources without a limit get a slot at once.
 */
export async function acquireSlot(source: string, maxWaitMs = MAX_QUEUE_WAIT_MS): Promise<() => void> {
  const one = state(source);
  const limit = concurrencyLimit(source);
  if (limit !== undefined && one.inflight >= limit) {
    const started = Date.now();
    one.delta.queued++;
    one.delta.maxQueue = Math.max(one.delta.maxQueue, one.queue.length + 1);
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        wake: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        const at = one.queue.indexOf(waiter);
        if (at >= 0) one.queue.splice(at, 1);
        one.delta.queueMs += Date.now() - started;
        one.delta.outcomes.busy++;
        reject(busy(source, limit));
      }, maxWaitMs);
      one.queue.push(waiter);
    });
    one.delta.queueMs += Date.now() - started;
    // The releasing request handed its slot over: inflight was not decremented for us.
  } else {
    one.inflight++;
  }
  one.delta.maxInflight = Math.max(one.delta.maxInflight, one.inflight);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = one.queue.shift();
    if (next) next.wake();
    else one.inflight--;
  };
}

/** Count one request that was sent upstream. */
export function recordUpstream(source: string, outcome: Exclude<UpstreamOutcome, "busy">, latencyMs: number): void {
  const d = state(source).delta;
  d.requests++;
  d.outcomes[outcome]++;
  const ms = Math.max(0, Math.round(latencyMs));
  d.latencyMs += ms;
  const bucket = LATENCY_BOUNDS_MS.findIndex((bound) => ms < bound);
  d.latency[bucket === -1 ? LATENCY_BOUNDS_MS.length : bucket]++;
}

export function outcomeOfStatus(status: number): Exclude<UpstreamOutcome, "busy" | "timeout" | "network"> {
  if (status === 429) return "http429";
  if (status === 403) return "http403";
  if (status >= 500) return "http5xx";
  if (status >= 400) return "http4xx";
  return "ok";
}

export function outcomeOfError(error: unknown): "timeout" | "network" {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "network";
}

function isEmpty(c: UpstreamCounters): boolean {
  return c.requests === 0 && c.queued === 0 && c.outcomes.busy === 0;
}

/** The counters gathered since the last call, per source (sources with nothing to report left out), and reset them. */
export function takeUpstreamStats(): Map<string, UpstreamCounters> {
  const out = new Map<string, UpstreamCounters>();
  for (const [source, one] of store().sources) {
    if (isEmpty(one.delta)) continue;
    out.set(source, one.delta);
    one.delta = emptyCounters();
  }
  return out;
}

/** Put counters back after a failed write, so the next flush carries them. */
export function restoreUpstreamStats(stats: Map<string, UpstreamCounters>): void {
  for (const [source, c] of stats) {
    const d = state(source).delta;
    d.requests += c.requests;
    for (const o of OUTCOMES) d.outcomes[o] += c.outcomes[o];
    d.latencyMs += c.latencyMs;
    c.latency.forEach((n, i) => (d.latency[i] += n));
    d.queued += c.queued;
    d.queueMs += c.queueMs;
    d.maxInflight = Math.max(d.maxInflight, c.maxInflight);
    d.maxQueue = Math.max(d.maxQueue, c.maxQueue);
  }
}
