import "server-only";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { after } from "next/server";
import { z } from "zod";
import { canDeleteDocument, canEditDocument, getAccess, type Access, type LibraryAccess } from "./access";
import { envOnlyMode, effectiveMode, sameOrigin } from "./guards";
import { TtlCache } from "@/src/sources/shared/cache";
import { LIBRARY_ID_RE, LIMITS, PAGE_CHARS, TERMS_VERSION, USER_ID_RE, UUID_RE, type FilesMode } from "./config";
import { withScope, type Queryable } from "./db/client";
import { deleteDocument, getDocument, listDocuments, nameWithoutExtension, renameDocument, type DocumentRow } from "./db/documents";
import { documentPreviewText, libraryDocCounts, mergeIdentKeys, metaContext } from "./db/documents-web";
import { createFolder, deleteFolder, depthOf, getFolder, heightOf, isDuplicate, isWithin, listFolders, MAX_DEPTH, MAX_FOLDER_NAME, MAX_FOLDERS, moveDocument, updateFolder, type FolderRow } from "./db/folders";
import { ensureLibrary, forgetPages, getLibraries, releasePages } from "./db/libraries";
import { loadReadDoc, loadText } from "./db/reading";
import { acceptTerms, audit, bumpUsage, hasAcceptedTerms, usageSum } from "./db/usage";
import { sanitizeLine } from "./dmd/normalize";
import { filesError, filesJson, FilesUserError, logFilesError, MESSAGES } from "./errors";
import { buildMetaTsv } from "./index/derive";
import { ownedScope, writeScope } from "./scope";
import type { DocumentDetail, DocumentListItem, DocumentListResponse, FolderItem, LibrarySummary, SummaryResponse } from "./web-types";

/**
 * The web API of the Vlastní zdroje modal — the logic behind the thin
 * route handlers in app/api/files/{summary,documents,documents/[id],
 * documents/[id]/export,terms}.
 * (Uploads and status polling are src/files/upload.ts and the status route.)
 *
 * Every handler: Clerk session (auth()), Origin check on mutations, access
 * from Clerk (fresh on mutations), a scope derived from that access only,
 * withScope + explicit library filters, fixed Czech messages, no content in
 * logs. A document or library the caller cannot see answers exactly like
 * one that does not exist (404).
 *
 * Rights: modifying a document (its metadata) needs a Pro
 * library (canEditDocument); listing, deleting and exporting need only
 * ownership (ownedScope + canDeleteDocument), also after Pro was revoked.
 *
 * Modes: "readonly" keeps list, detail, delete and export working and
 * refuses metadata edits; "off" (guards) keeps list,
 * delete (deleting is what frees the space) and export; env
 * "off"/"unconfigured" answers 503 before anything else.
 */

/** Documents one list request returns (the modal shows a library at once). */
const LIST_LIMIT = 200;
/** …and a library with folders is listed whole, so the tree can be walked without asking again. */
const TREE_LIMIT = 1_000;
/** JSON bodies of the mutating routes; the metadata form is far below this. */
const MAX_BODY_BYTES = 64 * 1024;
/** First characters of the text shown in the detail panel. */
const PREVIEW_CHARS = 1_500;

// ---------------------------------------------------------------------------
// Plumbing shared by the route handlers

/** The signed-in user, or the Response to return (401 / 503). */
export async function sessionUser(where: string): Promise<string | Response> {
  try {
    const { userId } = await auth();
    return userId ?? filesError(401, MESSAGES.signIn);
  } catch (error) {
    logFilesError(`${where}.auth`, error);
    return filesError(503, MESSAGES.unavailable);
  }
}

/** 503 when the feature is off or unconfigured on this deployment (no I/O). */
export function envRefusal(): Response | null {
  const env = envOnlyMode();
  return env === "off" || env === "unconfigured" ? filesError(503, MESSAGES.off) : null;
}

/** Any thrown error → its Response: a FilesUserError speaks for itself, the rest is logged and 503. */
export function errorResponse(where: string, error: unknown): Response {
  if (error instanceof FilesUserError) return filesError(error.status, error.message);
  logFilesError(where, error);
  return filesError(503, MESSAGES.unavailable);
}

/** Read a JSON body of at most MAX_BODY_BYTES; FilesUserError 413/400 otherwise. */
export async function readJson(request: Request, max = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) throw new FilesUserError(413, "Požadavek je příliš velký.");
  const text = await request.text();
  if (text.length > max) throw new FilesUserError(413, "Požadavek je příliš velký.");
  try {
    return JSON.parse(text);
  } catch {
    throw new FilesUserError(400, MESSAGES.badRequest);
  }
}

