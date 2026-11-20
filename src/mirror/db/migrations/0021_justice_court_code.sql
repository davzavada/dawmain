-- The court code of a general court's decision is the third part of its ECLI ("ECLI:CZ:KSBR:2024:…"),
-- which the open-data listing gives for every decision; justice_search's court_codes filters by it
-- (src/mirror/api/queries.ts, courtCodeIn — the expression and the source literal as here). An
-- expression index over the justice rows only (616k): no column, no rewrite of the table.
-- Migrations run in a transaction, so this cannot say CONCURRENTLY and would hold off the crawler's
-- writes while it builds (seconds; reads go on). To avoid even that, build it by hand first as
-- mirror_owner — this then finds it by name:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS decision_justice_court_code
--     ON mirror.decision (split_part(ecli, ':', 3), decided_on) WHERE source = 'justice';
CREATE INDEX IF NOT EXISTS decision_justice_court_code
  ON mirror.decision (split_part(ecli, ':', 3), decided_on) WHERE source = 'justice';
