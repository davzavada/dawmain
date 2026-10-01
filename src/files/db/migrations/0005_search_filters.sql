-- Search filters inside SQL: overloads of the 0004 channel functions.
--
-- Everything 0004_search.sql documents holds here unchanged — SECURITY
-- DEFINER, the policy's scope applied explicitly (files_scope() ∩ the
-- caller's filter, on chunks AND documents), ids / ordinals / counts only,
-- EXECUTE … USING with a query text built from constants, and the chunk scan
-- pinned to the GIN index in its own MATERIALIZED CTE. What 0005 adds:
--
--   p_require    a chunk must carry one of these keys (files_search
--                case_number: the decision's sz: / ecli: … keys; a query
--                of a § plus "písm. g)": that §'s keys). Tested in
--                the hits CTE — BEFORE the per-document cap and the LIMIT —
--                so the lexical channels rank only chunks citing the
--                decision instead of ranking the whole scope and fusing
--                non-citing passages in. The scan CTE stays as it is (its
--                plan is what 0004 pins).
--   p_section    "par:2913" / "cl:III" (sectionKeyOf's canonical key): only
--                chunks INSIDE that § / článek, ancestors included — a §
--                nested in the článek counts, as it did for the old
--                app-side filter over the section chain. A range test on
--                doc_sections (doc_sections_key serves it), also before the
--                cap: the best passages inside the § no longer lose their
--                slots to stronger matches in other §§ of the commentary.
--   p_per_doc    clamped to 200 (was 20): a search inside one document
--                pages through every passage the channel returns.
--   library_id   returned with each row (an id, like doc_id), so the caller
--                needs no extra lookup for "in K libraries".
--   meta p_keys  document keys (isbn:, doi:) matched against
--                documents.ident_keys (GIN documents_ident): a book found by
--                the ISBN in its metadata even when its text never prints
--                it. Key matches rank first; by_key says which matched.
--
-- Deploy order: migrations run by hand BEFORE the deploy that needs them, so
-- the 0004 signatures stay (the running build still calls them) — these are
-- overloads with more arguments and no DEFAULTs (a defaulted overload would
-- make the old 13-argument call ambiguous). A later migration drops the old
-- signatures once no deployed build calls them.

CREATE OR REPLACE FUNCTION files_search_chunks(
    p_libs text[], p_query text, p_keys text[], p_sec_keys text[],
    p_doc_types text[], p_year_from integer, p_year_to integer, p_doc uuid,
    p_act text, p_act_keys text[], p_act_prefix text,
    p_require text[], p_section text,
    p_per_doc integer, p_limit integer)
  RETURNS TABLE (doc_id uuid, library_id text, ord integer, per_doc_total bigint)
  LANGUAGE plpgsql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, public
  SET enable_seqscan = off
AS $fn$
DECLARE
  score text := CASE WHEN p_query IS NOT NULL
    THEN $q$ts_rank_cd('{0.05,0.12,0.2,1.0}'::float4[], c.tsv, to_tsquery('simple', $2))$q$
    ELSE $q$((SELECT count(*) FROM unnest(c.ident_keys) x WHERE x = ANY ($3))
             + 3 * (SELECT count(*) FROM unnest(c.ident_keys) x WHERE x = ANY ($4)))::float8$q$ END;
  -- The index probe of 0004: 'x':*ABC → 'x':*, 'x':D → 'x', <-> / <N> → &.
  probe text := CASE WHEN p_query ~ $re$^(\s*('[a-z0-9]+'|[a-z0-9]+)(:\*?[A-D]*)?|\s*(<->|<[0-9]{1,4}>|[&|()]))*\s*$$re$
    THEN regexp_replace(regexp_replace(regexp_replace(p_query, ':\*[A-D]+', ':*', 'g'), ':[A-D]+', '', 'g'), '<(-|[0-9]+)>', '&', 'g')
    ELSE p_query END;
  match text;
  in_libs text;
  -- The policy's scope AND the caller's filter.
  libs text[] := ARRAY(SELECT unnest(p_libs) INTERSECT SELECT unnest(files_scope()));
  -- An empty requirement is no requirement (NULL folds the test away).
  req text[] := CASE WHEN coalesce(cardinality(p_require), 0) > 0 THEN p_require END;
BEGIN
  IF cardinality(libs) = 0 OR (p_query IS NULL AND coalesce(cardinality(p_keys), 0) + coalesce(cardinality(p_sec_keys), 0) = 0) THEN
    RETURN;
  END IF;
  IF p_query IS NOT NULL AND (SELECT count(*) FROM (SELECT 1 FROM chunks c WHERE c.library_id = ANY (libs) LIMIT 5001) s) <= 5000 THEN
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
         SELECT c.doc_id, c.library_id, c.ord, c.char_start, c.ident_keys, $q$ || score || $q$ AS score
           FROM chunks c
          WHERE $q$ || match || $q$
            AND $q$ || in_libs || $q$
            AND ($8 IS NULL OR c.doc_id = $8)
       ), hits AS (
         SELECT m.doc_id, m.library_id, m.ord, m.score
           FROM m JOIN documents d ON d.id = m.doc_id AND d.library_id = m.library_id
          WHERE d.library_id = ANY ($1)
            AND d.status = 'ready' AND d.enabled
            AND ($5 IS NULL OR d.doc_type = ANY ($5))
            AND ($6 IS NULL OR d.year >= $6)
            AND ($7 IS NULL OR d.year <= $7)
            AND ($9 IS NULL OR d.commented_act = $9 OR m.ident_keys && $10
                 OR ($11 IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(m.ident_keys) k WHERE starts_with(k, $11))))
            AND ($15 IS NULL OR m.ident_keys && $15)
            AND ($16 IS NULL OR EXISTS (
                  SELECT 1 FROM doc_sections s
                   WHERE s.doc_id = m.doc_id AND s.library_id = m.library_id AND s.key = $16
                     AND s.char_start <= m.char_start AND m.char_start < s.char_end))
       ), capped AS (
         SELECT h.doc_id, h.library_id, h.ord, h.score,
                row_number() OVER (PARTITION BY h.doc_id ORDER BY h.score DESC, h.ord) AS rn,
                count(*) OVER (PARTITION BY h.doc_id) AS per_doc_total
           FROM hits h
       )
       SELECT x.doc_id, x.library_id, x.ord, x.per_doc_total FROM capped x
        WHERE x.rn <= $12
        ORDER BY x.score DESC, x.doc_id, x.ord
        LIMIT $13$q$
    USING libs, p_query, coalesce(p_keys, '{}'), coalesce(p_sec_keys, '{}'),
          p_doc_types, p_year_from, p_year_to, p_doc, p_act, coalesce(p_act_keys, '{}'), p_act_prefix,
          least(greatest(coalesce(p_per_doc, 3), 1), 200), least(greatest(coalesce(p_limit, 60), 1), 200), probe,
          req, p_section;
