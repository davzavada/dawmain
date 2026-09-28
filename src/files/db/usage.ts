import "server-only";
import { LIBRARY_ID_RE, LIMITS, USER_ID_RE } from "../config";
import type { Queryable } from "./client";
import { capString, jsonParam, num } from "./codec";
import { isUuid } from "./documents";

/**
 * Counters and small system tables behind the free-tier guards: daily usage
 * per scope, the compute-hours estimate from db_activity, system_state
 * (mode override, cached measurements), terms acceptance and the audit log.
 * None of these tables holds document content; they are not library-scoped
 * (no RLS), and `scope` strings are chosen by the server ('global', a
 * library id, 'user:<id>').
 */

export type UsageField = "uploads" | "pages" | "ai_calls" | "ai_microusd" | "tool_calls" | "reads" | "cpu_ms" | "reindexes";

/** Whitelist — the only strings ever interpolated as column names. */
export const USAGE_FIELDS: readonly UsageField[] = ["uploads", "pages", "ai_calls", "ai_microusd", "tool_calls", "reads", "cpu_ms", "reindexes"];
const FIELD_SET = new Set<string>(USAGE_FIELDS);

/** Neon suspends an idle compute after 5 minutes: each active minute costs at least that tail. */
const ACTIVITY_TAIL = "5 minutes";

/** Today's UTC date as Postgres sees it. */
const TODAY_UTC = "(now() AT TIME ZONE 'UTC')::date";

/**
 * Add to today's (UTC) counters of `scope`, creating the row on first use.
 * Unknown fields, non-finite and non-positive amounts are ignored; amounts
 * are rounded to integers (ai_microusd is already micro-dollars).
 */
export async function bumpUsage(db: Queryable, scope: string, fields: Partial<Record<UsageField, number>>): Promise<void> {
  const cols: string[] = [];
  const values: number[] = [];
  for (const [field, amount] of Object.entries(fields)) {
    if (!FIELD_SET.has(field) || typeof amount !== "number" || !Number.isFinite(amount)) continue;
    const n = Math.round(amount);
    if (n <= 0) continue;
    cols.push(field);
    values.push(n);
  }
  if (cols.length === 0) return;
  const placeholders = cols.map((_, i) => `$${i + 2}`).join(", ");
  const updates = cols.map((c) => `${c} = usage_daily.${c} + EXCLUDED.${c}`).join(", ");
  await db.query(
    `INSERT INTO usage_daily (day, scope, ${cols.join(", ")}) VALUES (${TODAY_UTC}, $1, ${placeholders})
     ON CONFLICT (day, scope) DO UPDATE SET ${updates}`,
    [scope, ...values],
  );
}

/**
 * Take back part of today's counter of `scope` (never below zero) — an
 * admission that bumped first, to hold the counter row, and was then refused.
 */
export async function refundUsage(db: Queryable, scope: string, field: UsageField, amount: number): Promise<void> {
  if (!FIELD_SET.has(field)) throw new Error(`unknown usage field: ${String(field)}`);
  const n = Math.round(amount);
  if (!Number.isFinite(n) || n <= 0) return;
  await db.query(`UPDATE usage_daily SET ${field} = greatest(0, ${field} - $2) WHERE day = ${TODAY_UTC} AND scope = $1`, [scope, n]);
}

/** Sum of `field` for `scope` over the last `days` UTC days including today (days = 1 → today only). */
export async function usageSum(db: Queryable, scope: string, field: UsageField, days: number): Promise<number> {
  if (!FIELD_SET.has(field)) throw new Error(`unknown usage field: ${String(field)}`);
  const span = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 1;
  const { rows } = await db.query(
    `SELECT coalesce(sum(${field}), 0) AS n FROM usage_daily
      WHERE scope = $1 AND day > ${TODAY_UTC} - $2::int`,
    [scope, span],
  );
  return num(rows[0]?.n);
}

/**
 * Estimated compute-unit hours used since `monthStart`: every minute that
 * saw DB activity (db_activity, written by withScope at most once a minute
 * per instance) keeps the compute awake for [minute, minute + 5 min]; the
 * union of those intervals, in hours, × LIMITS.computeUnits (0.25 CU).
 * Compare against LIMITS.computeHoursPerMonth.
 */
export async function computeHoursEstimate(db: Queryable, monthStart: Date): Promise<number> {
  const { rows } = await db.query(
    `WITH m AS (
       SELECT minute, CASE WHEN minute - lag(minute) OVER (ORDER BY minute) <= interval '${ACTIVITY_TAIL}' THEN 0 ELSE 1 END AS starts
         FROM db_activity WHERE minute >= $1
     ), islands AS (
       SELECT minute, sum(starts) OVER (ORDER BY minute) AS island FROM m
     )
     SELECT coalesce(sum(extract(epoch FROM (last - first + interval '${ACTIVITY_TAIL}'))), 0) AS seconds
       FROM (SELECT min(minute) AS first, max(minute) AS last FROM islands GROUP BY island) s`,
    [monthStart],
  );
  return (num(rows[0]?.seconds) / 3600) * LIMITS.computeUnits;
}

