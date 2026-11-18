import "server-only";
import { createHash } from "node:crypto";
import { getAccess } from "./access";
import { ORIGINAL_ALREADY_STORED, ORIGINAL_PART_BYTES, UUID_RE } from "./config";
import { withScope } from "./db/client";
import {
  deleteOriginalParts,
  getOriginalInfo,
  loadOriginalPart,
  originalPartSizes,
  putOriginalPart,
  setOriginalStatus,
  type OriginalInfo,
} from "./db/originals";
import { audit } from "./db/usage";
import { sanitizeLine } from "./dmd/normalize";
import { FilesUserError, logFilesError, MESSAGES } from "./errors";
import { effectiveMode } from "./guards";
import { ownedScope } from "./scope";
import type { FileKind } from "./types";
import { readCapped } from "./upload";

/**
 * The original files behind /api/files/documents/[id]/original. The text
 * layer (what the MCP tools search and read) is uploaded as before
 * (src/files/upload.ts) with `original: true` in its meta; the document then
 * waits in original 'uploading' and counts against the library's storage
 * quota at once. The browser then sends the file in parts of exactly
 * ORIGINAL_PART_BYTES (the last one shorter):
 *
 *   PUT  ?part=N   application/octet-stream — store part N (a retry replaces it);
 *   POST           finalize — all parts present, sizes add up to file_bytes,
 *                  SHA-256 of the whole = documents.file_sha256 → 'ready';
 *                  a mismatch drops the parts and sets 'missing' (422);
 *   GET  [?inline=1]  the file, streamed part by part.
 *
 * PUT and POST: the uploader only, a Pro library, effective mode "on".
 * GET: anyone who belongs to the library (team members too), Pro not
 * required, any mode but the deployment having the feature off. A
 * document the caller cannot see is 404, like one that does not exist.
 * An upload abandoned mid-way is reset to 'missing' by the daily cron
 * after 24 h (app/api/cron/files).
 */

const NOT_FOUND = "Dokument nenalezen.";
const NO_ORIGINAL = "Původní soubor tohoto dokumentu uložený není.";

/** Parts of an original of `fileBytes` bytes (an empty file has none and is never stored). Pure. */
export function partCount(fileBytes: number): number {
  return fileBytes > 0 ? Math.ceil(fileBytes / ORIGINAL_PART_BYTES) : 0;
}

/** Exact size of part `n` of an original of `fileBytes` bytes. Pure. */
export function partSize(fileBytes: number, n: number): number {
  return Math.max(0, Math.min(ORIGINAL_PART_BYTES, fileBytes - n * ORIGINAL_PART_BYTES));
}

/** Content-Type of an original by its kind. Pure. */
export function originalContentType(kind: FileKind): string {
  switch (kind) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "text/plain; charset=utf-8";
  }
}

/** Kinds a browser may show inline (with the sandbox CSP): never DOCX. Pure. */
export function inlineAllowed(kind: FileKind): boolean {
  return kind === "pdf" || kind === "txt" || kind === "md";
}

const EXTENSIONS: Record<FileKind, string> = { pdf: ".pdf", docx: ".docx", txt: ".txt", md: ".md" };

/**
 * `attachment|inline; filename="ascii"; filename*=UTF-8''…` (RFC 6266 /
 * 5987) for the stored file name, which ends in the kind's extension. Pure.
 */
export function originalDisposition(fileName: string, kind: FileKind, inline: boolean): string {
  const ext = EXTENSIONS[kind];
  let base = sanitizeLine(fileName, 255)
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (base.toLowerCase().endsWith(ext)) base = base.slice(0, -ext.length);
  base = base.replace(/^[\s.]+|[\s.]+$/g, "") || "dokument";
  // Never split a surrogate pair (encodeURIComponent throws on a lone half).
  const utf8 = `${base.slice(0, 200).replace(/[\uD800-\uDBFF]$/, "")}${ext}`;
  const ascii =
    base
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .slice(0, 80)
      .replace(/^[-.]+|[-.]+$/g, "") || "dokument";
  const encoded = encodeURIComponent(utf8).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}${ext}"; filename*=UTF-8''${encoded}`;
}

async function requireModeOn(): Promise<void> {
  const mode = await effectiveMode();
  if (mode === "readonly") throw new FilesUserError(503, MESSAGES.readonly);
  if (mode !== "on") throw new FilesUserError(503, MESSAGES.off);
}

