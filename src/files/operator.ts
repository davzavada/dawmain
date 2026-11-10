import "server-only";
import { ANALYZER_VERSION, envMode, LIMITS, operatorIds, USER_ID_RE, UUID_RE, type FilesMode } from "./config";
import { withScope } from "./db/client";
import { deleteDocument } from "./db/documents";
import { reindexBacklog, stuckDocuments, type StuckDocument } from "./db/documents-web";
import { forgetPages, listAllLibraries, releasePages, type LibraryRow } from "./db/libraries";
import { audit, blockContent, documentHash, documentsByHash, getSystemState, setSystemState, tableUsage, usageSum, type TableUsage } from "./db/usage";
import { effectiveMode, GUARDS_STATE_KEY, measureGuards, monthStartUtc, MODE_OVERRIDE_KEY, parseOverride, type GuardMeasurement } from "./guards";

/**
 * The operator page (app/vlastni-zdroje/provoz) — who may see it, what it
 * shows, and its three writes (mode override, re-derivation batch,
 * notice-and-takedown). Operators are the Clerk user ids in
 * FILES_OPERATOR_IDS; everyone else gets a 404 from the page and a refusal
 * from every action (checked again inside each action, not only when the
 * page renders).
 *
 * The page shows counters, ids and statuses only — no titles, file names
 * or text of anyone's documents.
 */

/** system_state key of the last "Přeindexovat dávku" result (shown on the page). */
export const REINDEX_STATE_KEY = "reindex_last";
/** system_state key of the last takedown (shown on the page). */
export const TAKEDOWN_STATE_KEY = "takedown_last";

export function isOperator(userId: string | null | undefined): userId is string {
  return typeof userId === "string" && USER_ID_RE.test(userId) && operatorIds().includes(userId);
}

export interface OperatorSnapshot {
  env: FilesMode;
  mode: FilesMode;
  override: FilesMode | null;
  guards: GuardMeasurement;
  /** Per table: physical and estimated live bytes (the VACUUM FULL plan). */
  tables: TableUsage[];
  /** Rolling 30-day AI spend in USD, and the budget. */
  aiSpentUsd: number;
  aiBudgetUsd: number;
  /** CPU booked by uploads, ingests and re-derivations (usage_daily.cpu_ms): today and over 30 days (UPLOAD_GUARDS caps). */
  cpuMsToday: number;
  cpuMs30Days: number;
  uploadsThisMonth: number;
  pagesThisMonth: number;
  /** The daily cron's last snapshot (its `at`), or null when it never ran. */
  cronAt: string | null;
  libraries: Array<LibraryRow & { created_at: string }>;
  stuck: StuckDocument[];
  reindexBacklog: number;
  analyzerVersion: number;
  lastReindex: { at: string; done: number; failed: number; skipped: number; remaining: number; limited?: string } | null;
  lastTakedown: TakedownReport | null;
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
      tables: await tableUsage(db),
      aiMicro: await usageSum(db, "global", "ai_microusd", 30),
      cpuToday: await usageSum(db, "global", "cpu_ms", 1),
      cpu30: await usageSum(db, "global", "cpu_ms", 30),
      uploads: await usageSum(db, "global", "uploads", days),
      pages: await usageSum(db, "global", "pages", days),
      cron: await getSystemState<{ at?: unknown }>(db, GUARDS_STATE_KEY),
      lastReindex: await getSystemState<OperatorSnapshot["lastReindex"]>(db, REINDEX_STATE_KEY),
      lastTakedown: await getSystemState<TakedownReport>(db, TAKEDOWN_STATE_KEY),
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
    tables: system.tables,
    aiSpentUsd: system.aiMicro / 1_000_000,
    aiBudgetUsd: LIMITS.aiBudgetUsd,
    cpuMsToday: system.cpuToday,
    cpuMs30Days: system.cpu30,
    uploadsThisMonth: system.uploads,
    pagesThisMonth: system.pages,
    cronAt: typeof system.cron?.at === "string" ? system.cron.at : null,
    libraries: system.libraries,
    stuck: content.stuck,
    reindexBacklog: content.backlog,
    analyzerVersion: ANALYZER_VERSION,
    lastReindex: system.lastReindex,
    lastTakedown: system.lastTakedown,
  };
}

/** A table worth a VACUUM FULL: this much free space inside its files. */
export const VACUUM_TABLE_MIN_BYTES = 8 * 1024 * 1024;
/** Room a rewrite needs, as a multiple of the table's live size (new heap, TOAST and indexes, plus slack). */
export const VACUUM_NEED_FACTOR = 1.25;

