-- A file is its name and its text: there is no bibliographic record to fill
-- in or to confirm any more. A document that was still waiting for its
-- metadata to be confirmed ('review' — not searched until then, and nothing
-- on the website confirms it now) becomes searchable like every other.
--
-- The typed metadata columns of `documents` (doc_type, title, authors, year,
-- commented_act, proposed_meta, confirmed_at…) stay where they are, unread:
-- nothing is deleted here. The index of documents derived under the old
-- rules is rebuilt by the app (ANALYZER_VERSION 3, the daily re-derivation).
UPDATE documents SET status = 'ready', status_detail = NULL, updated_at = now() WHERE status = 'review';
