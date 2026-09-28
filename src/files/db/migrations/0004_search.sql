-- Search channels as SECURITY DEFINER functions, so the GIN indexes work.
--
-- Under FORCE ROW LEVEL SECURITY the planner may use a qual as an index
-- condition ahead of the policy qual only when its operator is leakproof.
-- `@@` (ts_match_vq) and `&&` (arrayoverlap) are not, and only a superuser
-- could mark them so (Neon does not allow it). As dawmain_app every lexical
-- and identifier search therefore read ALL chunks of the libraries in scope
-- through chunks_lib_doc, detoasting each tsvector, and chunks_tsv,
-- chunks_ident and documents_meta_tsv were dead weight.
--
-- These functions run as the migration owner (bypasses RLS, as the system
-- functions of 0002 do), so `tsv @@ q` and `ident_keys && keys` drive a
-- Bitmap Index Scan on the GIN indexes. They apply the policy's own scope
-- explicitly — library_id = ANY of files_scope() ∩ the caller's library
-- filter, on chunks AND documents — so they see exactly what RLS would let
-- the caller see (and, were the owner ever subject to RLS itself, the
-- results would still be the same, only slower). They return ids, chunk
-- ordinals and counts only — never document content. EXECUTE: dawmain_app.
--
-- Shared filters (every function): status 'ready', enabled, the optional
-- doc types, year range and document id, and the act filter:
--   p_act        "zak:89/2012" / "eu:32016R0679" — NULL: no act filter
--   p_act_keys   chunk (document) keys that count as citing the act: the
--                query's own parz: keys of a § ("§ 2913 OZ"), or the act
--                key itself ("zak:89/2012" = the act cited by number)
--   p_act_prefix "parz:89/2012/" — any § of the act counts as citing it
--                (only when the query names no § of its own); NULL: off
-- A document passes when it is a commentary on the act, or (chunk channels:
-- the chunk; meta: the document) carries one of those keys.

-- Each is PL/pgSQL around one constant query run with EXECUTE … USING: a
-- plain SQL function body is planned generically on PG 16/17 (parameter
-- values unknown), and that plan misjudges the optional filters and walks
-- chunks_lib_doc document by document. EXECUTE plans with the actual values
-- (a NULL filter folds away). The query text is built from constants only;
-- every value travels in USING.
--
-- Even so, the planner does not cost detoasting: a tsvector is stored out
-- of line, so a scan of all chunks in scope looks cheap and wins for every
-- query but a rare AND (measured on 50k chunks: a rare OR 330 ms by scope
-- vs 38 ms by GIN; a mid-frequency word 420 vs 92 ms; a word in EVERY chunk
-- 803 vs 608 ms). So the chunk scan is pinned to the GIN index: it sits in
-- its own MATERIALIZED CTE whose library test no btree can serve
-- (`… IS TRUE`), with seq scans off for the function. Only `doc_id = p_doc`
-- (one document) may use the primary key instead.
--
-- Two limits of that. (1) The GIN index cannot check lexeme weights
-- (in_footnotes: ':*D', ':*ABC') or phrase positions (<->): such a query
-- makes the heap scan recheck, i.e. detoast, every matching chunk of EVERY
-- library before the library test runs (a 2.5k-chunk library: 30 → 290 ms
-- on 50k chunks). So the index is probed with the query's unweighted,
-- position-free form — a superset, which needs no recheck — and the query
-- itself runs only on chunks in scope (inside a CASE, after the library
-- test). A query outside buildTsQuery's grammar is used as it is. (2) Even
-- without a recheck the index hands over the matches of every library, so a
-- small scope would pay for the size of the whole database: a scope of at
-- most 5,000 chunks (counted, up to that bound, on chunks_lib_doc) is read
-- whole by chunks_lib_doc instead, its cost bounded by its own size (a
-- 2.5k-chunk library: 10–35 ms, as inline). The identifier channel uses
-- chunks_ident always: keys are selective, ident_keys needs no detoasting.

