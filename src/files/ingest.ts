import "server-only";
import { createHash, createHmac } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { ANALYZER_VERSION, LIBRARY_ID_RE, LIMITS, UUID_RE } from "./config";
import { FilesUnavailableError, withScope, type Queryable } from "./db/client";
import {
  claimForIngest,
  deleteDocument,
  failIngest,
  finishIngest,
  getDocument,
  ingestCandidates,
  MAX_INGEST_ATTEMPTS,
  writeDocumentIndex,
  type DocumentRow,
} from "./db/documents";
import { forgetPages, getLibraries, releasePages, settlePages } from "./db/libraries";
import { audit, bumpUsage, usageSum } from "./db/usage";
import { splitStorageBlocks } from "./dmd/blocks";
import { normalizeDmd } from "./dmd/normalize";
import { parseDmd } from "./dmd/parse";
import { DmdLimitError, type ParsedDoc } from "./dmd/types";
import { errorCode, logFilesError } from "./errors";
import { effectiveMode, envOnlyMode } from "./guards";
import { buildMetaTsv, deriveIndex, metaIdentKeys, sectionRangeOf } from "./index/derive";
import { heuristicMeta } from "./meta/heuristics";
import { buildMetaInput } from "./meta/input";
import { proposeMetadata } from "./meta/propose";
import { mergeProposals, proposalToBibMeta } from "./meta/schema";
import { DOC_TYPES, type BibMeta, type DocType, type ProposedMeta } from "./types";

/**
 * Ingest: turns an uploaded document (documents.pending_gz, status
 * 'queued') into a stored, indexed one ('review', or 'ready'). Runs in
 * after() of the upload route, and is re-kicked by the status poll and the
 * daily cron (kickPendingIngests) — the documents row IS the queue:
 *
 *   claim      compare-and-set lease + run token (claimForIngest); a run
 *              that loses the lease stops writing (every write checks it);
 *   inflate    gunzip pending_gz with a byte cap, strict UTF-8, re-check
 *              the content hash the upload verified;
 *   parse      normalizeDmd → parseDmd (the same pure parser as the browser);
 *   metadata   heuristics + the AI proposal (budgeted), merged — BEFORE the
 *              index is derived, because the document type decides how it
 *              is derived (a commentary's statute quotes are weight D, its
 *              act turns bare "§ 2913" into parz: keys);
 *   derive     storage blocks, chunks with tsvectors, identifier keys;
 *   commit     ONE transaction: writeDocumentIndex, finishIngest, settle the
 *              page reservation, and for a re-upload (`replaces`) delete the
 *              old document — so a lost lease or a crash leaves nothing half
 *              written;
 *   failure    failIngest: retryable failures go back to the queue until
 *              MAX_INGEST_ATTEMPTS, then 'error' and the reservation is
 *              released; a document over its attempts is failed on claim.
 *
 * Status after a successful run: 'ready' — the default, the upload is done
 * and the metadata can be edited later; 'review' (searchable only after the
 * user confirms) only in a library with autoConfirm: false. A document
 * that replaces an already confirmed one (authorized at upload: uploader or
 * admin, same library) starts from the confirmed metadata instead of a new
 * proposal (the same status rule applies). Never throws. Records the run's CPU time in usage_daily
 * (CpuMeter: the synchronous work only).
 */

export type IngestResult = "done" | "lost" | "failed";

/** Ingest writes whole documents: allow statements up to 60 s (default 10 s). */
const INGEST_STATEMENT_TIMEOUT_MS = 60_000;
/** Candidates one kick may run (each runs to completion, one after another). */
const MAX_KICK = 10;

/** An ingest failure with the Czech status_detail the user sees. */
export class IngestFailure extends Error {
  constructor(
    public readonly retryable: boolean,
    public readonly detail: string,
  ) {
    super(detail);
    this.name = "IngestFailure";
  }
}

/** The lease was lost between writes — roll the transaction back, stop quietly. */
class LeaseLost extends Error {
  constructor() {
    super("ingest lease lost");
    this.name = "LeaseLost";
  }
}

/**
 * CPU time of the feature's own work, for usage_daily.cpu_ms (which gates
 * uploads, see UPLOAD_GUARDS). process.cpuUsage() counts the whole process:
 * measured across an await it would also book whatever ran meanwhile on the
 * same instance — MCP calls, other uploads and ingests, during the Gemini
 * or database wait — so only synchronous sections are measured (`run`),
 * plus CPU-bound awaits without network I/O (`runAsync`, e.g. gunzip). The
 * driver's encoding of the writes is not in it: the figure is the parse,
 * derive and hash work, not the instance's Active CPU.
 */
