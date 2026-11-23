-- Page edits (rotate, flip, straighten, crop, reorder, remove) rewrite the searchable PDF.
-- page_edits lists the output pages, each relative to the searchable PDF as first produced,
-- which is kept at archive/<id>.base.pdf while edits exist. Null means unedited.
alter table document add column if not exists page_edits jsonb;
-- Bumped whenever the searchable PDF is rewritten, so the viewer reloads it.
alter table document add column if not exists pages_edited_at timestamptz;
