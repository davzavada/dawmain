import "server-only";
import { auth } from "@clerk/nextjs/server";
import { after } from "next/server";
import { z } from "zod";
import { canEditDocument, getAccess, type Access, type LibraryAccess } from "./access";
import { envOnlyMode, effectiveMode, sameOrigin } from "./guards";
import { LIBRARY_ID_RE, TERMS_VERSION, UUID_RE, type FilesMode } from "./config";
import { withScope, type Queryable } from "./db/client";
import { confirmDocument, deleteDocument, getDocument, listDocuments, updateDocumentMeta, type DocumentRow } from "./db/documents";
import { documentPreviewText, libraryDocCounts, mergeIdentKeys, metaContext, setDocumentEnabled } from "./db/documents-web";
import { forgetPages, getLibraries, releasePages } from "./db/libraries";
import { acceptTerms, audit, hasAcceptedTerms } from "./db/usage";
import { filesError, filesJson, FilesUserError, logFilesError, MESSAGES } from "./errors";
import { buildMetaTsv, metaIdentKeys } from "./index/derive";
import { bibMetaBaseSchema, bibMetaSchema } from "./meta/schema";
import { reindexDocument } from "./reindex";
import { ownedScope } from "./scope";
import { memberCount, memberNames } from "./team";
import type { BibMeta } from "./types";
import type { DocumentDetail, DocumentListItem, LibrarySummary, SummaryResponse } from "./web-types";

/**
 * The web API of the Vlastní zdroje modal — the logic behind the thin
 * route handlers in app/api/files/{summary,documents,documents/[id],terms}.
 * (Uploads and status polling are src/files/upload.ts and the status route.)
 *
 * Every handler: Clerk session (auth()), Origin check on mutations, access
 * from Clerk (fresh on mutations), a scope derived from that access only,
 * withScope + explicit library filters, fixed Czech messages, no content in
 * logs. A document or library the caller cannot see answers exactly like
 * one that does not exist (404).
 *
 * Modes: "readonly" keeps list, detail and delete working and refuses
 * metadata edits and the on/off toggle; "off" (guards) keeps list and
 * delete (deleting is what frees the space); env "off"/"unconfigured"
 * answers 503 before anything else.
 */

/** Documents one list request returns (the modal shows a library at once). */
const LIST_LIMIT = 200;
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
  if (error instanceof MetaValidationError) return filesJson({ error: error.message, fields: error.fields }, 422);
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
export function listItem(row: DocumentRow, lib: LibraryAccess, userId: string, names: Map<string, string> | null): DocumentListItem {
  return {
    id: row.id,
    libraryId: row.library_id,
    title: row.meta.title || row.file_name,
    fileName: row.file_name,
    fileKind: row.file_kind,
    fileBytes: row.file_bytes,
    status: row.status,
    statusDetail: row.status_detail,
    uploadedAt: row.uploaded_at,
    uploaderName: lib.kind === "org" ? (names?.get(row.uploaded_by) ?? null) : null,
    mine: row.uploaded_by === userId,
    enabled: row.enabled,
    canEdit: canEditDocument(lib, row.uploaded_by, userId),
    docType: row.meta.doc_type,
    billablePages: row.billable_pages,
    flags: documentFlags(row),
  };
}

