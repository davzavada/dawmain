import "server-only";
import { LIMITS, envMode, type FilesMode } from "./config";
import { withScope, type Queryable } from "./db/client";
import { globalUsage } from "./db/libraries";
import { computeHoursEstimate, dbUsage, getSystemState } from "./db/usage";

/**
 * Free-tier guards. Exceeding a Vercel Hobby or Neon Free limit pauses the
 * WHOLE deployment (the public MCP tools included), so Vlastní zdroje steps
 * back long before that:
 *
 *   envOnlyMode()   FILES_MODE / FILES_DATABASE_URL — no I/O, checked first
 *                   (tool registration, callers without Pro never wake the DB);
 *   effectiveMode() env ∧ operator override (system_state.mode_override) ∧
 *                   automatic guards: live data ≥ 80 % of LIMITS.dbBytesCap
 *                   (or the physical size reaching it: PHYSICAL_BACKSTOP),
 *                   stored + reserved pages ≥ 80 % of LIMITS.globalPages,
 *                   estimated compute hours ≥ 70 % of the month → readonly,
 *                   compute hours ≥ 90 % → off. The most restrictive wins;
 *                   an override can only restrict, never lift env "off".
 *                   Measured at most every 30 s per instance; "off" for
 *                   compute hours is kept until the month rolls over (the
 *                   estimate only grows, and every check wakes the DB).
 *                   Only env FILES_MODE=off stops the checks altogether.
 *   allowToolCall() per-user token bucket for files_* MCP calls.
 *   sameOrigin()    the Origin check of the mutating /api/files routes.
 *
 * readonly = search, read and delete work; uploads (and ingest) wait.
 */

const MODE_CACHE_MS = 30_000;
/**
 * Physical size (share of LIMITS.dbBytesCap) that turns the feature
 * read-only even when the live estimate is lower: free space inside the
 * files is reused, but should the estimate be wrong the files grow. The
 * owner's cap itself (plan: "Globálně DB ≤ 400 MB"), well under Neon Free's
 * 0.5 GB, which counts every database of the project and is only checked
 * here every 30 s while ingests keep writing.
 */
export const PHYSICAL_BACKSTOP = 1;
/** Neon Free's storage limit (0.5 GB): writes that grow the database fail beyond it. */
export const NEON_STORAGE_BYTES = 500_000_000;
/** system_state key the operator page writes: "on" | "readonly" | "off" (or { mode }). */
export const MODE_OVERRIDE_KEY = "mode_override";
/** system_state key of the last guard snapshot (written by the daily cron). */
export const GUARDS_STATE_KEY = "guards";

const RANK: Record<FilesMode, number> = { on: 0, readonly: 1, off: 2, unconfigured: 3 };

/** The more restrictive of two modes. Pure. */
export function stricter(a: FilesMode, b: FilesMode): FilesMode {
  return RANK[a] >= RANK[b] ? a : b;
}

export function envOnlyMode(): FilesMode {
  return envMode();
}

/** Parse the stored override; anything unrecognised means "no override". Pure. */
export function parseOverride(value: unknown): FilesMode | null {
  const raw = value && typeof value === "object" ? (value as { mode?: unknown }).mode : value;
  return raw === "on" || raw === "readonly" || raw === "off" ? raw : null;
}

export interface GuardMeasurement {
  /** Physical database size (pg_database_size). */
  dbBytes: number;
  /** Estimated live data: dbBytes minus the free space deletes left behind (files_db_usage). */
  liveBytes: number;
  totalPages: number;
  reservedPages: number;
  computeHours: number;
  /** Shares of the caps, 0–1+ (dbShare: live data; physicalShare: the files). */
  dbShare: number;
  physicalShare: number;
  pagesShare: number;
  computeShare: number;
  /** Mode the automatic guards alone imply. */
  mode: FilesMode;
  /** Czech reasons for a non-"on" mode (operator page). */
  reasons: string[];
}

/**
 * Automatic mode from raw figures. Pure — unit-tested. The DB guard reads
 * the live data (liveBytes, default dbBytes): deleting documents is the way
 * out of read-only mode, and a delete frees space for new rows without
 * shrinking the files.
 */
export function autoMode(figures: {
  dbBytes: number;
  liveBytes?: number;
  totalPages: number;
  reservedPages: number;
  computeHours: number;
}): GuardMeasurement {
  const liveBytes = Math.min(figures.dbBytes, figures.liveBytes ?? figures.dbBytes);
  const dbShare = liveBytes / LIMITS.dbBytesCap;
  const physicalShare = figures.dbBytes / LIMITS.dbBytesCap;
  const pagesShare = (figures.totalPages + figures.reservedPages) / LIMITS.globalPages;
  const computeShare = figures.computeHours / LIMITS.computeHoursPerMonth;
  let mode: FilesMode = "on";
  const reasons: string[] = [];
  if (dbShare >= LIMITS.readonlyAt) {
    mode = "readonly";
    reasons.push(`databáze má ${Math.round(dbShare * 100)} % limitu`);
  } else if (physicalShare >= PHYSICAL_BACKSTOP) {
    mode = "readonly";
    reasons.push(`soubory databáze mají ${Math.round(physicalShare * 100)} % limitu (uvolní je VACUUM FULL)`);
  }
  if (pagesShare >= LIMITS.readonlyAt) {
    mode = "readonly";
    reasons.push(`uloženo ${Math.round(pagesShare * 100)} % globálního limitu stran`);
  }
  if (computeShare >= 0.9) {
    mode = "off";
    reasons.push(`odhad výpočetních hodin je ${Math.round(computeShare * 100)} % měsíce`);
  } else if (computeShare >= 0.7) {
    mode = stricter(mode, "readonly");
    reasons.push(`odhad výpočetních hodin je ${Math.round(computeShare * 100)} % měsíce`);
  }
  return { ...figures, liveBytes, dbShare, physicalShare, pagesShare, computeShare, mode, reasons };
}

