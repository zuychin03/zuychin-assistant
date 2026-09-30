-- Expire Councils after seven consecutive paused days; retain transcripts and pause history.

create or replace function pause_council(p_session_id uuid)
returns jsonb language plpgsql as $$
declare v_row council_sessions;
begin
  update council_sessions set paused_at = now()
   where id = p_session_id and status in ('open', 'concluding') and paused_at is null
  returning * into v_row;
  if v_row.id is not null then
    return jsonb_build_object('ok', true, 'already', false);
  end if;
  select * into v_row from council_sessions where id = p_session_id;
  if v_row.id is null then return jsonb_build_object('ok', false, 'reason', 'no_session'); end if;
  if v_row.status not in ('open', 'concluding') then
    return jsonb_build_object('ok', false, 'reason', 'not_running', 'status', v_row.status);
  end if;
  if v_row.paused_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  return jsonb_build_object('ok', false, 'reason', 'not_running', 'status', v_row.status);
end;
$$;

create or replace function resume_council(p_session_id uuid)
returns jsonb language plpgsql as $$
declare v_row council_sessions; v_paused integer; v_now timestamptz;
begin
  select * into v_row from council_sessions where id = p_session_id for update;
  if v_row.id is null then return jsonb_build_object('ok', false, 'reason', 'no_session'); end if;
  if v_row.status not in ('open', 'concluding') then
    return jsonb_build_object('ok', false, 'reason', 'not_running', 'status', v_row.status);
  end if;
  if v_row.paused_at is null then return jsonb_build_object('ok', true, 'already', true); end if;
  -- Sample after locking: a waiting request must not resume using stale transaction time.
  v_now := clock_timestamp();
  if v_row.paused_at <= v_now - interval '168 hours' then
    update council_sessions set status = 'expired' where id = p_session_id;
    return jsonb_build_object('ok', false, 'reason', 'pause_expired');
  end if;
  v_paused := greatest(0, floor(extract(epoch from (v_now - v_row.paused_at)))::integer);

  -- Restore running deadlines without charging the owner for paused time.
  update council_sessions
     set paused_at = null,
         paused_total_seconds = paused_total_seconds + v_paused,
         expires_at = expires_at + make_interval(secs => v_paused),
         last_message_at = last_message_at + make_interval(secs => v_paused),
         floor_holder = null,
         floor_granted_at = null
   where id = p_session_id;

  -- Paused participants must not resume with stale quorum presence.
  update council_participants set last_seen_at = v_now
   where session_id = p_session_id and status in ('invited', 'active');

  return jsonb_build_object('ok', true, 'already', false, 'paused_seconds', v_paused);
end;
$$;
