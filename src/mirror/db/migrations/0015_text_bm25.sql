-- BM25 index over decision_text (columns and triggers: 0013).
-- The index: Czech Snowball stems with the diacritics folded ("bezduvodne" = "bezdůvodné"), the
-- filters as literal / date fields. Build it CONCURRENTLY by hand first (minutes); this then
-- finds it by name. Without pg_search (PGlite, a server without the package) it does nothing.
-- mutable_segment_rows = 0: new rows go straight to small immutable segments (merged in the
-- background). The default buffer of 1,000 rows is searched by indexing it again on every query:
-- 454 buffered decisions cost 600 ms a search, without them it takes under a millisecond.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_search') THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS decision_text_bm25 ON mirror.decision_text USING paradedb (
        decision_id,
        (body::pdb.simple('stemmer=czech', 'ascii_folding=true')),
        (source::pdb.literal),
        decided_on,
        (decision_type::pdb.literal),
        (category::pdb.literal)
      ) WITH (mutable_segment_rows = 0)
    $idx$;
    ALTER INDEX mirror.decision_text_bm25 SET (mutable_segment_rows = 0);
  END IF;
END
$$;
