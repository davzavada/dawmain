import "server-only";
import { ANALYZER_VERSION, LIBRARY_ID_RE, LIMITS, UUID_RE, type FilesMode } from "./config";
import { withScope, type Queryable } from "./db/client";
import { getDocument, writeDocumentIndex } from "./db/documents";
import { finishReindex, leaseForReindex, reindexBacklog, reindexCandidates } from "./db/documents-web";
import { listAllLibraries } from "./db/libraries";
import { loadText } from "./db/reading";
import { bumpUsage, clearReindexRequest, refundUsage, requestReindex, usageSum } from "./db/usage";
import { splitStorageBlocks } from "./dmd/blocks";
import { parseDmd } from "./dmd/parse";
import { errorCode } from "./errors";
import { effectiveMode, measureGuards } from "./guards";
import { buildMetaTsv, deriveIndex, metaIdentKeys, sectionRangeOf } from "./index/derive";
import { CpuMeter } from "./ingest";
import { UPLOAD_GUARDS } from "./upload";

/**
 * Re-derivation of stored documents from their stored text — no upload, no
 * AI. The index (chunks, tsvectors, keys, pages, sections, footnotes) is a
 * pure function of the DMD text plus the document type and commented act,
 * so it can be rebuilt whenever one of those inputs changes:
 *
 *   - the analyzer changed (ANALYZER_VERSION bumped: stemmer, chunker,
 *     tsvector layout) — the operator page runs `reindexBatch`, ≤ 200
 *     documents per click, oldest first;
 *   - the user confirmed a different document type or commented act (a
 *     commentary indexes its statute quotes at weight D and turns bare
 *     "§ 2913" into parz: keys) — the detail route runs `reindexDocument`
 *     in after(). A whole-document rewrite costs seconds of CPU on a big
 *     book and churns the largest tables, so these are budgeted: a save
 *     while a re-derivation is pending coalesces into it, a library starts
 *     at most REINDEXES_PER_LIBRARY_DAY a day, nothing starts while the
 *     shared CPU allowance of uploads and ingests (UPLOAD_GUARDS) is spent,
 *     and the rest stay marked (documents.reindex_requested_at) for the
 *     daily cron, which re-derives them with `reindexRequested` under the
 *     same CPU allowance — deferred, never dropped, so the index catches up
 *     with the saved type and act.
 *
 * CPU time of every run is booked into usage_daily.cpu_ms, as ingest does.
 *
 * One document = one transaction: lease (the row is 'processing' only
 * inside it), load and parse the text, derive, writeDocumentIndex,
 * restore the status with the rebuilt meta_tsv and ident keys. A failure
 * rolls everything back and the document keeps its old, working index.
 * Never throws.
 */

/** Whole-document writes: statements up to 60 s (default 10 s), as in ingest. */
const REINDEX_STATEMENT_TIMEOUT_MS = 60_000;
/** Documents one operator click may re-derive. */
export const REINDEX_BATCH_MAX = 200;
/** …and above DB_TIGHT_SHARE of the DB cap (plan §3: one at a time, never the whole corpus above 60 %). */
export const REINDEX_BATCH_TIGHT = 10;
const DB_TIGHT_SHARE = 0.6;
/**
 * Re-derivations a library's metadata saves may start per UTC day: a third
 * of what it may upload (about a minute of CPU on big books); the shared
 * CPU allowance caps all libraries together.
 */
export const REINDEXES_PER_LIBRARY_DAY = Math.floor(LIMITS.uploadsPerLibraryPerDay / 3);
/** Stop starting new documents after this long (the page's function limit is 300 s). */
const BATCH_BUDGET_MS = 240_000;

/**
 * Whether the CPU allowance uploads and ingests share (UPLOAD_GUARDS: the
 * feature's quarter of the Hobby Active CPU) has room today and over 30
 * days. A re-derivation books its CPU there too; when it is spent, saves
 * are deferred and the cron waits, as uploads are refused.
 */
export async function cpuAllowanceLeft(db: Queryable): Promise<boolean> {
  if ((await usageSum(db, "global", "cpu_ms", 1)) >= UPLOAD_GUARDS.globalCpuMsPerDay) return false;
  return (await usageSum(db, "global", "cpu_ms", 30)) < UPLOAD_GUARDS.globalCpuMs30Days;
}

export type ReindexResult = "done" | "skipped" | "failed" | "deferred";

