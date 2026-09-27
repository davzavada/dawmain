-- Vlastní zdroje — schema. Applied by scripts/db-migrate.mjs with the OWNER
-- connection (DATABASE_URL_UNPOOLED), never at build time. Every content row
-- carries library_id (a Clerk id: user_… personal, org_… team); child tables
-- reference (doc_id, library_id) so a row can never point across libraries.
-- The text itself is stored ONCE (doc_blocks, app-compressed); pages,
-- sections, footnotes and chunks are offset indexes into it.

CREATE TABLE IF NOT EXISTS libraries (
  id             text PRIMARY KEY CHECK (id ~ '^(user|org)_[A-Za-z0-9]+$'),
  kind           text GENERATED ALWAYS AS (CASE WHEN id LIKE 'org\_%' THEN 'org' ELSE 'user' END) STORED,
  display_name   text,
  settings       jsonb   NOT NULL DEFAULT '{}'::jsonb,   -- {autoConfirm:false, aiProposals:true}
  page_count     integer NOT NULL DEFAULT 0 CHECK (page_count >= 0),     -- billed pages stored
  pages_reserved integer NOT NULL DEFAULT 0 CHECK (pages_reserved >= 0), -- uploads in flight
  doc_count      integer NOT NULL DEFAULT 0 CHECK (doc_count >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  pro_revoked_at timestamptz,          -- Pro removed: read/delete/export only; purged after 90 days
  purge_after    timestamptz,          -- soft-deleted (Clerk user/org deleted): cron purges after this
  purged_at      timestamptz
);

CREATE TABLE IF NOT EXISTS documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id        text NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  status            text NOT NULL CHECK (status IN ('queued','processing','review','ready','error','deleting')),
  status_detail     text,
  uploaded_by       text NOT NULL CHECK (uploaded_by ~ '^user_[A-Za-z0-9]+$'),
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  lease_until       timestamptz,
  run_token         uuid,
  attempts          smallint NOT NULL DEFAULT 0,
  file_kind         text NOT NULL CHECK (file_kind IN ('pdf','docx','txt','md')),
  file_name         text NOT NULL CHECK (length(file_name) <= 255),
  file_bytes        bigint CHECK (file_bytes IS NULL OR file_bytes >= 0),  -- size of the original (never stored)
  file_sha256       text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),    -- client-asserted
  content_sha256    text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'), -- server-verified
  converter         text NOT NULL CHECK (length(converter) <= 40),
  rights            text NOT NULL CHECK (rights IN ('vlastni','verejne','licence','jine')),
  physical_pages    integer,
  billable_pages    integer NOT NULL CHECK (billable_pages > 0),
  char_count        integer NOT NULL,
  page_label_source text NOT NULL CHECK (page_label_source IN ('pdf_labels','printed','physical','none')),
  quality           jsonb NOT NULL DEFAULT '{}'::jsonb,
  hints             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- sanitized, never indexed
  analyzer_version  integer,
  pending_gz        bytea,            -- the uploaded DMD until ingest succeeds, then NULL
  replaces          uuid,
  proposed_meta     jsonb,
  meta_version      integer NOT NULL DEFAULT 0,
  confirmed_at      timestamptz,
  confirmed_by      text,
  injection_flag    boolean NOT NULL DEFAULT false,
  enabled           boolean NOT NULL DEFAULT true,   -- "vypnutý dokument asistent přeskočí"
  -- bibliographic metadata (typed, for filters and citations)
  doc_type          text CHECK (doc_type IN ('kniha','kapitola','clanek','komentar','vzor','rozhodnuti','jine')),
  title             text CHECK (length(title) <= 500),
  subtitle          text,
  authors           text[] NOT NULL DEFAULT '{}',
  editors           text[] NOT NULL DEFAULT '{}',
  edition           text,
  publisher         text,
  place             text,
  year              smallint CHECK (year BETWEEN 1500 AND 2100),
  series            text,
  isbn              text[] NOT NULL DEFAULT '{}',
  issn              text,
  doi               text,
  container_title   text,
  volume            text,
  issue             text,
  pages_range       text,
  commented_act     text CHECK (commented_act IS NULL OR commented_act ~ '^(zak:[0-9]{1,4}/[0-9]{4}|eu:[0-9]{5}[A-Z][0-9]{4})$'),
  commented_act_name text,
  section_range     text,
  anchor_label      text CHECK (anchor_label IS NULL OR anchor_label IN ('m. č.','marg. č.','bod')),
  template_kind     text,
  court             text,
  case_number       text,
  ecli              text,
  decided_on        date,
  keywords          text[] NOT NULL DEFAULT '{}',
  summary           text,
  language          text NOT NULL DEFAULT 'cs',
  ident_keys        text[] NOT NULL DEFAULT '{}',
  meta_tsv          tsvector,
  UNIQUE (id, library_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS documents_content_uniq ON documents (library_id, content_sha256) WHERE status <> 'deleting';
CREATE INDEX IF NOT EXISTS documents_lib_status ON documents (library_id, status);
CREATE INDEX IF NOT EXISTS documents_lib_type_year ON documents (library_id, doc_type, year);
CREATE INDEX IF NOT EXISTS documents_lease ON documents (status, lease_until) WHERE status IN ('queued','processing');
CREATE INDEX IF NOT EXISTS documents_meta_tsv ON documents USING gin (meta_tsv);
CREATE INDEX IF NOT EXISTS documents_ident ON documents USING gin (ident_keys);

-- The DMD text, stored once: paragraph-aligned blocks of ~12k chars, deflated in the app.
CREATE TABLE IF NOT EXISTS doc_blocks (
  doc_id     uuid    NOT NULL,
  library_id text    NOT NULL,
  ord        integer NOT NULL,
  char_start integer NOT NULL,
  char_end   integer NOT NULL,
  body       bytea   NOT NULL,
  PRIMARY KEY (doc_id, ord),
  FOREIGN KEY (doc_id, library_id) REFERENCES documents (id, library_id) ON DELETE CASCADE
);
ALTER TABLE doc_blocks ALTER COLUMN body SET STORAGE EXTERNAL;

CREATE TABLE IF NOT EXISTS doc_pages (
  doc_id     uuid    NOT NULL,
  library_id text    NOT NULL,
  ord        integer NOT NULL,          -- physical page 1..n
  label      text    NOT NULL,
  label_key  text    NOT NULL,          -- folded label for lookup
  char_start integer NOT NULL,
  char_end   integer NOT NULL,
  flags      smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (doc_id, ord),
  FOREIGN KEY (doc_id, library_id) REFERENCES documents (id, library_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS doc_pages_label ON doc_pages (doc_id, label_key);

CREATE TABLE IF NOT EXISTS doc_sections (
  doc_id     uuid     NOT NULL,
  library_id text     NOT NULL,
  ord        integer  NOT NULL,
  parent_ord integer,
  level      smallint NOT NULL CHECK (level BETWEEN 1 AND 6),
  kind       text     NOT NULL CHECK (kind IN ('part','chapter','par','cl','sub','front','toc','index','abbrev','biblio','annex')),
  key        text,
  key_num    numeric,
  heading    text     NOT NULL,
  author     text,
  char_start integer  NOT NULL,
  char_end   integer  NOT NULL,
  page_from  integer,
  page_to    integer,
  indexed    boolean  NOT NULL DEFAULT true,
  PRIMARY KEY (doc_id, ord),
  FOREIGN KEY (doc_id, library_id) REFERENCES documents (id, library_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS doc_sections_key ON doc_sections (doc_id, key) WHERE key IS NOT NULL;

CREATE TABLE IF NOT EXISTS doc_footnotes (
  doc_id      uuid    NOT NULL,
  library_id  text    NOT NULL,
  seq         integer NOT NULL,
  label       text    NOT NULL,
  kind        char(1) NOT NULL DEFAULT 'f' CHECK (kind IN ('f','e')),
  page_ord    integer,
  ref_at      integer,                  -- NULL = dangling definition
  def_start   integer NOT NULL,
  def_end     integer NOT NULL,
  section_ord integer,
  anchor      text,
  PRIMARY KEY (doc_id, seq),
  FOREIGN KEY (doc_id, library_id) REFERENCES documents (id, library_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS doc_footnotes_label ON doc_footnotes (doc_id, label);

-- Search units: a contiguous DMD span (paragraphs + the footnote definitions
-- that follow them), never crossing a heading. tsv is built in the app
-- (stem → fold, weights A heading / B parent heading / C body / D footnotes).
CREATE TABLE IF NOT EXISTS chunks (
  doc_id      uuid    NOT NULL,
  library_id  text    NOT NULL,
  ord         integer NOT NULL,
  char_start  integer NOT NULL,
  char_end    integer NOT NULL,
  page_from   integer,
  page_to     integer,
  section_ord integer,
  anchor_from text,
  anchor_to   text,
  tsv         tsvector NOT NULL,
  ident_keys  text[]   NOT NULL DEFAULT '{}',
  PRIMARY KEY (doc_id, ord),
  FOREIGN KEY (doc_id, library_id) REFERENCES documents (id, library_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS chunks_lib_doc ON chunks (library_id, doc_id);
CREATE INDEX IF NOT EXISTS chunks_tsv ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunks_ident ON chunks USING gin (ident_keys);

-- lz4 where the server supports it (Neon does; PGlite does not): pglz rarely
-- compresses a tsvector at all (it needs a 25 % saving within the first 1 KB).
DO $$ BEGIN
  ALTER TABLE chunks ALTER COLUMN tsv SET COMPRESSION lz4;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Bloat is real on a 0.5 GB budget: vacuum the big tables early.
ALTER TABLE chunks SET (autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE doc_blocks SET (autovacuum_vacuum_scale_factor = 0.02);

-- Counters behind the free-tier guards. No document content lives here.
CREATE TABLE IF NOT EXISTS usage_daily (
  day          date    NOT NULL,
  scope        text    NOT NULL,          -- 'global' | a library id | 'user:<id>'
  uploads      integer NOT NULL DEFAULT 0,
  pages        integer NOT NULL DEFAULT 0,
  ai_calls     integer NOT NULL DEFAULT 0,
  ai_microusd  bigint  NOT NULL DEFAULT 0,
  tool_calls   integer NOT NULL DEFAULT 0,
  reads        integer NOT NULL DEFAULT 0,
  cpu_ms       bigint  NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope)
);

-- One row per minute in which some instance touched the DB — the in-app
-- estimate of Neon compute hours (the consumption API is paid-plan only).
CREATE TABLE IF NOT EXISTS db_activity (
  minute timestamptz PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS system_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS terms_acceptance (
  user_id     text NOT NULL CHECK (user_id ~ '^user_[A-Za-z0-9]+$'),
  version     text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, version)
);

-- Who did what in a (team) library — accountability for deletes and re-uploads.
CREATE TABLE IF NOT EXISTS audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  library_id text NOT NULL,
  actor      text NOT NULL,
  action     text NOT NULL,
  doc_id     uuid,
  at         timestamptz NOT NULL DEFAULT now(),
  detail     jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_lib ON audit_log (library_id, at DESC);

-- Notice-and-action takedowns: content hashes that may not be uploaded again.
CREATE TABLE IF NOT EXISTS blocked_content (
  content_sha256 text PRIMARY KEY CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  reason         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
