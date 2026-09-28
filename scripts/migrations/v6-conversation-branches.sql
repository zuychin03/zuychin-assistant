-- Apply manually after the base setup. Branches never copy summaries or executable actions.
begin;
create table if not exists public.assistant_conversation_branches (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  user_profile_id uuid not null references public.user_profiles(id) on delete cascade,
  request_id uuid unique not null,
  root_conversation_id uuid not null,
  parent_conversation_id uuid not null,
  parent_message_id uuid not null,
  parent_message_created_at timestamptz not null,
  parent_title text not null,
  requested_title text,
  copied_count integer not null check (copied_count > 0),
  created_at timestamptz not null default now()
);
create table if not exists public.assistant_branch_messages (
  message_id uuid primary key references public.messages(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  source_conversation_id uuid not null,
  source_message_id uuid not null,
  source_created_at timestamptz not null,
  ordinal integer not null,
  unique(conversation_id, ordinal)
);
create index if not exists assistant_branch_root on public.assistant_conversation_branches(root_conversation_id, created_at);
alter table public.assistant_conversation_branches enable row level security;
alter table public.assistant_branch_messages enable row level security;
revoke all on public.assistant_conversation_branches, public.assistant_branch_messages from public, anon, authenticated;
grant all on public.assistant_conversation_branches, public.assistant_branch_messages to service_role;

create or replace function public.assistant_branch_metadata(p_metadata jsonb, p_conversation uuid, p_message uuid)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'branchOrigin', jsonb_build_object('conversationId', p_conversation, 'messageId', p_message, 'copied', true),
    'knowledgeOnly', case when p_metadata->'knowledgeOnly' = 'true'::jsonb then true end,
    'replyTo', case when p_metadata->'replyTo'->>'role' in ('user', 'assistant')
      and jsonb_typeof(p_metadata->'replyTo'->'content') = 'string'
      then jsonb_build_object('role', p_metadata->'replyTo'->>'role', 'content', p_metadata->'replyTo'->>'content') end,
    'historicalModels', (select jsonb_agg(distinct jsonb_build_object('providerId', observation->>'providerId', 'modelId', observation->>'modelId'))
      from (
        select value observation from jsonb_array_elements(case when jsonb_typeof(p_metadata->'replyTrace'->'calls') = 'array'
          then p_metadata->'replyTrace'->'calls' else '[]'::jsonb end)
          where value->>'purpose' in ('chat', 'worker', 'orchestration') and value->>'status' = 'success'
        union all
        select value observation from jsonb_array_elements(case when jsonb_typeof(p_metadata->'historicalModels') = 'array'
          then p_metadata->'historicalModels' else '[]'::jsonb end)
      ) identities where jsonb_typeof(observation->'providerId') = 'string' and jsonb_typeof(observation->'modelId') = 'string')
  ));
$$;

create or replace function public.assistant_branch_lineage_immutable()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'Conversation branch lineage is immutable' using errcode = '22023';
end;
$$;
drop trigger if exists assistant_branch_lineage_update on public.assistant_conversation_branches;
create trigger assistant_branch_lineage_update before update on public.assistant_conversation_branches
for each row execute function public.assistant_branch_lineage_immutable();
drop trigger if exists assistant_branch_message_lineage_update on public.assistant_branch_messages;
create trigger assistant_branch_message_lineage_update before update on public.assistant_branch_messages
for each row execute function public.assistant_branch_lineage_immutable();

create or replace function public.assistant_branch_conversation_json(p_id uuid)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select to_jsonb(c) || jsonb_build_object('parent_conversation_id', b.parent_conversation_id,
    'parent_message_id', b.parent_message_id, 'copied_count', coalesce(b.copied_count, 0))
  from public.conversations c left join public.assistant_conversation_branches b on b.conversation_id = c.id where c.id = p_id;
$$;

