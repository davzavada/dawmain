import "server-only";
import { z } from "zod";
import { canDeleteDocument, getAccess, type LibraryAccess } from "./access";
import { LIBRARY_ID_RE, UUID_RE } from "./config";
import { withScope, type Queryable } from "./db/client";
import {
  countFolders,
  deleteFolders,
  documentsInFolders,
  folderSubtree,
  getFolder,
  insertFolder,
  isSelfOrDescendant,
  lockFolderTree,
  MAX_FOLDERS_PER_LIBRARY,
  siblingNameTaken,
  updateFolder,
  type FolderRow,
} from "./db/folders";
import { deleteDocument } from "./db/documents";
import { forgetPages, releasePages } from "./db/libraries";
import { audit } from "./db/usage";
import { FilesUserError, MESSAGES } from "./errors";
import { effectiveMode } from "./guards";
import { ownedScope } from "./scope";
import type { FolderItem } from "./web-types";

/**
 * Folders of a library — the logic behind app/api/files/folders (POST
 * create) and app/api/files/folders/[id] (PATCH rename/move, DELETE). SQL
 * in src/files/db/folders.ts.
 *
 * Rights: any member who may upload into the library (a Pro library,
 * canUpload) manages its folders — creating, renaming, moving and deleting
 * them, whoever made them. Effective mode "on" only. A folder of a library
 * the caller does not belong to is 404, like one that does not exist.
 * Deleting a folder deletes everything in it — its subfolders and every
 * document in them, originals and index included. In a team, a member may
 * only do so when all those documents are theirs; the team's manager may
 * always.
 */

const NOT_FOUND = "Složka nenalezena.";
export const DUPLICATE_FOLDER = "Složka s tímto názvem už tu je.";
const MAX_NAME = 120;

/**
 * A name as stored: trimmed, inner whitespace collapsed to one space; no
 * "/" or "\", no control characters, 1–`max` characters. Returns the name
 * or a Czech message. Pure (shared with document renames).
 */
export function cleanName(raw: unknown, max = MAX_NAME): { name: string } | { error: string } {
  if (typeof raw !== "string") return { error: "Zadejte název." };
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (name === "") return { error: "Zadejte název." };
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) return { error: "Název obsahuje nepovolené znaky." };
  if (/[\\/]/.test(name)) return { error: "Název nesmí obsahovat znaky / ani \\." };
  if (name.length > max) return { error: `Název může mít nejvýš ${max} znaků.` };
  return { name };
}

function folderName(raw: unknown): string {
  const r = cleanName(raw, MAX_NAME);
  if ("error" in r) throw new FilesUserError(422, r.error);
  return r.name;
}

/** The API shape of a folder row. Pure. */
export function folderItem(row: FolderRow, userId: string): FolderItem {
  return {
    id: row.id,
    libraryId: row.library_id,
    parentId: row.parent_id,
    name: row.name,
    createdAt: row.created_at,
    mine: row.created_by === userId,
  };
}

async function requireModeOn(): Promise<void> {
  const mode = await effectiveMode();
  if (mode === "readonly") throw new FilesUserError(503, MESSAGES.readonly);
  if (mode !== "on") throw new FilesUserError(503, MESSAGES.off);
}

/** May manage the folders of this library: Pro, and the caller may upload into it. */
function assertManages(lib: LibraryAccess): void {
  if (!lib.pro || !lib.canUpload) throw new FilesUserError(403, "Složky lze upravovat jen v knihovně s Pro (právníky), do které můžete nahrávat.");
}

/** pg unique violation (a sibling took the name between the check and the write) → 409. */
function uniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "23505";
}

async function guardDuplicate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (uniqueViolation(error)) throw new FilesUserError(409, DUPLICATE_FOLDER);
    throw error;
  }
}

/** A parent folder in the library, or 422 (null = the root). */
async function parentIn(db: Queryable, libraryId: string, parentId: string | null): Promise<string | null> {
  if (parentId === null) return null;
  const parent = await getFolder(db, parentId, libraryId);
  if (!parent) throw new FilesUserError(422, "Nadřazená složka neexistuje.");
  return parent.id;
}

const uuid = z.string().regex(UUID_RE).transform((s) => s.toLowerCase());

const createSchema = z.strictObject({
  lib: z.string().regex(LIBRARY_ID_RE),
  parentId: uuid.nullable().optional(),
  name: z.string().max(1_000),
});