export interface VacuumStep {
  table: string;
  /** What the rewrite gives back. */
  reclaimBytes: number;
  /** Free room it needs while it runs: the old files stay until it commits. */
  needBytes: number;
}

/**
 * The order in which VACUUM FULL can shrink the files without hitting
 * `limitBytes` (Neon Free's 0.5 GB): the rewrite of a table writes a new
 * copy of its live rows and indexes before dropping the old files, so each
 * step needs about its live size free. Greedy — of the tables that fit the
 * current room, the one freeing most first; its space then counts as room
 * for the next. `blocked`: tables that never fit (delete documents from
 * them first). Pure.
 */
export function vacuumPlan(
  tables: ReadonlyArray<TableUsage>,
  dbBytes: number,
  limitBytes: number,
): { steps: VacuumStep[]; blocked: VacuumStep[] } {
  let pending = tables
    .map((t) => ({
      table: t.table,
      reclaimBytes: Math.max(0, t.totalBytes - t.liveBytes),
      needBytes: Math.ceil(t.liveBytes * VACUUM_NEED_FACTOR),
    }))
    .filter((t) => t.reclaimBytes >= VACUUM_TABLE_MIN_BYTES);
  let room = limitBytes - dbBytes;
  const steps: VacuumStep[] = [];
  for (;;) {
    const fits = pending.filter((t) => t.needBytes <= room).sort((a, b) => b.reclaimBytes - a.reclaimBytes);
    if (fits.length === 0) break;
    const next = fits[0];
    steps.push(next);
    room += next.reclaimBytes;
    pending = pending.filter((t) => t !== next);
  }
  return { steps, blocked: pending };
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
export async function recordReindex(
  actor: string,
  report: { done: number; failed: number; skipped: number; remaining: number; limited?: string },
): Promise<void> {
  await withScope([], async (db) => {
    await setSystemState(db, REINDEX_STATE_KEY, { at: new Date().toISOString(), ...report });
    await audit(db, { libraryId: "system", actor, action: "reindex.batch", detail: report });
  });
}

export interface TakedownReport {
  at: string;
  /** The blocked content hash. */
  sha256: string;
  /** Copies deleted, and the libraries they were in. */
  documents: number;
  libraries: number;
}

/**
 * Notice-and-takedown (DSA čl. 16/17; plan §9 "blokace podle
 * content_sha256"): block the hash — `target` is the hash itself or the id
 * of the reported document — and delete every copy of it in every library,
 * each with its page counters given back (as a user's delete) and an audit
 * row in its library. The block matches the exact converted text only: a
 * different conversion of the same work is a new hash (runbook). Deleting
 * again is harmless, so a retry after a partial failure finishes the job.
 */
export async function takedownContent(actor: string, target: string, reason: string): Promise<TakedownReport> {
  const input = target.trim().toLowerCase();
  const note = reason.trim();
  if (!note) throw new Error("takedown reason required");
  const copies = await withScope([], async (db) => {
    const sha = UUID_RE.test(input) ? await documentHash(db, input) : /^[0-9a-f]{64}$/.test(input) ? input : null;
    if (!sha) throw new Error("takedown target not found");
    await blockContent(db, sha, note);
    const found = await documentsByHash(db, sha);
    await audit(db, { libraryId: "system", actor, action: "content.takedown", detail: { sha256: sha, copies: found.length } });
    return { sha, found };
  });
  const byLibrary = new Map<string, string[]>();
  for (const c of copies.found) byLibrary.set(c.libraryId, [...(byLibrary.get(c.libraryId) ?? []), c.id]);
  let documents = 0;
  for (const [libraryId, ids] of byLibrary) {
    documents += await withScope([libraryId], async (db) => {
      let n = 0;
      for (const id of ids) {
        const gone = await deleteDocument(db, id, libraryId);
        if (!gone) continue;
        if (gone.status === "review" || gone.status === "ready") await forgetPages(db, libraryId, gone.billablePages);
        else if (gone.status === "queued" || gone.status === "processing") await releasePages(db, libraryId, gone.billablePages);
        await audit(db, { libraryId, actor, action: "document.takedown", docId: id, detail: { pages: gone.billablePages, status: gone.status } });
        n += 1;
      }
      return n;
    });
  }
  const report: TakedownReport = { at: new Date().toISOString(), sha256: copies.sha, documents, libraries: byLibrary.size };
  await withScope([], (db) => setSystemState(db, TAKEDOWN_STATE_KEY, report));
  return report;
}