function detailOf(row: DocumentRow, lib: LibraryAccess, userId: string, names: Map<string, string> | null, preview: string): DocumentDetail {
  return {
    ...listItem(row, lib, userId, names),
    libraryName: lib.name,
    meta: row.meta,
    proposed: row.proposed_meta,
    metaVersion: row.meta_version,
    confirmedAt: row.confirmed_at,
    physicalPages: row.physical_pages,
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
 * Libraries of the signed-in user with document counts, pages and team
 * sizes, the effective mode and whether the content rules were accepted.
 * The database is touched only for a user with at least one Pro library
 * (anyone else — signed out, never Pro — never wakes it); libraries
 * without Pro come without counts (their list loads when opened). `fresh`
 * (after accepting a team invitation) accepts access at most 10 s old.
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
  if (pro.length > 0) {
    mode = await effectiveMode();
    const loaded = await withScope(pro, async (db) => ({
      counts: await libraryDocCounts(db, pro),
      rows: await getLibraries(db, pro),
      terms: await hasAcceptedTerms(db, userId, TERMS_VERSION),
    }));
    counts = loaded.counts;
    pages = Object.fromEntries(loaded.rows.map((r) => [r.id, r.page_count + r.pages_reserved]));
    termsAccepted = loaded.terms;
  }
  const libraries = await Promise.all(
    access.all.map(async (lib): Promise<LibrarySummary> => ({
      id: lib.id,
      kind: lib.kind,
      name: lib.name,
      role: lib.role,
      pro: lib.pro,
      canUpload: lib.canUpload,
      canManageAll: lib.canManageAll,
      quotaPages: lib.quotaPages,
      pagesUsed: lib.pro ? (pages[lib.id] ?? 0) : null,
      counts: lib.pro ? (counts[lib.id] ?? null) : null,
      memberCount: lib.kind === "org" && lib.pro ? await memberCount(lib.id) : null,
    })),
  );
  return { state: "ok", mode, termsAccepted, libraries };
}

// ---------------------------------------------------------------------------
// GET /api/files/documents?lib=

/**
 * The documents of one library the caller owns or belongs to — Pro or not
 * (ownedScope: a user who lost Pro can still see and delete what they
 * stored). Newest first, at most 200.
 */
export async function listFor(userId: string, libraryId: string): Promise<{ libraryId: string; documents: DocumentListItem[]; total: number }> {
  if (!LIBRARY_ID_RE.test(libraryId)) throw new FilesUserError(404, "Knihovna nenalezena.");
  const access = await getAccess(userId);
  const scope = ownedScope(access, libraryId);
  const lib = scope.libraries[0];
  const { rows, total } = await withScope(scope.libraryIds, (db) =>
    listDocuments(db, { libraryIds: [...scope.libraryIds], limit: LIST_LIMIT, offset: 0, sort: "added" }),
  );
  const names = lib.kind === "org" && rows.length > 0 ? await memberNames(lib.id) : null;
  return { libraryId: lib.id, documents: rows.map((r) => listItem(r, lib, userId, names)), total };
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
  const names = lib.kind === "org" ? await memberNames(lib.id) : null;
  return detailOf(row, lib, userId, names, preview);
}

const patchSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("confirm"), version: z.number().int().min(0), meta: z.unknown() }),
  z.strictObject({ action: z.literal("save"), version: z.number().int().min(0), meta: z.unknown() }),
  z.strictObject({ action: z.literal("enable"), enabled: z.boolean() }),
]);

/** Validation errors of the metadata form: field path → Czech message (first per field). */
export class MetaValidationError extends FilesUserError {
  constructor(public readonly fields: Record<string, string>) {
    super(422, Object.values(fields)[0] ?? "Metadata nejsou platná.");
    this.name = "MetaValidationError";
  }
}

/** Parse the form's metadata: "confirm" needs a commentary's act, "save" is a draft. */
export function parseMetaForm(raw: unknown, confirm: boolean): BibMeta {
  const result = (confirm ? bibMetaSchema : bibMetaBaseSchema).safeParse(raw);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "_";
    fields[key] ??= issue.message;
  }
  throw new MetaValidationError(fields);
}

/** Changes to these fields change how the text is indexed — re-derive after saving. */
function indexInputsChanged(before: BibMeta, after: BibMeta): boolean {
  return before.doc_type !== after.doc_type || (before.commented_act ?? null) !== (after.commented_act ?? null);
}

/**
 * PATCH: confirm or save the metadata (optimistic `version` = meta_version
 * the form was loaded with), or switch the document on/off. Edit rights:
 * canEditDocument (the uploader with upload rights, or owner/admin).
 * Refused while the feature is read-only or off.
 */
