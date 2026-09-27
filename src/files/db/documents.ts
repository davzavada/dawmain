import "server-only";
import { UUID_RE } from "../config";
import type { ParsedDoc } from "../dmd/types";
import type { Derived } from "../index/types";
import {
  ANCHOR_LABELS,
  DOC_TYPES,
  TEMPLATE_KINDS,
  type BibMeta,
  type ConversionQuality,
  type DocStatus,
  type DocType,
  type FileKind,
  type PageLabelSource,
  type ProposedMeta,
  type Rights,
  type UploadHints,
  type UploadMeta,
} from "../types";
import type { Queryable } from "./client";
import { bytes, capString, deflateText, iso, isoOrNull, jsonParam, num, numOrNull } from "./codec";

/**
 * Documents: the upload row, the ingest queue (the row IS the queue: a
 * compare-and-set lease with a run token), the derived index tables, and
 * the bibliographic metadata the user confirms.
 *
 * Every statement names its library explicitly (`library_id = $n` or
 * `= ANY($n)`); RLS in the transaction's scope is only the backstop.
 * Foreign or malformed ids read as "not found" — never as an error that
 * would reveal whether the id exists elsewhere.
 *
 * Status flow: queued → processing → review → ready (confirmDocument), or
 * → error (failIngest after the last attempt). Only 'ready' AND enabled
 * documents are searched (src/files/db/search.ts).
 */

export interface DocumentRow {
  id: string;
  library_id: string;
  status: DocStatus;
  status_detail: string | null;
  uploaded_by: string;
  uploaded_at: string;
  updated_at: string;
  file_kind: FileKind;
  file_name: string;
  content_sha256: string;
  converter: string;
  rights: Rights;
  physical_pages: number | null;
  billable_pages: number;
  char_count: number;
  page_label_source: PageLabelSource;
  quality: ConversionQuality;
  hints: UploadHints;
  proposed_meta: ProposedMeta | null;
  meta_version: number;
  confirmed_at: string | null;
  confirmed_by: string | null;
  injection_flag: boolean;
  analyzer_version: number | null;
  /** Bibliographic metadata assembled from the typed columns. Before
   *  confirmation these are the provisional values ingest wrote; a missing
   *  doc_type reads as "jine" and a missing title as the file name. */
  meta: BibMeta;
  // Additions beyond the contract (additive):
  /** Ingest attempts so far (claimForIngest increments). */
  attempts: number;
  /** Document this upload replaces (same library), or null. */
  replaces: string | null;
  /** "zapnuto" — a disabled document is skipped by search. */
  enabled: boolean;
  /** Size of the original file in bytes (display only). */
  file_bytes: number | null;
}

/** Ingest attempts before failIngest gives up for good. */
export const MAX_INGEST_ATTEMPTS = 3;

/** Default lease of one ingest run — longer than the 300 s function limit. */
export const DEFAULT_LEASE_SECONDS = 360;

/** Rows per INSERT statement when writing the index (≤ 300 keeps each statement well under the timeout). */
export const INDEX_BATCH_ROWS = 300;
/** Text blocks are ~4 KB deflated each; fewer per statement keeps a statement's payload small. */
const BLOCK_BATCH_ROWS = 100;

const MAX_STATUS_DETAIL = 500;
const MAX_IDENT_KEYS = 1_000;

