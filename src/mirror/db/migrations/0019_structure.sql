-- The parts of each decision's text (src/mirror/structure.ts): sections (záhlaví, výrok, odůvodnění,
-- poučení, odlišná stanoviska), the odůvodnění's numbered paragraphs and its headings, as offsets into
-- decision_text.body. A table of its own: writing it onto decision_text would rewrite the text and
-- with it the BM25 index. Derived, nothing fetched: saveDecision writes it with the text, `mirror
-- structure` for what is stored.
CREATE TABLE IF NOT EXISTS mirror.decision_structure (
  decision_id bigint PRIMARY KEY REFERENCES mirror.decision(id) ON DELETE CASCADE,
  sections    jsonb NOT NULL,  -- [{kind, start, end}]
  paragraphs  jsonb NOT NULL,  -- [{num, start, end}]
  headings    jsonb NOT NULL,  -- [{text, start, end}]
  written_at  timestamptz NOT NULL DEFAULT now()
);

-- The výrok's text, for the search in výroky only (its BM25 index: 0020). The filters live here as on
-- decision_text, kept in step by the triggers of 0013.
CREATE TABLE IF NOT EXISTS mirror.decision_verdict (
  decision_id   bigint PRIMARY KEY REFERENCES mirror.decision(id) ON DELETE CASCADE,
  body          text NOT NULL,
  source        text,
  decided_on    date,
  decision_type text,
  category      text
);

DROP TRIGGER IF EXISTS decision_verdict_copy_meta ON mirror.decision_verdict;
CREATE TRIGGER decision_verdict_copy_meta BEFORE INSERT OR UPDATE OF body ON mirror.decision_verdict
  FOR EACH ROW EXECUTE FUNCTION mirror.decision_text_copy_meta();

CREATE OR REPLACE FUNCTION mirror.decision_meta_to_text() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mirror.decision_text t
  SET source = NEW.source, decided_on = NEW.decided_on, decision_type = NEW.decision_type, category = NEW.category
  WHERE t.decision_id = NEW.id;
  UPDATE mirror.decision_verdict v
  SET source = NEW.source, decided_on = NEW.decided_on, decision_type = NEW.decision_type, category = NEW.category
  WHERE v.decision_id = NEW.id;
  RETURN NULL;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON mirror.decision_structure, mirror.decision_verdict TO mirror_writer;
GRANT SELECT ON mirror.decision_structure, mirror.decision_verdict TO mirror_reader;