END $fn$;

-- Metadata channel: documents whose meta_tsv (title, authors, outline)
-- matches p_query, or whose own keys include one of p_keys (isbn:, doi:);
-- key matches first, then by rank. The act filter looks at the document's
-- keys, as in 0004.
CREATE OR REPLACE FUNCTION files_search_meta(
    p_libs text[], p_query text, p_keys text[],
    p_doc_types text[], p_year_from integer, p_year_to integer, p_doc uuid,
    p_act text, p_act_keys text[], p_act_prefix text,
    p_limit integer)
  RETURNS TABLE (doc_id uuid, library_id text, by_key boolean)
  LANGUAGE plpgsql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, public
AS $fn$
DECLARE
  libs text[] := ARRAY(SELECT unnest(p_libs) INTERSECT SELECT unnest(files_scope()));
BEGIN
  IF cardinality(libs) = 0 OR (p_query IS NULL AND coalesce(cardinality(p_keys), 0) = 0) THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE
    $q$SELECT d.id, d.library_id, d.ident_keys && $11 AS by_key FROM documents d
        WHERE d.library_id = ANY ($1)
          AND d.status = 'ready' AND d.enabled
          AND ($3 IS NULL OR d.doc_type = ANY ($3))
          AND ($4 IS NULL OR d.year >= $4)
          AND ($5 IS NULL OR d.year <= $5)
          AND ($6 IS NULL OR d.id = $6)
          AND ($7 IS NULL OR d.commented_act = $7 OR d.ident_keys && $8
               OR ($9 IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(d.ident_keys) k WHERE starts_with(k, $9))))
          AND (($2 IS NOT NULL AND d.meta_tsv @@ to_tsquery('simple', $2)) OR d.ident_keys && $11)
        ORDER BY (d.ident_keys && $11) DESC,
                 coalesce(ts_rank_cd('{0.05,0.12,0.2,1.0}'::float4[], d.meta_tsv, to_tsquery('simple', $2)), 0) DESC, d.id
        LIMIT $10$q$
    USING libs, p_query, p_doc_types, p_year_from, p_year_to, p_doc, p_act, coalesce(p_act_keys, '{}'), p_act_prefix,
          least(greatest(coalesce(p_limit, 60), 1), 200), coalesce(p_keys, '{}');
END $fn$;

REVOKE ALL ON FUNCTION files_search_chunks(text[], text, text[], text[], text[], integer, integer, uuid, text, text[], text, text[], text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION files_search_meta(text[], text, text[], text[], integer, integer, uuid, text, text[], text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION files_search_chunks(text[], text, text[], text[], text[], integer, integer, uuid, text, text[], text, text[], text, integer, integer) TO dawmain_app;
GRANT EXECUTE ON FUNCTION files_search_meta(text[], text, text[], text[], integer, integer, uuid, text, text[], text, integer) TO dawmain_app;
