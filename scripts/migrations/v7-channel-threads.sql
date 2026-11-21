-- Telegram and Discord as full channels (V7). Apply manually; safe to re-run.
-- assistant_channel_updates: each Telegram update_id runs once, since Telegram re-sends any update it saw no 200 for.
-- assistant_channel_threads: each chat's current conversation; /new or a quiet gap starts the next one.
-- assistant_approval_notices: the Telegram message carrying an approval's buttons, so a decision can edit it.
begin;
do $$ begin
    if to_regclass('public.conversations') is null or to_regclass('public.user_profiles') is null
        or to_regclass('public.assistant_action_approvals') is null then
        raise exception 'Run supabase-setup.sql before v7-channel-threads.sql.';
    end if;
end $$;

create table if not exists public.assistant_channel_updates (
  channel text not null check (channel in ('telegram', 'discord')),
  update_key text not null check (char_length(update_key) between 1 and 128),
  received_at timestamptz not null default now(),
  primary key (channel, update_key)
);
create index if not exists assistant_channel_updates_received on public.assistant_channel_updates (received_at);

alter table public.assistant_channel_updates enable row level security;
revoke all on public.assistant_channel_updates from public, anon, authenticated;

alter table public.conversations add column if not exists channel text not null default 'web';
do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'conversations_channel_check') then
        alter table public.conversations add constraint conversations_channel_check check (channel in ('web', 'discord', 'telegram'));
    end if;
end $$;

create table if not exists public.assistant_channel_threads (
  channel text not null check (channel in ('telegram', 'discord')),
  chat_key text not null check (char_length(chat_key) between 1 and 128),
  user_profile_id uuid references public.user_profiles(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  last_activity_at timestamptz not null default now(),
  primary key (channel, chat_key)
);

alter table public.assistant_channel_threads enable row level security;
revoke all on public.assistant_channel_threads from public, anon, authenticated;

-- Locks the chat's row, so two updates arriving together share one conversation.
create or replace function public.assistant_channel_thread(p_channel text, p_chat_key text, p_profile uuid, p_gap_seconds integer, p_force_new boolean)
returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.assistant_channel_threads;
  c uuid;
begin
  if p_channel not in ('telegram', 'discord') then raise exception 'Unsupported channel %', p_channel; end if;
  if p_gap_seconds is null or p_gap_seconds < 60 then raise exception 'The quiet gap must be at least 60 seconds'; end if;
  insert into public.assistant_channel_threads (channel, chat_key, user_profile_id)
    values (p_channel, p_chat_key, p_profile) on conflict (channel, chat_key) do nothing;
  select * into t from public.assistant_channel_threads where channel = p_channel and chat_key = p_chat_key for update;
  if not coalesce(p_force_new, false) and t.conversation_id is not null
    and t.user_profile_id is not distinct from p_profile
    and t.last_activity_at > now() - make_interval(secs => p_gap_seconds) then
    c := t.conversation_id;
  else
    insert into public.conversations (title, user_profile_id, channel) values ('New Chat', p_profile, p_channel) returning id into c;
  end if;
  update public.assistant_channel_threads set conversation_id = c, user_profile_id = p_profile, last_activity_at = now()
    where channel = p_channel and chat_key = p_chat_key;
  return c;
end;
$$;

revoke all on function public.assistant_channel_thread(text, text, uuid, integer, boolean) from public, anon, authenticated;
grant execute on function public.assistant_channel_thread(text, text, uuid, integer, boolean) to service_role;

-- Chat approvals (asked in a live chat turn) share the scheduled approvals' table, decide RPC and state machine.
alter table public.assistant_action_approvals alter column task_id drop not null;
alter table public.assistant_action_approvals alter column run_id drop not null;
alter table public.assistant_action_approvals add column if not exists source text not null default 'scheduled';
alter table public.assistant_action_approvals add column if not exists channel text;
alter table public.assistant_action_approvals add column if not exists conversation_id uuid references public.conversations(id) on delete set null;
alter table public.assistant_action_approvals add column if not exists turn_id uuid;
do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'assistant_action_source_check') then
        -- conversation_id is not required: deleting the conversation sets it null.
        alter table public.assistant_action_approvals add constraint assistant_action_source_check check (
          (source = 'scheduled' and task_id is not null and run_id is not null)
          or (source = 'chat' and turn_id is not null and channel in ('telegram', 'discord', 'web')));
    end if;
end $$;
create unique index if not exists assistant_action_chat_once on public.assistant_action_approvals (turn_id, tool, args_hash) where source = 'chat';

