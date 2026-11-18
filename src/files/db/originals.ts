import "server-only";
import type { FileKind } from "../types";
import type { Queryable } from "./client";
import { bytes, num, numOrNull } from "./codec";
import { isUuid, type OriginalStatus } from "./documents";

/**
 * The original files (doc_originals, 0008_originals_folders.sql): parts of
 * ORIGINAL_PART_BYTES in `ord` order, deleted with their document (FK
 * cascade). Every statement names its library; RLS is the backstop. The
 * rules (who, sizes, hash) live in src/files/originals.ts.
 */

export interface OriginalInfo {
  id: string;
  library_id: string;
  uploaded_by: string;
  file_kind: FileKind;
  file_name: string;
  file_bytes: number | null;
  file_sha256: string;
  original_status: OriginalStatus;
}

function mapInfo(r: Record<string, unknown>): OriginalInfo {
  const status = r.original_status;
  return {
    id: String(r.id),
    library_id: String(r.library_id),
    uploaded_by: String(r.uploaded_by),
    file_kind: r.file_kind as FileKind,
    file_name: String(r.file_name),
    file_bytes: numOrNull(r.file_bytes),
    file_sha256: String(r.file_sha256),
    original_status: status === "ready" || status === "uploading" ? status : "missing",
  };
}

/**
 * The document's original-file facts, in one of `libraryIds` (not being
 * deleted), or null. `lock` takes the row FOR UPDATE: a part upload and the
 * finalize of the same document then run one after another.
 */
export async function getOriginalInfo(
  db: Queryable,
  id: string,
  libraryIds: readonly string[],
  opts: { lock?: boolean } = {},
): Promise<OriginalInfo | null> {
  if (!isUuid(id) || libraryIds.length === 0) return null;
  const { rows } = await db.query(
    `SELECT id, library_id, uploaded_by, file_kind, file_name, file_bytes, file_sha256, original_status
       FROM documents WHERE id = $1 AND library_id = ANY($2::text[]) AND status <> 'deleting'${opts.lock ? " FOR UPDATE" : ""}`,
    [id.toLowerCase(), [...libraryIds]],
  );
  return rows[0] ? mapInfo(rows[0]) : null;
}

/** Store one part (a retry of the same part replaces it). */
export async function putOriginalPart(db: Queryable, docId: string, libraryId: string, ord: number, data: Uint8Array): Promise<void> {
  if (!Number.isInteger(ord) || ord < 0) throw new RangeError("ord must be a non-negative integer");
  await db.query(
    `INSERT INTO doc_originals (doc_id, library_id, ord, data) VALUES ($1, $2, $3, $4)
     ON CONFLICT (doc_id, ord) DO UPDATE SET data = EXCLUDED.data`,
    [docId, libraryId, ord, data],
  );
}

/** Sizes of the stored parts, in order. */
export async function originalPartSizes(db: Queryable, docId: string, libraryId: string): Promise<Array<{ ord: number; bytes: number }>> {
  const { rows } = await db.query(
    "SELECT ord, octet_length(data) AS bytes FROM doc_originals WHERE doc_id = $1 AND library_id = $2 ORDER BY ord",
    [docId, libraryId],
  );
  return rows.map((r) => ({ ord: num(r.ord), bytes: num(r.bytes) }));
}

/** One part's bytes, or null when it is not there. */
export async function loadOriginalPart(db: Queryable, docId: string, libraryId: string, ord: number): Promise<Uint8Array | null> {
  const { rows } = await db.query("SELECT data FROM doc_originals WHERE doc_id = $1 AND library_id = $2 AND ord = $3", [
    docId,
    libraryId,
    ord,
  ]);
  return rows[0] ? bytes(rows[0].data) : null;
}

/** Drop every part of the document's original. Returns how many went. */
export async function deleteOriginalParts(db: Queryable, docId: string, libraryId: string): Promise<number> {
  const { rows } = await db.query("DELETE FROM doc_originals WHERE doc_id = $1 AND library_id = $2 RETURNING ord", [docId, libraryId]);
  return rows.length;
}

/** Compare-and-set of original_status; false when it was not `from` (or the document is gone). */
export async function setOriginalStatus(
  db: Queryable,
  docId: string,
  libraryId: string,
  from: OriginalStatus,
  to: OriginalStatus,
): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE documents SET original_status = $4, updated_at = now()
      WHERE id = $1 AND library_id = $2 AND original_status = $3 RETURNING id`,
    [docId, libraryId, from, to],
  );
  return rows.length > 0;
}

/**
 * Originals of the library stuck in 'uploading' for longer than `hours`
 * (the browser was closed mid-upload): drop their parts and mark them
 * 'missing', so they stop counting against the storage quota. The text
 * layer stays. Returns how many documents were reset.
 */
export async function abandonStaleOriginals(db: Queryable, libraryId: string, hours: number): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE documents SET original_status = 'missing', updated_at = now()
      WHERE library_id = $1 AND original_status = 'uploading' AND uploaded_at < now() - make_interval(hours => $2)
      RETURNING id`,
    [libraryId, Math.max(1, Math.floor(hours))],
  );
  if (rows.length > 0) {
    await db.query("DELETE FROM doc_originals WHERE library_id = $1 AND doc_id = ANY($2::uuid[])", [
      libraryId,
      rows.map((r) => String(r.id)),
    ]);
  }
  return rows.length;
}