/** POST /api/files/folders {lib, parentId|null, name} → the new folder. */
export async function createFolderFor(userId: string, body: unknown): Promise<FolderItem> {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw new FilesUserError(400, MESSAGES.badRequest);
  const name = folderName(parsed.data.name);
  await requireModeOn();
  const access = await getAccess(userId, { fresh: true });
  const scope = ownedScope(access, parsed.data.lib);
  const lib = scope.libraries[0];
  assertManages(lib);
  const row = await guardDuplicate(() =>
    withScope([lib.id], async (db) => {
      await lockFolderTree(db, lib.id);
      const parentId = await parentIn(db, lib.id, parsed.data.parentId ?? null);
      if ((await countFolders(db, lib.id)) >= MAX_FOLDERS_PER_LIBRARY) {
        throw new FilesUserError(422, `Knihovna může mít nejvýš ${MAX_FOLDERS_PER_LIBRARY} složek.`);
      }
      // The library row exists once anything was uploaded; a folder may come first.
      await db.query("INSERT INTO libraries (id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [lib.id, lib.name]);
      const inserted = await insertFolder(db, { libraryId: lib.id, parentId, name, createdBy: userId });
      if (inserted === "duplicate") throw new FilesUserError(409, DUPLICATE_FOLDER);
      await audit(db, { libraryId: lib.id, actor: userId, action: "folder.create", detail: { folder: inserted.id } });
      return inserted;
    }),
  );
  return folderItem(row, userId);
}

const patchSchema = z
  .strictObject({
    name: z.string().max(1_000).optional(),
    parentId: uuid.nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.parentId !== undefined);

/**
 * Find a folder in the caller's libraries (locked) with the library's access, or 404.
 * The library's folder tree is locked first (lockFolderTree), so concurrent
 * moves cannot build a cycle and a delete sees every child.
 */
async function findFolder(db: Queryable, libs: readonly LibraryAccess[], id: string): Promise<{ folder: FolderRow; lib: LibraryAccess }> {
  const peek = await getFolder(
    db,
    id,
    libs.map((l) => l.id),
  );
  if (!peek) throw new FilesUserError(404, NOT_FOUND);
  await lockFolderTree(db, peek.library_id);
  const folder = await getFolder(
    db,
    id,
    libs.map((l) => l.id),
    { lock: true },
  );
  const lib = folder ? libs.find((l) => l.id === folder.library_id) : undefined;
  if (!folder || !lib) throw new FilesUserError(404, NOT_FOUND);
  return { folder, lib };
}

/** PATCH /api/files/folders/[id] {name?, parentId?} — rename and/or move (parentId null = to the root). */
export async function patchFolderFor(userId: string, id: string, body: unknown): Promise<FolderItem> {
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) throw new FilesUserError(400, MESSAGES.badRequest);
  if (!UUID_RE.test(id)) throw new FilesUserError(404, NOT_FOUND);
  const newName = parsed.data.name === undefined ? undefined : folderName(parsed.data.name);
  await requireModeOn();
  const access = await getAccess(userId, { fresh: true });
  const scope = ownedScope(access);
  if (scope.libraryIds.length === 0) throw new FilesUserError(404, NOT_FOUND);
  const row = await guardDuplicate(() =>
    withScope(scope.libraryIds, async (db) => {
      const { folder, lib } = await findFolder(db, scope.libraries, id.toLowerCase());
      assertManages(lib);
      let parentId = folder.parent_id;
      if (parsed.data.parentId !== undefined) {
        parentId = await parentIn(db, lib.id, parsed.data.parentId);
        if (parentId !== null && (await isSelfOrDescendant(db, lib.id, folder.id, parentId))) {
          throw new FilesUserError(422, "Složku nejde přesunout do sebe ani do své podsložky.");
        }
      }
      const name = newName ?? folder.name;
      if (await siblingNameTaken(db, lib.id, parentId, name, folder.id)) throw new FilesUserError(409, DUPLICATE_FOLDER);
      const updated = await updateFolder(db, folder.id, lib.id, { name, parentId });
      if (!updated) throw new FilesUserError(404, NOT_FOUND);
      await audit(db, {
        libraryId: lib.id,
        actor: userId,
        action: parentId !== folder.parent_id ? "folder.move" : "folder.rename",
        detail: { folder: folder.id },
      });
      return updated;
    }),
  );
  return folderItem(row, userId);
}

/** DELETE /api/files/folders/[id] — the folder, its subfolders and every document in them. */
export async function deleteFolderFor(userId: string, id: string): Promise<{ deleted: true; deletedDocuments: number; deletedFolders: number }> {
  if (!UUID_RE.test(id)) throw new FilesUserError(404, NOT_FOUND);
  await requireModeOn();
  const access = await getAccess(userId, { fresh: true });
  const scope = ownedScope(access);
  if (scope.libraryIds.length === 0) throw new FilesUserError(404, NOT_FOUND);
  return withScope(scope.libraryIds, async (db) => {
    const { folder, lib } = await findFolder(db, scope.libraries, id.toLowerCase());
    assertManages(lib);
    const subtree = await folderSubtree(db, lib.id, folder.id);
    const docs = await documentsInFolders(db, lib.id, subtree);
    if (docs.some((d) => !canDeleteDocument(lib, d.uploaded_by, userId))) {
      throw new FilesUserError(403, "Ve složce jsou dokumenty jiných členů týmu. Celou ji může smazat jen správce týmu.");
    }
    let deletedDocuments = 0;
    for (const doc of docs) {
      const gone = await deleteDocument(db, doc.id, lib.id);
      if (!gone) continue;
      deletedDocuments += 1;
      if (gone.status === "review" || gone.status === "ready") await forgetPages(db, lib.id, gone.billablePages);
      else if (gone.status === "queued" || gone.status === "processing") await releasePages(db, lib.id, gone.billablePages);
      await audit(db, {
        libraryId: lib.id,
        actor: userId,
        action: "document.delete",
        docId: doc.id,
        detail: { pages: gone.billablePages, status: gone.status, byAdmin: doc.uploaded_by !== userId, folder: folder.id },
      });
    }
    const deletedFolders = await deleteFolders(db, lib.id, subtree);
    if (deletedFolders === 0) throw new FilesUserError(404, NOT_FOUND);
    await audit(db, { libraryId: lib.id, actor: userId, action: "folder.delete", detail: { folder: folder.id, documents: deletedDocuments, folders: deletedFolders } });
    return { deleted: true as const, deletedDocuments, deletedFolders };
  });
}