create or replace function public.assistant_fork_conversation(p_conversation_id uuid, p_message_id uuid, p_request_id uuid, p_user_id uuid, p_title text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  parent public.conversations%rowtype;
  existing public.assistant_conversation_branches%rowtype;
  boundary public.messages%rowtype;
  branch_id uuid := gen_random_uuid();
  root_id uuid;
  copied_id uuid;
  records jsonb;
  source jsonb;
  ordinal integer := 0;
begin
  if p_user_id is null or p_request_id is null or (p_title is not null and (length(trim(p_title)) = 0 or length(trim(p_title)) > 120)) then
    raise exception 'Invalid fork request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  select * into existing from public.assistant_conversation_branches where request_id = p_request_id;
  if found then
    if existing.user_profile_id <> p_user_id or existing.parent_conversation_id <> p_conversation_id
      or existing.parent_message_id <> p_message_id or existing.requested_title is distinct from p_title then
      raise exception 'Fork request conflicts with an earlier request' using errcode = '22023';
    end if;
    return public.assistant_branch_conversation_json(existing.conversation_id);
  end if;
  select * into parent from public.conversations where id = p_conversation_id and user_profile_id = p_user_id for update;
  if not found then raise exception 'Conversation unavailable' using errcode = '42501'; end if;
  select * into boundary from public.messages where id = p_message_id and conversation_id = parent.id and user_profile_id = p_user_id for share;
  if not found then raise exception 'Message unavailable' using errcode = 'P0002'; end if;
  select jsonb_agg(to_jsonb(m) order by m.created_at, m.id) into records from (
    select * from public.messages where conversation_id = parent.id and (created_at, id) <= (boundary.created_at, boundary.id)
    order by created_at, id limit 20001
  ) m;
  if jsonb_array_length(records) > 20000 then raise exception 'Branch is too large' using errcode = '54000'; end if;
  if exists (select 1 from jsonb_array_elements(records) m where (m->>'user_profile_id')::uuid is distinct from p_user_id or m->>'channel' is distinct from boundary.channel) then
    raise exception 'Mixed owner or channel prefix cannot be branched' using errcode = '42501';
  end if;
  select root_conversation_id into root_id from public.assistant_conversation_branches where conversation_id = parent.id;
  root_id := coalesce(root_id, parent.id);
  insert into public.conversations(id, user_profile_id, project_id, title)
    values (branch_id, parent.user_profile_id, parent.project_id, coalesce(trim(p_title), left(coalesce(parent.title, 'Conversation'), 110) || ' (branch)'));
  insert into public.assistant_conversation_branches(conversation_id, user_profile_id, request_id, root_conversation_id, parent_conversation_id,
    parent_message_id, parent_message_created_at, parent_title, requested_title, copied_count)
    values (branch_id, p_user_id, p_request_id, root_id, parent.id, boundary.id, boundary.created_at, coalesce(parent.title, 'Conversation'), p_title, jsonb_array_length(records));
  for source in select value from jsonb_array_elements(records) loop
    ordinal := ordinal + 1;
    -- Preserve the source order even when timestamps are equal.
    copied_id := (substr(replace(branch_id::text, '-', ''), 1, 24) || lpad(to_hex(ordinal), 8, '0'))::uuid;
    insert into public.messages(id, conversation_id, user_profile_id, role, content, channel, image_url, metadata, created_at)
      values (copied_id, branch_id, parent.user_profile_id, source->>'role', source->>'content', source->>'channel', source->>'image_url',
        public.assistant_branch_metadata(source->'metadata', parent.id, (source->>'id')::uuid), (source->>'created_at')::timestamptz);
    insert into public.assistant_branch_messages(message_id, conversation_id, source_conversation_id, source_message_id, source_created_at, ordinal)
      values (copied_id, branch_id, parent.id, (source->>'id')::uuid, (source->>'created_at')::timestamptz, ordinal);
  end loop;
  return public.assistant_branch_conversation_json(branch_id);
end;
$$;

create or replace function public.assistant_related_conversations(p_conversation_id uuid, p_user_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with current_conversation as (
    select c.id, coalesce(b.root_conversation_id, c.id) root_id from public.conversations c
    left join public.assistant_conversation_branches b on b.conversation_id = c.id where c.id = p_conversation_id and c.user_profile_id = p_user_id
  ) select jsonb_build_object('current', public.assistant_branch_conversation_json(current_conversation.id),
    'related', coalesce((select jsonb_agg(public.assistant_branch_conversation_json(c.id) order by c.created_at, c.id)
      from public.conversations c left join public.assistant_conversation_branches b on b.conversation_id = c.id
      where c.user_profile_id = p_user_id and c.id <> current_conversation.id
        and (c.id = current_conversation.root_id or b.root_conversation_id = current_conversation.root_id)), '[]'::jsonb)) from current_conversation;
$$;

create or replace function public.assistant_compare_conversations(p_left uuid, p_right uuid, p_user_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with allowed as (
    select c.id, coalesce(b.root_conversation_id, c.id) root_id from public.conversations c
      left join public.assistant_conversation_branches b on b.conversation_id = c.id
      where c.id in (p_left, p_right) and c.user_profile_id = p_user_id
  ), sides as (
    select a.id, jsonb_build_object('conversation', public.assistant_branch_conversation_json(a.id),
      'messages', coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at, m.id) from (
        select id, role, content, channel, image_url, metadata, created_at from public.messages where conversation_id = a.id and user_profile_id = p_user_id
          order by created_at, id limit 20001
      ) m), '[]'::jsonb)) data from allowed a
  ) select jsonb_build_object('left', (select data from sides where id = p_left), 'right', (select data from sides where id = p_right))
    where p_left <> p_right and (select count(*) from allowed) = 2 and (select count(distinct root_id) from allowed) = 1;
$$;

revoke all on function public.assistant_branch_metadata(jsonb, uuid, uuid) from public, anon, authenticated;
revoke all on function public.assistant_branch_lineage_immutable() from public, anon, authenticated;
revoke all on function public.assistant_branch_conversation_json(uuid) from public, anon, authenticated;
revoke all on function public.assistant_fork_conversation(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.assistant_related_conversations(uuid, uuid) from public, anon, authenticated;
revoke all on function public.assistant_compare_conversations(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.assistant_fork_conversation(uuid, uuid, uuid, uuid, text) to service_role;
grant execute on function public.assistant_related_conversations(uuid, uuid) to service_role;
grant execute on function public.assistant_compare_conversations(uuid, uuid, uuid) to service_role;
commit;
