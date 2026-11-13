-- Legislation the decisions cite, and what they cite of it (decided 26. 10.:
-- search by § / článek down to odstavec, písmeno, bod; every act, not a list).
--
-- act            the registry: every act of the Sbírka zákonů and the Sbírka
--                mezinárodních smluv (e-Sbírka open data, 002PravniAkt) and
--                every EU regulation, directive and decision (Cellar), plus
--                the primary law cited by name (SFEU, SEU, Listina EU).
--                Ids as elsewhere: zak:89/2012, sm:12/2005, eu:32016R0679.
-- act_alias      how decisions refer to an act without its number: names
--                (from the official titles), abbreviations (the act table of
--                src/files/index/acts.ts, and those the case law defines,
--                mined), each with its origin and how often it was seen.
-- decision_provision  DERIVED from the text (rebuilt by `mirror reindex`):
--                every provision a decision cites, at every level —
--                par:2913, par:2913/1, par:2913/1/b — with the act when it
--                could be resolved ('' when not), how often and where first.

CREATE TABLE IF NOT EXISTS mirror.act (
  id         text PRIMARY KEY CHECK (id ~ '^(zak|sm|eu):'),
  collection text NOT NULL CHECK (collection IN ('sb','sm','eu')),
  kind       text,                 -- zákon, vyhláška, nařízení vlády, sdělení … / nařízení, směrnice, rozhodnutí (EU)
  number     text,
  year       smallint,
  title      text NOT NULL,
  short_title text,                -- the official short citation: "(zákon o obchodních korporacích)"
  origin     text NOT NULL CHECK (origin IN ('esbirka','cellar','manual')),
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mirror.act_alias (
  alias      text NOT NULL,        -- as written: "o. s. ř.", "zákon o obchodních korporacích"
  act_id     text NOT NULL REFERENCES mirror.act(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('name','abbreviation')),
  origin     text NOT NULL CHECK (origin IN ('title','table','caselaw','manual')),
  seen       integer NOT NULL DEFAULT 0,   -- definitions found in the case law
  PRIMARY KEY (alias, act_id)
);

CREATE TABLE IF NOT EXISTS mirror.decision_provision (
  decision_id bigint NOT NULL REFERENCES mirror.decision(id) ON DELETE CASCADE,
  act_id      text NOT NULL DEFAULT '',  -- '' = the act could not be resolved
  provision   text NOT NULL CHECK (provision ~ '^(par|cl):'),
  mentions    integer NOT NULL CHECK (mentions > 0),
  first_at    integer NOT NULL CHECK (first_at >= 0),
  PRIMARY KEY (decision_id, act_id, provision)
);

CREATE INDEX IF NOT EXISTS decision_provision_lookup ON mirror.decision_provision (act_id, provision);

GRANT SELECT, INSERT, UPDATE, DELETE ON mirror.act, mirror.act_alias, mirror.decision_provision TO mirror_writer;
GRANT SELECT ON mirror.act, mirror.act_alias, mirror.decision_provision TO mirror_reader;
