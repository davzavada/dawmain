CREATE TABLE people (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,
  titles              TEXT,
  email               TEXT,
  website             TEXT,
  country             TEXT,
  note                TEXT,
  orcid               TEXT,
  openalex_id         TEXT,
  semantic_scholar_id TEXT,
  source              TEXT NOT NULL DEFAULT 'manual',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_people_orcid ON people(orcid) WHERE orcid IS NOT NULL;
CREATE INDEX idx_people_name ON people(name COLLATE NOCASE);

CREATE TABLE institutions (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  short_name  TEXT,
  city        TEXT,
  country     TEXT,
  url         TEXT,
  ror_id      TEXT,
  openalex_id TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_institutions_name ON institutions(name COLLATE NOCASE);

-- person <-> institution with a time range; end_date NULL = current
CREATE TABLE affiliations (
  id             INTEGER PRIMARY KEY,
  person_id      INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  role           TEXT,
  start_date     TEXT,
  end_date       TEXT,
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_affiliations_person ON affiliations(person_id);
CREATE INDEX idx_affiliations_institution ON affiliations(institution_id);

CREATE TABLE publications (
  id                  INTEGER PRIMARY KEY,
  title               TEXT NOT NULL,
  year                INTEGER,
  venue               TEXT,
  type                TEXT NOT NULL DEFAULT 'article'
                      CHECK (type IN ('article','book','chapter','conference_paper','thesis','other')),
  doi                 TEXT,
  url                 TEXT,
  abstract            TEXT,
  language            TEXT,
  openalex_id         TEXT,
  semantic_scholar_id TEXT,
  source              TEXT NOT NULL DEFAULT 'manual',
  note                TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_publications_doi ON publications(doi) WHERE doi IS NOT NULL;
CREATE INDEX idx_publications_title ON publications(title COLLATE NOCASE);
CREATE INDEX idx_publications_year ON publications(year);

-- ordered authorship; the raw as-printed author string is always kept,
-- person_id stays NULL until the author is (or becomes) a contact
CREATE TABLE publication_authors (
  publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  author_name    TEXT NOT NULL,
  person_id      INTEGER REFERENCES people(id) ON DELETE SET NULL,
  PRIMARY KEY (publication_id, position)
);
CREATE INDEX idx_pub_authors_person ON publication_authors(person_id);
CREATE INDEX idx_pub_authors_name ON publication_authors(author_name COLLATE NOCASE);

-- manual person <-> person edges, stored directed; symmetry is decided by
-- the relation type (shared/relationTypes.ts) at the application level
CREATE TABLE relations (
  id             INTEGER PRIMARY KEY,
  from_person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  to_person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,
  date           TEXT,
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (from_person_id <> to_person_id),
  UNIQUE (from_person_id, to_person_id, type)
);
CREATE INDEX idx_relations_from ON relations(from_person_id);
CREATE INDEX idx_relations_to   ON relations(to_person_id);

CREATE TABLE tags (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL COLLATE NOCASE UNIQUE,
  color TEXT
);
CREATE TABLE person_tags (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, tag_id)
);

-- author names the user chose not to track; keeps the suggestions inbox quiet
CREATE TABLE dismissed_suggestions (
  author_name  TEXT COLLATE NOCASE PRIMARY KEY,
  dismissed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
