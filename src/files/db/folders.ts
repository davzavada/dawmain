import "server-only";
import type { Queryable } from "./client";
import { iso } from "./codec";
import { isUuid } from "./documents";

/**
 * Folders of a library (0008_originals_folders.sql). They nest through
 * parent_id; a name is unique among its siblings, case-insensitively
 * (folders_sibling_name). Every statement names its library; RLS is the
 * backstop. The rules (names, rights, cycles) live in src/files/folders.ts.
 */

export interface FolderRow {
  id: string;
  library_id: string;
  parent_id: string | null;
  name: string;
  created_by: string;
  created_at: string;
}

const COLUMNS = "id, library_id, parent_id, name, created_by, created_at";

/** Folders one library may hold — far more than anyone files by hand; keeps the list response bounded. */
export const MAX_FOLDERS_PER_LIBRARY = 2_000;

function mapFolder(r: Record<string, unknown>): FolderRow {
  return {
    id: String(r.id),
    library_id: String(r.library_id),
    parent_id: typeof r.parent_id === "string" ? r.parent_id : null,
    name: String(r.name),
    created_by: String(r.created_by),
    created_at: iso(r.created_at),
  };
}

/**
 * Serialize changes to the library's folder tree (create, rename, move,
 * delete) until the transaction ends: the cycle check of a move and the
 * moving-up of a delete then see each other's result. Taken before any
 * folder row is locked.
 */
export async function lockFolderTree(db: Queryable, libraryId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`files-folders:${libraryId}`]);
}

/** pg foreign-key violation of documents.folder_id: the folder was deleted while a document was on its way into it. */
export function folderGone(error: unknown): boolean {
  const e = error as { code?: unknown; constraint?: unknown } | null;
  return !!e && typeof e === "object" && e.code === "23503" && e.constraint === "documents_folder_fk";
}

/** Every folder of the library, by name. */
export async function listFolders(db: Queryable, libraryId: string): Promise<FolderRow[]> {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM folders WHERE library_id = $1 ORDER BY lower(name), id LIMIT ${MAX_FOLDERS_PER_LIBRARY}`,
    [libraryId],
  );
  return rows.map(mapFolder);
}

export async function countFolders(db: Queryable, libraryId: string): Promise<number> {
  const { rows } = await db.query<{ n: string | number }>("SELECT count(*) AS n FROM folders WHERE library_id = $1", [libraryId]);
  return Number(rows[0]?.n ?? 0);
}

/** One folder of the given libraries, or null (malformed ids too). `lock` takes FOR UPDATE. */
export async function getFolder(
  db: Queryable,
  id: string,
  libraryIds: string | readonly string[],
  opts: { lock?: boolean } = {},
): Promise<FolderRow | null> {
  if (!isUuid(id)) return null;
  const ids = typeof libraryIds === "string" ? [libraryIds] : [...libraryIds];
  if (ids.length === 0) return null;
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM folders WHERE id = $1 AND library_id = ANY($2::text[])${opts.lock ? " FOR UPDATE" : ""}`,
    [id.toLowerCase(), ids],
  );
  return rows[0] ? mapFolder(rows[0]) : null;
}

