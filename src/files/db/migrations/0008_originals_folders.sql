-- Originals and folders. The original file of a document is stored next to
-- its text (doc_originals, in parts of ORIGINAL_PART_BYTES — src/files/
-- config.ts) so users can see and download it; the MCP tools keep working on
-- the text layer only. A library's storage quota is the sum of its
-- originals' sizes (documents.file_bytes where original_status <> 'missing').
-- Folders nest within one library. Both new tables follow 0002: library_id
-- on every row, composite foreign keys that cannot point across libraries,
-- FORCEd row-level security, the freeze trigger and grants to dawmain_app.

CREATE TABLE IF NOT EXISTS folders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id text NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  parent_id  uuid,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_by text NOT NULL CHECK (created_by ~ '^user_[A-Za-z0-9]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, library_id),
  FOREIGN KEY (parent_id, library_id) REFERENCES folders (id, library_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS folders_sibling_name ON folders
  (library_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
CREATE INDEX IF NOT EXISTS folders_parent ON folders (library_id, parent_id);

ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder_id uuid;
DO $$ BEGIN
  ALTER TABLE documents ADD CONSTRAINT documents_folder_fk
    FOREIGN KEY (folder_id, library_id) REFERENCES folders (id, library_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS documents_lib_folder ON documents (library_id, folder_id);

-- missing: never stored (documents from before originals were kept) or an
-- abandoned upload the cron dropped; uploading: parts arriving; ready: complete
-- and verified against file_sha256.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS original_status text NOT NULL DEFAULT 'missing';
DO $$ BEGIN
  ALTER TABLE documents ADD CONSTRAINT documents_original_status_check
    CHECK (original_status IN ('missing','uploading','ready'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS doc_originals (
  doc_id     uuid    NOT NULL,
  library_id text    NOT NULL,
  ord        integer NOT NULL CHECK (ord >= 0),
  data       bytea   NOT NULL,
  PRIMARY KEY (doc_id, ord),
  FOREIGN KEY (doc_id, library_id) REFERENCES documents (id, library_id) ON DELETE CASCADE
);
-- PDFs and DOCX are compressed already: no pglz attempt, straight to TOAST.
ALTER TABLE doc_originals ALTER COLUMN data SET STORAGE EXTERNAL;
ALTER TABLE doc_originals SET (autovacuum_vacuum_scale_factor = 0.02);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['folders','doc_originals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS library_scope ON %I', t);
    EXECUTE format(
      'CREATE POLICY library_scope ON %I USING (library_id = ANY (files_scope())) WITH CHECK (library_id = ANY (files_scope()))', t);
    EXECUTE format('DROP TRIGGER IF EXISTS freeze_library_id ON %I', t);
    EXECUTE format('CREATE TRIGGER freeze_library_id BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION files_freeze_library_id()', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON folders, doc_originals TO dawmain_app;

-- Bytes of originals per library (stored or uploading) for the admin's team
-- list: ids and sums only, no content — like files_list_libraries.
CREATE OR REPLACE FUNCTION files_library_bytes()
  RETURNS TABLE (library_id text, bytes bigint)
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT library_id, coalesce(sum(file_bytes), 0)::bigint FROM documents
   WHERE original_status <> 'missing' AND status <> 'deleting'
   GROUP BY library_id ORDER BY library_id
$$;

REVOKE ALL ON FUNCTION files_library_bytes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION files_library_bytes() TO dawmain_app;
