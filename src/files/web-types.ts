/**
 * JSON shapes of the Vlastní zdroje web API (GET /api/files/summary,
 * /api/files/documents, /api/files/documents/[id], /api/files/team) —
 * produced on the server (src/files/web.ts), read by the client components
 * in app/_zdroje. Types only: safe to import from client code.
 */

import type { FilesMode } from "./config";
import type { BibMeta, ConversionQuality, DocStatus, DocType, FileKind, PageLabelSource, ProposedMeta, Rights } from "./types";

/** Per-library document counts. */
export interface LibraryDocCounts {
  total: number;
  ready: number;
  review: number;
  /** queued + processing */
  processing: number;
  error: number;
  /** Ready AND switched on — what the assistant actually searches. */
  searchable: number;
}

/** One library as the modal, the home page and the nav see it. */
export interface LibrarySummary {
  id: string;
  kind: "user" | "org";
  name: string;
  role: "owner" | "org:admin" | "org:member";
  pro: boolean;
  canUpload: boolean;
  canManageAll: boolean;
  quotaPages: number;
  /** Stored + reserved (in flight) pages; null when not loaded (library without Pro). */
  pagesUsed: number | null;
  /** Null when not loaded (library without Pro — its list loads when opened). */
  counts: LibraryDocCounts | null;
  /** Team size (Clerk), null for a personal library or when unknown. */
  memberCount: number | null;
}

export type SummaryResponse =
  | { state: "signed_out" }
  /** The feature is off on this deployment (env), or the database is not configured. */
  | { state: "unavailable"; mode: FilesMode }
  | {
      state: "ok";
      /** Effective mode: "on", "readonly" (search, read, delete — no uploads) or "off". */
      mode: FilesMode;
      termsAccepted: boolean;
      /** Personal library first, then teams (Pro or not). */
      libraries: LibrarySummary[];
    };

/** One row of the modal's document list. */
export interface DocumentListItem {
  id: string;
  libraryId: string;
  /** Confirmed (or provisional) title; the file name until ingest wrote one. */
  title: string;
  fileName: string;
  fileKind: FileKind;
  fileBytes: number | null;
  status: DocStatus;
  statusDetail: string | null;
  uploadedAt: string;
  /** Team libraries: the uploader's display name (null in a personal library or when unknown). */
  uploaderName: string | null;
  mine: boolean;
  enabled: boolean;
  /** May edit metadata, toggle and delete (uploader with upload rights, or owner/admin). */
  canEdit: boolean;
  docType: DocType;
  billablePages: number;
  /** Conversion flags worth a badge: footnotes unsure, OCR/plain, lost numbering, instruction-like text. */
  flags: string[];
}

export interface DocumentListResponse {
  libraryId: string;
  documents: DocumentListItem[];
  total: number;
}

/** The detail / review panel. */
export interface DocumentDetail extends DocumentListItem {
  libraryName: string;
  meta: BibMeta;
  proposed: ProposedMeta | null;
  metaVersion: number;
  confirmedAt: string | null;
  physicalPages: number | null;
  charCount: number;
  pageLabelSource: PageLabelSource;
  converter: string;
  rights: Rights;
  quality: ConversionQuality;
  /** The first ~1,500 characters as plain text (render as text, never as HTML). */
  preview: string;
}

export interface TeamMemberView {
  userId: string;
  name: string;
  email: string;
  admin: boolean;
  since: number;
  self: boolean;
}

export interface TeamView {
  orgId: string;
  name: string;
  members: TeamMemberView[];
  invitations: Array<{ id: string; email: string; state: "pending" | "declined"; sentAt: number }>;
}

/** Every error body: a fixed Czech message; 409 on upload also names the duplicate. */
export interface ErrorBody {
  error: string;
  duplicate?: { id: string; title: string | null };
  /** 422 from the metadata form: field → Czech message. */
  fields?: Record<string, string>;
}
