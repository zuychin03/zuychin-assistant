-- Owner notes to Council seats during a work campaign, and Requeue for blocked items.
-- Notes are not debate messages: they never enter council_messages, so a closed Council
-- still refuses debate writes. A null agent_name means every seat; delivered maps a seat
-- name to the time that seat was given the note.
--
-- Safe to run more than once.

begin;

create table if not exists council_owner_notes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references council_sessions(id) on delete cascade,
  agent_name text,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  delivered jsonb not null default '{}'
);
create index if not exists idx_council_owner_notes_session on council_owner_notes (session_id, created_at);
alter table council_owner_notes enable row level security;
revoke all on council_owner_notes from public, anon, authenticated;

create or replace function add_council_owner_note(p_session_id uuid, p_agent_name text, p_body text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session council_sessions; v_campaign council_campaigns; v_note council_owner_notes; v_body text := btrim(coalesce(p_body, ''));
begin
  select * into v_session from council_sessions where id = p_session_id for update;
  if v_session.id is null then return jsonb_build_object('ok', false, 'reason', 'unknown_session'); end if;
  if v_session.status <> 'closed' then return jsonb_build_object('ok', false, 'reason', 'not_closed'); end if;
  select * into v_campaign from council_campaigns where session_id = p_session_id;
  if v_campaign.id is null then return jsonb_build_object('ok', false, 'reason', 'no_campaign'); end if;
  if v_campaign.status not in ('running', 'blocked') or v_campaign.integration_manifest is not null then
    return jsonb_build_object('ok', false, 'reason', 'campaign_finished');
  end if;
  if p_agent_name is not null and not exists (
    select 1 from council_participants where session_id = p_session_id and name = p_agent_name and kind = 'agent'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_seat');
  end if;
  if char_length(v_body) not between 1 and 4000 then return jsonb_build_object('ok', false, 'reason', 'invalid_body'); end if;
  insert into council_owner_notes (session_id, agent_name, body) values (p_session_id, p_agent_name, v_body)
  returning * into v_note;
  return jsonb_build_object('ok', true, 'note', to_jsonb(v_note));
end;
$$;

create or replace function pending_council_owner_notes(p_session_id uuid, p_agent_name text)
returns table (id uuid, agent_name text, body text, created_at timestamptz)
language sql stable security invoker set search_path = public, pg_temp as $$
  select n.id, n.agent_name, n.body, n.created_at from council_owner_notes n
   where n.session_id = p_session_id
     and (n.agent_name is null or n.agent_name = p_agent_name)
     and not (n.delivered ? p_agent_name)
   order by n.created_at, n.id;
$$;

-- Returns only the ids this call marked, so two concurrent readers of the same
-- pending note cannot both deliver it.
create or replace function mark_council_owner_notes_delivered(p_ids uuid[], p_agent_name text)
returns setof uuid language sql security invoker set search_path = public, pg_temp as $$
  update council_owner_notes n
     set delivered = n.delivered || jsonb_build_object(p_agent_name, now())
   where n.id = any(p_ids)
     and (n.agent_name is null or n.agent_name = p_agent_name)
     and not (n.delivered ? p_agent_name)
  returning n.id;
$$;

create or replace function requeue_council_work_item(p_item_id uuid)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session_id uuid; v_campaign council_campaigns; v_item council_work_items;
begin
  select c.session_id into v_session_id from council_work_items i
    join council_campaigns c on c.id = i.campaign_id where i.id = p_item_id;
  if v_session_id is null then return jsonb_build_object('ok', false, 'reason', 'unknown_item'); end if;
  perform 1 from council_sessions where id = v_session_id for update;
  select * into v_campaign from council_campaigns where session_id = v_session_id for update;
  if v_campaign.integration_manifest is not null then return jsonb_build_object('ok', false, 'reason', 'manifest_frozen'); end if;
  if v_campaign.status not in ('running', 'blocked') then return jsonb_build_object('ok', false, 'reason', 'campaign_finished'); end if;
  update council_work_items
     set status = 'queued', attempts = 0, rejections = 0,
         progress = left(concat_ws(E'\n', nullif(progress, ''),
           'Requeued by the owner' || coalesce('. It was blocked: ' || blocked_reason, '') || '.'), 4000),
         blocked_reason = null, lease_owner = null, lease_expires_at = null, heartbeat_at = now()
   where id = p_item_id and status = 'blocked'
  returning * into v_item;
  if v_item.id is null then return jsonb_build_object('ok', false, 'reason', 'not_blocked'); end if;
  update council_campaigns set status = 'running' where id = v_campaign.id and status = 'blocked';
  return jsonb_build_object('ok', true, 'item', to_jsonb(v_item));
end;
$$;

do $$
declare v_function regprocedure;
begin
  for v_function in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(array[
      'add_council_owner_note', 'pending_council_owner_notes', 'mark_council_owner_notes_delivered', 'requeue_council_work_item'
    ])
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

commit;
