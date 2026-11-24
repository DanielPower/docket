-- Merging inbox documents (an invoice and a receipt scanned separately, say).
-- The document merged into keeps its id; the others go to the trash with
-- merged_into set, so Undo is a restore.
alter table document add column if not exists merged_into uuid references entity(id) on delete set null;
-- The uploads the document is made of, in page order: [{ id, filename, mimeType, originalPath, pages }].
-- Null for a document that was never merged. original_path then holds a PDF of all of them.
alter table document add column if not exists merge_parts jsonb;
-- The document as it was before its latest merge, for Undo. Its files are archive/<id>.premerge.pdf
-- (and .premerge.base.pdf when it had page edits).
alter table document add column if not exists premerge jsonb;
