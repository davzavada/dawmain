-- Flags the source itself sets on a decision, verbatim (BASE: lost unless
-- stored when fetched). justice.cz: metadata.specialType (e.g. "ESLP").
-- A finer form than decision_type — rozsudek pro zmeškání / pro uznání,
-- bez odůvodnění — is not here: the sources do not state it as a field, it
-- is read from the text and belongs to the derived layer (reindex).

ALTER TABLE mirror.decision ADD COLUMN IF NOT EXISTS source_flags text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS decision_source_flags ON mirror.decision USING gin (source_flags) WHERE source_flags <> '{}';
