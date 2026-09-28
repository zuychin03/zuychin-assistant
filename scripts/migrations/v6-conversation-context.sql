-- Assistant history only. Apply manually before enabling durable summary reuse.
begin;

create table if not exists public.assistant_context_revisions (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  revision bigint not null default 0
);
create table if not exists public.assistant_conversation_summaries (
  scope_key text primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  generation bigint not null,
  summary jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.assistant_context_revisions enable row level security;
alter table public.assistant_conversation_summaries enable row level security;
revoke all on public.assistant_context_revisions, public.assistant_conversation_summaries from public, anon, authenticated;
grant all on public.assistant_context_revisions, public.assistant_conversation_summaries to service_role;
insert into public.assistant_context_revisions (conversation_id)
select id from public.conversations on conflict do nothing;

create or replace function public.assistant_context_touch()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  old_id uuid;
  new_id uuid;
  target_id uuid;
begin
  if tg_table_name = 'conversations' then
    if tg_op = 'UPDATE' and old.project_id is not distinct from new.project_id then return new; end if;
    new_id := new.id;
  else
    if tg_op = 'UPDATE' and
      row(old.id, old.role, old.content, old.channel, old.user_profile_id, old.conversation_id, old.created_at, old.image_url, old.metadata->'replyTo')
      is not distinct from
      row(new.id, new.role, new.content, new.channel, new.user_profile_id, new.conversation_id, new.created_at, new.image_url, new.metadata->'replyTo')
      then return new;
    end if;
    if tg_op <> 'INSERT' then old_id := old.conversation_id; end if;
    if tg_op <> 'DELETE' then new_id := new.conversation_id; end if;
  end if;
  for target_id in select distinct x from unnest(array[old_id, new_id]) x where x is not null order by x loop
    insert into public.assistant_context_revisions (conversation_id, revision)
      select id, 1 from public.conversations where id = target_id
      on conflict (conversation_id) do update set revision = assistant_context_revisions.revision + 1;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists assistant_context_messages_changed on public.messages;
create trigger assistant_context_messages_changed before insert or update or delete on public.messages
for each row execute function public.assistant_context_touch();
drop trigger if exists assistant_context_conversation_changed on public.conversations;
create trigger assistant_context_conversation_changed after insert or update of project_id on public.conversations
for each row execute function public.assistant_context_touch();

create or replace function public.assistant_context_snapshot(p_conversation_id uuid, p_channel text, p_user_id uuid, p_scope text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'revision', coalesce(r.revision, 0)::text,
    'project_id', c.project_id,
    'summary', case when s.summary is null then null else s.summary || jsonb_build_object('generation', s.generation) end,
    'messages', coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at, m.id) from (
      select id, role, content, channel, created_at, image_url, metadata from public.messages
      where conversation_id = c.id and channel = p_channel and user_profile_id is not distinct from p_user_id
      order by created_at, id limit 20001
    ) m), '[]'::jsonb)
  ) from public.conversations c
  left join public.assistant_context_revisions r on r.conversation_id = c.id
  left join public.assistant_conversation_summaries s on s.scope_key = p_scope and s.conversation_id = c.id
  where c.id = p_conversation_id and c.user_profile_id is not distinct from p_user_id;
$$;

create or replace function public.assistant_context_save(p_conversation_id uuid, p_scope text, p_revision bigint, p_generation bigint, p_summary jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  current_revision bigint;
  saved_rows integer;
begin
  select revision into current_revision from public.assistant_context_revisions
    where conversation_id = p_conversation_id for update;
  if current_revision is null or current_revision <> p_revision then return false; end if;
  if p_generation is null or p_generation < 0 or p_summary->>'scope' is distinct from p_scope
    or p_summary->>'version' is distinct from '1'
    or (p_summary->>'generation')::bigint is distinct from p_generation + 1 then return false; end if;
  if p_generation = 0 then
    insert into public.assistant_conversation_summaries (scope_key, conversation_id, generation, summary)
      values (p_scope, p_conversation_id, 1, p_summary) on conflict do nothing;
  else
    update public.assistant_conversation_summaries set generation = p_generation + 1, summary = p_summary, updated_at = now()
      where scope_key = p_scope and conversation_id = p_conversation_id and generation = p_generation;
  end if;
  get diagnostics saved_rows = row_count;
  return saved_rows = 1;
end;
$$;

revoke all on function public.assistant_context_touch() from public, anon, authenticated;
revoke all on function public.assistant_context_snapshot(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.assistant_context_save(uuid, text, bigint, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.assistant_context_snapshot(uuid, text, uuid, text) to service_role;
grant execute on function public.assistant_context_save(uuid, text, bigint, bigint, jsonb) to service_role;
commit;
