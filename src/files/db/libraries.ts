import "server-only";
import type { Queryable } from "./client";
import { capString, isoOrNull, iso, num } from "./codec";

/**
 * Libraries: one row per Clerk user (personal) or organization (team),
 * holding the page counters the quotas are enforced against. Rows in scope
 * are read and written directly (RLS on `libraries` is keyed on the id);
 * cross-library views go through the SECURITY DEFINER functions of
 * 0002_rls.sql, which return counters and ids only — never content.
 *
 * Page accounting, one document's life:
 *   upload   reservePages(n)            pages_reserved += n   (atomic vs both caps)
 *   ingest   settlePages(n, actual)     pages_reserved −= n, page_count += actual, doc_count + 1
 *   failure  releasePages(n)            pages_reserved −= n
 *   delete   forgetPages(actual)        page_count −= actual, doc_count − 1
 * Every decrement floors at 0 (the CHECK constraints would otherwise turn a
 * double release into a failed transaction).
 */

export interface LibraryRow {
  id: string;
  kind: "user" | "org";
  display_name: string | null;
  settings: Record<string, unknown>;
  page_count: number;
  pages_reserved: number;
  doc_count: number;
  pro_revoked_at: string | null;
  purge_after: string | null;
}

const LIBRARY_COLUMNS =
  "id, kind, display_name, settings, page_count, pages_reserved, doc_count, pro_revoked_at, purge_after";

/** Display names come from Clerk (admin-controlled); keep them bounded. */
const MAX_DISPLAY_NAME = 200;

/** Documents deleted per statement when purging (each cascades to thousands of chunk rows). */
const PURGE_BATCH = 20;

function mapLibrary(r: Record<string, unknown>): LibraryRow {
  const settings = r.settings;
  return {
    id: String(r.id),
    kind: r.kind === "org" ? "org" : "user",
    display_name: (r.display_name as string | null) ?? null,
    settings: settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {},
    page_count: num(r.page_count),
    pages_reserved: num(r.pages_reserved),
    doc_count: num(r.doc_count),
    pro_revoked_at: isoOrNull(r.pro_revoked_at),
    purge_after: isoOrNull(r.purge_after),
  };
}

function wholePages(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`${what} must be a non-negative integer`);
  return n;
}

/** Create the library row on first use; refresh the display name (a null name keeps the stored one). */
export async function ensureLibrary(db: Queryable, id: string, displayName: string | null): Promise<void> {
  const name = displayName === null ? null : capString(displayName, MAX_DISPLAY_NAME);
  await db.query(
    `INSERT INTO libraries (id, display_name) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET display_name = coalesce(EXCLUDED.display_name, libraries.display_name)
      WHERE libraries.display_name IS DISTINCT FROM coalesce(EXCLUDED.display_name, libraries.display_name)`,
    [id, name],
  );
}

/** The given libraries that exist, in id order. */
export async function getLibraries(db: Queryable, ids: string[]): Promise<LibraryRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query(`SELECT ${LIBRARY_COLUMNS} FROM libraries WHERE id = ANY($1::text[]) ORDER BY id`, [ids]);
  return rows.map(mapLibrary);
}

/**
 * Reserve `pages` against the library cap and the global cap in one atomic
 * step (files_reserve_pages: advisory lock + conditional UPDATE). The library
 * must be in the transaction's scope — the function raises otherwise.
 */
export async function reservePages(
  db: Queryable,
  libraryId: string,
  pages: number,
  libraryCap: number,
  globalCap: number,
): Promise<"ok" | "library" | "global"> {
  if (!Number.isInteger(pages) || pages <= 0) throw new RangeError("pages must be a positive integer");
  const { rows } = await db.query<{ r: string }>("SELECT files_reserve_pages($1, $2, $3, $4) AS r", [
    libraryId,
    pages,
    Math.floor(libraryCap),
    Math.floor(globalCap),
  ]);
  const r = rows[0]?.r;
  if (r === "ok" || r === "library" || r === "global") return r;
  throw new Error(`unexpected reservation result: ${String(r)}`);
}