/**
 * Database size (files_db_usage): the physical size, and an estimate of the
 * live data — what is left once the free space deletes leave behind (which
 * new rows reuse, but the physical size never gives back) is subtracted.
 */
export async function dbUsage(db: Queryable): Promise<{ dbBytes: number; liveBytes: number }> {
  const { rows } = await db.query("SELECT db_bytes, live_bytes FROM files_db_usage()");
  const dbBytes = num(rows[0]?.db_bytes);
  return { dbBytes, liveBytes: Math.min(dbBytes, num(rows[0]?.live_bytes)) };
}

export interface TableUsage {
  table: string;
  /** pg_total_relation_size: heap, indexes and TOAST. */
  totalBytes: number;
  /** Estimated live part of it (files_table_usage, as dbUsage). */
  liveBytes: number;
}

/** Per table of the schema (operator page: what VACUUM FULL would free and need). System scope. */
export async function tableUsage(db: Queryable): Promise<TableUsage[]> {
  const { rows } = await db.query("SELECT table_name, total_bytes, live_bytes FROM files_table_usage()");
  return rows.map((r) => {
    const totalBytes = num(r.total_bytes);
    return { table: String(r.table_name), totalBytes, liveBytes: Math.min(totalBytes, num(r.live_bytes)) };
  });
}

export async function getSystemState<T>(db: Queryable, key: string): Promise<T | null> {
  const { rows } = await db.query<{ value: T }>("SELECT value FROM system_state WHERE key = $1", [key]);
  return rows[0] ? (rows[0].value ?? null) : null;
}

/** Upsert a JSON value (undefined is stored as JSON null). */
export async function setSystemState(db: Queryable, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, jsonParam(value)],
  );
}

export async function hasAcceptedTerms(db: Queryable, userId: string, version: string): Promise<boolean> {
  if (!USER_ID_RE.test(userId)) return false;
  const { rows } = await db.query("SELECT 1 FROM terms_acceptance WHERE user_id = $1 AND version = $2", [userId, version]);
  return rows.length > 0;
}

/** Idempotent: the first acceptance time is kept. */
export async function acceptTerms(db: Queryable, userId: string, version: string): Promise<void> {
  if (!USER_ID_RE.test(userId)) throw new Error("invalid user id");
  await db.query("INSERT INTO terms_acceptance (user_id, version) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, version]);
}

/** A deleted Clerk user: their acceptances go with the account. */
export async function forgetTermsAcceptance(db: Queryable, userId: string): Promise<void> {
  if (!USER_ID_RE.test(userId)) return;
  await db.query("DELETE FROM terms_acceptance WHERE user_id = $1", [userId]);
}

/**
 * Append to the audit log (who did what in which library). `detail` is
 * stored as JSON — callers put ids and counts there, never document text.
 * A malformed docId is stored as null rather than failing the action.
 */
export async function audit(
  db: Queryable,
  entry: { libraryId: string; actor: string; action: string; docId?: string | null; detail?: unknown },
): Promise<void> {
  await db.query(
    "INSERT INTO audit_log (library_id, actor, action, doc_id, detail) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [
      capString(entry.libraryId, 100),
      capString(entry.actor, 100),
      capString(entry.action, 100),
      isUuid(entry.docId) ? entry.docId : null,
      entry.detail === undefined ? null : jsonParam(entry.detail),
    ],
  );
}

// ---------------------------------------------------------------------------
// Retention (/soukromi, bod 5)

/** Usage data: "nejdéle 12 měsíců". */
export const USAGE_KEEP_DAYS = 365;
/**
 * Per-user read / export counters: only today's row is ever consulted (the daily caps), so the
 * daily cron keeps today's and yesterday's rows and drops older ones — /soukromi says "2 dny".
 */
export const READ_COUNTER_KEEP_DAYS = 1;
/** db_activity feeds the estimate of the current month; the previous one is kept for comparison. */
export const ACTIVITY_KEEP_DAYS = 62;

/** Drop counters and activity minutes past their retention. Returns rows deleted per table. */
export async function pruneUsage(db: Queryable): Promise<{ usage: number; activity: number }> {
  const usage = await db.query(
    `DELETE FROM usage_daily
      WHERE day < ${TODAY_UTC} - $1::int
         OR (starts_with(scope, 'read:') AND day < ${TODAY_UTC} - $2::int)
      RETURNING 1`,
    [USAGE_KEEP_DAYS, READ_COUNTER_KEEP_DAYS],
  );
  const activity = await db.query("DELETE FROM db_activity WHERE minute < now() - make_interval(days => $1) RETURNING 1", [
    ACTIVITY_KEEP_DAYS,
  ]);
  return { usage: usage.rows.length, activity: activity.rows.length };
}