create or replace function public.assistant_action_immutable()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if row(old.id,old.task_id,old.run_id,old.user_profile_id,old.task_title,old.tool,old.args,old.args_hash,old.instruction,old.source_context,old.created_at,old.expires_at,old.source,old.channel,old.turn_id)
    is distinct from row(new.id,new.task_id,new.run_id,new.user_profile_id,new.task_title,new.tool,new.args,new.args_hash,new.instruction,new.source_context,new.created_at,new.expires_at,new.source,new.channel,new.turn_id)
    or (new.conversation_id is not null and new.conversation_id is distinct from old.conversation_id)
    then raise exception 'Approval payload is immutable'; end if;
  if old.status <> new.status and not (
    (old.status='pending' and new.status in ('executing','rejected','expired'))
    or (old.status='executing' and new.status in ('succeeded','outcome_unknown'))
  ) then raise exception 'Invalid approval transition'; end if;
  return new;
end;
$$;

-- Same as v6-scheduled-actions.sql, except a chat approval has no task row to lock.
create or replace function public.assistant_decide_action(p_id uuid,p_user_id uuid,p_decision text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.assistant_action_approvals; task uuid;
begin
  if p_decision not in ('approve','reject') then raise exception 'Invalid decision'; end if;
  select * into a from public.assistant_action_approvals where id=p_id and user_profile_id=p_user_id;
  if not found then return null; end if;
  task := a.task_id;
  if task is not null then
    perform 1 from public.scheduled_tasks where id=task and user_profile_id=p_user_id for update;
    if not found then return null; end if;
  end if;
  select * into a from public.assistant_action_approvals where id=p_id and user_profile_id=p_user_id for update;
  if not found then return null; end if;
  if a.status='pending' and a.expires_at <= now() then
    update public.assistant_action_approvals set status='expired' where id=a.id returning * into a;
  end if;
  if a.status <> 'pending' then return jsonb_build_object('claimed',false,'approval',to_jsonb(a)); end if;
  update public.assistant_action_approvals set status=case when p_decision='approve' then 'executing' else 'rejected' end,
    decided_at=now(), execution_token=case when p_decision='approve' then gen_random_uuid() else null end
    where id=a.id returning * into a;
  return jsonb_build_object('claimed',true,'approval',to_jsonb(a));
end;
$$;
revoke all on function public.assistant_decide_action(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.assistant_decide_action(uuid,uuid,text) to service_role;

create table if not exists public.assistant_approval_notices (
  approval_id uuid not null references public.assistant_action_approvals(id) on delete cascade,
  channel text not null check (channel in ('telegram', 'discord')),
  chat_id text not null check (char_length(chat_id) between 1 and 64),
  message_id bigint,
  created_at timestamptz not null default now(),
  primary key (approval_id, channel)
);

alter table public.assistant_approval_notices enable row level security;
revoke all on public.assistant_approval_notices from public, anon, authenticated;

-- A send asked for in a live chat turn waits for the owner. One row per turn and exact action; it expires after an hour.
create or replace function public.assistant_propose_chat_action(p_profile uuid, p_conversation uuid, p_turn uuid, p_channel text,
  p_tool text, p_args jsonb, p_hash text, p_instruction text, p_sources text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.assistant_action_approvals;
begin
  if p_profile is null or p_turn is null then raise exception 'A chat approval needs an owner and a turn'; end if;
  insert into public.assistant_action_approvals(user_profile_id, task_title, tool, args, args_hash, instruction, source_context,
      expires_at, source, channel, conversation_id, turn_id)
    values (p_profile, case p_channel when 'telegram' then 'Telegram chat' when 'discord' then 'Discord chat' else 'Web chat' end,
      p_tool, p_args, p_hash, left(coalesce(p_instruction, ''), 20000), left(coalesce(p_sources, ''), 16000),
      now() + interval '1 hour', 'chat', p_channel, p_conversation, p_turn)
    on conflict (turn_id, tool, args_hash) where source = 'chat' do nothing;
  select * into a from public.assistant_action_approvals where source = 'chat' and turn_id = p_turn and tool = p_tool and args_hash = p_hash;
  if a.args <> p_args or a.user_profile_id <> p_profile then raise exception 'Action identity conflict'; end if;
  return to_jsonb(a);
end;
$$;
revoke all on function public.assistant_propose_chat_action(uuid, uuid, uuid, text, text, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.assistant_propose_chat_action(uuid, uuid, uuid, text, text, jsonb, text, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
