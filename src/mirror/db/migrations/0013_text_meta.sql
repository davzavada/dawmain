-- Full-text search over whole decisions with BM25 (pg_search, ParadeDB, index in
-- 0014): the index ranks and returns the top hits itself, filters included — 5 ms
-- where the chunk RUM index took seconds on common phrases (pilot on NS, 27. 10.).
-- The filters the search takes live in the indexed table, so the decision's
-- court, date, type and category are copied onto its text and kept in step
-- by triggers (the writer and `mirror ns-categories` change only decision).

ALTER TABLE mirror.decision_text
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS decided_on date,
  ADD COLUMN IF NOT EXISTS decision_type text,
  ADD COLUMN IF NOT EXISTS category text;

UPDATE mirror.decision_text t
SET source = d.source, decided_on = d.decided_on, decision_type = d.decision_type, category = d.category
FROM mirror.decision d
WHERE d.id = t.decision_id
  AND (t.source, t.decided_on, t.decision_type, t.category) IS DISTINCT FROM (d.source, d.decided_on, d.decision_type, d.category);

CREATE OR REPLACE FUNCTION mirror.decision_text_copy_meta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT d.source, d.decided_on, d.decision_type, d.category
  INTO NEW.source, NEW.decided_on, NEW.decision_type, NEW.category
  FROM mirror.decision d WHERE d.id = NEW.decision_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS decision_text_copy_meta ON mirror.decision_text;
CREATE TRIGGER decision_text_copy_meta BEFORE INSERT OR UPDATE OF body ON mirror.decision_text
  FOR EACH ROW EXECUTE FUNCTION mirror.decision_text_copy_meta();

CREATE OR REPLACE FUNCTION mirror.decision_meta_to_text() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mirror.decision_text t
  SET source = NEW.source, decided_on = NEW.decided_on, decision_type = NEW.decision_type, category = NEW.category
  WHERE t.decision_id = NEW.id;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS decision_meta_to_text ON mirror.decision;
CREATE TRIGGER decision_meta_to_text AFTER UPDATE OF source, decided_on, decision_type, category ON mirror.decision
  FOR EACH ROW
  WHEN ((OLD.source, OLD.decided_on, OLD.decision_type, OLD.category) IS DISTINCT FROM (NEW.source, NEW.decided_on, NEW.decision_type, NEW.category))
  EXECUTE FUNCTION mirror.decision_meta_to_text();
