import "server-only";
import { stripMarkup } from "../dmd/parse";
import type { DmdSection } from "../dmd/types";
import type { Queryable } from "./client";
import { capString, iso, num } from "./codec";
import { isUuid } from "./documents";
import { loadText } from "./reading";
import type { LibraryDocCounts } from "../web-types";

export type { LibraryDocCounts };

/**
 * Repository functions of the web UI (the Vlastní zdroje modal, the detail
 * form, the operator page and the batch re-derivation) that the ingest and
 * MCP repositories (documents.ts, reading.ts) do not need.
 *
 * Same rules as there: every statement names its library explicitly
 * (`library_id = $n` / `= ANY($n)`) on top of RLS, all SQL is
 * parameterized, and a foreign or malformed id reads as "not found".
 */

const EMPTY_COUNTS: LibraryDocCounts = { total: 0, ready: 0, review: 0, processing: 0, error: 0, searchable: 0 };

/** Document ident keys per row — the same cap documents.ts applies. */
const MAX_IDENT_KEYS = 1_000;
/** Outline headings loaded to rebuild meta_tsv (buildMetaTsv reads levels ≤ 2 up to 3 000 chars). */
const MAX_META_HEADINGS = 500;

/**
 * Switch a document on or off for the assistant ("zapnuto"): search skips a
 * disabled document (search.ts filters `d.enabled`). Any status except
 * 'deleting'. Returns false when the document is not in the library.
 */
export async function setDocumentEnabled(db: Queryable, id: string, libraryId: string, enabled: boolean): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rows } = await db.query(
    `UPDATE documents SET enabled = $3, updated_at = now()
      WHERE id = $1 AND library_id = $2 AND status <> 'deleting'
      RETURNING id`,
    [id, libraryId, enabled === true],
  );
  return rows.length > 0;
}

/** Counts per library (every requested id present, zeros when empty). */
export async function libraryDocCounts(db: Queryable, libraryIds: string[]): Promise<Record<string, LibraryDocCounts>> {
  const out: Record<string, LibraryDocCounts> = {};
  for (const id of libraryIds) out[id] = { ...EMPTY_COUNTS };
  if (libraryIds.length === 0) return out;
  const { rows } = await db.query(
    `SELECT library_id,
            count(*) AS total,
            count(*) FILTER (WHERE status = 'ready') AS ready,
            count(*) FILTER (WHERE status = 'review') AS review,
            count(*) FILTER (WHERE status IN ('queued', 'processing')) AS processing,
            count(*) FILTER (WHERE status = 'error') AS error,
            count(*) FILTER (WHERE status = 'ready' AND enabled) AS searchable
       FROM documents
      WHERE library_id = ANY($1::text[]) AND status <> 'deleting'
      GROUP BY library_id`,
    [libraryIds],
  );
  for (const r of rows) {
    const id = String(r.library_id);
    if (!(id in out)) continue;
    out[id] = {
      total: num(r.total),
      ready: num(r.ready),
      review: num(r.review),
      processing: num(r.processing),
      error: num(r.error),
      searchable: num(r.searchable),
    };
  }
  return out;
}

/**
 * What a metadata save needs besides the form: the document's stored ident
 * keys (text-derived keys live there next to the metadata keys) and its
 * outline headings as DmdSection-shaped rows for buildMetaTsv. Null when
 * the document is not in the library.
 */
export async function metaContext(
  db: Queryable,
  id: string,
  libraryId: string,
): Promise<{ identKeys: string[]; sections: DmdSection[] } | null> {
  if (!isUuid(id)) return null;
  const doc = await db.query<{ ident_keys: string[] | null }>(
    "SELECT ident_keys FROM documents WHERE id = $1 AND library_id = $2 AND status <> 'deleting'",
    [id, libraryId],
  );
  if (doc.rows.length === 0) return null;
  const { rows } = await db.query(
    `SELECT ord, parent_ord, level, kind, key, heading, indexed, char_start, char_end
       FROM doc_sections
      WHERE doc_id = $1 AND library_id = $2 AND level <= 2
      ORDER BY ord LIMIT ${MAX_META_HEADINGS}`,
    [id, libraryId],
  );
  const sections: DmdSection[] = rows.map((r) => ({
    ord: num(r.ord),
    parent: r.parent_ord === null || r.parent_ord === undefined ? null : num(r.parent_ord),
    level: num(r.level),
    kind: String(r.kind) as DmdSection["kind"],
    key: typeof r.key === "string" ? r.key : null,
    keyNum: null,
    heading: String(r.heading ?? ""),
    author: null,
    start: num(r.char_start),
    end: num(r.char_end),
    pageFrom: 0,
    pageTo: 0,
    indexed: r.indexed !== false,
  }));
  const keys = Array.isArray(doc.rows[0].ident_keys) ? doc.rows[0].ident_keys.filter((k) => typeof k === "string") : [];
  return { identKeys: keys, sections };
}