const STATUS_SET = new Set<string>(["queued", "processing", "review", "ready", "error", "deleting"]);
const DOC_TYPE_SET = new Set<string>(DOC_TYPES);
const ANCHOR_SET = new Set<string>(ANCHOR_LABELS);
const TEMPLATE_SET = new Set<string>(TEMPLATE_KINDS);
const SECTION_KINDS = new Set(["part", "chapter", "par", "cl", "sub", "front", "toc", "index", "abbrev", "biblio", "annex"]);
const COMMENTED_ACT_RE = /^(zak:[0-9]{1,4}\/[0-9]{4}|eu:[0-9]{5}[A-Z][0-9]{4})$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function isUuid(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/** Typed metadata columns, in the order metaValues() returns them. */
const META_COLUMNS = [
  ["doc_type", "text"],
  ["title", "text"],
  ["subtitle", "text"],
  ["authors", "text[]"],
  ["editors", "text[]"],
  ["edition", "text"],
  ["publisher", "text"],
  ["place", "text"],
  ["year", "smallint"],
  ["series", "text"],
  ["isbn", "text[]"],
  ["issn", "text"],
  ["doi", "text"],
  ["container_title", "text"],
  ["volume", "text"],
  ["issue", "text"],
  ["pages_range", "text"],
  ["commented_act", "text"],
  ["commented_act_name", "text"],
  ["section_range", "text"],
  ["anchor_label", "text"],
  ["template_kind", "text"],
  ["court", "text"],
  ["case_number", "text"],
  ["ecli", "text"],
  ["decided_on", "date"],
  ["keywords", "text[]"],
  ["summary", "text"],
  ["language", "text"],
] as const;

const ROW_COLUMNS = [
  "id",
  "library_id",
  "status",
  "status_detail",
  "uploaded_by",
  "uploaded_at",
  "updated_at",
  "file_kind",
  "file_name",
  "file_bytes",
  "content_sha256",
  "converter",
  "rights",
  "physical_pages",
  "billable_pages",
  "char_count",
  "page_label_source",
  "quality",
  "hints",
  "proposed_meta",
  "meta_version",
  "confirmed_at",
  "confirmed_by",
  "injection_flag",
  "analyzer_version",
  "attempts",
  "replaces",
  "enabled",
];

/**
 * SELECT list producing what mapDocumentRow expects, for table alias `a`
 * (exported for src/files/db/documents-web.ts and reindex).
 */
export function documentColumns(a = "d"): string {
  const meta = META_COLUMNS.map(([c]) => (c === "decided_on" ? `${a}.decided_on::text AS decided_on` : `${a}.${c}`));
  return [...ROW_COLUMNS.map((c) => `${a}.${c}`), ...meta].join(", ");
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function objectOr<T>(v: unknown, fallback: T): T {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : fallback;
}

export function mapDocumentRow(r: Record<string, unknown>): DocumentRow {
  const fileName = String(r.file_name ?? "");
  const docType = strOrNull(r.doc_type);
  const meta: BibMeta = {
    doc_type: docType && DOC_TYPE_SET.has(docType) ? (docType as DocType) : "jine",
    title: strOrNull(r.title) ?? fileName,
    subtitle: strOrNull(r.subtitle),
    authors: strArray(r.authors),
    editors: strArray(r.editors),
    year: numOrNull(r.year),
    edition: strOrNull(r.edition),
    publisher: strOrNull(r.publisher),
    place: strOrNull(r.place),
    series: strOrNull(r.series),
    isbn: strArray(r.isbn),
    issn: strOrNull(r.issn),
    doi: strOrNull(r.doi),
    container_title: strOrNull(r.container_title),
    volume: strOrNull(r.volume),
    issue: strOrNull(r.issue),
    pages_range: strOrNull(r.pages_range),
    commented_act: strOrNull(r.commented_act),
    commented_act_name: strOrNull(r.commented_act_name),
    section_range: strOrNull(r.section_range),
    anchor_label: (strOrNull(r.anchor_label) as BibMeta["anchor_label"]) ?? null,
    template_kind: (strOrNull(r.template_kind) as BibMeta["template_kind"]) ?? null,
    court: strOrNull(r.court),
    case_number: strOrNull(r.case_number),
    ecli: strOrNull(r.ecli),
    decided_on: strOrNull(r.decided_on),
    keywords: strArray(r.keywords),
    summary: strOrNull(r.summary),
    language: strOrNull(r.language) ?? "cs",
  };
  return {
    id: String(r.id),
    library_id: String(r.library_id),
    status: r.status as DocStatus,
    status_detail: strOrNull(r.status_detail),
    uploaded_by: String(r.uploaded_by),
    uploaded_at: iso(r.uploaded_at),
    updated_at: iso(r.updated_at),
    file_kind: r.file_kind as FileKind,
    file_name: fileName,
    content_sha256: String(r.content_sha256),
    converter: String(r.converter),
    rights: r.rights as Rights,
    physical_pages: numOrNull(r.physical_pages),
    billable_pages: num(r.billable_pages),
    char_count: num(r.char_count),
    page_label_source: r.page_label_source as PageLabelSource,
    quality: objectOr<ConversionQuality>(r.quality, {} as ConversionQuality),
    hints: objectOr<UploadHints>(r.hints, {}),
    proposed_meta: objectOr<ProposedMeta | null>(r.proposed_meta, null),
    meta_version: num(r.meta_version),
    confirmed_at: isoOrNull(r.confirmed_at),
    confirmed_by: strOrNull(r.confirmed_by),
    injection_flag: r.injection_flag === true,
    analyzer_version: numOrNull(r.analyzer_version),
    meta,
    attempts: num(r.attempts),
    replaces: strOrNull(r.replaces),
    enabled: r.enabled !== false,
    file_bytes: numOrNull(r.file_bytes),
  };
}

// ---------------------------------------------------------------------------
// Metadata columns
// ---------------------------------------------------------------------------

function cleanStr(v: unknown, max = 2_000): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? capString(s, max) : null;
}

function cleanArr(v: unknown, maxItems = 50, maxLen = 300): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const s = cleanStr(x, maxLen);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function inSet(v: unknown, set: Set<string>): string | null {
  return typeof v === "string" && set.has(v) ? v : null;
}

/**
 * BibMeta → values for META_COLUMNS. Validation belongs to bibMetaSchema;
 * this only guarantees the row satisfies the table's CHECK constraints, so a
 * slightly off proposal can never fail an ingest: a value that would violate
 * one (year outside 1500–2100, a malformed commented_act or date, an unknown
 * enum) is stored as NULL.
 */
export function metaValues(meta: Partial<BibMeta>): unknown[] {
  const year = typeof meta.year === "number" && Number.isInteger(meta.year) && meta.year >= 1500 && meta.year <= 2100 ? meta.year : null;
  const act = typeof meta.commented_act === "string" && COMMENTED_ACT_RE.test(meta.commented_act) ? meta.commented_act : null;
  const decided =
    typeof meta.decided_on === "string" && ISO_DATE_RE.test(meta.decided_on) && !Number.isNaN(Date.parse(meta.decided_on))
      ? meta.decided_on
      : null;
  const values: Record<(typeof META_COLUMNS)[number][0], unknown> = {
    doc_type: inSet(meta.doc_type, DOC_TYPE_SET),
    title: cleanStr(meta.title, 500),
    subtitle: cleanStr(meta.subtitle),
    authors: cleanArr(meta.authors),
    editors: cleanArr(meta.editors),
    edition: cleanStr(meta.edition),
    publisher: cleanStr(meta.publisher),
    place: cleanStr(meta.place),
    year,
    series: cleanStr(meta.series),
    isbn: cleanArr(meta.isbn),
    issn: cleanStr(meta.issn),
    doi: cleanStr(meta.doi),
    container_title: cleanStr(meta.container_title),
    volume: cleanStr(meta.volume),
    issue: cleanStr(meta.issue),
    pages_range: cleanStr(meta.pages_range),
    commented_act: act,
    commented_act_name: cleanStr(meta.commented_act_name),
    section_range: cleanStr(meta.section_range),
    anchor_label: inSet(meta.anchor_label, ANCHOR_SET),
    template_kind: inSet(meta.template_kind, TEMPLATE_SET),
    court: cleanStr(meta.court),
    case_number: cleanStr(meta.case_number),
    ecli: cleanStr(meta.ecli),
    decided_on: decided,
    keywords: cleanArr(meta.keywords),
    summary: cleanStr(meta.summary, 4_000),
    language: cleanStr(meta.language, 12) ?? "cs",
  };
  return META_COLUMNS.map(([c]) => values[c]);
}

/**
 * "col = $n::type, …" for the typed metadata columns, parameters starting at
 * `first`. section_range keeps the stored value when the new one is null:
 * it is derived from the sections at ingest, and a form that does not send
 * it back must not erase it.
 */
function metaAssignments(first: number): string {
  return META_COLUMNS.map(([c, type], i) => {
    const p = `$${first + i}::${type}`;
    return c === "section_range" ? `${c} = coalesce(${p}, ${c})` : `${c} = ${p}`;
  }).join(", ");
}

function cleanKeys(keys: string[]): string[] {
  return [...new Set(keys.filter((k) => typeof k === "string" && k.length > 0 && k.length <= 200))].slice(0, MAX_IDENT_KEYS);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Insert an uploaded document as 'queued' with its gzip text in pending_gz.
 * Dedupe on the server-verified content hash within the library: the same
 * text again returns the existing document instead. `replaces` is kept only
 * when it names a document of the same library. The uploader's
 * doc_type_hint becomes the provisional doc_type and a "user" proposal.
 */
export async function insertUploadedDocument(
  db: Queryable,
  row: {
    libraryId: string;
    uploadedBy: string;
    meta: UploadMeta;
    contentSha256: string;
    charCount: number;
    billablePages: number;
    physicalPages: number | null;
    pendingGz: Uint8Array;
    quality: ConversionQuality;
    hints: UploadHints;
    injectionFlag: boolean;
  },
): Promise<{ id: string } | { duplicate: { id: string; title: string | null } }> {
  const m = row.meta;
  const contentSha = row.contentSha256.toLowerCase();
  const hint = inSet(m.doc_type_hint, DOC_TYPE_SET);
  const proposed: ProposedMeta | null = hint ? { doc_type: { value: hint as DocType, source: "user", confidence: 0.9 } } : null;
  const replaces = isUuid(m.replaces) ? m.replaces : null;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO documents (library_id, status, uploaded_by, file_kind, file_name, file_bytes, file_sha256, content_sha256,
        converter, rights, physical_pages, billable_pages, char_count, page_label_source, quality, hints, pending_gz,
        replaces, injection_flag, doc_type, proposed_meta)
     VALUES ($1, 'queued', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16,
        (SELECT r.id FROM documents r WHERE r.id = $17::uuid AND r.library_id = $1), $18, $19, $20::jsonb)
     ON CONFLICT (library_id, content_sha256) WHERE status <> 'deleting' DO NOTHING
     RETURNING id`,
    [
      row.libraryId,
      row.uploadedBy,
      m.file.kind,
      capString(m.file.name, 255),
      Number.isFinite(m.file.bytes) && m.file.bytes >= 0 ? Math.floor(m.file.bytes) : null,
      m.file.sha256.toLowerCase(),
      contentSha,
      capString(m.converter, 40),
      m.rights,
      row.physicalPages,
      row.billablePages,
      row.charCount,
      m.pages?.label_source ?? "none",
      jsonParam(row.quality),
      jsonParam(row.hints),
      row.pendingGz,
      replaces,
      row.injectionFlag,
      hint,
      proposed ? jsonParam(proposed) : null,
    ],
  );
  if (rows[0]) return { id: String(rows[0].id) };
  const existing = await db.query<{ id: string; title: string | null }>(
    `SELECT id, coalesce(title, file_name) AS title FROM documents
      WHERE library_id = $1 AND content_sha256 = $2 AND status <> 'deleting'`,
    [row.libraryId, contentSha],
  );
  const dup = existing.rows[0];
  if (!dup) throw new Error("document insert conflicted but no duplicate is visible");
  return { duplicate: { id: String(dup.id), title: dup.title ?? null } };
}

// ---------------------------------------------------------------------------
// Ingest queue
// ---------------------------------------------------------------------------

/**
 * Take the ingest lease (compare-and-set): a queued document, or a
 * processing one whose lease expired (a crashed run), becomes 'processing'
 * with a fresh run token, attempts + 1 and lease_until = now() + lease.
 * Returns null when someone else holds the lease, the document is gone or
 * in another state, or it has no pending text. The caller decides whether
 * attempts exceeded MAX_INGEST_ATTEMPTS (row.attempts).
 */
export async function claimForIngest(
  db: Queryable,
  id: string,
  libraryId: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<{ runToken: string; pendingGz: Uint8Array; row: DocumentRow } | null> {
  if (!isUuid(id)) return null;
  const lease = Number.isFinite(leaseSeconds) && leaseSeconds > 0 ? leaseSeconds : DEFAULT_LEASE_SECONDS;
  const { rows } = await db.query(
    `UPDATE documents d SET status = 'processing', run_token = gen_random_uuid(), attempts = d.attempts + 1,
            lease_until = now() + make_interval(secs => $3), updated_at = now()
      WHERE d.id = $1 AND d.library_id = $2 AND d.status IN ('queued', 'processing')
        AND (d.lease_until IS NULL OR d.lease_until < now()) AND d.pending_gz IS NOT NULL
      RETURNING ${documentColumns("d")}, d.run_token, d.pending_gz`,
    [id, libraryId, lease],
  );
  const r = rows[0];
  if (!r) return null;
  return { runToken: String(r.run_token), pendingGz: bytes(r.pending_gz), row: mapDocumentRow(r) };
}

/** Folded page label for doc_pages.label_key (lookup by printed label): lowercase, no diacritics or spaces, "–" → "-". */
export function pageLabelKey(label: string): string {
  return label
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, "");
}

type Column = readonly [name: string, type: string];

/**
 * INSERT rows of one document's child table in batches: one statement per
 * `batchSize` rows, as `INSERT … SELECT $1, $2, v.* FROM (VALUES …) v` so
 * doc_id/library_id travel once. Every value has an explicit cast — the
 * tsvector literal is parsed by Postgres as `$n::tsvector`.
 */
async function insertBatched(
  db: Queryable,
  table: string,
  docId: string,
  libraryId: string,
  columns: readonly Column[],
  rows: unknown[][],
  batchSize = INDEX_BATCH_ROWS,
): Promise<void> {
  const names = columns.map(([n]) => n).join(", ");
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const params: unknown[] = [docId, libraryId];
    const tuples = batch.map((row) => {
      const cells = row.map((value, c) => {
        params.push(value);
        return `$${params.length}::${columns[c][1]}`;
      });
      return `(${cells.join(", ")})`;
    });
    await db.query(
      `INSERT INTO ${table} (doc_id, library_id, ${names}) SELECT $1::uuid, $2::text, v.* FROM (VALUES ${tuples.join(", ")}) AS v(${names})`,
      params,
    );
  }
}

const BLOCK_COLUMNS: Column[] = [
  ["ord", "integer"],
  ["char_start", "integer"],
  ["char_end", "integer"],
  ["body", "bytea"],
];
const PAGE_COLUMNS: Column[] = [
  ["ord", "integer"],
  ["label", "text"],
  ["label_key", "text"],
  ["char_start", "integer"],
  ["char_end", "integer"],
  ["flags", "smallint"],
];
const SECTION_COLUMNS: Column[] = [
  ["ord", "integer"],
  ["parent_ord", "integer"],
  ["level", "smallint"],
  ["kind", "text"],
  ["key", "text"],
  ["key_num", "numeric"],
  ["heading", "text"],
  ["author", "text"],
  ["char_start", "integer"],
  ["char_end", "integer"],
  ["page_from", "integer"],
  ["page_to", "integer"],
  ["indexed", "boolean"],
];
const FOOTNOTE_COLUMNS: Column[] = [
  ["seq", "integer"],
  ["label", "text"],
  ["kind", "text"],
  ["page_ord", "integer"],
  ["ref_at", "integer"],
  ["def_start", "integer"],
  ["def_end", "integer"],
  ["section_ord", "integer"],
  ["anchor", "text"],
];
const CHUNK_COLUMNS: Column[] = [
  ["ord", "integer"],
  ["char_start", "integer"],
  ["char_end", "integer"],
  ["page_from", "integer"],
  ["page_to", "integer"],
  ["section_ord", "integer"],
  ["anchor_from", "text"],
  ["anchor_to", "text"],
  ["tsv", "tsvector"],
  ["ident_keys", "text[]"],
];

/** Physical page ords are 1-based; 0 means "unpaged". */
const pageOrNull = (n: number | null | undefined): number | null => (typeof n === "number" && n > 0 ? n : null);
/** Section indexes are 0-based; -1 means "none". */
const sectionOrNull = (n: number | null | undefined): number | null => (typeof n === "number" && n >= 0 ? n : null);

/** The blocks must tile [0, text.length) exactly — loadText relies on it. */
function assertTiling(blocks: Array<{ ord: number; start: number; end: number }>, length: number): void {
  let at = 0;
  blocks.forEach((b, i) => {
    if (b.ord !== i || b.start !== at || b.end <= b.start || b.end > length) {
      throw new Error(`storage blocks do not tile the text at block ${i}`);
    }
    at = b.end;
  });
  if (at !== length) throw new Error("storage blocks do not cover the whole text");
}

/**
 * Replace the stored text and every derived row of the document — blocks,
 * pages, sections, footnotes, chunks — while this run still holds the lease
 * (run_token matches and status is 'processing'); returns false when the
 * lease was lost. The first statement locks the document row, so a
 * concurrent claim waits for this transaction. Delete + reinsert makes a
 * repeated run idempotent. Also records analyzer_version.
 */
export async function writeDocumentIndex(
  db: Queryable,
  args: {
    id: string;
    libraryId: string;
    runToken: string;
    text: string;
    blocks: Array<{ ord: number; start: number; end: number }>;
    parsed: ParsedDoc;
    derived: Derived;
    analyzerVersion: number;
  },
): Promise<boolean> {
  const { id, libraryId, runToken, text, parsed, derived } = args;
  if (!isUuid(id) || !isUuid(runToken)) return false;
  assertTiling(args.blocks, text.length);

  const held = await db.query(
    `UPDATE documents SET analyzer_version = $4, updated_at = now()
      WHERE id = $1 AND library_id = $2 AND run_token = $3 AND status = 'processing'
      RETURNING id`,
    [id, libraryId, runToken, args.analyzerVersion],
  );
  if (held.rows.length === 0) return false;

  for (const table of ["chunks", "doc_footnotes", "doc_sections", "doc_pages", "doc_blocks"]) {
    await db.query(`DELETE FROM ${table} WHERE doc_id = $1 AND library_id = $2`, [id, libraryId]);
  }

  await insertBatched(
    db,
    "doc_blocks",
    id,
    libraryId,
    BLOCK_COLUMNS,
    args.blocks.map((b) => [b.ord, b.start, b.end, deflateText(text.slice(b.start, b.end))]),
    BLOCK_BATCH_ROWS,
  );
  await insertBatched(
    db,
    "doc_pages",
    id,
    libraryId,
    PAGE_COLUMNS,
    parsed.pages.map((p) => [p.ord, p.label, pageLabelKey(p.label), p.start, p.end, p.flags]),
  );
  await insertBatched(
    db,
    "doc_sections",
    id,
    libraryId,
    SECTION_COLUMNS,
    parsed.sections.map((s, i) => [
      i,
      sectionOrNull(s.parent),
      Math.min(6, Math.max(1, s.level)),
      SECTION_KINDS.has(s.kind) ? s.kind : "sub",
      s.key,
      s.keyNum,
      s.heading,
      s.author,
      s.start,
      s.end,
      pageOrNull(s.pageFrom),
      pageOrNull(s.pageTo),
      s.indexed,
    ]),
  );
  await insertBatched(
    db,
    "doc_footnotes",
    id,
    libraryId,
    FOOTNOTE_COLUMNS,
    parsed.footnotes.map((f) => [
      f.seq,
      f.label,
      f.kind === "e" ? "e" : "f",
      pageOrNull(f.page),
      f.refAt,
      f.defStart,
      f.defEnd,
      sectionOrNull(f.section),
      f.anchor,
    ]),
  );
  await insertBatched(
    db,
    "chunks",
    id,
    libraryId,
    CHUNK_COLUMNS,
    derived.chunks.map((c) => [
      c.ord,
      c.start,
      c.end,
      pageOrNull(c.pageFrom),
      pageOrNull(c.pageTo),
      sectionOrNull(c.section),
      c.anchorFrom,
      c.anchorTo,
      c.tsv,
      cleanKeys(c.identKeys),
    ]),
  );
  return true;
}

/**
 * End a successful ingest (lease still held): store the proposals, the
 * provisional (or, for 'ready', the confirmed) metadata, meta_tsv and the
 * document ident keys; set the status; drop pending_gz; release the lease.
 * meta_version is bumped so a stale review form conflicts. Returns false
 * when the lease was lost.
 */
export async function finishIngest(
  db: Queryable,
  args: {
    id: string;
    libraryId: string;
    runToken: string;
    proposed: ProposedMeta;
    meta: BibMeta;
    metaTsv: string;
    identKeys: string[];
    status: "review" | "ready";
    statusDetail: string | null;
  },
): Promise<boolean> {
  if (!isUuid(args.id) || !isUuid(args.runToken)) return false;
  const status = args.status === "ready" ? "ready" : "review";
  const { rows } = await db.query(
    `UPDATE documents SET ${metaAssignments(9)},
            proposed_meta = $4::jsonb, meta_tsv = $5::tsvector, ident_keys = $6::text[], status = $7,
            status_detail = $8, pending_gz = NULL, lease_until = NULL, run_token = NULL,
            meta_version = meta_version + 1, updated_at = now(),
            confirmed_at = CASE WHEN $7 = 'ready' THEN now() END,
            confirmed_by = CASE WHEN $7 = 'ready' THEN uploaded_by END
      WHERE id = $1 AND library_id = $2 AND run_token = $3 AND status = 'processing'
      RETURNING id`,
    [
      args.id,
      args.libraryId,
      args.runToken,
      jsonParam(args.proposed),
      args.metaTsv,
      cleanKeys(args.identKeys),
      status,
      args.statusDetail === null ? null : capString(args.statusDetail, MAX_STATUS_DETAIL),
      ...metaValues(args.meta),
    ],
  );
  return rows.length > 0;
}

/**
 * Record a failed ingest run. With a run token, only while that run still
 * holds the lease; with null (the run never got one), whenever the document
 * is still queued/processing. Retryable failures go back to 'queued' until
 * MAX_INGEST_ATTEMPTS, then (and for non-retryable ones) 'error'. The
 * pending text is kept (the cron clears it) so an operator can requeue.
 * Returns the resulting status, or null when nothing was updated (additive
 * over the contract's void).
 */
export async function failIngest(
  db: Queryable,
  id: string,
  libraryId: string,
  runToken: string | null,
  detail: string,
  retryable: boolean,
): Promise<"queued" | "error" | null> {
  if (!isUuid(id) || (runToken !== null && !isUuid(runToken))) return null;
  const { rows } = await db.query<{ status: "queued" | "error" }>(
    `UPDATE documents SET status = CASE WHEN $5 AND attempts < $6 THEN 'queued' ELSE 'error' END,
            status_detail = $4, lease_until = NULL, run_token = NULL, updated_at = now()
      WHERE id = $1 AND library_id = $2 AND status IN ('queued', 'processing')
        AND ($3::uuid IS NULL OR run_token = $3::uuid)
      RETURNING status`,
    [id, libraryId, runToken, capString(detail, MAX_STATUS_DETAIL), retryable, MAX_INGEST_ATTEMPTS],
  );
  return rows[0]?.status ?? null;
}

// ---------------------------------------------------------------------------
// Metadata edits (optimistic concurrency on meta_version)
// ---------------------------------------------------------------------------

export interface MetaEdit {
  id: string;
  libraryId: string;
  meta: BibMeta;
  /** meta_version the form was loaded with. */
  expectedVersion: number;
  userId: string;
  metaTsv: string;
  identKeys: string[];
}

async function saveMeta(db: Queryable, args: MetaEdit, confirm: boolean): Promise<"ok" | "conflict" | "not_found"> {
  if (!isUuid(args.id)) return "not_found";
  if (Number.isInteger(args.expectedVersion) && (await tryUpdateMeta(db, args, confirm))) return "ok";
  const current = await db.query("SELECT status FROM documents WHERE id = $1 AND library_id = $2 AND status <> 'deleting'", [
    args.id,
    args.libraryId,
  ]);
  // Exists but the version moved on, or it is not (yet) in a reviewable state.
  return current.rows.length > 0 ? "conflict" : "not_found";
}

async function tryUpdateMeta(db: Queryable, args: MetaEdit, confirm: boolean): Promise<boolean> {
  const params: unknown[] = [args.id, args.libraryId, args.expectedVersion, args.metaTsv, cleanKeys(args.identKeys)];
  const assignments = metaAssignments(params.length + 1);
  params.push(...metaValues(args.meta));
  let confirmSet = "";
  if (confirm) {
    params.push(args.userId);
    confirmSet = `, status = 'ready', status_detail = NULL, confirmed_at = now(), confirmed_by = $${params.length}`;
  }
  const { rows } = await db.query(
    `UPDATE documents SET ${assignments}, meta_tsv = $4::tsvector, ident_keys = $5::text[],
            meta_version = meta_version + 1, updated_at = now()${confirmSet}
      WHERE id = $1 AND library_id = $2 AND meta_version = $3 AND status IN ('review', 'ready')
      RETURNING id`,
    params,
  );
  return rows.length > 0;
}

/**
 * Confirm the metadata: status → 'ready' (searchable), confirmed_at/by,
 * meta_version + 1. Only from 'review' or 'ready'; a document that is still
 * being processed, or failed, answers "conflict".
 */
export async function confirmDocument(db: Queryable, args: MetaEdit): Promise<"ok" | "conflict" | "not_found"> {
  return saveMeta(db, args, true);
}

/** Save metadata without changing the status (same rules as confirmDocument). */
export async function updateDocumentMeta(db: Queryable, args: MetaEdit): Promise<"ok" | "conflict" | "not_found"> {
  return saveMeta(db, args, false);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getDocument(db: Queryable, id: string, libraryIds: string[]): Promise<DocumentRow | null> {
  if (!isUuid(id) || libraryIds.length === 0) return null;
  const { rows } = await db.query(
    `SELECT ${documentColumns("d")} FROM documents d
      WHERE d.id = $1 AND d.library_id = ANY($2::text[]) AND d.status <> 'deleting'`,
    [id, libraryIds],
  );
  return rows[0] ? mapDocumentRow(rows[0]) : null;
}

/** Czech/Slovak/German letters folded for the list filter — the same map on both sides. */
const FOLD_FROM = "áäčďéěëíĺľňóôöŕřšťúůüýžÁÄČĎÉĚËÍĹĽŇÓÔÖŔŘŠŤÚŮÜÝŽ";
const FOLD_TO = "aacdeeeillnooorrstuuuyzAACDEEEILLNOOORRSTUUUYZ";
const FOLD_MAP = new Map([...FOLD_FROM].map((ch, i) => [ch, FOLD_TO[i]]));

/** Fold like the SQL side of listDocuments' filter: translate(…) then lower(). */
export function foldForFilter(s: string): string {
  return [...s].map((ch) => FOLD_MAP.get(ch) ?? ch).join("").toLowerCase();
}

/** `%…%` LIKE pattern with \ % _ escaped (used with ESCAPE '\'). */
export function likeContains(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const SORTS = {
  added: "d.uploaded_at DESC, d.id",
  title: "lower(coalesce(d.title, d.file_name)), d.id",
  year: "d.year DESC NULLS LAST, lower(coalesce(d.title, d.file_name)), d.id",
} as const;

/**
 * One page of documents with the total. `q` matches (folded, substring)
 * title, subtitle, file name, authors and editors. limit 1–200.
 */
export async function listDocuments(
  db: Queryable,
  args: {
    libraryIds: string[];
    status?: DocStatus[];
    docType?: DocType[];
    q?: string;
    limit: number;
    offset: number;
    sort?: "added" | "title" | "year";
  },
): Promise<{ rows: DocumentRow[]; total: number }> {
  if (args.libraryIds.length === 0) return { rows: [], total: 0 };
  const params: unknown[] = [args.libraryIds];
  const where = ["d.library_id = ANY($1::text[])", "d.status <> 'deleting'"];
  const statuses = (args.status ?? []).filter((s) => STATUS_SET.has(s));
  if (args.status && args.status.length > 0) {
    params.push(statuses);
    where.push(`d.status = ANY($${params.length}::text[])`);
  }
  const types = (args.docType ?? []).filter((t) => DOC_TYPE_SET.has(t));
  if (args.docType && args.docType.length > 0) {
    params.push(types);
    where.push(`d.doc_type = ANY($${params.length}::text[])`);
  }
  const q = foldForFilter(capString((args.q ?? "").trim(), 200));
  if (q) {
    params.push(likeContains(q));
    where.push(
      `lower(translate(concat_ws(' ', d.title, d.subtitle, d.file_name, array_to_string(d.authors, ' '), array_to_string(d.editors, ' ')),
         '${FOLD_FROM}', '${FOLD_TO}')) LIKE $${params.length} ESCAPE '\\'`,
    );
  }
  const whereSql = where.join(" AND ");
  const limit = Math.min(200, Math.max(1, Math.floor(args.limit) || 1));
  const offset = Math.max(0, Math.floor(args.offset) || 0);
  const order = args.sort && Object.hasOwn(SORTS, args.sort) ? SORTS[args.sort] : SORTS.added;
  const total = await db.query(`SELECT count(*) AS n FROM documents d WHERE ${whereSql}`, params);
  const { rows } = await db.query(
    `SELECT ${documentColumns("d")} FROM documents d WHERE ${whereSql}
      ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { rows: rows.map(mapDocumentRow), total: num(total.rows[0]?.n) };
}

/** Status of the given documents (polling). Unknown, foreign and malformed ids are simply absent. */
export async function documentStatuses(
  db: Queryable,
  libraryIds: string[],
  ids: string[],
): Promise<Array<{ id: string; status: DocStatus; status_detail: string | null; updated_at: string }>> {
  const valid = [...new Set(ids.filter(isUuid).map((s) => s.toLowerCase()))].slice(0, 200);
  if (valid.length === 0 || libraryIds.length === 0) return [];
  const { rows } = await db.query(
    `SELECT id, status, status_detail, updated_at FROM documents
      WHERE library_id = ANY($1::text[]) AND id = ANY($2::uuid[]) AND status <> 'deleting'
      ORDER BY uploaded_at, id`,
    [libraryIds, valid],
  );
  return rows.map((r) => ({
    id: String(r.id),
    status: r.status as DocStatus,
    status_detail: strOrNull(r.status_detail),
    updated_at: iso(r.updated_at),
  }));
}

/**
 * Delete the document and everything derived from it (FK cascade). Returns
 * its billable pages and the status it had (additive: 'review'/'ready' hold
 * settled pages → forgetPages; 'queued'/'processing' hold a reservation →
 * releasePages; 'error' holds neither), or null when not found.
 */
export async function deleteDocument(
  db: Queryable,
  id: string,
  libraryId: string,
): Promise<{ billablePages: number; status: DocStatus } | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query(
    "DELETE FROM documents WHERE id = $1 AND library_id = $2 RETURNING billable_pages, status",
    [id, libraryId],
  );
  const r = rows[0];
  return r ? { billablePages: num(r.billable_pages), status: r.status as DocStatus } : null;
}

/** Per library: documents awaiting review, being processed (queued + processing) and ready. */
export async function pendingCounts(
  db: Queryable,
  libraryIds: string[],
): Promise<Record<string, { review: number; processing: number; ready: number }>> {
  const out: Record<string, { review: number; processing: number; ready: number }> = {};
  for (const lib of libraryIds) out[lib] = { review: 0, processing: 0, ready: 0 };
  if (libraryIds.length === 0) return out;
  const { rows } = await db.query(
    `SELECT library_id,
            count(*) FILTER (WHERE status = 'review') AS review,
            count(*) FILTER (WHERE status IN ('queued', 'processing')) AS processing,
            count(*) FILTER (WHERE status = 'ready') AS ready
       FROM documents WHERE library_id = ANY($1::text[]) GROUP BY library_id`,
    [libraryIds],
  );
  for (const r of rows) {
    out[String(r.library_id)] = { review: num(r.review), processing: num(r.processing), ready: num(r.ready) };
  }
  return out;
}

/** Content taken down under notice-and-action may not be uploaded again. */
export async function isBlocked(db: Queryable, contentSha256: string): Promise<boolean> {
  const sha = contentSha256.toLowerCase();
  if (!SHA256_RE.test(sha)) return false;
  const { rows } = await db.query("SELECT 1 FROM blocked_content WHERE content_sha256 = $1", [sha]);
  return rows.length > 0;
}