/**
 * Who asks: "user" (a metadata save — budgeted and coalesced, the default
 * of the detail route's call), "operator" (the analyzer batch) or "cron"
 * (deferred requests) — those two are budgeted by their callers.
 */
export type ReindexSource = "user" | "operator" | "cron";

/**
 * Rebuild one document's index from its stored text. From a metadata save:
 * "skipped" also when a pending re-derivation will pick the save up, and
 * "deferred" when the library's daily budget or the shared CPU allowance
 * is spent (the cron runs it later).
 */
export async function reindexDocument(docId: string, libraryId: string, source: ReindexSource = "user"): Promise<ReindexResult> {
  if (!UUID_RE.test(docId) || !LIBRARY_ID_RE.test(libraryId)) return "skipped";
  if (source === "user") {
    let admitted: "run" | "pending" | "deferred";
    try {
      admitted = await withScope([libraryId], async (db) => {
        if (!(await requestReindex(db, docId, libraryId))) return "pending";
        if (!(await cpuAllowanceLeft(db))) return "deferred";
        // Bump, then read (as upload.ts): the upsert holds the counter row
        // until commit, so a concurrent save waits here and then sees this one.
        await bumpUsage(db, libraryId, { reindexes: 1 });
        if ((await usageSum(db, libraryId, "reindexes", 1)) > REINDEXES_PER_LIBRARY_DAY) {
          await refundUsage(db, libraryId, "reindexes", 1); // not started; the mark stays for the cron
          return "deferred";
        }
        await bumpUsage(db, "global", { reindexes: 1 });
        return "run";
      });
    } catch (error) {
      console.error(`files: reindex request failed (${errorCode(error)})`);
      return "failed";
    }
    if (admitted === "pending") return "skipped";
    if (admitted === "deferred") return "deferred";
  }
  // Only the synchronous work is measured: CPU used by other requests while
  // this run awaits the database would otherwise be booked here too, and
  // cpu_ms gates uploads (UPLOAD_GUARDS).
  const cpu = new CpuMeter();
  try {
    return await withScope(
      [libraryId],
      async (db) => {
        const lease = await leaseForReindex(db, docId, libraryId);
        if (!lease) return "skipped";
        // Taken: a save from now on waits for this row lock and asks again after the commit.
        await clearReindexRequest(db, docId, libraryId);
        const row = await getDocument(db, docId, [libraryId]);
        if (!row) return "skipped";
        const src = await loadText(db, docId, libraryId, 0, lease.charCount);
        const text = src.slice(0, lease.charCount);
        if (text.length !== lease.charCount) throw new Error("stored text incomplete");

        const meta = row.meta;
        const { parsed, derived, blocks, metaTsv, identKeys, sectionRange } = cpu.run(() => {
          const parsed = parseDmd(text, { anchorLabel: meta.anchor_label ?? undefined });
          const derived = deriveIndex(parsed, { docType: meta.doc_type, commentedAct: meta.commented_act ?? null });
          return {
            parsed,
            derived,
            blocks: splitStorageBlocks(text),
            metaTsv: buildMetaTsv(meta, parsed.sections),
            identKeys: [...metaIdentKeys(meta), ...derived.docIdentKeys],
            sectionRange: meta.doc_type === "komentar" ? sectionRangeOf(parsed.sections) : null,
          };
        });
        const wrote = await writeDocumentIndex(db, {
          id: docId,
          libraryId,
          runToken: lease.runToken,
          text,
          blocks,
          parsed,
          derived,
          analyzerVersion: ANALYZER_VERSION,
        });
        if (!wrote) throw new Error("reindex lease lost");
        const finished = await finishReindex(db, {
          id: docId,
          libraryId,
          runToken: lease.runToken,
          previous: lease.previous,
          metaTsv,
          identKeys,
          sectionRange,
        });
        if (!finished) throw new Error("reindex lease lost");
        return "done" as const;
      },
      { statementTimeoutMs: REINDEX_STATEMENT_TIMEOUT_MS },
    );
  } catch (error) {
    console.error(`files: reindex failed (${errorCode(error)})`);
    return "failed";
  } finally {
    await recordCpu(libraryId, cpu.ms);
  }
}

async function recordCpu(libraryId: string, ms: number): Promise<void> {
  try {
    if (ms <= 0) return;
    await withScope([], async (db) => {
      await bumpUsage(db, libraryId, { cpu_ms: ms });
      await bumpUsage(db, "global", { cpu_ms: ms });
    });
  } catch {
    // Bookkeeping only.
  }
}

