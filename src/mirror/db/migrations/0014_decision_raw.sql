-- The source's own document of each decision, as it came (gzip): NS WebSearch HTML, ÚS GetText HTML,
-- NSS DokumentOriginal/Html, justice finaldoc JSON. What the parsers leave out (formatting, structure)
-- can then be read again from it without asking the court. Filled by every fetch, and for decisions
-- stored before by `mirror raw`. `status`: the HTTP status; a 404 / 410 is kept (gz empty) so the run
-- does not ask again.

CREATE TABLE IF NOT EXISTS mirror.decision_raw (
  decision_id  bigint PRIMARY KEY REFERENCES mirror.decision(id) ON DELETE CASCADE,
  url          text NOT NULL,
  status       integer NOT NULL,
  content_type text,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  bytes        integer NOT NULL CHECK (bytes >= 0),
  sha256       text,
  gz           bytea NOT NULL
);

-- Already compressed: Postgres should not try again.
ALTER TABLE mirror.decision_raw ALTER COLUMN gz SET STORAGE EXTERNAL;

GRANT SELECT, INSERT, UPDATE, DELETE ON mirror.decision_raw TO mirror_writer;
GRANT SELECT ON mirror.decision_raw TO mirror_reader;

-- `mirror raw` records its runs like the others.
ALTER TABLE mirror.sync_run DROP CONSTRAINT IF EXISTS sync_run_mode_check;
ALTER TABLE mirror.sync_run ADD CONSTRAINT sync_run_mode_check CHECK (mode IN ('backfill','sync','reindex','retry','raw'));
