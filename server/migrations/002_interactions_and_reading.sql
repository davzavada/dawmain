-- The interactions journal: one entry per person per touchpoint.
CREATE TABLE interactions (
  id         INTEGER PRIMARY KEY,
  person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,                 -- YYYY, YYYY-MM or YYYY-MM-DD
  kind       TEXT NOT NULL DEFAULT 'other', -- app-level list in shared/interactionKinds.ts
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_interactions_person ON interactions(person_id);
CREATE INDEX idx_interactions_date ON interactions(date);

-- Reading list: papers the user likes / wants to read.
ALTER TABLE publications ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publications ADD COLUMN read_status TEXT NOT NULL DEFAULT 'none'
  CHECK (read_status IN ('none','to_read','read'));

-- One institution per ROR id (resolveInstitution matches by it).
CREATE UNIQUE INDEX idx_institutions_ror ON institutions(ror_id) WHERE ror_id IS NOT NULL;
