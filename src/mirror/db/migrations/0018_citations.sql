-- Links between decisions (src/mirror/citations.ts): each decision's own keys (sp. zn., ECLI) and the
-- keys its text cites; a link is the two joined on the key. Derived from the stored chunks, nothing
-- fetched: filled by saveDecision / reindex for what comes, by `mirror citations` for what is stored.
CREATE TABLE IF NOT EXISTS mirror.decision_key (
  key         text NOT NULL,
  decision_id bigint NOT NULL REFERENCES mirror.decision(id) ON DELETE CASCADE,
  PRIMARY KEY (key, decision_id)
);
CREATE INDEX IF NOT EXISTS decision_key_decision ON mirror.decision_key (decision_id);

CREATE TABLE IF NOT EXISTS mirror.decision_citation (
  citing_id bigint NOT NULL REFERENCES mirror.decision(id) ON DELETE CASCADE,
  key       text NOT NULL,
  mentions  integer NOT NULL CHECK (mentions > 0),  -- in how many chunks
  first_at  integer NOT NULL CHECK (first_at >= 0),  -- char offset of the first of them
  PRIMARY KEY (citing_id, key)
);
-- Who cites a key: the reverse direction.
CREATE INDEX IF NOT EXISTS decision_citation_key ON mirror.decision_citation (key);

GRANT SELECT, INSERT, UPDATE, DELETE ON mirror.decision_key, mirror.decision_citation TO mirror_writer;
GRANT SELECT ON mirror.decision_key, mirror.decision_citation TO mirror_reader;