/** Same-origin check of a mutating request as a Response, or null when fine. */
export function originRefusal(request: Request): Response | null {
  return sameOrigin(request) ? null : filesError(403, MESSAGES.badOrigin);
}

/**
 * A GET that hands out a whole document (the export): a download link sends
 * no Origin, so only Sec-Fetch-Site is checked — when sent, it must be
 * same-origin or none (typed or bookmarked). A cross-site page cannot read
 * the answer anyway, but must not spend the daily export count either.
 */
export function fetchSiteRefusal(request: Request): Response | null {
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none" ? null : filesError(403, MESSAGES.badOrigin);
}

// ---------------------------------------------------------------------------
// DTOs

/** Badges worth showing next to a document (Czech, short). Pure. */
export function documentFlags(row: Pick<DocumentRow, "quality" | "injection_flag">): string[] {
  const q = row.quality ?? ({} as DocumentRow["quality"]);
  const flags: string[] = [];
  if (q.ocr) flags.push("OCR · prostý text");
  if (q.footnotes === "unsure" || q.footnotes === "partial") flags.push("poznámky nejisté");
  if (q.numbering === "lost") flags.push("číslování ztraceno");
  if (row.injection_flag) flags.push("text s pokyny pro AI");
  return flags;
}

/** One list row from a document row and the caller's rights. Pure. */
export function listItem(row: DocumentRow, lib: LibraryAccess, userId: string): DocumentListItem {
  return {
    id: row.id,
    libraryId: row.library_id,
    folderId: row.folder_id,
    title: row.meta.title || row.file_name,
    fileName: row.file_name,
    fileKind: row.file_kind,
    fileBytes: row.file_bytes,
    status: row.status,
    statusDetail: row.status_detail,
    uploadedAt: row.uploaded_at,
    mine: row.uploaded_by === userId,
    canEdit: canEditDocument(lib, row.uploaded_by, userId),
    canDelete: canDeleteDocument(lib, row.uploaded_by, userId),
    physicalPages: row.physical_pages,
    billablePages: row.billable_pages,
    flags: documentFlags(row),
  };
}

function detailOf(row: DocumentRow, lib: LibraryAccess, userId: string, preview: string): DocumentDetail {
  return {
    ...listItem(row, lib, userId),
    libraryName: lib.name,
    charCount: row.char_count,
    pageLabelSource: row.page_label_source,
    converter: row.converter,
    rights: row.rights,
    quality: row.quality,
    preview,
  };
}

// ---------------------------------------------------------------------------
// GET /api/files/summary

/**
 * The signed-in user's library with document counts and pages, the
 * effective mode and whether the content rules were accepted. The database
 * is touched only for a user with a Pro library (anyone else — signed out,
 * never Pro — never wakes it); a library without Pro comes without counts
 * (its list loads when opened). `fresh` accepts access at most 10 s old.
 */
export async function summaryFor(userId: string, opts: { fresh?: boolean } = {}): Promise<SummaryResponse> {
  const env = envOnlyMode();
  if (env === "off" || env === "unconfigured") return { state: "unavailable", mode: env };
  const access = await getAccess(userId, { fresh: opts.fresh === true });
  const pro = access.libraries.map((l) => l.id);
  let mode: FilesMode = env;
  let termsAccepted = false;
  let counts: Record<string, LibrarySummary["counts"]> = {};
  let pages: Record<string, number> = {};
  let loadedCounts = false;
  if (pro.length > 0) mode = await effectiveMode();
  // While the guards have the feature off (compute hours; cached until the
  // month rolls over) a page load must not wake the database just for counts.
  if (pro.length > 0 && mode !== "off" && mode !== "unconfigured") {
    loadedCounts = true;
    const loaded = await withScope(pro, async (db) => ({
      counts: await libraryDocCounts(db, pro),
      rows: await getLibraries(db, pro),
      terms: await hasAcceptedTerms(db, userId, TERMS_VERSION),
    }));
    counts = loaded.counts;
    pages = Object.fromEntries(loaded.rows.map((r) => [r.id, r.page_count + r.pages_reserved]));
    termsAccepted = loaded.terms;
  }
  const libraries = access.all.map(
    (lib): LibrarySummary => ({
      id: lib.id,
      kind: lib.kind,
      name: lib.name,
      role: lib.role,
      pro: lib.pro,
      canUpload: lib.canUpload,
      canManageAll: lib.canManageAll,
      quotaPages: lib.quotaPages,
      pagesUsed: lib.pro && loadedCounts ? (pages[lib.id] ?? 0) : null,
      counts: lib.pro && loadedCounts ? (counts[lib.id] ?? null) : null,
    }),
  );
  return { state: "ok", mode, termsAccepted, libraries, ukaz: access.ukaz === true };
}