export class CpuMeter {
  private us = 0;

  run<T>(fn: () => T): T {
    const start = process.cpuUsage();
    try {
      return fn();
    } finally {
      this.add(start);
    }
  }

  async runAsync<T>(fn: () => Promise<T>): Promise<T> {
    const start = process.cpuUsage();
    try {
      return await fn();
    } finally {
      this.add(start);
    }
  }

  /** Whole milliseconds, rounded up (any measured work books ≥ 1 ms). */
  get ms(): number {
    return Math.ceil(this.us / 1_000);
  }

  private add(start: NodeJS.CpuUsage): void {
    const used = process.cpuUsage(start);
    this.us += used.user + used.system;
  }
}

const CORRUPT = "Uložený text dokumentu je poškozený. Nahrajte dokument prosím znovu.";

/**
 * pending_gz → the uploaded DMD text: gunzip capped at LIMITS.maxTextBytes,
 * strict UTF-8, and when `contentSha256` is given it must be the SHA-256 of
 * the normalized text (what the upload stores since the hash covers what is
 * kept) or of the bytes as sent (rows uploaded before that; the browser
 * sends normalized text, so for it the two agree). Throws IngestFailure
 * (not retryable) on anything else. Pure.
 */
export function inflatePending(gz: Uint8Array, contentSha256?: string | null): string {
  let raw: Buffer;
  try {
    raw = gunzipSync(Buffer.from(gz.buffer, gz.byteOffset, gz.byteLength), { maxOutputLength: LIMITS.maxTextBytes });
  } catch {
    throw new IngestFailure(false, CORRUPT);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new IngestFailure(false, CORRUPT);
  }
  if (contentSha256) {
    const want = contentSha256.toLowerCase();
    if (
      createHash("sha256").update(raw).digest("hex") !== want &&
      createHash("sha256").update(normalizeDmd(text).text, "utf8").digest("hex") !== want
    ) {
      throw new IngestFailure(false, CORRUPT);
    }
  }
  return text;
}

/** Opaque per-user id for the AI Gateway's usage attribution — never the Clerk id itself. */
export function userHash(userId: string): string {
  const key = process.env.FILES_USER_HASH_SECRET?.trim() || process.env.CLERK_SECRET_KEY?.trim() || "dawmain-files";
  return createHmac("sha256", key).update(`files-meta:${userId}`).digest("hex").slice(0, 32);
}

/**
 * The AI budget of one proposal: the rolling 30-day spend (all libraries)
 * must stay under LIMITS.aiBudgetUsd and the library under
 * LIMITS.aiProposalsPerLibraryPerDay calls today. Each check and booking is
 * its own short system-scope transaction (usage_daily holds no content) —
 * never held open across the model call.
 */
export function aiBudget(libraryId: string): { allow: () => Promise<boolean>; record: (usd: number) => Promise<void> } {
  return {
    allow: () =>
      withScope([], async (db) => {
        const spent = await usageSum(db, "global", "ai_microusd", 30);
        if (spent >= LIMITS.aiBudgetUsd * 1_000_000) return false;
        const calls = await usageSum(db, libraryId, "ai_calls", 1);
        return calls < LIMITS.aiProposalsPerLibraryPerDay;
      }),
    record: (usd: number) =>
      withScope([], async (db) => {
        const micro = Number.isFinite(usd) && usd > 0 ? Math.max(1, Math.round(usd * 1_000_000)) : 0;
        // Library row first, then 'global' — the order every writer of usage_daily keeps (no deadlock).
        await bumpUsage(db, libraryId, { ai_calls: 1, ai_microusd: micro });
        await bumpUsage(db, "global", { ai_calls: 1, ai_microusd: micro });
      }),
  };
}

const DOC_TYPE_SET = new Set<string>(DOC_TYPES);

/** The uploader's type hint, stored by the upload as a "user" proposal. */
function docTypeHint(row: DocumentRow): DocType | null {
  const field = row.proposed_meta?.doc_type;
  const value = field?.value;
  return field?.source === "user" && typeof value === "string" && DOC_TYPE_SET.has(value) ? (value as DocType) : null;
}

interface Claimed {
  runToken: string;
  pendingGz: Uint8Array;
  row: DocumentRow;
  settings: Record<string, unknown>;
  purging: boolean;
  replaced: DocumentRow | null;
}

interface Prepared {
  text: string;
  parsed: ParsedDoc;
  meta: BibMeta;
  proposed: ProposedMeta;
  statusDetail: string | null;
  status: "review" | "ready";
}

