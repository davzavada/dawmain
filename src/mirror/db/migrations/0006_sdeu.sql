-- SDEU (Soudní dvůr EU, Tribunál, Soud pro veřejnou službu) joins the
-- mirror as source `sdeu` (decided 25. 10. 2026, beyond the v1 plan):
-- judgments, orders and opinions of the Advocates General, in Czech where
-- the Publications Office (Cellar) holds a Czech version. Identity: CELEX.

ALTER TABLE mirror.decision DROP CONSTRAINT IF EXISTS decision_source_check;
ALTER TABLE mirror.decision ADD CONSTRAINT decision_source_check CHECK (source IN ('ns','nss','us','justice','sdeu'));

ALTER TABLE mirror.sync_cursor DROP CONSTRAINT IF EXISTS sync_cursor_source_check;
ALTER TABLE mirror.sync_cursor ADD CONSTRAINT sync_cursor_source_check CHECK (source IN ('ns','nss','us','justice','sdeu'));

ALTER TABLE mirror.sync_run DROP CONSTRAINT IF EXISTS sync_run_source_check;
ALTER TABLE mirror.sync_run ADD CONSTRAINT sync_run_source_check CHECK (source IN ('ns','nss','us','justice','sdeu'));

ALTER TABLE mirror.fetch_queue DROP CONSTRAINT IF EXISTS fetch_queue_source_check;
ALTER TABLE mirror.fetch_queue ADD CONSTRAINT fetch_queue_source_check CHECK (source IN ('ns','nss','us','justice','sdeu'));

CREATE TABLE IF NOT EXISTS mirror.decision_chunk_sdeu PARTITION OF mirror.decision_chunk FOR VALUES IN ('sdeu');
GRANT SELECT, INSERT, UPDATE, DELETE ON mirror.decision_chunk_sdeu TO mirror_writer;
GRANT SELECT ON mirror.decision_chunk_sdeu TO mirror_reader;
