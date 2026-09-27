import "server-only";
import { ANALYZER_VERSION, LIBRARY_ID_RE, UUID_RE } from "./config";
import { withScope } from "./db/client";
import { getDocument, writeDocumentIndex } from "./db/documents";
import { finishReindex, leaseForReindex, reindexBacklog, reindexCandidates } from "./db/documents-web";
import { listAllLibraries } from "./db/libraries";
import { loadText } from "./db/reading";
import { splitStorageBlocks } from "./dmd/blocks";
import { parseDmd } from "./dmd/parse";
import { errorCode } from "./errors";
import { buildMetaTsv, deriveIndex, metaIdentKeys, sectionRangeOf } from "./index/derive";

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
 *     in after().
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
/** Stop starting new documents after this long (the page's function limit is 300 s). */
const BATCH_BUDGET_MS = 240_000;

export type ReindexResult = "done" | "skipped" | "failed";

/** Rebuild one document's index from its stored text. */
export async function reindexDocument(docId: string, libraryId: string): Promise<ReindexResult> {
  if (!UUID_RE.test(docId) || !LIBRARY_ID_RE.test(libraryId)) return "skipped";
  try {
    return await withScope(
      [libraryId],
      async (db) => {
        const lease = await leaseForReindex(db, docId, libraryId);
        if (!lease) return "skipped";
        const row = await getDocument(db, docId, [libraryId]);
        if (!row) return "skipped";
        const src = await loadText(db, docId, libraryId, 0, lease.charCount);
        const text = src.slice(0, lease.charCount);
        if (text.length !== lease.charCount) throw new Error("stored text incomplete");

        const meta = row.meta;
        const parsed = parseDmd(text, { anchorLabel: meta.anchor_label ?? undefined });
        const derived = deriveIndex(parsed, { docType: meta.doc_type, commentedAct: meta.commented_act ?? null });
        const wrote = await writeDocumentIndex(db, {
          id: docId,
          libraryId,
          runToken: lease.runToken,
          text,
          blocks: splitStorageBlocks(text),
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
          metaTsv: buildMetaTsv(meta, parsed.sections),
          identKeys: [...metaIdentKeys(meta), ...derived.docIdentKeys],
          sectionRange: meta.doc_type === "komentar" ? sectionRangeOf(parsed.sections) : null,
        });
        if (!finished) throw new Error("reindex lease lost");
        return "done" as const;
      },
      { statementTimeoutMs: REINDEX_STATEMENT_TIMEOUT_MS },
    );
  } catch (error) {
    console.error(`files: reindex failed (${errorCode(error)})`);
    return "failed";
  }
}

export interface ReindexBatchReport {
  done: number;
  skipped: number;
  failed: number;
  /** Candidates left for the next click (0 when the backlog is cleared). */
  remaining: number;
}

/**
 * Re-derive up to `limit` (≤ 200) documents built by an older analyzer,
 * across all libraries, one after another, stopping early when the time
 * budget runs out. For the operator — the caller checks operatorIds().
 */
export async function reindexBatch(limit = REINDEX_BATCH_MAX, now: () => number = Date.now): Promise<ReindexBatchReport> {
  const started = now();
  const max = Math.max(1, Math.min(REINDEX_BATCH_MAX, Math.floor(limit)));
  const libraries = (await withScope([], (db) => listAllLibraries(db))).map((l) => l.id);
  if (libraries.length === 0) return { done: 0, skipped: 0, failed: 0, remaining: 0 };
  const candidates = await withScope(libraries, (db) => reindexCandidates(db, libraries, ANALYZER_VERSION, max));
  const report: ReindexBatchReport = { done: 0, skipped: 0, failed: 0, remaining: 0 };
  for (const c of candidates) {
    if (now() - started > BATCH_BUDGET_MS) break;
    report[await reindexDocument(c.id, c.libraryId)] += 1;
  }
  // Failed and skipped documents stay candidates; count what is really left.
  report.remaining = await withScope(libraries, (db) => reindexBacklog(db, libraries, ANALYZER_VERSION));
  return report;
}