// ---------------------------------------------------------------------------
// GET /api/files/documents?lib=

/**
 * The documents of the caller's library — Pro or not
 * (ownedScope: a user who lost Pro can still see and delete what they
 * stored). Newest first, at most 200.
 */
export async function listFor(userId: string, libraryId: string): Promise<DocumentListResponse> {
  if (!LIBRARY_ID_RE.test(libraryId)) throw new FilesUserError(404, "Knihovna nenalezena.");
  const access = await getAccess(userId);
  const scope = ownedScope(access, libraryId);
  const lib = scope.libraries[0];
  const { rows, total, folders } = await withScope(scope.libraryIds, async (db) => {
    const list: DocumentRow[] = [];
    let count = 0;
    // listDocuments answers at most LIST_LIMIT a page.
    for (let offset = 0; offset < TREE_LIMIT; offset += LIST_LIMIT) {
      const page = await listDocuments(db, { libraryIds: [...scope.libraryIds], limit: LIST_LIMIT, offset, sort: "added" });
      list.push(...page.rows);
      count = page.total;
      if (page.rows.length < LIST_LIMIT) break;
    }
    return { rows: list, total: count, folders: await listFolders(db, [...scope.libraryIds]) };
  });
  const documents = rows.map((r) => listItem(r, lib, userId));
  if (lib.kind === "org") {
    const names = await uploaderNames(rows.map((r) => r.uploaded_by));
    rows.forEach((r, i) => (documents[i].uploadedByName = names.get(r.uploaded_by) ?? null));
  }
  return { libraryId: lib.id, documents, total, folders: folders.map((f) => folderItem(f, lib, userId)) };
}

function folderItem(folder: FolderRow, lib: LibraryAccess, userId: string): FolderItem {
  return { id: folder.id, parentId: folder.parent_id, name: folder.name, canManage: canManageFolder(lib, folder, userId) };
}

/** May rename, move and delete a folder: who made it, the library's owner or the team's admin. */
function canManageFolder(lib: LibraryAccess, folder: FolderRow, userId: string): boolean {
  return lib.canManageAll || folder.created_by === userId;
}

/** Uploaders' names stay put for ten minutes: a team's list is opened far more often than a name changes. */
const uploaderNameCache = new TtlCache<string>(10 * 60_000, 2_000);

/**
 * Who uploaded what in a team library: user id → a short name ("Jan Novák",
 * else the user name). One Clerk call for the ids not cached; a failure
 * (or a deleted account) leaves the name out — the list never waits on it.
 */
export async function uploaderNames(userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)].filter((id) => USER_ID_RE.test(id));
  const names = new Map<string, string>();
  const missing: string[] = [];
  for (const id of ids) {
    const hit = uploaderNameCache.get(id);
    if (hit !== undefined) names.set(id, hit);
    else missing.push(id);
  }
  if (missing.length === 0) return names;
  try {
    const client = await clerkClient();
    const { data } = await client.users.getUserList({ userId: missing.slice(0, 100), limit: 100 });
    for (const u of data) {
      const name = sanitizeLine([u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || "", 60);
      if (!name) continue;
      uploaderNameCache.set(u.id, name);
      names.set(u.id, name);
    }
  } catch (error) {
    logFilesError("documents.uploaders", error);
  }
  return names;
}

// ---------------------------------------------------------------------------
// /api/files/documents/[id]

/** The document in any library the caller belongs to, with that library's access — or 404. */
async function findDocument(db: Queryable, access: Access, id: string): Promise<{ row: DocumentRow; lib: LibraryAccess }> {
  const scope = ownedScope(access);
  const row = UUID_RE.test(id) ? await getDocument(db, id.toLowerCase(), [...scope.libraryIds]) : null;
  const lib = row ? scope.libraries.find((l) => l.id === row.library_id) : undefined;
  if (!row || !lib) throw new FilesUserError(404, "Dokument nenalezen.");
  return { row, lib };
}

function libraryIdsOf(access: Access): string[] {
  return [...ownedScope(access).libraryIds];
}

