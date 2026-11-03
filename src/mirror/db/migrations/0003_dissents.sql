-- Every odlišné stanovisko of a decision, not only the first: a plenary
-- decision can carry several (Pl. ÚS 37/93: four). DERIVED from the text and
-- the separator rules among decision_image; `mirror reindex` rebuilds it.
-- A dissent runs to the next one or to the end of the text.

CREATE TABLE IF NOT EXISTS mirror.decision_dissent (
  decision_id bigint NOT NULL REFERENCES mirror.decision(id) ON DELETE CASCADE,
  ord         integer NOT NULL CHECK (ord >= 0),
  char_start  integer NOT NULL CHECK (char_start >= 0),
  char_end    integer NOT NULL CHECK (char_end >= char_start),
  heading     text,               -- "Odlišné stanovisko soudce Jiřího Muchy", as the text has it
  PRIMARY KEY (decision_id, ord)
);

-- What 0002 knew (the first dissent) carries over until a reindex finds the rest.
INSERT INTO mirror.decision_dissent (decision_id, ord, char_start, char_end, heading)
SELECT t.decision_id, 0, t.dissent_at, t.char_count,
       nullif(btrim(split_part(substr(t.body, t.dissent_at + 1, 300), E'\n', 1)), '')
FROM mirror.decision_text t
WHERE t.dissent_at IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE mirror.decision_text DROP COLUMN IF EXISTS dissent_at;

GRANT SELECT, INSERT, UPDATE, DELETE ON mirror.decision_dissent TO mirror_writer;
GRANT SELECT ON mirror.decision_dissent TO mirror_reader;
