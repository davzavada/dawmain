import "server-only";
import { auth } from "@clerk/nextjs/server";
import { after } from "next/server";
import { z } from "zod";
import { canDeleteDocument, canEditDocument, getAccess, type Access, type LibraryAccess } from "./access";
import { envOnlyMode, effectiveMode, sameOrigin } from "./guards";
import { LIBRARY_ID_RE, LIMITS, PAGE_CHARS, TERMS_VERSION, UUID_RE, type FilesMode } from "./config";
import { withScope, type Queryable } from "./db/client";
import { confirmDocument, deleteDocument, getDocument, listDocuments, updateDocumentMeta, type DocumentRow } from "./db/documents";
import { documentPreviewText, libraryDocCounts, mergeIdentKeys, metaContext, setDocumentEnabled } from "./db/documents-web";
import { forgetPages, getLibraries, releasePages } from "./db/libraries";
import { loadReadDoc, loadText } from "./db/reading";
import { acceptTerms, audit, bumpUsage, hasAcceptedTerms, usageSum } from "./db/usage";
import { sanitizeLine } from "./dmd/normalize";
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
 * Rights: modifying a document (metadata, the on/off switch) needs a Pro
 * library (canEditDocument); listing, deleting and exporting need only
 * ownership (ownedScope + canDeleteDocument), also after Pro was revoked.
 *
 * Modes: "readonly" keeps list, detail, delete and export working and
 * refuses metadata edits and the on/off toggle; "off" (guards) keeps list,
 * delete (deleting is what frees the space) and export; env
 * "off"/"unconfigured" answers 503 before anything else.
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
    canDelete: canDeleteDocument(lib, row.uploaded_by, userId),
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
 * (right after accepting a team invitation) accepts access at most 2 s old,
 * so the new team shows up at once.
 */
export async function summaryFor(userId: string, opts: { fresh?: boolean } = {}): Promise<SummaryResponse> {
  const env = envOnlyMode();
  if (env === "off" || env === "unconfigured") return { state: "unavailable", mode: env };
  const access = await getAccess(userId, { joined: opts.fresh === true });
  const pro = access.libraries.map((l) => l.id);
  // Team sizes come from Clerk, the counts from the database: ask both at once.
  const members = new Map(
    access.all.filter((lib) => lib.kind === "org" && lib.pro).map((lib) => [lib.id, memberCount(lib.id)]),
  );
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
      pagesUsed: lib.pro && loadedCounts ? (pages[lib.id] ?? 0) : null,
      counts: lib.pro && loadedCounts ? (counts[lib.id] ?? null) : null,
      memberCount: (await members.get(lib.id)) ?? null,
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

/** Edits of a document in a library without Pro (listing, deleting and exporting stay). */
const NO_PRO_EDIT = "Upravovat dokumenty lze jen v knihovně s Pro. Dokument můžete dál smazat nebo si stáhnout jeho text.";

/** Changes to these fields change how the text is indexed — re-derive after saving. */
function indexInputsChanged(before: BibMeta, after: BibMeta): boolean {
  return before.doc_type !== after.doc_type || (before.commented_act ?? null) !== (after.commented_act ?? null);
}

/**
 * PATCH: confirm or save the metadata (optimistic `version` = meta_version
 * the form was loaded with), or switch the document on/off. Edit rights:
 * canEditDocument (a Pro library, and the uploader or owner/admin) — a
 * library that lost Pro is only listed, deleted and exported. Refused
 * while the feature is read-only or off.
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
    // Only someone who could still delete it hears about Pro; anyone else about ownership.
    if (!lib.pro && canDeleteDocument(lib, row.uploaded_by, userId)) throw new FilesUserError(403, NO_PRO_EDIT);
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
    if (!canDeleteDocument(lib, row.uploaded_by, userId)) throw new FilesUserError(403, "Tento dokument může smazat jen ten, kdo ho nahrál, nebo správce.");
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
 * export per UTC day, over all documents: one largest library's quota —
 * a whole library fits in a day, a second copy of it waits for the next.
 * Counted in `pages` under `read:<user>:export` (same retention and
 * erasure as above; never a document id, so no clash with the per-document
 * counters).
 */
export function exportPagesPerUserPerDay(): number {
  return Math.max(LIMITS.personalPages, LIMITS.teamPages);
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
  const lines = ["---", `title: ${q(row.meta.title || row.file_name)}`];
  if (row.meta.subtitle) lines.push(`subtitle: ${q(row.meta.subtitle)}`);
  const authors = (row.meta.authors ?? []).filter((a) => typeof a === "string" && a.trim() !== "");
  if (authors.length > 0) lines.push(`authors: [${authors.map((a) => q(a, 200)).join(", ")}]`);
  if (typeof row.meta.year === "number" && Number.isInteger(row.meta.year)) lines.push(`year: ${row.meta.year}`);
  lines.push(`doc_type: ${q(row.meta.doc_type ?? "jine", 40)}`, `source_file: ${q(row.file_name, 200)}`, `library: ${q(libraryName, 120)}`);
  const uploaded = date(row.uploaded_at);
  if (uploaded) lines.push(`uploaded: ${uploaded}`);
  lines.push(`exported: ${exportedAt.toISOString().slice(0, 10)}`, `format: "DMD (Dawmain Markdown)"`, "---", "", "");
  return lines.join("\n");
}

/**
 * The stored text of one document as a download, for GDPR portability and
 * for a library that lost Pro (the 90 days before its purge). Ownership
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
      throw new FilesUserError(403, "Text tohoto dokumentu si může stáhnout jen ten, kdo ho nahrál, nebo správce.");
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