-- Chunk channels. With p_query: the lexical channels (and / or) — chunks
-- matching the tsquery, scored by ts_rank_cd (weights {D,C,B,A}: footnotes,
-- body, parent heading, own heading). Without it: the identifier channel —
-- chunks carrying any of p_keys or p_sec_keys, one point per matching key,
-- three per section key ("sec:par:2913": the § itself before chunks that
-- merely cite it). Best p_per_doc chunks per document, each with its
-- document's uncapped count, best first, at most p_limit rows.
CREATE OR REPLACE FUNCTION files_search_chunks(
    p_libs text[], p_query text, p_keys text[], p_sec_keys text[],
    p_doc_types text[], p_year_from integer, p_year_to integer, p_doc uuid,
    p_act text, p_act_keys text[], p_act_prefix text,
    p_per_doc integer, p_limit integer)
  RETURNS TABLE (doc_id uuid, ord integer, per_doc_total bigint)
  LANGUAGE plpgsql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, public
  SET enable_seqscan = off
AS $fn$
DECLARE
  score text := CASE WHEN p_query IS NOT NULL
    THEN $q$ts_rank_cd('{0.05,0.12,0.2,1.0}'::float4[], c.tsv, to_tsquery('simple', $2))$q$
    ELSE $q$((SELECT count(*) FROM unnest(c.ident_keys) x WHERE x = ANY ($3))
             + 3 * (SELECT count(*) FROM unnest(c.ident_keys) x WHERE x = ANY ($4)))::float8$q$ END;
  -- The index probe: 'x':*ABC → 'x':*, 'x':D → 'x', <-> / <N> → &. Only for
  -- lexemes, & | ( ) and phrase operators (no `!`): its matches are then a
  -- superset of the query's.
  probe text := CASE WHEN p_query ~ $re$^(\s*('[a-z0-9]+'|[a-z0-9]+)(:\*?[A-D]*)?|\s*(<->|<[0-9]{1,4}>|[&|()]))*\s*$$re$
    THEN regexp_replace(regexp_replace(regexp_replace(p_query, ':\*[A-D]+', ':*', 'g'), ':[A-D]+', '', 'g'), '<(-|[0-9]+)>', '&', 'g')
    ELSE p_query END;
  match text;
  in_libs text;
  -- The policy's scope AND the caller's filter.
  libs text[] := ARRAY(SELECT unnest(p_libs) INTERSECT SELECT unnest(files_scope()));