/** The libraries of the caller (ownedScope) and the library access of one of them. */
async function scopeOf(userId: string, fresh: boolean) {
  const access = await getAccess(userId, { fresh });
  const scope = ownedScope(access);
  if (scope.libraryIds.length === 0) throw new FilesUserError(404, NOT_FOUND);
  return scope;
}

/** The uploader of a document whose original is on its way, in a library they may still upload into. */
function assertUploader(info: OriginalInfo, userId: string, canUpload: boolean): void {
  if (info.uploaded_by !== userId) throw new FilesUserError(403, "Původní soubor může nahrát jen ten, kdo dokument nahrál.");
  if (!canUpload) throw new FilesUserError(403, "Do této knihovny nemůžete nahrávat.");
  if (info.original_status !== "uploading") {
    throw new FilesUserError(409, info.original_status === "ready" ? ORIGINAL_ALREADY_STORED : "Na původní soubor se u tohoto dokumentu nečeká.");
  }
  if (!info.file_bytes || info.file_bytes <= 0) throw new FilesUserError(409, "Na původní soubor se u tohoto dokumentu nečeká.");
}

/**
 * PUT ?part=N: store one part. The body is read with a hard cap of the
 * part's exact size (Content-Length is not trusted) and must be exactly
 * that long.
 */
export async function putOriginalPartFor(userId: string, id: string, partParam: string | null, request: Request): Promise<void> {
  if (!UUID_RE.test(id)) throw new FilesUserError(404, NOT_FOUND);
  if (partParam === null || !/^\d{1,6}$/.test(partParam)) throw new FilesUserError(400, "Chybí nebo nesedí číslo části souboru.");
  const part = Number(partParam);
  await requireModeOn();
  const scope = await scopeOf(userId, true);
  // Check before reading the body: a stranger's 8 MB never gets read.
  const info = await withScope(scope.libraryIds, (db) => getOriginalInfo(db, id, scope.libraryIds));
  if (!info) throw new FilesUserError(404, NOT_FOUND);
  const lib = scope.libraries.find((l) => l.id === info.library_id);
  if (!lib) throw new FilesUserError(404, NOT_FOUND);
  assertUploader(info, userId, lib.pro && lib.canUpload);
  const fileBytes = info.file_bytes ?? 0;
  if (part >= partCount(fileBytes)) throw new FilesUserError(400, "Chybí nebo nesedí číslo části souboru.");
  const expected = partSize(fileBytes, part);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > expected) throw new FilesUserError(413, "Část souboru je větší, než má být.");
  const body = await readCapped(request.body, expected);
  if (!body) throw new FilesUserError(413, "Část souboru je větší, než má být.");
  if (body.byteLength !== expected) throw new FilesUserError(400, "Část souboru nedorazila celá. Zkuste nahrání zopakovat.");

  await withScope(
    [info.library_id],
    async (db) => {
      // Re-checked under the row lock: a finalize or a delete may have run meanwhile.
      const now = await getOriginalInfo(db, info.id, [info.library_id], { lock: true });
      if (!now) throw new FilesUserError(404, NOT_FOUND);
      assertUploader(now, userId, true);
      if (now.file_bytes !== info.file_bytes) throw new FilesUserError(409, "Dokument se mezitím změnil.");
      await putOriginalPart(db, info.id, info.library_id, part, body);
    },
    { statementTimeoutMs: 30_000 },
  );
}

/**
 * POST: every part there, sizes adding up, the SHA-256 of the whole equal
 * to the file hash the upload declared → 'ready'. Otherwise the parts go and
 * the original is 'missing' (422) — the text layer stays either way.
 * One transaction holding the document row, so no part changes under the hash.
 */
