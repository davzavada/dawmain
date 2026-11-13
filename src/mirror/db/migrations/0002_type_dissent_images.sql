-- Typ rozhodnutí, odlišná stanoviska a obrázky (rozhodnutí 24. 10. 2026:
-- celé rozhodnutí jako podklad, aby šlo vykreslit).
--
-- decision.decision_type   BASE — the form as the source names it, folded to
--                          one vocabulary across sources (NULL = unknown)
-- decision_text.dissent_at DERIVED — offset into body where the first
--                          odlišné stanovisko begins (NULL = none); rebuilt
--                          from the text by `mirror reindex`
-- decision_image           BASE — the pictures the source embeds in the
--                          decision (ÚS: \pict groups of the RTF text), each
--                          at its offset into body; text + images render the
--                          whole decision

ALTER TABLE mirror.decision
  ADD COLUMN IF NOT EXISTS decision_type text
  CHECK (decision_type IN ('rozsudek','usneseni','nalez','stanovisko','jine'));

CREATE INDEX IF NOT EXISTS decision_source_type ON mirror.decision (source, decision_type);

ALTER TABLE mirror.decision_text
  ADD COLUMN IF NOT EXISTS dissent_at integer CHECK (dissent_at IS NULL OR dissent_at >= 0);

CREATE TABLE IF NOT EXISTS mirror.decision_image (
  decision_id bigint NOT NULL REFERENCES mirror.decision(id) ON DELETE CASCADE,
  ord         integer NOT NULL CHECK (ord >= 0),
  char_at     integer NOT NULL CHECK (char_at >= 0),   -- offset into decision_text.body
  mime        text NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/x-wmf','image/x-emf')),
  width       integer,
  height      integer,
  bytes       bytea NOT NULL,
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (decision_id, ord)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON mirror.decision_image TO mirror_writer;
GRANT SELECT ON mirror.decision_image TO mirror_reader;
