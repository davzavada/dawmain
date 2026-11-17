-- E-mail messages (.eml) are converted to text in the browser like PDF,
-- DOCX, TXT and Markdown. file_kind only records what the file was before
-- the conversion; the stored text is the same DMD whatever it came from.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_file_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_file_kind_check
  CHECK (file_kind IN ('pdf', 'docx', 'txt', 'md', 'eml'));
