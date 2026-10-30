-- decision_chunk had no index led by decision_id: its primary key starts with
-- source (the partition key), so every cascade from a deleted decision and
-- every "DELETE … WHERE decision_id" scanned all chunks of all sources. On
-- 26. 10. deleting the 45k SDEU decisions ran for over 16 minutes before it
-- was cancelled. Created on the parent: every partition gets its own.

CREATE INDEX IF NOT EXISTS decision_chunk_decision ON mirror.decision_chunk (decision_id);