BEGIN
  IF cardinality(libs) = 0 OR (p_query IS NULL AND coalesce(cardinality(p_keys), 0) + coalesce(cardinality(p_sec_keys), 0) = 0) THEN
    RETURN;
  END IF;
  IF p_query IS NOT NULL AND (SELECT count(*) FROM (SELECT 1 FROM chunks c WHERE c.library_id = ANY (libs) LIMIT 5001) s) <= 5000 THEN
    -- A small scope: chunks_lib_doc drives, the query (not indexable as
    -- `… IS TRUE`) filters.
    match := $q$(c.tsv @@ to_tsquery('simple', $2)) IS TRUE$q$;
    in_libs := $q$c.library_id = ANY ($1)$q$;
  ELSE
    match := CASE WHEN p_query IS NULL THEN $q$c.ident_keys && ($3 || $4)$q$
      WHEN probe = p_query THEN $q$c.tsv @@ to_tsquery('simple', $2)$q$
      ELSE $q$c.tsv @@ to_tsquery('simple', $14)
              AND CASE WHEN c.library_id = ANY ($1) THEN c.tsv @@ to_tsquery('simple', $2) ELSE false END$q$ END;
    in_libs := $q$(c.library_id = ANY ($1)) IS TRUE$q$;
  END IF;
  RETURN QUERY EXECUTE
    $q$WITH m AS MATERIALIZED (
         SELECT c.doc_id, c.library_id, c.ord, c.ident_keys, $q$ || score || $q$ AS score
           FROM chunks c
          WHERE $q$ || match || $q$
            AND $q$ || in_libs || $q$
            AND ($8 IS NULL OR c.doc_id = $8)
       ), hits AS (
         SELECT m.doc_id, m.ord, m.score
           FROM m JOIN documents d ON d.id = m.doc_id AND d.library_id = m.library_id
          WHERE d.library_id = ANY ($1)
            AND d.status = 'ready' AND d.enabled
            AND ($5 IS NULL OR d.doc_type = ANY ($5))
            AND ($6 IS NULL OR d.year >= $6)
            AND ($7 IS NULL OR d.year <= $7)
            AND ($9 IS NULL OR d.commented_act = $9 OR m.ident_keys && $10
                 OR ($11 IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(m.ident_keys) k WHERE starts_with(k, $11))))
       ), capped AS (
         SELECT h.doc_id, h.ord, h.score,
                row_number() OVER (PARTITION BY h.doc_id ORDER BY h.score DESC, h.ord) AS rn,
                count(*) OVER (PARTITION BY h.doc_id) AS per_doc_total
           FROM hits h
       )
       SELECT x.doc_id, x.ord, x.per_doc_total FROM capped x
        WHERE x.rn <= $12
        ORDER BY x.score DESC, x.doc_id, x.ord
        LIMIT $13$q$
    USING libs, p_query, coalesce(p_keys, '{}'), coalesce(p_sec_keys, '{}'),
          p_doc_types, p_year_from, p_year_to, p_doc, p_act, coalesce(p_act_keys, '{}'), p_act_prefix,
          least(greatest(coalesce(p_per_doc, 3), 1), 20), least(greatest(coalesce(p_limit, 60), 1), 200), probe;
END $fn$;

-- Metadata channel: documents whose meta_tsv (title, authors, outline)
-- matches p_query, best first; the act filter looks at the document's keys.
CREATE OR REPLACE FUNCTION files_search_meta(
    p_libs text[], p_query text,
    p_doc_types text[], p_year_from integer, p_year_to integer, p_doc uuid,
    p_act text, p_act_keys text[], p_act_prefix text,
    p_limit integer)
  RETURNS TABLE (doc_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, public
AS $fn$
DECLARE
  libs text[] := ARRAY(SELECT unnest(p_libs) INTERSECT SELECT unnest(files_scope()));
BEGIN
  IF cardinality(libs) = 0 THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE
    $q$SELECT d.id FROM documents d
        WHERE d.library_id = ANY ($1)
          AND d.status = 'ready' AND d.enabled
          AND ($3 IS NULL OR d.doc_type = ANY ($3))
          AND ($4 IS NULL OR d.year >= $4)
          AND ($5 IS NULL OR d.year <= $5)
          AND ($6 IS NULL OR d.id = $6)
          AND ($7 IS NULL OR d.commented_act = $7 OR d.ident_keys && $8
               OR ($9 IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(d.ident_keys) k WHERE starts_with(k, $9))))
          AND d.meta_tsv @@ to_tsquery('simple', $2)
        ORDER BY ts_rank_cd('{0.05,0.12,0.2,1.0}'::float4[], d.meta_tsv, to_tsquery('simple', $2)) DESC, d.id
        LIMIT $10$q$
    USING libs, p_query, p_doc_types, p_year_from, p_year_to, p_doc, p_act, coalesce(p_act_keys, '{}'), p_act_prefix,
          least(greatest(coalesce(p_limit, 60), 1), 200);
END $fn$;

REVOKE ALL ON FUNCTION files_search_chunks(text[], text, text[], text[], text[], integer, integer, uuid, text, text[], text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION files_search_meta(text[], text, text[], integer, integer, uuid, text, text[], text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION files_search_chunks(text[], text, text[], text[], text[], integer, integer, uuid, text, text[], text, integer, integer) TO dawmain_app;
GRANT EXECUTE ON FUNCTION files_search_meta(text[], text, text[], integer, integer, uuid, text, text[], text, integer) TO dawmain_app;
