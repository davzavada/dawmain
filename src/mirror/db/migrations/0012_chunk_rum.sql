-- RUM index on the chunks' tsvector: the search takes the chunks the index ranks first instead
-- of ranking every match (src/mirror/api/queries.ts). The extension is the system package
-- postgresql-17-rum, created by hand as postgres (it is not a trusted extension). Build the
-- partitions' indexes CONCURRENTLY by hand first (decision_chunk_<source>_tsv_rum, minutes each);
-- this then only attaches them under the parent. Without the extension (PGlite) it does nothing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'rum') THEN
    CREATE INDEX IF NOT EXISTS decision_chunk_tsv_rum ON mirror.decision_chunk USING rum (tsv rum_tsvector_ops);
  END IF;
END
$$;
