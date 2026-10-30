-- The source's own metadata of a decision, verbatim as its parser read it
-- (NS: the metadata table incl. Ústavní stížnost; NSS: the detail fields;
-- justice: the open-data item and the document's metadata; ÚS: the NALUS
-- results row). The raw layer: the clean tables (judges, keywords, reports,
-- links) are derived from it, so they can be rebuilt without a download.
-- NULL = fetched before this column existed.

ALTER TABLE mirror.decision ADD COLUMN IF NOT EXISTS source_meta jsonb;
