-- Operations: re-derivation budget, live database size, retention,
-- notice-and-takedown across libraries and the nightly counter recount.
-- Same rules as 0002: SECURITY DEFINER functions run as the owner (bypass
-- RLS), return ids and counters only — never document content — and have
-- EXECUTE for dawmain_app alone.

-- Re-derivations started per day by metadata saves that change the
-- document type or the commented act (the budget of src/files/reindex.ts).
ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS reindexes integer NOT NULL DEFAULT 0;

-- A re-derivation was asked for and has not run yet: set by a metadata save
-- (a save while one is pending coalesces into it), kept when the library's
-- daily budget defers it, cleared by the run. The daily cron re-derives
-- whatever is still marked, so the index never stays out of step with the
-- saved type or act.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS reindex_requested_at timestamptz;
CREATE INDEX IF NOT EXISTS documents_reindex_requested ON documents (reindex_requested_at)
  WHERE reindex_requested_at IS NOT NULL;

-- Deferred or orphaned re-derivation requests older than p_age, oldest first (cron).
CREATE OR REPLACE FUNCTION files_reindex_requests(p_age interval, p_limit integer)
  RETURNS TABLE (id uuid, library_id text)
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT id, library_id FROM documents
   WHERE reindex_requested_at IS NOT NULL AND reindex_requested_at < now() - p_age
     AND status IN ('review','ready')
   ORDER BY reindex_requested_at
   LIMIT least(greatest(p_limit, 1), 200)
$$;

