create table if not exists public.capture_inbox (
    profile_id uuid not null references public.user_profiles(id) on delete cascade,
    id uuid not null,
    source jsonb not null check (jsonb_typeof(source) = 'object' and octet_length(source::text) <= 3000000),
    source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
    receipt jsonb check (receipt is null or jsonb_typeof(receipt) = 'object'),
    ingest_claim jsonb check (ingest_claim is null or jsonb_typeof(ingest_claim) = 'object'),
    created_at timestamptz not null default now(),
    primary key (profile_id, id)
);
create index if not exists capture_inbox_profile_created on public.capture_inbox(profile_id, created_at desc);
alter table public.capture_inbox enable row level security;
revoke all on public.capture_inbox from public, anon, authenticated;
grant select, insert, update, delete on public.capture_inbox to service_role;
alter table public.capture_inbox add column if not exists ingest_claim jsonb;
create or replace function public.assistant_capture_claim(p_profile_id uuid, p_id uuid, p_claim jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare saved jsonb;
begin
    if jsonb_typeof(p_claim) <> 'object' or coalesce(p_claim->>'path', '') = ''
        or coalesce(p_claim->>'contentHash', '') !~ '^[a-f0-9]{64}$' then
        raise exception 'Invalid capture claim';
    end if;
    select ingest_claim into saved from public.capture_inbox where profile_id = p_profile_id and id = p_id for update;
    if not found then raise exception 'Capture not found'; end if;
    if saved is null then
        update public.capture_inbox set ingest_claim = p_claim where profile_id = p_profile_id and id = p_id;
        saved := p_claim;
    end if;
    return saved;
end;
$$;
revoke all on function public.assistant_capture_claim(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.assistant_capture_claim(uuid, uuid, jsonb) to service_role;
