/**
 * The figures of the daily call limit (src/mcp/daily-limit.ts) and their
 * checks. Pure and free of imports, so the admin's form (a client
 * component) can share them without pulling the database client along.
 */

/** Calls per account and UTC day unless Správa says otherwise. */
export const DEFAULT_DAILY_CALL_LIMIT = 2_000;
export const MIN_DAILY_CALL_LIMIT = 1;
export const MAX_DAILY_CALL_LIMIT = 1_000_000;

/** system_state key of the admin's own limit: a whole number, or JSON null / no row for the default. */
export const DAILY_CALL_LIMIT_KEY = "mcp_daily_call_limit";

/** A limit an admin may set: a whole number from MIN_ to MAX_DAILY_CALL_LIMIT. Pure. */
export function validDailyLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_DAILY_CALL_LIMIT && value <= MAX_DAILY_CALL_LIMIT;
}

/** The stored value as a limit, or null for "the default" (nothing stored, or not what was stored). Pure. */
export function parseDailyLimit(value: unknown): number | null {
  return validDailyLimit(value) ? value : null;
}
