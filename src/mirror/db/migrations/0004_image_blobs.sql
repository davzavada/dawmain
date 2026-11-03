-- Pictures stored once: the bytes go to image_blob under their sha256, a
-- decision only points at them. Every NS decision carries the state emblem
-- (105×119 GIF) and every ÚS dissent the same 609×1 rule — ~165k copies of
-- one picture otherwise. GIF joins the allowed types (Domino serves
-- rich-text pictures as GIF); source_url keeps where a fetched picture came
-- from (NS: the Domino element URL).

CREATE TABLE IF NOT EXISTS mirror.image_blob (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime   text NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/gif','image/x-wmf','image/x-emf')),
  bytes  bytea NOT NULL
);

INSERT INTO mirror.image_blob (sha256, mime, bytes)
SELECT DISTINCT ON (sha256) sha256, mime, bytes FROM mirror.decision_image ORDER BY sha256
ON CONFLICT DO NOTHING;

ALTER TABLE mirror.decision_image DROP COLUMN IF EXISTS bytes;
ALTER TABLE mirror.decision_image ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE mirror.decision_image DROP CONSTRAINT IF EXISTS decision_image_mime_check;
ALTER TABLE mirror.decision_image
  ADD CONSTRAINT decision_image_mime_check CHECK (mime IN ('image/png','image/jpeg','image/gif','image/x-wmf','image/x-emf'));
ALTER TABLE mirror.decision_image
  ADD CONSTRAINT decision_image_blob_fk FOREIGN KEY (sha256) REFERENCES mirror.image_blob(sha256);
CREATE INDEX IF NOT EXISTS decision_image_sha ON mirror.decision_image (sha256);

GRANT SELECT, INSERT, UPDATE, DELETE ON mirror.image_blob TO mirror_writer;
GRANT SELECT ON mirror.image_blob TO mirror_reader;