export async function patchFor(userId: string, id: string, body: unknown): Promise<DocumentDetail> {
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success || !UUID_RE.test(id)) throw new FilesUserError(400, MESSAGES.badRequest);
  const mode = await effectiveMode();
  if (mode === "readonly") throw new FilesUserError(503, MESSAGES.readonly);
  if (mode !== "on") throw new FilesUserError(503, MESSAGES.off);
  const input = parsed.data;
  const meta = input.action === "enable" ? null : parseMetaForm(input.meta, input.action === "confirm");

  const access = await getAccess(userId, { fresh: true });
  const ids = libraryIdsOf(access);
  if (ids.length === 0) throw new FilesUserError(404, "Dokument nenalezen.");
  const changed: { reindex?: { id: string; libraryId: string } } = {};
  await withScope(ids, async (db) => {
    const { row, lib } = await findDocument(db, access, id);
    if (!canEditDocument(lib, row.uploaded_by, userId)) throw new FilesUserError(403, "Tento dokument může upravit jen ten, kdo ho nahrál, nebo správce.");
    if (input.action === "enable") {
      if (!(await setDocumentEnabled(db, row.id, row.library_id, input.enabled))) throw new FilesUserError(404, "Dokument nenalezen.");
      await audit(db, { libraryId: row.library_id, actor: userId, action: input.enabled ? "document.enable" : "document.disable", docId: row.id });
      return;
    }
    const ctx = await metaContext(db, row.id, row.library_id);
    if (!ctx) throw new FilesUserError(404, "Dokument nenalezen.");
    const next = meta as BibMeta;
    const edit = {
      id: row.id,
      libraryId: row.library_id,
      meta: next,
      expectedVersion: input.version,
      userId,
      metaTsv: buildMetaTsv(next, ctx.sections),
      identKeys: mergeIdentKeys(ctx.identKeys, metaIdentKeys(row.meta), metaIdentKeys(next)),
    };
    const outcome = input.action === "confirm" ? await confirmDocument(db, edit) : await updateDocumentMeta(db, edit);
    if (outcome === "not_found") throw new FilesUserError(404, "Dokument nenalezen.");
    if (outcome === "conflict") {
      throw new FilesUserError(
        409,
        row.status === "review" || row.status === "ready"
          ? "Dokument mezitím upravil někdo jiný. Načtěte ho znovu a změny zopakujte."
          : "Dokument se ještě zpracovává — metadata půjde upravit, až bude hotový.",
      );
    }
    await audit(db, { libraryId: row.library_id, actor: userId, action: input.action === "confirm" ? "document.confirm" : "document.meta", docId: row.id });
    if (indexInputsChanged(row.meta, next)) changed.reindex = { id: row.id, libraryId: row.library_id };
  });
  if (changed.reindex) {
    const { id: docId, libraryId } = changed.reindex;
    // The index depends on the type and the commented act; rebuild it after the response.
    after(async () => {
      await reindexDocument(docId, libraryId);
    });
  }
  return detailFor(userId, id);
}

/**
 * DELETE: remove the document and everything derived from it, and give its
 * pages back. Allowed in read-only mode (deleting frees space) and while
 * the guards have the feature off; not when the deployment has it off.
 */
export async function deleteFor(userId: string, id: string): Promise<void> {
  if (!UUID_RE.test(id)) throw new FilesUserError(404, "Dokument nenalezen.");
  const access = await getAccess(userId, { fresh: true });
  const ids = libraryIdsOf(access);
  if (ids.length === 0) throw new FilesUserError(404, "Dokument nenalezen.");
  await withScope(ids, async (db) => {
    const { row, lib } = await findDocument(db, access, id);
    if (!canEditDocument(lib, row.uploaded_by, userId)) throw new FilesUserError(403, "Tento dokument může smazat jen ten, kdo ho nahrál, nebo správce.");
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