/** GET: detail with the text preview. */
export async function detailFor(userId: string, id: string): Promise<DocumentDetail> {
  if (!UUID_RE.test(id)) throw new FilesUserError(404, "Dokument nenalezen.");
  const access = await getAccess(userId);
  const ids = libraryIdsOf(access);
  if (ids.length === 0) throw new FilesUserError(404, "Dokument nenalezen.");
  const { row, lib, preview } = await withScope(ids, async (db) => {
    const found = await findDocument(db, access, id);
    return { ...found, preview: await documentPreviewText(db, found.row.id, found.row.library_id, PREVIEW_CHARS) };
  });
  return detailOf(row, lib, userId, preview);
}

const patchSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("rename"), name: z.string().max(1_000) }),
  z.strictObject({ action: z.literal("move"), folderId: z.string().regex(UUID_RE).nullable() }),
]);

/** The longest file name a rename accepts (the column allows 255; the list has to show it). */
export const MAX_FILE_NAME = 160;

/**
 * A file or folder name as the user typed it: one line, no control characters or path
 * separators, trimmed; null when nothing is left or it is too long. Pure.
 */
export function cleanName(raw: string, max = MAX_FILE_NAME): string | null {
  const name = sanitizeLine(raw.replace(/[\\/]+/g, " "), 400).trim();
  return name && name.length <= max ? name : null;
}


/** Edits of a document in a library without Pro (listing, deleting and exporting stay). */
const NO_PRO_EDIT = "Upravovat dokumenty lze jen v knihovně s Pro. Dokument můžete dál smazat nebo si stáhnout jeho text.";

/**
 * PATCH: rename the file or move it to another folder — the two things a
 * user changes about a file. Edit rights: canEditDocument (a Pro library;
 * its owner, the team's admin, or the uploader). Refused while the feature
 * is read-only or off.
 */
export async function patchFor(userId: string, id: string, body: unknown): Promise<DocumentDetail> {
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success || !UUID_RE.test(id)) throw new FilesUserError(400, MESSAGES.badRequest);
  const mode = await effectiveMode();
  if (mode === "readonly") throw new FilesUserError(503, MESSAGES.readonly);
  if (mode !== "on") throw new FilesUserError(503, MESSAGES.off);
  const input = parsed.data;
  return input.action === "rename" ? renameFor(userId, id, input.name) : moveFor(userId, id, input.folderId);
}

/**
 * PATCH { action: "rename", name }: the one thing a user edits. The name is
 * what the list shows and — without its extension — the title the
 * assistant cites and the search's metadata channel matches. Same rights
 * as any edit (canEditDocument).
 */
async function renameFor(userId: string, id: string, rawName: string): Promise<DocumentDetail> {
  const fileName = cleanName(rawName);
  if (!fileName) throw new FilesUserError(422, `Zadejte název, nejvýš ${MAX_FILE_NAME} znaků.`);
  const access = await getAccess(userId, { fresh: true });
  const ids = libraryIdsOf(access);
  if (ids.length === 0) throw new FilesUserError(404, "Dokument nenalezen.");
  await withScope(ids, async (db) => {
    const { row, lib } = await findDocument(db, access, id);
    if (!lib.pro && canDeleteDocument(lib, row.uploaded_by, userId)) throw new FilesUserError(403, NO_PRO_EDIT);
    if (!canEditDocument(lib, row.uploaded_by, userId)) throw new FilesUserError(403, "Tento soubor může přejmenovat jen ten, kdo ho nahrál, nebo správce týmu.");
    if (row.file_name === fileName) return;
    const ctx = await metaContext(db, row.id, row.library_id);
    if (!ctx) throw new FilesUserError(404, "Dokument nenalezen.");
    const title = nameWithoutExtension(fileName);
    const renamed = await renameDocument(db, {
      id: row.id,
      libraryId: row.library_id,
      fileName,
      title,
      metaTsv: buildMetaTsv({ ...row.meta, title }, ctx.sections),
    });
    if (!renamed) throw new FilesUserError(409, "Soubor se ještě zpracovává — přejmenovat půjde, až bude hotový.");
    await audit(db, { libraryId: row.library_id, actor: userId, action: "document.rename", docId: row.id });
  });
  return detailFor(userId, id);
}

/**
 * PATCH { action: "move", folderId }: put the file into a folder of its own
 * library (null: the library's root). Same rights as any edit.
 */
