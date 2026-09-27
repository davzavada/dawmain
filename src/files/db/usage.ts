import "server-only";
import { LIMITS, USER_ID_RE } from "../config";
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

export type UsageField = "uploads" | "pages" | "ai_calls" | "ai_microusd" | "tool_calls" | "reads" | "cpu_ms";

/** Whitelist — the only strings ever interpolated as column names. */
export const USAGE_FIELDS: readonly UsageField[] = ["uploads", "pages", "ai_calls", "ai_microusd", "tool_calls", "reads", "cpu_ms"];
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
