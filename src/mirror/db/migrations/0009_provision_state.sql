-- What decision_provision was derived from, per decision: the text (its
-- sha256) and the extractor version (EXTRACTOR_VERSION in
-- src/mirror/legal/provisions.ts). `mirror provisions` processes the
-- decisions missing here, with another text, or from an older version — so
-- it runs after every sync, and again over everything when the rules change.

CREATE TABLE IF NOT EXISTS mirror.provision_state (
  decision_id bigint PRIMARY KEY REFERENCES mirror.decision(id) ON DELETE CASCADE,
  text_sha256 text,
  version     integer NOT NULL,
  done_at     timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON mirror.provision_state TO mirror_writer;
GRANT SELECT ON mirror.provision_state TO mirror_reader;