/**
 * Documents are ready (searchable) straight after ingest: the metadata is
 * proposed and stored, and the user corrects it later in the detail view
 * if needed. A library opts back into the review step with autoConfirm: false.
 */
export function autoConfirms(settings: Record<string, unknown>): boolean {
  return settings.autoConfirm !== false;
}

const REPLACED_DETAIL = "Nový převod dokumentu: metadata jsou převzata z původní verze, zkontrolujte je a potvrďte.";

/** Parse the text and settle the metadata (see the header). */
async function prepare(claim: Claimed, cpu: CpuMeter): Promise<Prepared> {
  const { row, replaced, settings } = claim;
  const confirmedOld = replaced && replaced.status === "ready" && replaced.confirmed_at ? replaced : null;
  const { text, parsed, input, heuristic } = cpu.run(() => {
    const text = normalizeDmd(inflatePending(claim.pendingGz, row.content_sha256)).text;
    const parsed = parseDmd(text, { anchorLabel: confirmedOld?.meta.anchor_label ?? undefined });
    const input = buildMetaInput(parsed, row.hints ?? {}, row.file_name, docTypeHint(row));
    return { text, parsed, input, heuristic: heuristicMeta(input) };
  });

  if (confirmedOld) {
    // A better conversion of a confirmed document: keep what the user confirmed.
    const old = confirmedOld.meta;
    const meta: BibMeta = {
      ...old,
      section_range: old.doc_type === "komentar" ? (sectionRangeOf(parsed.sections) ?? old.section_range ?? null) : (old.section_range ?? null),
      anchor_label: old.anchor_label ?? parsed.anchorLabel,
    };
    const status = autoConfirms(settings) ? "ready" : "review";
    return {
      text,
      parsed,
      meta,
      proposed: confirmedOld.proposed_meta ?? heuristic,
      statusDetail: status === "review" ? REPLACED_DETAIL : null,
      status,
    };
  }

  const ai =
    settings.aiProposals === false
      ? { meta: {}, ai: "skipped" as const, detail: null }
      : await proposeMetadata(input, { userHash: userHash(row.uploaded_by), ...aiBudget(row.library_id) });
  const proposed = mergeProposals(heuristic, ai.meta);
  const meta = proposalToBibMeta(proposed, row.file_name);
  if (meta.doc_type === "komentar") meta.section_range = sectionRangeOf(parsed.sections);
  if (!meta.anchor_label) meta.anchor_label = parsed.anchorLabel;
  const status = autoConfirms(settings) ? "ready" : "review";
  return { text, parsed, meta, proposed, statusDetail: status === "review" ? ai.detail : null, status };
}

/** Write the index and finish, atomically; delete the replaced document. */
async function commit(claim: Claimed, p: Prepared, cpu: CpuMeter): Promise<void> {
  const { row, runToken } = claim;
  const id = row.id;
  const libraryId = row.library_id;
  const { derived, blocks, metaTsv, identKeys } = cpu.run(() => {
    const derived = deriveIndex(p.parsed, { docType: p.meta.doc_type, commentedAct: p.meta.commented_act ?? null });
    return {
      derived,
      blocks: splitStorageBlocks(p.text),
      metaTsv: buildMetaTsv(p.meta, p.parsed.sections),
      identKeys: [...new Set([...metaIdentKeys(p.meta), ...derived.docIdentKeys])],
    };
  });

  await withScope(
    [libraryId],
    async (db) => {
      const wrote = await writeDocumentIndex(db, {
        id,
        libraryId,
        runToken,
        text: p.text,
        blocks,
        parsed: p.parsed,
        derived,
        analyzerVersion: ANALYZER_VERSION,
      });
      if (!wrote) throw new LeaseLost();
      const finished = await finishIngest(db, {
        id,
        libraryId,
        runToken,
        proposed: p.proposed,
        meta: p.meta,
        metaTsv,
        identKeys,
        status: p.status,
        statusDetail: p.statusDetail,
      });
      if (!finished) throw new LeaseLost();
      // The billed pages were fixed (and reserved) at upload; the counters follow that figure.
      await settlePages(db, libraryId, row.billable_pages, row.billable_pages);
      if (claim.replaced && claim.replaced.id !== id) await dropReplaced(db, claim.replaced, row);
    },
    { statementTimeoutMs: INGEST_STATEMENT_TIMEOUT_MS },
  );
}

