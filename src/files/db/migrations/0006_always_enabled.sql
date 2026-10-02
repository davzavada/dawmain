-- The on/off switch of a document is gone from the web UI and the API: every
-- ready document is searched. Switch back on whatever someone switched off
-- before, so nothing stays hidden with no way to bring it back. The column
-- stays (the search functions of 0004/0005 still read it) and keeps its
-- default true.
UPDATE documents SET enabled = true, updated_at = now() WHERE NOT enabled;
