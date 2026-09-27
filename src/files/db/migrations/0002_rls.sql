-- Isolation: the runtime connects as dawmain_app — a role created HERE, by
-- SQL, so on Neon it is NOT a member of neon_superuser and has no
-- BYPASSRLS (roles created in the Console/API are, and would ignore every
-- policy). The operator gives it a password once, outside git:
--   ALTER ROLE dawmain_app WITH LOGIN PASSWORD '…';
-- and points FILES_DATABASE_URL at it (pooled host). Every content table
-- FORCEs row-level security keyed on the transaction-local setting
-- app.library_ids; an unset setting yields NULL, i.e. zero rows (fails closed).
-- RLS guards against a forgotten WHERE, not against SQL injection (the app
-- role sets the variable itself) — all SQL stays parameterized.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dawmain_app') THEN
    CREATE ROLE dawmain_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- The library ids of the current transaction (set by withScope).
CREATE OR REPLACE FUNCTION files_scope() RETURNS text[]
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$ SELECT string_to_array(nullif(current_setting('app.library_ids', true), ''), ',') $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['documents','doc_blocks','doc_pages','doc_sections','doc_footnotes','chunks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS library_scope ON %I', t);
    EXECUTE format(
      'CREATE POLICY library_scope ON %I USING (library_id = ANY (files_scope())) WITH CHECK (library_id = ANY (files_scope()))', t);
  END LOOP;
END $$;

ALTER TABLE libraries ENABLE ROW LEVEL SECURITY;
ALTER TABLE libraries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS library_scope ON libraries;
CREATE POLICY library_scope ON libraries USING (id = ANY (files_scope())) WITH CHECK (id = ANY (files_scope()));

-- A row never moves between libraries (RLS WITH CHECK only stops moves out of scope).
CREATE OR REPLACE FUNCTION files_freeze_library_id() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.library_id IS DISTINCT FROM OLD.library_id THEN
    RAISE EXCEPTION 'library_id is immutable';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['documents','doc_blocks','doc_pages','doc_sections','doc_footnotes','chunks'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS freeze_library_id ON %I', t);
    EXECUTE format('CREATE TRIGGER freeze_library_id BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION files_freeze_library_id()', t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO dawmain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  libraries, documents, doc_blocks, doc_pages, doc_sections, doc_footnotes, chunks,
  usage_daily, db_activity, system_state, terms_acceptance, blocked_content
TO dawmain_app;
GRANT SELECT, INSERT ON audit_log TO dawmain_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO dawmain_app;

-- ---------------------------------------------------------------------------
-- Cross-library system functions. SECURITY DEFINER (they run as the owner,
-- which bypasses RLS), so each one returns aggregates or ids only — never
-- document content — and the one that writes checks the caller's scope.
-- ---------------------------------------------------------------------------

-- Atomic page reservation against both the library cap and the global cap.
-- The library must be inside the caller's scope; the global sum is taken
-- under an advisory lock so parallel uploads cannot overshoot it.
CREATE OR REPLACE FUNCTION files_reserve_pages(p_library text, p_pages integer, p_library_cap integer, p_global_cap integer)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE used bigint;
BEGIN
  IF p_pages <= 0 OR NOT (p_library = ANY (files_scope())) THEN
    RAISE EXCEPTION 'reservation outside scope';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('files_reserve_pages'));
  SELECT coalesce(sum(page_count + pages_reserved), 0) INTO used FROM libraries WHERE purged_at IS NULL;
  IF used + p_pages > p_global_cap THEN
    RETURN 'global';
  END IF;
  UPDATE libraries SET pages_reserved = pages_reserved + p_pages
   WHERE id = p_library AND page_count + pages_reserved + p_pages <= p_library_cap;
  IF NOT FOUND THEN
    RETURN 'library';
  END IF;
  RETURN 'ok';
END $$;

-- Global usage for the guards and the operator page.
CREATE OR REPLACE FUNCTION files_global_usage()
  RETURNS TABLE (total_pages bigint, reserved_pages bigint, libraries bigint, documents bigint, db_bytes bigint)
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT (SELECT coalesce(sum(page_count), 0) FROM libraries WHERE purged_at IS NULL),
         (SELECT coalesce(sum(pages_reserved), 0) FROM libraries WHERE purged_at IS NULL),
         (SELECT count(*) FROM libraries WHERE purged_at IS NULL),
         (SELECT count(*) FROM documents),
         pg_database_size(current_database())
$$;

-- Library list for the daily cron and the operator page: ids and counters, no content.
CREATE OR REPLACE FUNCTION files_list_libraries()
  RETURNS TABLE (id text, kind text, display_name text, page_count integer, pages_reserved integer,
                 doc_count integer, pro_revoked_at timestamptz, purge_after timestamptz, created_at timestamptz)
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT id, kind, display_name, page_count, pages_reserved, doc_count, pro_revoked_at, purge_after, created_at
    FROM libraries WHERE purged_at IS NULL ORDER BY id
$$;

-- Documents whose ingest should be (re)started: queued, or processing with an expired lease.
CREATE OR REPLACE FUNCTION files_ingest_candidates(p_limit integer)
  RETURNS TABLE (id uuid, library_id text, status text, attempts smallint, uploaded_at timestamptz)
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT id, library_id, status, attempts, uploaded_at FROM documents
   WHERE status IN ('queued','processing') AND (lease_until IS NULL OR lease_until < now())
   ORDER BY uploaded_at
   LIMIT least(greatest(p_limit, 1), 100)
$$;

REVOKE ALL ON FUNCTION files_reserve_pages(text, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION files_global_usage() FROM PUBLIC;
REVOKE ALL ON FUNCTION files_list_libraries() FROM PUBLIC;
REVOKE ALL ON FUNCTION files_ingest_candidates(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION files_scope() TO dawmain_app;
GRANT EXECUTE ON FUNCTION files_reserve_pages(text, integer, integer, integer) TO dawmain_app;
GRANT EXECUTE ON FUNCTION files_global_usage() TO dawmain_app;
GRANT EXECUTE ON FUNCTION files_list_libraries() TO dawmain_app;
GRANT EXECUTE ON FUNCTION files_ingest_candidates(integer) TO dawmain_app;
