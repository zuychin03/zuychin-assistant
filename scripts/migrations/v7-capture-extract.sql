-- Source text that Capture fetched or read for a capture (V7). Apply manually; safe to re-run.
-- Kept outside `source`, which is hashed into source_hash for idempotent capture retries.
begin;
do $$ begin
    if to_regclass('public.capture_inbox') is null then
        raise exception 'Apply v6-capture-inbox.sql before v7-capture-extract.sql.';
    end if;
end $$;

alter table public.capture_inbox add column if not exists extract jsonb;

do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'capture_inbox_extract_shape') then
        alter table public.capture_inbox add constraint capture_inbox_extract_shape
            check (extract is null or (jsonb_typeof(extract) = 'object' and octet_length(extract::text) <= 1000000));
    end if;
end $$;

commit;