async function moveFor(userId: string, id: string, folderId: string | null): Promise<DocumentDetail> {
  const access = await getAccess(userId, { fresh: true });
  const ids = libraryIdsOf(access);
  if (ids.length === 0) throw new FilesUserError(404, "Dokument nenalezen.");
  await withScope(ids, async (db) => {
    const { row, lib } = await findDocument(db, access, id);
    if (!lib.pro && canDeleteDocument(lib, row.uploaded_by, userId)) throw new FilesUserError(403, NO_PRO_EDIT);
    if (!canEditDocument(lib, row.uploaded_by, userId)) throw new FilesUserError(403, "Tento soubor může přesunout jen ten, kdo ho nahrál, nebo správce týmu.");
    // A folder of another library is "not found", like one that does not exist.
    if (folderId !== null && !(await getFolder(db, folderId, [row.library_id]))) throw new FilesUserError(404, "Složka nenalezena.");
    if (row.folder_id === (folderId?.toLowerCase() ?? null)) return;
    if (!(await moveDocument(db, { id: row.id, libraryId: row.library_id, folderId: folderId?.toLowerCase() ?? null }))) throw new FilesUserError(404, "Dokument nenalezen.");
    await audit(db, { libraryId: row.library_id, actor: userId, action: "document.move", docId: row.id });
  });
  return detailFor(userId, id);
}

// ---------------------------------------------------------------------------
// Folders: /api/files/folders, /api/files/folders/[id]

const folderCreateSchema = z.strictObject({
  lib: z.string().regex(LIBRARY_ID_RE),
  parentId: z.string().regex(UUID_RE).nullable(),
  name: z.string().max(1_000),
});
const folderPatchSchema = z.union([
  z.strictObject({ action: z.literal("rename"), name: z.string().max(1_000) }),
  z.strictObject({ action: z.literal("move"), parentId: z.string().regex(UUID_RE).nullable() }),
]);

const FOLDER_NAME = `Zadejte název složky, nejvýš ${MAX_FOLDER_NAME} znaků.`;
const FOLDER_EXISTS = "Složka s tímto názvem tu už je.";
const FOLDER_TOO_DEEP = `Složky jdou vnořit nejvýš do ${MAX_DEPTH} úrovní.`;
const FOLDER_FORBIDDEN = "Tuto složku může měnit jen ten, kdo ji založil, nebo správce týmu.";

/** Mutations of the tree need the feature fully on (deleting an empty folder is allowed while read-only). */
async function requireOn(): Promise<void> {
  const mode = await effectiveMode();
  if (mode === "readonly") throw new FilesUserError(503, MESSAGES.readonly);
  if (mode !== "on") throw new FilesUserError(503, MESSAGES.off);
}

/** A unique-name violation → the Czech 409; anything else is thrown on. */
function folderConflict(error: unknown): never {
  if (isDuplicate(error)) throw new FilesUserError(409, FOLDER_EXISTS);
  throw error;
}

/** POST: a new folder in a library the caller may upload into (any member of a team). */
export async function createFolderFor(userId: string, body: unknown): Promise<FolderItem> {
  const parsed = folderCreateSchema.safeParse(body);
  if (!parsed.success) throw new FilesUserError(400, MESSAGES.badRequest);
  const name = cleanName(parsed.data.name, MAX_FOLDER_NAME);
  if (!name) throw new FilesUserError(422, FOLDER_NAME);
  await requireOn();
  const access = await getAccess(userId, { fresh: true });
  const { library } = writeScope(access, parsed.data.lib);
  const parentId = parsed.data.parentId?.toLowerCase() ?? null;
  try {
    return await withScope([library.id], async (db) => {
      const folders = await listFolders(db, [library.id]);
      if (parentId !== null && !folders.some((f) => f.id === parentId)) throw new FilesUserError(404, "Složka nenalezena.");
      if (folders.length >= MAX_FOLDERS) throw new FilesUserError(422, `Knihovna může mít nejvýš ${MAX_FOLDERS} složek.`);
      if (depthOf(folders, parentId) + 1 > MAX_DEPTH) throw new FilesUserError(422, FOLDER_TOO_DEEP);
      // The folder points at its library's row: make sure there is one (an empty library has none yet).
      await ensureLibrary(db, library.id, library.name);
      const folder = await createFolder(db, { libraryId: library.id, parentId, name, createdBy: userId });
      await audit(db, { libraryId: library.id, actor: userId, action: "folder.create", detail: { folder: folder.id } });
      return folderItem(folder, library, userId);
    });
  } catch (error) {
    return folderConflict(error);
  }
}

/** The folder in any library the caller belongs to, with that library's access — or 404. */
async function findFolder(db: Queryable, access: Access, id: string): Promise<{ folder: FolderRow; lib: LibraryAccess }> {
  const scope = ownedScope(access);
  const folder = await getFolder(db, id, [...scope.libraryIds]);
  const lib = folder ? scope.libraries.find((l) => l.id === folder.library_id) : undefined;
  if (!folder || !lib) throw new FilesUserError(404, "Složka nenalezena.");
  return { folder, lib };
}