/** The new document is in place: delete the one it replaces and give its pages back. */
async function dropReplaced(db: Queryable, old: DocumentRow, row: DocumentRow): Promise<void> {
  const gone = await deleteDocument(db, old.id, row.library_id);
  if (!gone) return; // deleted meanwhile
  if (gone.status === "review" || gone.status === "ready") await forgetPages(db, row.library_id, gone.billablePages);
  else if (gone.status === "queued" || gone.status === "processing") await releasePages(db, row.library_id, gone.billablePages);
  await audit(db, {
    libraryId: row.library_id,
    actor: row.uploaded_by,
    action: "document.replaced",
    docId: row.id,
    detail: { replaced: old.id, pages: row.billable_pages },
  });
}

/** Failure → retryable or not, with a fixed Czech detail. Unexpected errors are logged without content. */
function classify(error: unknown): IngestFailure {
  if (error instanceof IngestFailure) return error;
  if (error instanceof DmdLimitError) {
    return new IngestFailure(false, `Dokument překračuje bezpečnostní limit: ${error.message}`);
  }
  logFilesError("ingest", error);
  if (error instanceof FilesUnavailableError) {
    return new IngestFailure(true, "Databáze byla dočasně nedostupná, zpracování se zopakuje.");
  }
  return new IngestFailure(true, "Zpracování se nepodařilo, zkusíme to znovu.");
}

async function recordFailure(claim: Claimed, failure: IngestFailure): Promise<IngestResult> {
  const { row } = claim;
  try {
    return await withScope([row.library_id], async (db) => {
      const status = await failIngest(db, row.id, row.library_id, claim.runToken, failure.detail, failure.retryable);
      if (status === null) return "lost";
      if (status === "error") await releasePages(db, row.library_id, row.billable_pages);
      return "failed";
    });
  } catch (error) {
    // The lease expires on its own; the next kick retries or gives up.
    logFilesError("ingest.fail", error);
    return "failed";
  }
}

async function recordCpu(libraryId: string, cpu: CpuMeter): Promise<void> {
  try {
    const ms = cpu.ms;
    if (ms <= 0) return;
    await withScope([], async (db) => {
      await bumpUsage(db, libraryId, { cpu_ms: ms });
      await bumpUsage(db, "global", { cpu_ms: ms });
    });
  } catch {
    // Bookkeeping only.
  }
}

export async function ingestDocument(docId: string, libraryId: string): Promise<IngestResult> {
  if (typeof docId !== "string" || !UUID_RE.test(docId) || typeof libraryId !== "string" || !LIBRARY_ID_RE.test(libraryId)) {
    return "failed";
  }
  const env = envOnlyMode();
  if (env === "off" || env === "unconfigured") return "failed";
  const cpu = new CpuMeter();
  let claim: Claimed | null = null;
  try {
    claim = await withScope([libraryId], async (db) => {
      const c = await claimForIngest(db, docId, libraryId);
      if (!c) return null;
      const [lib] = await getLibraries(db, [libraryId]);
      const replaced = c.row.replaces ? await getDocument(db, c.row.replaces, [libraryId]) : null;
      return {
        runToken: c.runToken,
        pendingGz: c.pendingGz,
        row: c.row,
        settings: lib?.settings ?? {},
        purging: Boolean(lib?.purge_after),
        replaced,
      };
    });
    if (!claim) return "lost";
    if (claim.row.attempts > MAX_INGEST_ATTEMPTS) {
      throw new IngestFailure(false, "Dokument se nepodařilo zpracovat ani na několikátý pokus. Nahrajte ho prosím znovu.");
    }
    if (claim.purging) throw new IngestFailure(false, "Knihovna je určena ke smazání.");
    await commit(claim, await prepare(claim, cpu), cpu);
    return "done";
  } catch (error) {
    if (error instanceof LeaseLost) return "lost";
    if (!claim) {
      logFilesError("ingest.claim", error);
      return "failed";
    }
    return recordFailure(claim, classify(error));
  } finally {
    if (claim) await recordCpu(libraryId, cpu);
  }
}

/**
 * Run ingest for up to `limit` waiting documents, one after another (the
 * caller wraps this in after(), which keeps the function alive until it
 * settles). Only in mode "on" — a read-only deployment must not grow the
 * database. Returns how many were started. Never throws.
 */
export async function kickPendingIngests(limit: number): Promise<number> {
  try {
    if (envOnlyMode() !== "on" || (await effectiveMode()) !== "on") return 0;
    const n = Math.min(MAX_KICK, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1)));
    const candidates = await withScope([], (db) => ingestCandidates(db, n));
    let started = 0;
    for (const c of candidates) {
      started += 1;
      await ingestDocument(c.id, c.libraryId);
    }
    return started;
  } catch (error) {
    console.error(`files: kickPendingIngests failed (${errorCode(error)})`);
    return 0;
  }
}