export interface ReindexBatchReport {
  done: number;
  skipped: number;
  failed: number;
  /** Candidates left for the next click (0 when the backlog is cleared). */
  remaining: number;
  /** Why the batch was refused or cut short by the guards (Czech, operator page); absent when it ran in full. */
  limited?: string;
}

/**
 * How many documents one batch may re-derive under the current guards.
 * Pure. Not at all unless the feature is "on" (read-only means writes
 * wait); at most REINDEX_BATCH_TIGHT once the DB holds 60 % of its cap.
 */
export function batchAllowance(mode: FilesMode, dbShare: number): { max: number; reason: string | null } {
  if (mode !== "on") return { max: 0, reason: "Vlastní zdroje nejsou zapnuté (režim jen pro čtení nebo vypnuto) — přeindexování počká." };
  if (dbShare >= DB_TIGHT_SHARE) {
    return {
      max: REINDEX_BATCH_TIGHT,
      reason: `Databáze má ${Math.round(dbShare * 100)} % limitu — dávka nejvýš ${REINDEX_BATCH_TIGHT} dokumentů, celý korpus najednou ne.`,
    };
  }
  return { max: REINDEX_BATCH_MAX, reason: null };
}

/**
 * Re-derive up to `limit` (≤ 200, ≤ 10 above 60 % of the DB cap, none
 * unless the mode is "on") documents built by an older analyzer, across all
 * libraries, one after another, stopping early when the time budget or
 * the shared CPU allowance runs out. For the operator — the caller checks
 * operatorIds().
 */
export async function reindexBatch(limit = REINDEX_BATCH_MAX, now: () => number = Date.now): Promise<ReindexBatchReport> {
  const started = now();
  const guards = await withScope([], (db) => measureGuards(db));
  const allowance = batchAllowance(await effectiveMode(), guards.dbShare);
  const max = Math.min(allowance.max, Math.max(1, Math.min(REINDEX_BATCH_MAX, Math.floor(limit))));
  const libraries = (await withScope([], (db) => listAllLibraries(db))).map((l) => l.id);
  const report: ReindexBatchReport = { done: 0, skipped: 0, failed: 0, remaining: 0 };
  if (allowance.reason) report.limited = allowance.reason;
  if (libraries.length === 0) return report;
  const candidates = max > 0 ? await withScope(libraries, (db) => reindexCandidates(db, libraries, ANALYZER_VERSION, max)) : [];
  for (const c of candidates) {
    if (now() - started > BATCH_BUDGET_MS) break;
    // The shared CPU allowance binds the operator too: a corpus-wide batch
    // must not spend what uploads and the Hobby team need.
    if (!(await withScope([], (db) => cpuAllowanceLeft(db)))) {
      report.limited = "Denní nebo 30denní rozpočet CPU pro zpracování je vyčerpaný — zbytek přeindexování počká.";
      break;
    }
    const result = await reindexDocument(c.id, c.libraryId, "operator");
    report[result === "deferred" ? "skipped" : result] += 1;
  }
  // Failed and skipped documents stay candidates; count what is really left.
  report.remaining = await withScope(libraries, (db) => reindexBacklog(db, libraries, ANALYZER_VERSION));
  return report;
}

export interface ReindexRequestsReport {
  done: number;
  skipped: number;
  failed: number;
}

/**
 * The daily cron's catch-up: re-derive documents whose request was
 * deferred by the budget (or whose run died), oldest first, at most `limit`,
 * until `late()`. A document that fails is given up on (its request
 * cleared) — it keeps its previous, working index, and one broken document
 * must not take the cron's whole share every night. Stops, leaving the
 * rest marked, once the shared CPU allowance is spent. The caller checks
 * the mode.
 */
export async function reindexRequested(
  candidates: ReadonlyArray<{ id: string; libraryId: string }>,
  late: () => boolean,
): Promise<ReindexRequestsReport> {
  const report: ReindexRequestsReport = { done: 0, skipped: 0, failed: 0 };
  for (const c of candidates) {
    if (late()) break;
    if (!(await withScope([], (db) => cpuAllowanceLeft(db)))) break;
    const result = await reindexDocument(c.id, c.libraryId, "cron");
    if (result === "failed") {
      await withScope([c.libraryId], (db) => clearReindexRequest(db, c.id, c.libraryId)).catch(() => undefined);
    }
    report[result === "deferred" ? "skipped" : result] += 1;
  }
  return report;
}