/**
 * Document ident keys after a metadata edit: the keys derived from the
 * text stay, the keys of the previous metadata are replaced by those of the
 * new one (metadata keys first, so the cap never drops them). Pure.
 */
export function mergeIdentKeys(stored: string[], oldMetaKeys: string[], newMetaKeys: string[]): string[] {
  const old = new Set(oldMetaKeys);
  const textKeys = stored.filter((k) => !old.has(k));
  return [...new Set([...newMetaKeys, ...textKeys])].filter((k) => k.length > 0 && k.length <= 200).slice(0, MAX_IDENT_KEYS);
}

/**
 * The beginning of the stored text as plain text (markup stripped) for the
 * detail panel — at most `chars` characters, cut at a word boundary with
 * "…". Empty when no text is stored yet (the document is still processing).
 */
export async function documentPreviewText(db: Queryable, id: string, libraryId: string, chars = 1_500): Promise<string> {
  const want = Math.max(1, Math.min(10_000, Math.floor(chars)));
  // Markup (page markers, [^n], #) is stripped afterwards: load a little more.
  const src = await loadText(db, id, libraryId, 0, want + 500);
  const raw = src.slice(0, want + 500);
  if (!raw) return "";
  return clipText(stripMarkup(raw).text.replace(/\n{3,}/g, "\n\n").trim(), want);
}

/** Cut `s` to ≤ max chars at a word boundary, marking the cut with "…". Pure. */
export function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.search(/\s\S*$/);
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A document the pipeline seems stuck on (operator page) — ids and counters only, no content. */
export interface StuckDocument {
  id: string;
  library_id: string;
  status: string;
  attempts: number;
  updated_at: string;
  status_detail: string | null;
}

/**
 * Documents stuck in the pipeline: queued or processing without progress
 * for `minutes` (default 60), and failed ones from the last 7 days. For the
 * operator page — deliberately without titles or file names.
 */
export async function stuckDocuments(db: Queryable, libraryIds: string[], minutes = 60, limit = 50): Promise<StuckDocument[]> {
  if (libraryIds.length === 0) return [];
  const { rows } = await db.query(
    `SELECT id, library_id, status, attempts, updated_at, status_detail FROM documents
      WHERE library_id = ANY($1::text[])
        AND ((status IN ('queued', 'processing') AND updated_at < now() - make_interval(mins => $2))
          OR (status = 'error' AND updated_at > now() - interval '7 days'))
      ORDER BY updated_at LIMIT $3`,
    [libraryIds, Math.max(1, Math.floor(minutes)), Math.max(1, Math.min(200, Math.floor(limit)))],
  );
  return rows.map((r) => ({
    id: String(r.id),
    library_id: String(r.library_id),
    status: String(r.status),
    attempts: num(r.attempts),
    updated_at: iso(r.updated_at),
    status_detail: typeof r.status_detail === "string" ? capString(r.status_detail, 200) : null,
  }));
}

/** Documents whose stored index was built by an older analyzer (review/ready only), oldest first. */
export async function reindexCandidates(
  db: Queryable,
  libraryIds: string[],
  analyzerVersion: number,
  limit: number,
): Promise<Array<{ id: string; libraryId: string }>> {
  if (libraryIds.length === 0) return [];
  const { rows } = await db.query(
    `SELECT id, library_id FROM documents
      WHERE library_id = ANY($1::text[]) AND status IN ('review', 'ready')
        AND analyzer_version IS DISTINCT FROM $2
      ORDER BY updated_at, id LIMIT $3`,
    [libraryIds, analyzerVersion, Math.max(1, Math.min(1_000, Math.floor(limit)))],
  );
  return rows.map((r) => ({ id: String(r.id), libraryId: String(r.library_id) }));
}

