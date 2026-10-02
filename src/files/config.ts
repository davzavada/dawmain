/**
 * Configuration of "Vlastní zdroje" — env reading and the constants the
 * free-tier guards are built from. Pure except for reading process.env;
 * nothing here touches the network or the database, so every layer
 * (including tool registration, which must stay I/O-free) may import it.
 */

/** Bump when the stemmer, tokenizer, chunker, identifier keys or tsvector
 * layout changes: stored indexes carry the version they were built with and
 * get re-derived. 2: chunks carry the EU acts they cite (eu:<CELEX> keys). */
export const ANALYZER_VERSION = 2;

/** Version of the Vlastní zdroje content rules a user accepts before uploading. */
export const TERMS_VERSION = "2026-10";

/** Characters per billed ("normovaná") page — one formula for every format,
 * because the file kind and the page markers are client-asserted. */
export const PAGE_CHARS = 3_600;

export type FilesMode = "on" | "readonly" | "off" | "unconfigured";

/**
 * Mode from the environment alone — checked before anything touches the DB.
 * `FILES_MODE` defaults to off; without `FILES_DATABASE_URL` (the app role,
 * never the owner) the feature is unconfigured. There is deliberately NO
 * fallback to DATABASE_URL: that is the owner role, which bypasses RLS.
 */
export function envMode(): FilesMode {
  if (!process.env.FILES_DATABASE_URL?.trim()) return "unconfigured";
  const raw = process.env.FILES_MODE?.trim().toLowerCase();
  if (raw === "on" || raw === "readonly") return raw;
  return "off";
}

export function databaseUrl(): string | undefined {
  return process.env.FILES_DATABASE_URL?.trim() || undefined;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Quotas and guard thresholds (see the plan's free-tier table). */
export const LIMITS = {
  get personalPages() {
    return intEnv("FILES_PERSONAL_PAGES", 3_000);
  },
  get globalPages() {
    return intEnv("FILES_GLOBAL_MAX_PAGES", 30_000);
  },
  /** Neon Free is 0.5 GB; writes fail beyond it. Read-only well before. */
  dbBytesCap: 400 * 1024 * 1024,
  /** Share of any guard at which the feature turns read-only. */
  readonlyAt: 0.8,
  /** Upload request body (gzip text + JSON) — Vercel functions accept ≤ 4.5 MB. */
  maxUploadBytes: 4_400_000,
  /** Decompressed text cap and max decompression ratio (zip-bomb guard). */
  maxTextBytes: 16_000_000,
  maxGzipRatio: 20,
  uploadsPerLibraryPerDay: 60,
  aiProposalsPerLibraryPerDay: 50,
  /** files_* MCP calls per user per hour. */
  toolCallsPerHour: 60,
  /** files_get_document windows per document per user per day (anti-exfiltration). */
  readsPerDocPerDay: 40,
  /** Estimated Neon compute hours per month (Free: 100 CU-h at 0.25 CU). */
  computeHoursPerMonth: 100,
  computeUnits: 0.25,
  /**
   * Global daily volume of uploads and the CPU allowance uploads, ingests
   * and re-derivations share (usage_daily.cpu_ms; see UPLOAD_GUARDS in
   * upload.ts): 200 uploads a day, 10 min of CPU a day and 60 min per
   * 30 days (a quarter of Hobby's 4 h of Active CPU, plan §8). Tunable
   * after comparing cpu_ms with the Vercel usage page.
   */
  get globalUploadsPerDay() {
    return intEnv("FILES_GLOBAL_UPLOADS_PER_DAY", 200);
  },
  get globalCpuMsPerDay() {
    return intEnv("FILES_CPU_MS_DAY", 10 * 60_000);
  },
  get globalCpuMs30Days() {
    return intEnv("FILES_CPU_MS_30D", 60 * 60_000);
  },
  /** Rolling AI budget in USD per 30 days (Gateway free credit is $5). */
  get aiBudgetUsd() {
    return intEnv("FILES_AI_BUDGET_USD", 4);
  },
} as const;

/** Model id for the metadata proposal, through Vercel AI Gateway. Keep it in
 * config: the free-tier model list changes (Gemini 2.5 retires Oct 2026). */
export function metaModel(): string {
  return process.env.FILES_META_MODEL?.trim() || "google/gemini-2.5-flash-lite";
}

/** Clerk user ids allowed on the operator page. Empty entries dropped. */
export function operatorIds(): string[] {
  return (process.env.FILES_OPERATOR_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^user_[A-Za-z0-9]+$/.test(s));
}

export function cronSecret(): string | undefined {
  return process.env.CRON_SECRET?.trim() || undefined;
}

/**
 * Library ids are Clerk ids: `user_…`. `org_…` (a team library from before
 * teams were removed) is still a valid id, so the cron can purge one.
 */
export const LIBRARY_ID_RE = /^(user|org)_[A-Za-z0-9]+$/;
export const USER_ID_RE = /^user_[A-Za-z0-9]+$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