/** Ingest succeeded: the reservation becomes stored pages, and the document is counted. */
export async function settlePages(db: Queryable, libraryId: string, reserved: number, actual: number): Promise<void> {
  await db.query(
    `UPDATE libraries SET pages_reserved = greatest(pages_reserved - $2, 0), page_count = page_count + $3,
            doc_count = doc_count + 1
      WHERE id = $1`,
    [libraryId, wholePages(reserved, "reserved"), wholePages(actual, "actual")],
  );
}

/** Upload or ingest failed: give the reservation back. */
export async function releasePages(db: Queryable, libraryId: string, reserved: number): Promise<void> {
  await db.query("UPDATE libraries SET pages_reserved = greatest(pages_reserved - $2, 0) WHERE id = $1", [
    libraryId,
    wholePages(reserved, "reserved"),
  ]);
}

/** A settled document was deleted. */
export async function forgetPages(db: Queryable, libraryId: string, pages: number): Promise<void> {
  await db.query(
    `UPDATE libraries SET page_count = greatest(page_count - $2, 0), doc_count = greatest(doc_count - 1, 0)
      WHERE id = $1`,
    [libraryId, wholePages(pages, "pages")],
  );
}

/** Totals over every library (files_global_usage — aggregates only). */
export async function globalUsage(
  db: Queryable,
): Promise<{ totalPages: number; reservedPages: number; libraries: number; documents: number; dbBytes: number }> {
  const { rows } = await db.query("SELECT total_pages, reserved_pages, libraries, documents, db_bytes FROM files_global_usage()");
  const r = rows[0] ?? {};
  return {
    totalPages: num(r.total_pages),
    reservedPages: num(r.reserved_pages),
    libraries: num(r.libraries),
    documents: num(r.documents),
    dbBytes: num(r.db_bytes),
  };
}

/**
 * Every live library (files_list_libraries) — for the daily cron and the
 * operator page. The system function exposes counters only, so `settings`
 * is always `{}` here; read a library's settings with getLibraries in its scope.
 */
export async function listAllLibraries(db: Queryable): Promise<Array<LibraryRow & { created_at: string }>> {
  const { rows } = await db.query(
    `SELECT id, kind, display_name, page_count, pages_reserved, doc_count, pro_revoked_at, purge_after, created_at
       FROM files_list_libraries()`,
  );
  return rows.map((r) => ({ ...mapLibrary({ ...r, settings: {} }), created_at: iso(r.created_at) }));
}

/**
 * Soft delete (Clerk user/org deleted, or Pro revoked for too long): the
 * cron purges after `after`. A repeated mark never postpones an earlier date.
 */
export async function markLibraryForPurge(db: Queryable, libraryId: string, after: Date): Promise<void> {
  await db.query(
    `UPDATE libraries SET purge_after = CASE WHEN purge_after IS NULL OR purge_after > $2 THEN $2 ELSE purge_after END
      WHERE id = $1 AND purged_at IS NULL`,
    [libraryId, after],
  );
}

/**
 * Delete every document of the library (children cascade), in small batches
 * so no single statement runs into the statement timeout, then zero the
 * counters, drop the display name (personal data) and set purged_at.
 * Returns the number of documents deleted.
 */
export async function purgeLibraryContent(db: Queryable, libraryId: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const { rows } = await db.query(
      `DELETE FROM documents WHERE library_id = $1
          AND id IN (SELECT id FROM documents WHERE library_id = $1 LIMIT ${PURGE_BATCH})
        RETURNING id`,
      [libraryId],
    );
    deleted += rows.length;
    if (rows.length < PURGE_BATCH) break;
  }
  await db.query(
    `UPDATE libraries SET page_count = 0, pages_reserved = 0, doc_count = 0, display_name = NULL,
            settings = '{}'::jsonb, purged_at = now()
      WHERE id = $1`,
    [libraryId],
  );
  return deleted;
}
