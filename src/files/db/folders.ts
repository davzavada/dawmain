import "server-only";
import { UUID_RE } from "../config";
import type { Queryable } from "./client";

/**
 * Folders (migration 0007): the directory tree of a library. Every query
 * carries the library id explicitly; RLS (library_scope) is the backstop.
 * A library holds at most MAX_FOLDERS folders, MAX_DEPTH levels deep —
 * small enough that the whole tree travels with the document list.
 */

export const MAX_FOLDERS = 300;
export const MAX_DEPTH = 6;
export const MAX_FOLDER_NAME = 80;

export interface FolderRow {
  id: string;
  library_id: string;
  parent_id: string | null;
  name: string;
  created_by: string;
}

const COLUMNS = "id, library_id, parent_id, name, created_by";

function mapFolder(r: Record<string, unknown>): FolderRow {
  return {
    id: String(r.id),
    library_id: String(r.library_id),
    parent_id: typeof r.parent_id === "string" ? r.parent_id : null,
    name: String(r.name ?? ""),
    created_by: String(r.created_by ?? ""),
  };
}

/** Postgres unique_violation — here: a folder of that name already in that place. */
export function isDuplicate(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "23505";
}

/** Every folder of the libraries, by name. */
export async function listFolders(db: Queryable, libraryIds: string[]): Promise<FolderRow[]> {
  if (libraryIds.length === 0) return [];
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM folders WHERE library_id = ANY($1::text[]) ORDER BY lower(name), id`, [libraryIds]);
  return rows.map(mapFolder);
}

export async function getFolder(db: Queryable, id: string, libraryIds: string[]): Promise<FolderRow | null> {
  if (!UUID_RE.test(id) || libraryIds.length === 0) return null;
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM folders WHERE id = $1 AND library_id = ANY($2::text[])`, [id.toLowerCase(), libraryIds]);
  return rows[0] ? mapFolder(rows[0]) : null;
}

/** Levels from the root down to `folderId` (1 for a folder at the root; 0 for the root itself). Pure. */
export function depthOf(folders: readonly FolderRow[], folderId: string | null): number {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let depth = 0;
  for (let at = folderId; at !== null && depth <= MAX_FOLDERS; at = byId.get(at)?.parent_id ?? null) depth += 1;
  return depth;
}

/** Levels below `folderId`, itself included (1 for a folder without subfolders). Pure. */
export function heightOf(folders: readonly FolderRow[], folderId: string): number {
  const children = folders.filter((f) => f.parent_id === folderId);
  return 1 + children.reduce((max, child) => Math.max(max, heightOf(folders, child.id)), 0);
}

/** Is `candidate` the folder itself or somewhere below it? (Moving a folder there would make a loop.) Pure. */
export function isWithin(folders: readonly FolderRow[], folderId: string, candidate: string | null): boolean {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let steps = 0;
  for (let at = candidate; at !== null && steps <= MAX_FOLDERS; at = byId.get(at)?.parent_id ?? null, steps += 1) {
    if (at === folderId) return true;
  }
  return false;
}

/** "Komentáře / Občanské právo" — the path of a folder from the root; "" for the root. Pure. */
export function folderPath(folders: readonly Pick<FolderRow, "id" | "parent_id" | "name">[], folderId: string | null): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const names: string[] = [];
  for (let at = folderId; at !== null && names.length <= MAX_FOLDERS; at = byId.get(at)?.parent_id ?? null) {
    const folder = byId.get(at);
    if (!folder) break;
    names.unshift(folder.name);
  }
  return names.join(" / ");
}

export async function createFolder(
  db: Queryable,
  args: { libraryId: string; parentId: string | null; name: string; createdBy: string },
): Promise<FolderRow> {
  const { rows } = await db.query(
    `INSERT INTO folders (library_id, parent_id, name, created_by) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
    [args.libraryId, args.parentId, args.name, args.createdBy],
  );
  return mapFolder(rows[0]);
}

/** Rename and/or move a folder (`parentId` undefined: stays where it is). */
export async function updateFolder(
  db: Queryable,
  args: { id: string; libraryId: string; name?: string; parentId?: string | null },
): Promise<FolderRow | null> {
  const { rows } = await db.query(
    `UPDATE folders SET name = coalesce($3, name), parent_id = CASE WHEN $4 THEN $5::uuid ELSE parent_id END
      WHERE id = $1 AND library_id = $2 RETURNING ${COLUMNS}`,
    [args.id, args.libraryId, args.name ?? null, args.parentId !== undefined, args.parentId ?? null],
  );
  return rows[0] ? mapFolder(rows[0]) : null;
}

/** Delete an EMPTY folder: "not_empty" when it still holds a document or a subfolder. */
export async function deleteFolder(db: Queryable, id: string, libraryId: string): Promise<"ok" | "not_empty" | "not_found"> {
  const used = await db.query(
    `SELECT (SELECT count(*) FROM folders WHERE parent_id = $1 AND library_id = $2)
          + (SELECT count(*) FROM documents WHERE folder_id = $1 AND library_id = $2) AS n`,
    [id, libraryId],
  );
  if (Number(used.rows[0]?.n ?? 0) > 0) return "not_empty";
  const { rows } = await db.query("DELETE FROM folders WHERE id = $1 AND library_id = $2 RETURNING id", [id, libraryId]);
  return rows.length > 0 ? "ok" : "not_found";
}

/** Put a document into a folder of its library (null: the root). False when there is no such document. */
export async function moveDocument(db: Queryable, args: { id: string; libraryId: string; folderId: string | null }): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE documents SET folder_id = $3, updated_at = now() WHERE id = $1 AND library_id = $2 AND status <> 'deleting' RETURNING id`,
    [args.id, args.libraryId, args.folderId],
  );
  return rows.length > 0;
}

/** A purged library keeps no folder names either. */
export async function deleteAllFolders(db: Queryable, libraryId: string): Promise<void> {
  await db.query("DELETE FROM folders WHERE library_id = $1", [libraryId]);
}
