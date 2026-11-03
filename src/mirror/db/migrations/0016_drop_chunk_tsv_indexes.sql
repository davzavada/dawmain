-- The chunks' tsvector indexes are no longer read: words go to BM25 over decision_text (0015), and
-- with an identifier the chunk channel looks for the words only within BM25's first decisions (by
-- decision_id). The RUM index (0012) and the GIN (0001) took 6.1 + 2.7 GB. The tsvector stays: it
-- picks the excerpt's chunk and ranks the identifier channel.
DROP INDEX IF EXISTS mirror.decision_chunk_tsv_rum;
DROP INDEX IF EXISTS mirror.decision_chunk_tsv;