/** PATCH: rename the folder, or move it (with everything in it) into another folder of its library. */
export async function patchFolderFor(userId: string, id: string, body: unknown): Promise<FolderItem> {
  const parsed = folderPatchSchema.safeParse(body);
  if (!parsed.success || !UUID_RE.test(id)) throw new FilesUserError(400, MESSAGES.badRequest);
  const input = parsed.data;
  const name = input.action === "rename" ? cleanName(input.name, MAX_FOLDER_NAME) : undefined;
  if (name === null) throw new FilesUserError(422, FOLDER_NAME);
  await requireOn();
  const access = await getAccess(userId, { fresh: true });
  const ids = libraryIdsOf(access);
  if (ids.length === 0) throw new FilesUserError(404, "Složka nenalezena.");
  try {
    return await withScope(ids, async (db) => {
      const { folder, lib } = await findFolder(db, access, id);
      if (!lib.pro) throw new FilesUserError(403, NO_PRO_EDIT);
      if (!canManageFolder(lib, folder, userId)) throw new FilesUserError(403, FOLDER_FORBIDDEN);
      let parentId: string | null | undefined;
      if (input.action === "move") {
        parentId = input.parentId?.toLowerCase() ?? null;
        const folders = await listFolders(db, [folder.library_id]);
        if (parentId !== null && !folders.some((f) => f.id === parentId)) throw new FilesUserError(404, "Složka nenalezena.");
        if (isWithin(folders, folder.id, parentId)) throw new FilesUserError(422, "Složku nejde přesunout do sebe samé.");
        if (depthOf(folders, parentId) + heightOf(folders, folder.id) > MAX_DEPTH) throw new FilesUserError(422, FOLDER_TOO_DEEP);
      }
      const updated = await updateFolder(db, { id: folder.id, libraryId: folder.library_id, name, parentId });
      if (!updated) throw new FilesUserError(404, "Složka nenalezena.");
      await audit(db, { libraryId: folder.library_id, actor: userId, action: `folder.${input.action}`, detail: { folder: folder.id } });
      return folderItem(updated, lib, userId);
    });
  } catch (error) {
    return folderConflict(error);
  }
}

/** DELETE: an empty folder only — files and subfolders are moved or deleted first, so nothing disappears by accident. */
export async function deleteFolderFor(userId: string, id: string): Promise<void> {
  if (!UUID_RE.test(id)) throw new FilesUserError(404, "Složka nenalezena.");
  const mode = await effectiveMode();
  if (mode === "unconfigured") throw new FilesUserError(503, MESSAGES.off);
  const access = await getAccess(userId, { fresh: true });
  const ids = libraryIdsOf(access);
  if (ids.length === 0) throw new FilesUserError(404, "Složka nenalezena.");
  await withScope(ids, async (db) => {
    const { folder, lib } = await findFolder(db, access, id);
    if (!canManageFolder(lib, folder, userId)) throw new FilesUserError(403, FOLDER_FORBIDDEN);
    const outcome = await deleteFolder(db, folder.id, folder.library_id);
    if (outcome === "not_empty") throw new FilesUserError(409, "Složka není prázdná. Nejdřív z ní soubory a podsložky přesuňte nebo je smažte.");
    if (outcome === "not_found") throw new FilesUserError(404, "Složka nenalezena.");
    await audit(db, { libraryId: folder.library_id, actor: userId, action: "folder.delete", detail: { folder: folder.id } });
  });
}

/**
 * DELETE: remove the document and everything derived from it, and give its
 * pages back. Ownership only (canDeleteDocument: the uploader or
 * owner/admin), Pro not required. Allowed in read-only mode (deleting
 * frees space) and while the guards have the feature off; not when the
 * deployment has it off.
 */
export async function deleteFor(userId: string, id: string): Promise<void> {
  if (!UUID_RE.test(id)) throw new FilesUserError(404, "Dokument nenalezen.");
  const access = await getAccess(userId, { fresh: true });
  const ids = libraryIdsOf(access);
  if (ids.length === 0) throw new FilesUserError(404, "Dokument nenalezen.");
  await withScope(ids, async (db) => {
    const { row, lib } = await findDocument(db, access, id);
    if (!canDeleteDocument(lib, row.uploaded_by, userId)) throw new FilesUserError(403, "Tento dokument může smazat jen jeho vlastník.");
    const gone = await deleteDocument(db, row.id, row.library_id);
    if (!gone) throw new FilesUserError(404, "Dokument nenalezen.");
    if (gone.status === "review" || gone.status === "ready") await forgetPages(db, row.library_id, gone.billablePages);
    else if (gone.status === "queued" || gone.status === "processing") await releasePages(db, row.library_id, gone.billablePages);
    await audit(db, {
      libraryId: row.library_id,
      actor: userId,
      action: "document.delete",
      docId: row.id,
      detail: { pages: gone.billablePages, status: gone.status, byAdmin: row.uploaded_by !== userId },
    });
  });
}

