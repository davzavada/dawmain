-- NS "Kategorie rozhodnutí" A–E (A = Sbírka … E = the rest): the court's own
-- weight of a decision, the cheapest authority signal. NULL = none given, or
-- another source. Filled by every NS fetch and, for decisions stored before,
-- by `mirror ns-categories` from NS search result rows.

ALTER TABLE mirror.decision ADD COLUMN IF NOT EXISTS category text CHECK (category IS NULL OR category ~ '^[A-E]$');

CREATE INDEX IF NOT EXISTS decision_category ON mirror.decision (source, category) WHERE category IS NOT NULL;