/** First instant of the current UTC month. */
export function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** First instant of the next UTC month. */
export function nextMonthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Measure the guards inside an existing (system-scope) transaction. */
export async function measureGuards(db: Queryable, now = new Date()): Promise<GuardMeasurement> {
  const usage = await globalUsage(db);
  const size = await dbUsage(db);
  const computeHours = await computeHoursEstimate(db, monthStartUtc(now));
  return autoMode({
    dbBytes: size.dbBytes,
    liveBytes: size.liveBytes,
    totalPages: usage.totalPages,
    reservedPages: usage.reservedPages,
    computeHours,
  });
}

let modeCache: { until: number; mode: FilesMode } | null = null;
/** The measurement in flight: concurrent callers (parallel files_* calls at expiry) share it. */
let measuring: Promise<{ mode: FilesMode; computeOff: boolean } | null> | null = null;
/** Bumped by the test reset, so a measurement still in flight cannot refill the cache it cleared. */
let generation = 0;

/** Tests: forget the cached mode. */
export function __resetGuardsForTests(): void {
  modeCache = null;
  measuring = null;
  generation++;
  buckets.clear();
}

/**
 * The mode when it is known without I/O — env "off"/"unconfigured", or a
 * cached measurement (including "off" for compute hours until the month
 * rolls over) — else null: effectiveMode() would measure. Lets files_search
 * overlap a cold measurement with its own first queries (the measurement
 * wakes the DB anyway), while a known "off" still touches nothing.
 */
export function cachedMode(now = Date.now()): FilesMode | null {
  const env = envOnlyMode();
  if (env === "off" || env === "unconfigured") return env;
  return modeCache && now < modeCache.until ? stricter(env, modeCache.mode) : null;
}

/**
 * The mode to act on. Env "off"/"unconfigured" answers without I/O; else one
 * system-scope transaction (override + measurements), cached 30 s — or,
 * when the guards turned the feature off for compute hours, until the next
 * UTC month: the estimate never falls within a month, and re-measuring
 * would wake the DB just to learn it again (each wake costs ≥ 5 minutes of
 * the reserve the guard protects). Concurrent callers share one
 * measurement. When the measurement itself fails the env mode is returned
 * uncached — the caller's own DB call will then fail with a proper
 * "unavailable".
 */
export async function effectiveMode(): Promise<FilesMode> {
  const known = cachedMode();
  if (known !== null) return known;
  const env = envOnlyMode();
  if (!measuring) {
    const gen = generation;
    const now = Date.now();
    const run: Promise<{ mode: FilesMode; computeOff: boolean } | null> = withScope([], async (db) => {
      const override = parseOverride(await getSystemState<unknown>(db, MODE_OVERRIDE_KEY));
      const auto = await measureGuards(db, new Date(now));
      return { mode: override ? stricter(override, auto.mode) : auto.mode, computeOff: auto.mode === "off" };
    })
      .then((measured) => {
        if (gen === generation) {
          modeCache = {
            until: measured.computeOff ? nextMonthStartUtc(new Date(now)).getTime() : now + MODE_CACHE_MS,
            mode: measured.mode,
          };
        }
        return measured;
      })
      .catch(() => null)
      .finally(() => {
        if (measuring === run) measuring = null;
      });
    measuring = run;
  }
  const measured = await measuring;
  return measured ? stricter(env, measured.mode) : env;
}

// ---------------------------------------------------------------------------
// Per-user rate limit of files_* tool calls

const buckets = new Map<string, { tokens: number; at: number }>();
const MAX_BUCKETS = 5_000;
const HOUR_MS = 3_600_000;

/**
 * Token bucket per key: `capacity` tokens (LIMITS.toolCallsPerHour unless
 * given), refilled continuously over an hour. Returns false (and consumes
 * nothing) when empty. In memory per instance — a soft limit against
 * runaway agents, the DB counters are the hard ones.
 *
 * files_* pass the bare Clerk user id; another tool family passes its own
 * prefixed key ("zotero:<userId>") and capacity, so the two never drain
 * each other's bucket — a Clerk id cannot contain ":" (USER_ID_RE). One key
 * must always come with the same capacity. The LRU bound is shared.
 */
export function allowToolCall(key: string, now = Date.now(), capacity: number = LIMITS.toolCallsPerHour): boolean {
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    bucket = { tokens: capacity, at: now };
  } else {
    const elapsed = Math.max(0, now - bucket.at);
    bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed * capacity) / HOUR_MS);
    bucket.at = now;
    buckets.delete(key); // re-insert: Map order doubles as LRU order
  }
  buckets.set(key, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// ---------------------------------------------------------------------------
// Same-origin check of mutating routes

/**
 * A mutating browser request must come from this site: the Origin header is
 * required and its host must equal the request's host (x-forwarded-host on
 * Vercel), and Sec-Fetch-Site, when sent, must not say cross-site. Route
 * Handlers get no CSRF protection of their own (Server Actions do). Pure.
 */
export function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  let originHost: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    originHost = url.host.toLowerCase();
  } catch {
    return false;
  }
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = (forwarded || request.headers.get("host") || safeHost(request.url)).toLowerCase();
  return host !== "" && originHost === host;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
