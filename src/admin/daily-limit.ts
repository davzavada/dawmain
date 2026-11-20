import "server-only";
import { withScope } from "@/src/files/db/client";
import { getSystemState, setSystemState } from "@/src/files/db/usage";
import { envOnlyMode } from "@/src/files/guards";
import { DAILY_CALL_LIMIT_KEY, DEFAULT_DAILY_CALL_LIMIT, noteDailyLimit, parseDailyLimit, validDailyLimit } from "@/src/mcp/daily-limit";

/**
 * The admin's side of the daily call limit (src/mcp/daily-limit.ts): what
 * Správa → Systém shows and saves. One whole number under system_state
 * 'mcp_daily_call_limit' in the files database; JSON null (or no row) means
 * the default. Where that database is off or unconfigured the default
 * applies and nothing can be saved — the MCP path does not read it there.
 */

export interface LoadedDailyLimit {
  /** The admin's own limit, or null while the default applies. */
  own: number | null;
  /** false: the database is off, unconfigured or did not answer — the default applies and nothing can be saved. */
  available: boolean;
}

function databaseOn(): boolean {
  const mode = envOnlyMode();
  return mode === "on" || mode === "readonly";
}

/** For the Systém page. Never throws. */
export async function loadDailyLimit(): Promise<LoadedDailyLimit> {
  if (!databaseOn()) return { own: null, available: false };
  try {
    const stored = await withScope([], (db) => getSystemState<unknown>(db, DAILY_CALL_LIMIT_KEY), { statementTimeoutMs: 5_000 });
    return { own: parseDailyLimit(stored), available: true };
  } catch (error) {
    console.warn("daily limit: read failed —", error instanceof Error ? error.message : String(error));
    return { own: null, available: false };
  }
}

export type SaveDailyLimitResult = { ok: true; own: number | null } | { ok: false; error: string };

/**
 * Store the limit (`value` null = back to the default; the default typed in
 * is stored as "the default" too). Applies in this process at once.
 */
export async function saveDailyLimit(value: number | null): Promise<SaveDailyLimitResult> {
  if (value !== null && !validDailyLimit(value)) return { ok: false, error: "Neplatná hodnota." };
  if (!databaseOn()) return { ok: false, error: "Databáze není nastavená nebo je vypnutá, limit tady změnit nejde." };
  const own = value === DEFAULT_DAILY_CALL_LIMIT ? null : value;
  try {
    await withScope([], (db) => setSystemState(db, DAILY_CALL_LIMIT_KEY, own));
  } catch (error) {
    console.warn("daily limit: save failed —", error instanceof Error ? error.message : String(error));
    return { ok: false, error: "Uložení se nepovedlo, databáze neodpověděla. Zkus to za chvíli." };
  }
  noteDailyLimit(own);
  return { ok: true, own };
}
