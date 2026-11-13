-- Zrcadlo judikatury (docs/infra/v1-plan.md) — schema `mirror`. Applied by
-- `scripts/mirror.ts migrate` (scripts/db-migrate.mjs --dir) with the
-- mirror_owner connection, in its own database on the home server — never
-- the Vlastní zdroje database.
--
-- Stored is only the BASE layer: court, decision date, case number, legal
-- sentence and the full TEXT, plus technical fields (source and its id, URL,
-- ECLI, publication date). Everything in decision_chunk is derived from the
-- text and can be rebuilt by `mirror reindex` without a single download.
-- Raw upstream responses are not kept.
--
-- Roles (created by hand on the server, see docs/infra/proxmox.md):
--   mirror_owner   owns the schema, runs migrations
--   mirror_writer  crawler: reads and writes every table
--   mirror_reader  API: reads only

CREATE SCHEMA IF NOT EXISTS mirror;

-- One row per decision as the source identifies it: NS UNID, NSS numeric id,
-- ÚS `sz`, justice.cz UUID. A case number is not unique (several decisions
-- per case, several case numbers per decision), so it is never the key.
CREATE TABLE IF NOT EXISTS mirror.decision (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source          text NOT NULL CHECK (source IN ('ns','nss','us','justice')),
  source_id       text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 200),
  url             text NOT NULL,
  court           text,
  case_number     text,                              -- the primary sp. zn. as the source shows it
  case_numbers    text[] NOT NULL DEFAULT '{}',      -- every sp. zn. of the decision (NS may list several)
  decided_on      date,
  legal_sentence  text,                              -- only where the source has one (NS/NSS partly, ÚS abstracts)
  ecli            text,
  published_on    date,
  text_sha256     text CHECK (text_sha256 IS NULL OR text_sha256 ~ '^[0-9a-f]{64}$'), -- NULL = no text yet
  parser_version  integer NOT NULL,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),  -- last time discover or sync saw it at the source
  last_changed_at timestamptz NOT NULL DEFAULT now(),  -- last change of text_sha256 or a base field
  gone_at         timestamptz,                         -- the source stopped listing it
  UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS decision_source_decided ON mirror.decision (source, decided_on);
CREATE INDEX IF NOT EXISTS decision_ecli ON mirror.decision (ecli) WHERE ecli IS NOT NULL;
CREATE INDEX IF NOT EXISTS decision_case_numbers ON mirror.decision USING gin (case_numbers);
CREATE INDEX IF NOT EXISTS decision_no_text ON mirror.decision (source) WHERE text_sha256 IS NULL;

-- The full text: the one mandatory part of a record. Kept apart from the
-- metadata so scans of decision never touch it; TOAST compresses it with
-- lz4 (default_toast_compression on the server). text_source says which
-- path produced it (e.g. ns:webprint, ns:websearch, nss:text, nss:html).
CREATE TABLE IF NOT EXISTS mirror.decision_text (
  decision_id bigint PRIMARY KEY REFERENCES mirror.decision(id) ON DELETE CASCADE,
  body        text NOT NULL,
  char_count  integer NOT NULL CHECK (char_count >= 0),
  text_source text NOT NULL CHECK (length(text_source) BETWEEN 1 AND 40)
);

-- Derived search index: offsets into decision_text.body with the tsvector
-- (built by the application, Snowball over 'simple', as in Vlastní zdroje)
-- and identifier keys (sp. zn., §). Partitioned by source, so a reindex or
-- a rebuild of one source touches one partition only.
CREATE TABLE IF NOT EXISTS mirror.decision_chunk (
  source      text NOT NULL,
  decision_id bigint NOT NULL REFERENCES mirror.decision(id) ON DELETE CASCADE,
  ord         integer NOT NULL CHECK (ord >= 0),
  char_start  integer NOT NULL CHECK (char_start >= 0),
  char_end    integer NOT NULL CHECK (char_end >= char_start),
  tsv         tsvector NOT NULL,
  ident_keys  text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (source, decision_id, ord)
) PARTITION BY LIST (source);

CREATE TABLE IF NOT EXISTS mirror.decision_chunk_ns PARTITION OF mirror.decision_chunk FOR VALUES IN ('ns');
CREATE TABLE IF NOT EXISTS mirror.decision_chunk_nss PARTITION OF mirror.decision_chunk FOR VALUES IN ('nss');
CREATE TABLE IF NOT EXISTS mirror.decision_chunk_us PARTITION OF mirror.decision_chunk FOR VALUES IN ('us');
CREATE TABLE IF NOT EXISTS mirror.decision_chunk_justice PARTITION OF mirror.decision_chunk FOR VALUES IN ('justice');

CREATE INDEX IF NOT EXISTS decision_chunk_tsv ON mirror.decision_chunk USING gin (tsv);
CREATE INDEX IF NOT EXISTS decision_chunk_ident ON mirror.decision_chunk USING gin (ident_keys);

-- Operations. sync_cursor: where discover/sync of a source continues
-- (shape per source, e.g. {"quarter":"2004Q1","page":3}).
CREATE TABLE IF NOT EXISTS mirror.sync_cursor (
  source     text PRIMARY KEY CHECK (source IN ('ns','nss','us','justice')),
  cursor     jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every backfill / sync / reindex run is one row; `mirror status` reads them.
CREATE TABLE IF NOT EXISTS mirror.sync_run (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source      text NOT NULL CHECK (source IN ('ns','nss','us','justice')),
  mode        text NOT NULL CHECK (mode IN ('backfill','sync','reindex','retry')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  fetched     integer NOT NULL DEFAULT 0,
  changed     integer NOT NULL DEFAULT 0,
  failed      integer NOT NULL DEFAULT 0,
  error       text                                 -- set when the run itself stopped (429/403, crash)
);

CREATE INDEX IF NOT EXISTS sync_run_source_started ON mirror.sync_run (source, started_at DESC);

-- A document that failed (or came without text) waits here and is retried;
-- one failure never stops a run. kind: what is missing — the whole record
-- or only its text.
CREATE TABLE IF NOT EXISTS mirror.fetch_queue (
  source      text NOT NULL CHECK (source IN ('ns','nss','us','justice')),
  source_id   text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('decision','text')),
  attempts    integer NOT NULL DEFAULT 0,
  next_try_at timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id, kind)
);

CREATE INDEX IF NOT EXISTS fetch_queue_due ON mirror.fetch_queue (source, next_try_at);

-- Privileges. The roles exist on the server already; a fresh database (tests)
-- gets NOLOGIN placeholders so the grants below apply the same way.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mirror_writer') THEN
    CREATE ROLE mirror_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mirror_reader') THEN
    CREATE ROLE mirror_reader NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA mirror TO mirror_writer, mirror_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mirror TO mirror_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mirror TO mirror_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA mirror TO mirror_reader;