// ---------------------------------------------------------------------------
// GET /api/files/documents/[id]/export?lib=

/**
 * Stored text loaded per database round trip of an export (storage blocks
 * are ~12k chars): each batch is its own short withScope, so a slow
 * download never holds a connection and a long book never sits in memory.
 */
const EXPORT_BATCH_CHARS = 600_000;

/**
 * Exports of one document per user and UTC day. Not the MCP read cap (that
 * one keeps a model from copying a book out window by window; this is the
 * uploader's own text, handed back whole on purpose) — only a bound on the
 * egress and CPU one user can cause on the free tier. The counter sits
 * under the read counters' `read:<user>:` prefix, so their short retention
 * and the erasure of a deleted account apply to it.
 */
export const EXPORTS_PER_DOC_PER_DAY = 10;

/**
 * Pages (PAGE_CHARS of stored text, rounded up per document) one user may
 * export per UTC day, over all documents: one library's quota — a whole
 * library fits in a day, a second copy of it waits for the next.
 * Counted in `pages` under `read:<user>:export` (same retention and
 * erasure as above; never a document id, so no clash with the per-document
 * counters).
 */
export function exportPagesPerUserPerDay(): number {
  return LIMITS.personalPages;
}

export interface DocumentExport {
  /** Content-Disposition: attachment with an ASCII filename and an RFC 5987 filename*. */
  disposition: string;
  /** UTF-8: the metadata header, then the stored DMD text. */
  body: ReadableStream<Uint8Array>;
}

/** File names of an export: ASCII (no diacritics, safe characters only) and UTF-8, both ending ".md". Pure. */
export function exportFileNames(title: string): { ascii: string; utf8: string } {
  const clean = sanitizeLine(title, 100)
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  const ascii = clean
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .slice(0, 80)
    .replace(/^[-.]+|[-.]+$/g, "");
  return { ascii: `${ascii || "dokument"}.md`, utf8: `${clean || "dokument"}.md` };
}

/** `attachment; filename="…"; filename*=UTF-8''…` (RFC 6266 / 5987). Pure. */
export function exportDisposition(title: string): string {
  const { ascii, utf8 } = exportFileNames(title);
  const encoded = encodeURIComponent(utf8).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * The metadata header of an export: YAML front matter, one line per field,
 * strings JSON-quoted (valid YAML) after sanitizeLine — no line breaks, so
 * nothing in the metadata can end the header early. Pure.
 */
export function exportHeader(row: DocumentRow, libraryName: string, exportedAt: Date): string {
  const q = (s: string, max = 300) => JSON.stringify(sanitizeLine(s, max));
  const date = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);
  const lines = ["---", `title: ${q(row.meta.title || row.file_name)}`, `source_file: ${q(row.file_name, 200)}`, `library: ${q(libraryName, 120)}`];
  const uploaded = date(row.uploaded_at);
  if (uploaded) lines.push(`uploaded: ${uploaded}`);
  lines.push(`exported: ${exportedAt.toISOString().slice(0, 10)}`, `format: "DMD (Dawmain Markdown)"`, "---", "", "");
  return lines.join("\n");
}

/**
 * The stored text of one document as a download, for GDPR portability and
 * for a library that lost Pro (the days before its purge). Ownership
 * only, Pro not required (canDeleteDocument: the uploader or owner/admin —
 * a member does not export a colleague's upload); allowed in any mode
 * except the deployment having the feature off. `libraryId` narrows
 * ownedScope to that one library (404 when the caller does not belong to
 * it). Audited as document.export with the length, never the text. Only
 * review/ready documents have stored text.
 *
 * The first withScope checks everything, counts and audits, and loads the
 * first batch; the rest streams in batches. A document deleted or changed
 * mid-download errors the stream (the browser shows a failed download)
 * rather than ending it short.
 */