/** Count of documents still on an older analyzer (operator page). */
export async function reindexBacklog(db: Queryable, libraryIds: string[], analyzerVersion: number): Promise<number> {
  if (libraryIds.length === 0) return 0;
  const { rows } = await db.query(
    `SELECT count(*) AS n FROM documents
      WHERE library_id = ANY($1::text[]) AND status IN ('review', 'ready') AND analyzer_version IS DISTINCT FROM $2`,
    [libraryIds, analyzerVersion],
  );
  return num(rows[0]?.n);
}

/**
 * Take a re-derivation lease on a confirmed or reviewable document: inside
 * the caller's transaction the row becomes 'processing' with a fresh run
 * token (what writeDocumentIndex requires); finishReindex restores the
 * previous status before the transaction commits, so no other transaction
 * ever sees the intermediate state. Null when the document is gone, in
 * another state, or leased by a running ingest.
 */
export async function leaseForReindex(
  db: Queryable,
  id: string,
  libraryId: string,
): Promise<{ runToken: string; previous: "review" | "ready"; charCount: number } | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query(
    `UPDATE documents d SET status = 'processing', run_token = gen_random_uuid(),
            lease_until = now() + interval '6 minutes'
       FROM (SELECT id, status FROM documents
              WHERE id = $1 AND library_id = $2 AND status IN ('review', 'ready')
                AND (lease_until IS NULL OR lease_until < now())
              FOR UPDATE) old
      WHERE d.id = old.id AND d.library_id = $2
      RETURNING d.run_token, old.status AS previous, d.char_count`,
    [id, libraryId],
  );
  const r = rows[0];
  if (!r) return null;
  return { runToken: String(r.run_token), previous: r.previous === "ready" ? "ready" : "review", charCount: num(r.char_count) };
}

/** End a re-derivation: back to the previous status with the rebuilt document-level keys. */
export async function finishReindex(
  db: Queryable,
  args: { id: string; libraryId: string; runToken: string; previous: "review" | "ready"; metaTsv: string; identKeys: string[]; sectionRange?: string | null },
): Promise<boolean> {
  if (!isUuid(args.id) || !isUuid(args.runToken)) return false;
  const keys = [...new Set(args.identKeys.filter((k) => typeof k === "string" && k.length > 0 && k.length <= 200))].slice(0, MAX_IDENT_KEYS);
  const { rows } = await db.query(
    `UPDATE documents SET status = $4, run_token = NULL, lease_until = NULL,
            meta_tsv = $5::tsvector, ident_keys = $6::text[],
            section_range = coalesce($7, section_range), updated_at = now()
      WHERE id = $1 AND library_id = $2 AND run_token = $3 AND status = 'processing'
      RETURNING id`,
    [args.id, args.libraryId, args.runToken, args.previous === "ready" ? "ready" : "review", args.metaTsv, keys, args.sectionRange ?? null],
  );
  return rows.length > 0;
}

/**
 * Invitation outcomes the operator of a team sees that Clerk does not keep:
 * which revoked invitations were declined by the invitee (Clerk only knows
 * "revoked"), and which of those the admin removed from the list. Kept in
 * the audit log of the team library (ids only).
 */
export async function invitationMarks(db: Queryable, orgId: string): Promise<{ declined: Set<string>; dismissed: Set<string> }> {
  const { rows } = await db.query<{ action: string; invitation: string | null }>(
    `SELECT action, detail->>'invitation' AS invitation FROM audit_log
      WHERE library_id = $1 AND action IN ('invitation.declined', 'invitation.dismissed')
        AND at > now() - interval '90 days'
      ORDER BY at DESC LIMIT 500`,
    [orgId],
  );
  const declined = new Set<string>();
  const dismissed = new Set<string>();
  for (const r of rows) {
    if (typeof r.invitation !== "string") continue;
    (r.action === "invitation.declined" ? declined : dismissed).add(r.invitation);
  }
  return { declined, dismissed };
}

