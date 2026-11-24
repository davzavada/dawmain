-- A purged library leaves nothing behind (/soukromi): no audit rows — not
-- even a record of the purge — and no library row. The library id is the
-- owner's Clerk id, so a kept row or purge record would still be personal
-- data for as long as the account exists (Pro taken away). A later upload
-- by the same owner starts a new, empty library (ensureLibrary).
-- Same name and signature as in 0003, so the cron needs no change to call it;
-- it returns the number of audit rows deleted.
CREATE OR REPLACE FUNCTION files_forget_purged_audit()
  RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  n bigint;
BEGIN
  WITH gone AS (
    DELETE FROM audit_log a USING libraries l
     WHERE a.library_id = l.id AND l.purged_at IS NOT NULL
    RETURNING 1
  )
  SELECT count(*) INTO n FROM gone;
  -- Its documents and folders are gone already (purgeLibraryContent); the
  -- cascade only covers a race with nothing left to race.
  DELETE FROM libraries WHERE purged_at IS NOT NULL;
  RETURN n;
END
$$;

REVOKE ALL ON FUNCTION files_forget_purged_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION files_forget_purged_audit() TO dawmain_app;
