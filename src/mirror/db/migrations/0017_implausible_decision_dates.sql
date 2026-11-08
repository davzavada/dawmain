-- A datum vydání that cannot be one — in the future or before 1990 — is no date (169 of justice:
-- 1168-10-28, 2944-04-30, typos of the source and some of the court's own). The text has no signature
-- date to take instead; the source's value stays in decision_raw. mapJustice does the same from now on
-- (plausibleDecidedOn) and flags the record. The trigger of 0013 carries the NULL to decision_text.
UPDATE mirror.decision
SET decided_on = NULL,
    source_flags = array_append(source_flags, 'decided_on_implausible')
WHERE decided_on IS NOT NULL
  AND (decided_on > current_date OR decided_on < DATE '1990-01-01')
  AND NOT ('decided_on_implausible' = ANY(source_flags));
