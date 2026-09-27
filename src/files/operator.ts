import "server-only";
import { ANALYZER_VERSION, envMode, LIMITS, operatorIds, USER_ID_RE, type FilesMode } from "./config";
import { withScope } from "./db/client";
import { reindexBacklog, stuckDocuments, type StuckDocument } from "./db/documents-web";
import { listAllLibraries, type LibraryRow } from "./db/libraries";
import { audit, getSystemState, setSystemState, usageSum } from "./db/usage";
import { effectiveMode, GUARDS_STATE_KEY, measureGuards, monthStartUtc, MODE_OVERRIDE_KEY, parseOverride, type GuardMeasurement } from "./guards";

/**
 * The operator page (app/vlastni-zdroje/provoz) — who may see it, what it
 * shows, and its two writes. Operators are the Clerk user ids in
 * FILES_OPERATOR_IDS; everyone else gets a 404 from the page and a refusal
 * from every action (checked again inside each action, not only when the
 * page renders).
 *
 * The page shows counters, ids and statuses only — no titles, file names
 * or text of anyone's documents.
 */

/** system_state key of the last "Přeindexovat dávku" result (shown on the page). */
export const REINDEX_STATE_KEY = "reindex_last";

export function isOperator(userId: string | null | undefined): userId is string {
  return typeof userId === "string" && USER_ID_RE.test(userId) && operatorIds().includes(userId);
}

export interface OperatorSnapshot {
  env: FilesMode;
  mode: FilesMode;
  override: FilesMode | null;
  guards: GuardMeasurement;
  /** Rolling 30-day AI spend in USD, and the budget. */
  aiSpentUsd: number;
  aiBudgetUsd: number;
  uploadsThisMonth: number;
  pagesThisMonth: number;
  /** The daily cron's last snapshot (its `at`), or null when it never ran. */
  cronAt: string | null;
  libraries: Array<LibraryRow & { created_at: string }>;
  stuck: StuckDocument[];
  reindexBacklog: number;
  analyzerVersion: number;
  lastReindex: { at: string; done: number; failed: number; skipped: number; remaining: number } | null;
}

/** Days from the month's start through today (usageSum counts `days` UTC days including today). */
function daysThisMonth(now: Date): number {
  return Math.floor((now.getTime() - monthStartUtc(now).getTime()) / 86_400_000) + 1;
}

/** Everything the page shows — two system-scope transactions and one over all libraries. */
export async function operatorSnapshot(now = new Date()): Promise<OperatorSnapshot> {
  const env = envMode();
  const system = await withScope([], async (db) => {
    const days = daysThisMonth(now);
    return {
      override: parseOverride(await getSystemState<unknown>(db, MODE_OVERRIDE_KEY)),
      guards: await measureGuards(db, now),
      aiMicro: await usageSum(db, "global", "ai_microusd", 30),
      uploads: await usageSum(db, "global", "uploads", days),
      pages: await usageSum(db, "global", "pages", days),
      cron: await getSystemState<{ at?: unknown }>(db, GUARDS_STATE_KEY),
      lastReindex: await getSystemState<OperatorSnapshot["lastReindex"]>(db, REINDEX_STATE_KEY),
      libraries: await listAllLibraries(db),
    };
  });
  const ids = system.libraries.map((l) => l.id);
  const content = ids.length
    ? await withScope(ids, async (db) => ({
        stuck: await stuckDocuments(db, ids),
        backlog: await reindexBacklog(db, ids, ANALYZER_VERSION),
      }))
    : { stuck: [], backlog: 0 };
  return {
    env,
    mode: await effectiveMode(),
    override: system.override,
    guards: system.guards,
    aiSpentUsd: system.aiMicro / 1_000_000,
    aiBudgetUsd: LIMITS.aiBudgetUsd,
    uploadsThisMonth: system.uploads,
    pagesThisMonth: system.pages,
    cronAt: typeof system.cron?.at === "string" ? system.cron.at : null,
    libraries: system.libraries,
    stuck: content.stuck,
    reindexBacklog: content.backlog,
    analyzerVersion: ANALYZER_VERSION,
    lastReindex: system.lastReindex,
  };
}

/**
 * Set (or with "auto", clear) the operator's mode override. It can only
 * restrict: effectiveMode takes the stricter of the override, the env and
 * the automatic guards. Takes effect within 30 s on every instance.
 */
export async function writeModeOverride(actor: string, value: string): Promise<FilesMode | null> {
  const mode = value === "auto" ? null : parseOverride(value);
  if (value !== "auto" && mode === null) throw new Error("invalid mode override");
  await withScope([], async (db) => {
    await setSystemState(db, MODE_OVERRIDE_KEY, mode === null ? null : { mode });
    await audit(db, { libraryId: "system", actor, action: "mode.override", detail: { mode: mode ?? "auto" } });
  });
  return mode;
}

/** Remember the last batch result for the page. */
export async function recordReindex(actor: string, report: { done: number; failed: number; skipped: number; remaining: number }): Promise<void> {
  await withScope([], async (db) => {
    await setSystemState(db, REINDEX_STATE_KEY, { at: new Date().toISOString(), ...report });
    await audit(db, { libraryId: "system", actor, action: "reindex.batch", detail: report });
  });
}
