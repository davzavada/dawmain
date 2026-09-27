import "server-only";
import { LIMITS, envMode, type FilesMode } from "./config";
import { withScope, type Queryable } from "./db/client";
import { globalUsage } from "./db/libraries";
import { computeHoursEstimate, getSystemState } from "./db/usage";

/**
 * Free-tier guards. Exceeding a Vercel Hobby or Neon Free limit pauses the
 * WHOLE deployment (the public MCP tools included), so Vlastní zdroje steps
 * back long before that:
 *
 *   envOnlyMode()   FILES_MODE / FILES_DATABASE_URL — no I/O, checked first
 *                   (tool registration, callers without Pro never wake the DB);
 *   effectiveMode() env ∧ operator override (system_state.mode_override) ∧
 *                   automatic guards: DB size ≥ 80 % of LIMITS.dbBytesCap,
 *                   stored + reserved pages ≥ 80 % of LIMITS.globalPages,
 *                   estimated compute hours ≥ 70 % of the month → readonly,
 *                   compute hours ≥ 90 % → off. The most restrictive wins;
 *                   an override can only restrict, never lift env "off".
 *                   Measured at most every 30 s per instance.
 *   allowToolCall() per-user token bucket for files_* MCP calls.
 *   sameOrigin()    the Origin check of the mutating /api/files routes.
 *
 * readonly = search, read and delete work; uploads (and ingest) wait.
 */

const MODE_CACHE_MS = 30_000;
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
  dbBytes: number;
  totalPages: number;
  reservedPages: number;
  computeHours: number;
  /** Shares of the caps, 0–1+. */
  dbShare: number;
  pagesShare: number;
  computeShare: number;
  /** Mode the automatic guards alone imply. */
  mode: FilesMode;
  /** Czech reasons for a non-"on" mode (operator page). */
  reasons: string[];
}

/** Automatic mode from raw figures. Pure — unit-tested. */
export function autoMode(figures: { dbBytes: number; totalPages: number; reservedPages: number; computeHours: number }): GuardMeasurement {
  const dbShare = figures.dbBytes / LIMITS.dbBytesCap;
  const pagesShare = (figures.totalPages + figures.reservedPages) / LIMITS.globalPages;
  const computeShare = figures.computeHours / LIMITS.computeHoursPerMonth;
  let mode: FilesMode = "on";
  const reasons: string[] = [];
  if (dbShare >= LIMITS.readonlyAt) {
    mode = "readonly";
    reasons.push(`databáze má ${Math.round(dbShare * 100)} % limitu`);
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
  return { ...figures, dbShare, pagesShare, computeShare, mode, reasons };
}

/** First instant of the current UTC month. */
export function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Measure the guards inside an existing (system-scope) transaction. */
export async function measureGuards(db: Queryable, now = new Date()): Promise<GuardMeasurement> {
  const usage = await globalUsage(db);
  const computeHours = await computeHoursEstimate(db, monthStartUtc(now));
  return autoMode({ dbBytes: usage.dbBytes, totalPages: usage.totalPages, reservedPages: usage.reservedPages, computeHours });
}

let modeCache: { at: number; mode: FilesMode } | null = null;

/** Tests: forget the cached mode. */
export function __resetGuardsForTests(): void {
  modeCache = null;
  buckets.clear();
}

/**
 * The mode to act on. Env "off"/"unconfigured" answers without I/O; else one
 * system-scope transaction (override + measurements), cached 30 s. When the
 * measurement itself fails the env mode is returned uncached — the caller's
 * own DB call will then fail with a proper "unavailable".
 */
export async function effectiveMode(): Promise<FilesMode> {
  const env = envOnlyMode();
  if (env === "off" || env === "unconfigured") return env;
  if (modeCache && Date.now() - modeCache.at < MODE_CACHE_MS) return stricter(env, modeCache.mode);
  let measured: FilesMode;
  try {
    measured = await withScope([], async (db) => {
      const override = parseOverride(await getSystemState<unknown>(db, MODE_OVERRIDE_KEY));
      const auto = await measureGuards(db);
      return override ? stricter(override, auto.mode) : auto.mode;
    });
  } catch {
    return env;
  }
  modeCache = { at: Date.now(), mode: measured };
  return stricter(env, measured);
}

// ---------------------------------------------------------------------------
// Per-user rate limit of files_* tool calls

const buckets = new Map<string, { tokens: number; at: number }>();
const MAX_BUCKETS = 5_000;
const HOUR_MS = 3_600_000;

/**
 * Token bucket per user: LIMITS.toolCallsPerHour tokens, refilled
 * continuously over an hour. Returns false (and consumes nothing) when
 * empty. In memory per instance — a soft limit against runaway agents, the
 * DB counters are the hard ones.
 */
export function allowToolCall(userId: string, now = Date.now()): boolean {
  const capacity = LIMITS.toolCallsPerHour;
  let bucket = buckets.get(userId);
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
    buckets.delete(userId); // re-insert: Map order doubles as LRU order
  }
  buckets.set(userId, bucket);
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