/** A deleted Clerk user: their per-document read counters go with the account. */
export async function forgetUserUsage(db: Queryable, userId: string): Promise<void> {
  if (!USER_ID_RE.test(userId)) return;
  await db.query("DELETE FROM usage_daily WHERE starts_with(scope, $1)", [`read:${userId}:`]);
}

/** A purged library: its own counters go with it (the 'global' totals stay). */
export async function forgetLibraryUsage(db: Queryable, libraryId: string): Promise<void> {
  if (!LIBRARY_ID_RE.test(libraryId)) return;
  await db.query("DELETE FROM usage_daily WHERE scope = $1", [libraryId]);
}

/**
 * The audit rows of purged libraries ("dokud knihovna trvá"), except the
 * purge record itself — files_forget_purged_audit, as the app role cannot
 * delete from the log. Returns how many.
 */
export async function forgetPurgedAudit(db: Queryable): Promise<number> {
  const { rows } = await db.query("SELECT files_forget_purged_audit() AS n");
  return num(rows[0]?.n);
}

// ---------------------------------------------------------------------------
// Re-derivation requests (documents.reindex_requested_at) — the budget of
// src/files/reindex.ts. Library-scoped: run inside withScope([libraryId]).

/** A request older than this no longer counts as pending (its run died): the next one takes over, the cron picks it up. */
export const REINDEX_REQUEST_STALE_MINUTES = 10;

/**
 * Mark a reviewable or confirmed document for re-derivation. False when it
 * is gone, in another state, or already has a fresh pending request — the
 * pending run reads the metadata when it starts, so this save coalesces
 * into it. A run in progress holds the row lock and clears the mark as it
 * commits; a save it did not see marks the document again after that.
 */
export async function requestReindex(db: Queryable, id: string, libraryId: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rows } = await db.query(
    `UPDATE documents SET reindex_requested_at = now()
      WHERE id = $1 AND library_id = $2 AND status IN ('review', 'ready')
        AND (reindex_requested_at IS NULL OR reindex_requested_at < now() - make_interval(mins => $3))
      RETURNING id`,
    [id, libraryId, REINDEX_REQUEST_STALE_MINUTES],
  );
  return rows.length > 0;
}

/** The run took the request (or the cron gave up on it). */
export async function clearReindexRequest(db: Queryable, id: string, libraryId: string): Promise<void> {
  if (!isUuid(id)) return;
  await db.query("UPDATE documents SET reindex_requested_at = NULL WHERE id = $1 AND library_id = $2 AND reindex_requested_at IS NOT NULL", [
    id,
    libraryId,
  ]);
}

/** Requests left over (deferred by the budget, or their run died), oldest first, across libraries — ids only. System scope. */
export async function pendingReindexRequests(db: Queryable, limit: number): Promise<Array<{ id: string; libraryId: string }>> {
  const { rows } = await db.query("SELECT id, library_id FROM files_reindex_requests(make_interval(mins => $1), $2)", [
    REINDEX_REQUEST_STALE_MINUTES,
    Math.max(1, Math.floor(limit)),
  ]);
  return rows.map((r) => ({ id: String(r.id), libraryId: String(r.library_id) }));
}

// ---------------------------------------------------------------------------
// Counters and takedown across libraries (system scope, SECURITY DEFINER)

/** Recompute page_count, doc_count and pages_reserved of every live library from its documents. Returns how many had drifted. */
export async function recountLibraries(db: Queryable): Promise<number> {
  const { rows } = await db.query("SELECT files_recount_libraries() AS n");
  return num(rows[0]?.n);
}

/** Every copy of a content hash, in any library (ids only). */
export async function documentsByHash(db: Queryable, contentSha256: string): Promise<Array<{ id: string; libraryId: string }>> {
  const sha = contentSha256.toLowerCase();
  if (!SHA256_HEX_RE.test(sha)) return [];
  const { rows } = await db.query("SELECT id, library_id FROM files_documents_by_hash($1)", [sha]);
  return rows.map((r) => ({ id: String(r.id), libraryId: String(r.library_id) }));
}

/** The content hash of a document in any library, or null. */
export async function documentHash(db: Queryable, id: string): Promise<string | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query("SELECT files_document_hash($1) AS sha", [id]);
  return typeof rows[0]?.sha === "string" ? rows[0].sha : null;
}

/** Block a content hash from being uploaded again (idempotent; the first reason is kept). */
export async function blockContent(db: Queryable, contentSha256: string, reason: string): Promise<void> {
  const sha = contentSha256.toLowerCase();
  if (!SHA256_HEX_RE.test(sha)) throw new Error("invalid content hash");
  await db.query("INSERT INTO blocked_content (content_sha256, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    sha,
    capString(reason, 500) || "takedown",
  ]);
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
