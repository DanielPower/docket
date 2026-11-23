-- Tell listeners (the web server's live updates) when a document arrives,
-- changes status or is deleted. A trigger catches every path: the consume
-- folder, uploads, the worker (which may run in another process) and the API.
create function notify_document_change() returns trigger language plpgsql as $$
declare
  r record := coalesce(new, old);
begin
  perform pg_notify('docket_document', json_build_object('id', r.entity_id, 'status', case when tg_op = 'DELETE' then null else r.status end)::text);
  return null;
end $$;

create trigger document_change_notify
  after insert or delete or update of status on document
  for each row execute function notify_document_change();