export async function finalizeOriginalFor(userId: string, id: string): Promise<{ original: "ready" }> {
  if (!UUID_RE.test(id)) throw new FilesUserError(404, NOT_FOUND);
  await requireModeOn();
  const scope = await scopeOf(userId, true);
  const outcome = await withScope(
    scope.libraryIds,
    async (db) => {
      const info = await getOriginalInfo(db, id, scope.libraryIds, { lock: true });
      const lib = info ? scope.libraries.find((l) => l.id === info.library_id) : undefined;
      if (!info || !lib) throw new FilesUserError(404, NOT_FOUND);
      assertUploader(info, userId, lib.pro && lib.canUpload);
      const fileBytes = info.file_bytes ?? 0;
      const sizes = await originalPartSizes(db, info.id, info.library_id);
      const count = partCount(fileBytes);
      const complete = sizes.length === count && sizes.every((s, i) => s.ord === i && s.bytes === partSize(fileBytes, i));
      if (!complete) {
        const missing = count - sizes.filter((s) => s.ord < count).length;
        throw new FilesUserError(409, `Původní soubor ještě není nahraný celý (chybí ${Math.max(1, missing)} z ${count} částí).`);
      }
      const hash = createHash("sha256");
      for (let i = 0; i < count; i += 1) {
        const data = await loadOriginalPart(db, info.id, info.library_id, i);
        if (!data) throw new Error("original part vanished under the row lock");
        hash.update(data);
      }
      if (hash.digest("hex") !== info.file_sha256) {
        await deleteOriginalParts(db, info.id, info.library_id);
        await setOriginalStatus(db, info.id, info.library_id, "uploading", "missing");
        await audit(db, { libraryId: info.library_id, actor: userId, action: "document.original_rejected", docId: info.id });
        return "mismatch" as const;
      }
      await setOriginalStatus(db, info.id, info.library_id, "uploading", "ready");
      await audit(db, {
        libraryId: info.library_id,
        actor: userId,
        action: "document.original",
        docId: info.id,
        detail: { bytes: fileBytes, parts: count },
      });
      return "ready" as const;
    },
    { statementTimeoutMs: 60_000 },
  );
  if (outcome === "mismatch") {
    throw new FilesUserError(422, "Nahraný soubor neodpovídá dokumentu (kontrolní součet nesouhlasí). Původní soubor se neuložil — text dokumentu zůstává.");
  }
  return { original: "ready" };
}

export interface OriginalDownload {
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
}

/**
 * GET: the original as a download (attachment), or with `inline` shown in
 * the browser — only PDF and plain text, always under `Content-Security-
 * Policy: sandbox` so nothing in it runs script on this origin. The first
 * scope checks and loads part 0; every further part is its own short scope,
 * so a slow download never holds a database connection. A document deleted
 * mid-download errors the stream rather than ending it short.
 */
export async function originalDownloadFor(userId: string, id: string, opts: { inline?: boolean } = {}): Promise<OriginalDownload> {
  if (!UUID_RE.test(id)) throw new FilesUserError(404, NOT_FOUND);
  const scope = await scopeOf(userId, false);
  const first = await withScope(scope.libraryIds, async (db) => {
    const info = await getOriginalInfo(db, id, scope.libraryIds);
    if (!info || !scope.libraries.some((l) => l.id === info.library_id)) throw new FilesUserError(404, NOT_FOUND);
    if (info.original_status !== "ready" || !info.file_bytes) throw new FilesUserError(404, NO_ORIGINAL);
    const data = await loadOriginalPart(db, info.id, info.library_id, 0);
    if (!data) throw new FilesUserError(404, NO_ORIGINAL);
    return { info, data };
  });
  const { info } = first;
  const fileBytes = info.file_bytes ?? 0;
  const count = partCount(fileBytes);
  const inline = opts.inline === true && inlineAllowed(info.file_kind);
  let next = 1;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.data.byteLength !== partSize(fileBytes, 0)) {
        controller.error(new Error("original part has the wrong size"));
        return;
      }
      controller.enqueue(first.data);
      if (next >= count) controller.close();
    },
    async pull(controller) {
      try {
        const data = await withScope([info.library_id], (db) => loadOriginalPart(db, info.id, info.library_id, next));
        if (!data || data.byteLength !== partSize(fileBytes, next)) throw new Error("original changed during the download");
        controller.enqueue(data);
        next += 1;
        if (next >= count) controller.close();
      } catch (error) {
        logFilesError("document.original.stream", error);
        controller.error(error);
      }
    },
  });
  const headers: Record<string, string> = {
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-type": originalContentType(info.file_kind),
    "content-length": String(fileBytes),
    "content-disposition": originalDisposition(info.file_name, info.file_kind, inline),
    // Inline: nothing in the file may run script on this origin. Sent with a download too (harmless there).
    "content-security-policy": "sandbox",
  };
  return { headers, body };
}