export async function exportFor(
  userId: string,
  id: string,
  libraryId: string,
  opts: { now?: Date; batchChars?: number } = {},
): Promise<DocumentExport> {
  const batch = Math.max(1, Math.floor(opts.batchChars ?? EXPORT_BATCH_CHARS));
  if (!LIBRARY_ID_RE.test(libraryId)) throw new FilesUserError(404, "Knihovna nenalezena.");
  if (!UUID_RE.test(id)) throw new FilesUserError(404, "Dokument nenalezen.");
  const access = await getAccess(userId, { fresh: true });
  const scope = ownedScope(access, libraryId);
  const lib = scope.libraries[0];
  const docId = id.toLowerCase();
  const first = await withScope(scope.libraryIds, async (db) => {
    const doc = await loadReadDoc(db, docId, [lib.id]);
    if (!doc) throw new FilesUserError(404, "Dokument nenalezen.");
    const { row } = doc;
    if (!canDeleteDocument(lib, row.uploaded_by, userId)) {
      throw new FilesUserError(403, "Text tohoto dokumentu si může stáhnout jen jeho vlastník.");
    }
    if (row.status === "queued" || row.status === "processing") {
      throw new FilesUserError(409, "Dokument se ještě zpracovává — text půjde stáhnout, až bude hotový.");
    }
    if ((row.status !== "review" && row.status !== "ready") || doc.textLength === 0) {
      throw new FilesUserError(409, "Text tohoto dokumentu uložený není.");
    }
    // Count first, then compare: the upsert holds the counter row, so concurrent
    // exports queue on it; a refusal throws and the transaction takes the count back.
    const counter = `read:${userId}:${row.id}:export`;
    await bumpUsage(db, counter, { reads: 1 });
    if ((await usageSum(db, counter, "reads", 1)) > EXPORTS_PER_DOC_PER_DAY) {
      throw new FilesUserError(429, `Text tohoto dokumentu jste dnes stáhli už ${EXPORTS_PER_DOC_PER_DAY}krát. Další stažení půjde zítra.`);
    }
    const budget = `read:${userId}:export`;
    await bumpUsage(db, budget, { pages: Math.max(1, Math.ceil(doc.textLength / PAGE_CHARS)) });
    if ((await usageSum(db, budget, "pages", 1)) > exportPagesPerUserPerDay()) {
      throw new FilesUserError(429, "Dnes jste si stáhli už tolik textu, kolik se vejde do celé knihovny. Další stažení půjde zítra.");
    }
    await audit(db, {
      libraryId: row.library_id,
      actor: userId,
      action: "document.export",
      docId: row.id,
      detail: { chars: doc.textLength, byAdmin: row.uploaded_by !== userId },
    });
    const text = await loadText(db, row.id, row.library_id, 0, Math.min(doc.textLength, batch));
    return { row, total: doc.textLength, text };
  });

  const { row, total } = first;
  const encoder = new TextEncoder();
  let at = Math.min(first.text.end, total);
  if (first.text.start !== 0 || at <= 0) throw new Error("stored text does not start at offset 0");
  const head = exportHeader(row, lib.name, opts.now ?? new Date()) + first.text.slice(0, at);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(head));
      if (at >= total) controller.close();
    },
    async pull(controller) {
      try {
        const src = await withScope(scope.libraryIds, (db) => loadText(db, row.id, row.library_id, at, Math.min(total, at + batch)));
        if (src.start > at || src.end <= at) throw new Error("stored text changed during the export");
        const end = Math.min(src.end, total);
        controller.enqueue(encoder.encode(src.slice(at, end)));
        at = end;
        if (at >= total) controller.close();
      } catch (error) {
        logFilesError("document.export.stream", error);
        controller.error(error);
      }
    },
  });
  return { disposition: exportDisposition(row.meta.title || row.file_name.replace(/\.[A-Za-z0-9]{1,5}$/, "")), body };
}

// ---------------------------------------------------------------------------
// POST /api/files/terms

/** Accept the current content rules. Only for a user with a Pro library (anyone else has nothing to upload to). */
export async function acceptTermsFor(userId: string, body: unknown): Promise<void> {
  const parsed = z.strictObject({ accept: z.literal(true), version: z.string().max(40) }).safeParse(body);
  if (!parsed.success) throw new FilesUserError(400, MESSAGES.badRequest);
  if (parsed.data.version !== TERMS_VERSION) throw new FilesUserError(409, "Pravidla se mezitím změnila. Načtěte stránku znovu.");
  const access = await getAccess(userId);
  if (access.libraries.length === 0) throw new FilesUserError(403, MESSAGES.forbidden);
  await withScope([], (db) => acceptTerms(db, userId, TERMS_VERSION));
}