/** Is there a sibling (same parent) named `name`, case-insensitively — other than `exceptId`? */
export async function siblingNameTaken(
  db: Queryable,
  libraryId: string,
  parentId: string | null,
  name: string,
  exceptId: string | null = null,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM folders
      WHERE library_id = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND lower(name) = lower($3)
        AND ($4::uuid IS NULL OR id <> $4::uuid)
      LIMIT 1`,
    [libraryId, parentId, name, exceptId],
  );
  return rows.length > 0;
}

/** Create a folder; "duplicate" when a sibling already has the name (the unique index decides). */
export async function insertFolder(
  db: Queryable,
  args: { libraryId: string; parentId: string | null; name: string; createdBy: string },
): Promise<FolderRow | "duplicate"> {
  const { rows } = await db.query(
    `INSERT INTO folders (library_id, parent_id, name, created_by) VALUES ($1, $2::uuid, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING ${COLUMNS}`,
    [args.libraryId, args.parentId, args.name, args.createdBy],
  );
  return rows[0] ? mapFolder(rows[0]) : "duplicate";
}

/** Rename and/or move a folder (the caller checked the name and the cycle). */
export async function updateFolder(
  db: Queryable,
  id: string,
  libraryId: string,
  next: { name: string; parentId: string | null },
): Promise<FolderRow | null> {
  const { rows } = await db.query(
    `UPDATE folders SET name = $3, parent_id = $4::uuid WHERE id = $1 AND library_id = $2 RETURNING ${COLUMNS}`,
    [id, libraryId, next.name, next.parentId],
  );
  return rows[0] ? mapFolder(rows[0]) : null;
}

/** True when `candidate` is `folderId` itself or one of its descendants (moving there would make a cycle). */
export async function isSelfOrDescendant(db: Queryable, libraryId: string, folderId: string, candidate: string): Promise<boolean> {
  const { rows } = await db.query(
    `WITH RECURSIVE sub AS (
       SELECT id FROM folders WHERE id = $2::uuid AND library_id = $1
       UNION
       SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id WHERE f.library_id = $1
     )
     SELECT 1 FROM sub WHERE id = $3::uuid LIMIT 1`,
    [libraryId, folderId, candidate],
  );
  return rows.length > 0;
}

/** A name not taken among `taken` (lower-cased): "Název", then "Název (2)", "Název (3)", … within 120 characters. Pure. */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const candidate = `${name.slice(0, 120 - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Delete a folder: its documents and subfolders move to its parent first
 * (a subfolder whose name the parent already has gets " (2)" etc.).
 * Returns how many documents and subfolders moved, or null when the folder
 * is not there. The caller locked the folder row.
 */
export async function deleteFolderMovingUp(
  db: Queryable,
  folder: FolderRow,
): Promise<{ documents: number; folders: number } | null> {
  const lib = folder.library_id;
  const docs = await db.query(
    "UPDATE documents SET folder_id = $3::uuid, updated_at = now() WHERE library_id = $1 AND folder_id = $2::uuid RETURNING id",
    [lib, folder.id, folder.parent_id],
  );
  const children = await db.query<{ id: string; name: string }>(
    "SELECT id, name FROM folders WHERE library_id = $1 AND parent_id = $2::uuid ORDER BY lower(name), id FOR UPDATE",
    [lib, folder.id],
  );
  if (children.rows.length > 0) {
    // The dying folder steps out of its siblings' way first: a child of the
    // same name may take that name in the parent.
    await db.query("UPDATE folders SET name = id::text WHERE id = $1 AND library_id = $2", [folder.id, lib]);
    const siblings = await db.query<{ name: string }>(
      "SELECT name FROM folders WHERE library_id = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND id <> $3::uuid",
      [lib, folder.parent_id, folder.id],
    );
    const taken = new Set(siblings.rows.map((r) => String(r.name).toLowerCase()));
    for (const child of children.rows) {
      const name = freeName(String(child.name), taken);
      taken.add(name.toLowerCase());
      await db.query("UPDATE folders SET parent_id = $3::uuid, name = $4 WHERE id = $1 AND library_id = $2", [
        child.id,
        lib,
        folder.parent_id,
        name,
      ]);
    }
  }
  const gone = await db.query("DELETE FROM folders WHERE id = $1 AND library_id = $2 RETURNING id", [folder.id, lib]);
  if (gone.rows.length === 0) return null;
  return { documents: docs.rows.length, folders: children.rows.length };
}

/** Move a document into a folder of its library (null = the root). False when the document is not there. */
export async function moveDocument(db: Queryable, docId: string, libraryId: string, folderId: string | null): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE documents SET folder_id = $3::uuid, updated_at = now()
      WHERE id = $1 AND library_id = $2 AND status <> 'deleting' RETURNING id`,
    [docId, libraryId, folderId],
  );
  return rows.length > 0;
}

/** Rename a document (its file name; the title of an unconfirmed document falls back to it). */
export async function renameDocument(db: Queryable, docId: string, libraryId: string, fileName: string): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE documents SET file_name = $3, updated_at = now()
      WHERE id = $1 AND library_id = $2 AND status <> 'deleting' RETURNING id`,
    [docId, libraryId, fileName],
  );
  return rows.length > 0;
}