-- Database size for the guards: the physical size (what the files take)
-- and an estimate of the live data. A delete leaves free space inside the
-- relation files that new rows reuse but pg_database_size never gives back
-- (only VACUUM FULL does), so a guard on the physical size alone would stay
-- tripped for good. Per table of the schema, from the catalog only (no
-- scan; pg_class/pg_statistic survive a compute restart, unlike pg_stat_*):
--   heap   reltuples × estimated row width (pg_stats) against relpages;
--   TOAST  reltuples chunks at four per page;
--   indexes scaled like their heap.
-- A relation never vacuumed or analyzed counts in full, so the estimate
-- errs towards the physical size.
-- files_table_usage() gives the figures per table (the operator page plans
-- VACUUM FULL from them: a table's rewrite needs about its live size free);
-- files_db_usage() subtracts their free space from pg_database_size.
CREATE OR REPLACE FUNCTION files_table_usage()
  RETURNS TABLE (table_name text, total_bytes bigint, live_bytes bigint)
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, public
AS $$
  WITH t AS (
    SELECT c.oid, c.relname, c.relpages, c.reltuples, c.reltoastrelid,
           (SELECT sum(s.avg_width) FROM pg_stats s WHERE s.schemaname = n.nspname AND s.tablename = c.relname) AS width
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
  ), f AS (
    SELECT t.oid, t.relname, t.reltoastrelid,
           CASE WHEN t.relpages <= 0 OR t.reltuples < 0 OR t.width IS NULL THEN 1.0
                ELSE least(1.0, ceil(t.reltuples / greatest(1.0, floor(8168.0 / (ceil((24 + t.width) / 8.0) * 8 + 4)))) / t.relpages)
           END AS heap_live,
           CASE WHEN t.reltoastrelid = 0 THEN 1.0
                WHEN tc.relpages <= 0 OR tc.reltuples < 0 THEN 1.0
                ELSE least(1.0, ceil(tc.reltuples / 4.0) / tc.relpages)
           END AS toast_live
      FROM t LEFT JOIN pg_class tc ON tc.oid = t.reltoastrelid
  ), s AS (
    SELECT f.relname::text AS table_name,
           pg_total_relation_size(f.oid) AS total_bytes,
           (pg_relation_size(f.oid) + pg_indexes_size(f.oid)) * (1 - f.heap_live)
             + CASE WHEN f.reltoastrelid = 0 THEN 0 ELSE pg_total_relation_size(f.reltoastrelid) * (1 - f.toast_live) END AS free_bytes
      FROM f
  )
  SELECT table_name, total_bytes, greatest(0, total_bytes - free_bytes)::bigint FROM s ORDER BY table_name
$$;

CREATE OR REPLACE FUNCTION files_db_usage()
  RETURNS TABLE (db_bytes bigint, live_bytes bigint)
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT pg_database_size(current_database()),
         greatest(0, pg_database_size(current_database())
                     - (SELECT coalesce(sum(total_bytes - live_bytes), 0) FROM files_table_usage()))::bigint
$$;

-- Retention (/soukromi: "záznamy o tom, kdo co v knihovně nahrál, potvrdil
-- nebo smazal - dokud knihovna trvá"): the audit rows of purged libraries
-- go, except the purge record itself. The app role has no DELETE on
-- audit_log, so the log cannot be rewritten by anything else.
CREATE OR REPLACE FUNCTION files_forget_purged_audit()
  RETURNS bigint
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  WITH gone AS (
    DELETE FROM audit_log a USING libraries l
     WHERE a.library_id = l.id AND l.purged_at IS NOT NULL AND a.action <> 'library.purged'
    RETURNING 1
  )
  SELECT count(*) FROM gone
$$;

-- Notice-and-takedown: every copy of a content hash, in any library (ids only).
CREATE OR REPLACE FUNCTION files_documents_by_hash(p_sha text)
  RETURNS TABLE (id uuid, library_id text)
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT id, library_id FROM documents WHERE content_sha256 = p_sha ORDER BY library_id, id LIMIT 1000
$$;

-- The content hash of one document (the operator has the id from the notice).
CREATE OR REPLACE FUNCTION files_document_hash(p_id uuid)
  RETURNS text
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, public
AS $$ SELECT content_sha256 FROM documents WHERE id = p_id $$;

-- Nightly recount (plan §8 "přepočet počítadel"): page_count and doc_count
-- from the documents holding settled pages (review, ready), pages_reserved
-- from those in flight (queued, processing). The library rows are locked
-- first and the documents counted in the next statement, so an upload,
-- ingest or delete running at the same time either finished before the
-- count or applies its relative change after it. Returns how many
-- libraries had drifted.
CREATE OR REPLACE FUNCTION files_recount_libraries()
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE fixed integer;
BEGIN
  PERFORM 1 FROM libraries WHERE purged_at IS NULL ORDER BY id FOR UPDATE;
  WITH c AS (
    SELECT l.id,
           coalesce(sum(d.billable_pages) FILTER (WHERE d.status IN ('review','ready')), 0)::integer AS pages,
           count(d.id) FILTER (WHERE d.status IN ('review','ready'))::integer AS docs,
           coalesce(sum(d.billable_pages) FILTER (WHERE d.status IN ('queued','processing')), 0)::integer AS reserved
      FROM libraries l LEFT JOIN documents d ON d.library_id = l.id
     WHERE l.purged_at IS NULL
     GROUP BY l.id
  )
  UPDATE libraries l SET page_count = c.pages, doc_count = c.docs, pages_reserved = c.reserved
    FROM c
   WHERE l.id = c.id AND (l.page_count, l.doc_count, l.pages_reserved) IS DISTINCT FROM (c.pages, c.docs, c.reserved);
  GET DIAGNOSTICS fixed = ROW_COUNT;
  RETURN fixed;
END $$;

REVOKE ALL ON FUNCTION files_reindex_requests(interval, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION files_table_usage() FROM PUBLIC;
REVOKE ALL ON FUNCTION files_db_usage() FROM PUBLIC;
REVOKE ALL ON FUNCTION files_forget_purged_audit() FROM PUBLIC;
REVOKE ALL ON FUNCTION files_documents_by_hash(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION files_document_hash(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION files_recount_libraries() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION files_reindex_requests(interval, integer) TO dawmain_app;
GRANT EXECUTE ON FUNCTION files_table_usage() TO dawmain_app;
GRANT EXECUTE ON FUNCTION files_db_usage() TO dawmain_app;
GRANT EXECUTE ON FUNCTION files_forget_purged_audit() TO dawmain_app;
GRANT EXECUTE ON FUNCTION files_documents_by_hash(text) TO dawmain_app;
GRANT EXECUTE ON FUNCTION files_document_hash(uuid) TO dawmain_app;
GRANT EXECUTE ON FUNCTION files_recount_libraries() TO dawmain_app;
