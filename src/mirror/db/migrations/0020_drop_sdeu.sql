-- SDEU leaves the mirror for good: its case law has been read live through
-- Cellar since 26. 10. 2026 (sdeu_search, caselaw_search include_eu), the
-- crawler is gone and the mirror never held an SDEU row. Drop the empty
-- chunk partition and take 'sdeu' out of the source checks (0006).

DROP TABLE IF EXISTS mirror.decision_chunk_sdeu;

ALTER TABLE mirror.decision DROP CONSTRAINT IF EXISTS decision_source_check;
ALTER TABLE mirror.decision ADD CONSTRAINT decision_source_check CHECK (source IN ('ns','nss','us','justice'));

ALTER TABLE mirror.sync_cursor DROP CONSTRAINT IF EXISTS sync_cursor_source_check;
ALTER TABLE mirror.sync_cursor ADD CONSTRAINT sync_cursor_source_check CHECK (source IN ('ns','nss','us','justice'));

ALTER TABLE mirror.sync_run DROP CONSTRAINT IF EXISTS sync_run_source_check;
ALTER TABLE mirror.sync_run ADD CONSTRAINT sync_run_source_check CHECK (source IN ('ns','nss','us','justice'));

ALTER TABLE mirror.fetch_queue DROP CONSTRAINT IF EXISTS fetch_queue_source_check;
ALTER TABLE mirror.fetch_queue ADD CONSTRAINT fetch_queue_source_check CHECK (source IN ('ns','nss','us','justice'));
