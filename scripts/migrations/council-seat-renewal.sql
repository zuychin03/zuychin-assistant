-- ===== Bounded Council campaign seat renewal =====

begin;

create or replace function public.renew_council_host_lease(
  p_session_id uuid, p_host_id uuid, p_lease_epoch bigint,
  p_duration_seconds integer default 45
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_session council_sessions;
  v_lease council_host_leases;
  v_campaign council_campaigns;
  v_key council_seat_keys;
  v_now timestamptz;
  v_duration integer;
begin
  v_duration := greatest(15, least(coalesce(p_duration_seconds, 45), 300));
  select * into v_session from council_sessions where id = p_session_id for share;
  if v_session.id is null then return jsonb_build_object('ok', false, 'reason', 'no_session'); end if;
  if v_session.protocol_version <> 3 then return jsonb_build_object('ok', false, 'reason', 'not_v3'); end if;
  if v_session.status = 'expired' then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  select * into v_lease from council_host_leases where session_id = p_session_id for update;
  if v_lease.session_id is null then return jsonb_build_object('ok', false, 'reason', 'no_lease'); end if;
  if v_lease.host_id is distinct from p_host_id or v_lease.lease_epoch is distinct from p_lease_epoch then
    return jsonb_build_object('ok', false, 'reason', 'stale_epoch');
  end if;
  select * into v_campaign from council_campaigns where session_id = p_session_id for share;
  v_now := clock_timestamp();
  if v_lease.released_at is not null or v_lease.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'lease_expired');
  end if;
  update council_host_leases
     set lease_expires_at = v_now + make_interval(secs => v_duration), last_heartbeat_at = v_now
   where session_id = p_session_id returning * into v_lease;

  if v_session.status in ('open', 'concluding', 'closed') and v_session.paused_at is null and v_campaign.id is not null and (
    v_campaign.status in ('running', 'blocked') or
    (v_campaign.status = 'complete' and coalesce(v_campaign.integration_status, 'pending') in ('pending', 'running'))
  ) then
    -- Busy credential writes must not stall the host heartbeat.
    for v_key in
      select k.* from council_seat_keys k
       where k.session_id = p_session_id and k.issued_by = 'host'
         and k.host_id = p_host_id and k.lease_epoch = p_lease_epoch
         and k.revoked_at is null and k.expires_at > v_now
         and k.expires_at <= v_now + interval '1 hour'
         and exists (select 1 from council_participants p
           where p.session_id = k.session_id and p.name = k.seat_name and p.kind = 'agent')
       for update of k skip locked
    loop
      v_now := clock_timestamp();
      if v_key.expires_at > v_now then
        update council_seat_keys set expires_at = v_now + interval '24 hours' where id = v_key.id;
      end if;
    end loop;
  end if;
  return jsonb_build_object(
    'ok', true, 'hostId', v_lease.host_id, 'leaseEpoch', v_lease.lease_epoch,
    'leaseExpiresAt', v_lease.lease_expires_at
  );
end;
$$;

revoke all on function public.renew_council_host_lease(uuid, uuid, bigint, integer) from public, anon, authenticated;
grant execute on function public.renew_council_host_lease(uuid, uuid, bigint, integer) to service_role;

create or replace function public.issue_council_seat_key(
  p_session_id uuid, p_seat_name text, p_token_hash text, p_expires_at timestamptz
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session council_sessions; v_campaign council_campaigns; v_kind text; v_now timestamptz;
begin
  select * into v_session from council_sessions where id = p_session_id for share;
  if v_session.id is null or v_session.status not in ('open', 'concluding', 'closed') or v_session.paused_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'inactive_session');
  end if;
  if v_session.status = 'closed' then
    select * into v_campaign from council_campaigns where session_id = p_session_id for share;
    if v_campaign.id is null or not (
      v_campaign.status in ('running', 'blocked') or
      (v_campaign.status = 'complete' and coalesce(v_campaign.integration_status, 'pending') in ('pending', 'running'))
    ) then return jsonb_build_object('ok', false, 'reason', 'inactive_session'); end if;
  end if;
  select kind into v_kind from council_participants
   where session_id = p_session_id and name = p_seat_name for share;
  if v_kind is null then return jsonb_build_object('ok', false, 'reason', 'not_on_roster'); end if;
  if v_kind <> 'agent' then return jsonb_build_object('ok', false, 'reason', 'not_an_agent_seat'); end if;
  v_now := clock_timestamp();
  if p_expires_at is null or not isfinite(p_expires_at) or p_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'invalid_expiry');
  end if;
  insert into council_seat_keys (
    session_id, seat_name, token_hash, expires_at, issued_by, host_id, lease_epoch
  ) values (
    p_session_id, p_seat_name, p_token_hash, least(p_expires_at, v_now + interval '24 hours'), 'owner', null, null
  ) on conflict (session_id, seat_name) do update
    set token_hash = excluded.token_hash, expires_at = excluded.expires_at,
        issued_at = clock_timestamp(), claimed_at = null, revoked_at = null,
        issued_by = 'owner', host_id = null, lease_epoch = null;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.issue_council_seat_key(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.issue_council_seat_key(uuid, text, text, timestamptz) to service_role;

create or replace function public.resolve_council_seat_key(p_token_hash text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_seed council_seat_keys;
  v_key council_seat_keys;
  v_lease council_host_leases;
  v_status text;
  v_code text;
  v_now timestamptz;
begin
  -- The first lookup only chooses the session and lease lock order.
  select * into v_seed from council_seat_keys where token_hash = p_token_hash;
  if v_seed.id is null then return null; end if;
  select status, code into v_status, v_code from council_sessions
   where id = v_seed.session_id for share;
  if v_status is null or v_status = 'expired' then return null; end if;
  if v_seed.issued_by = 'host' then
    select * into v_lease from council_host_leases where session_id = v_seed.session_id for share;
  end if;
  select * into v_key from council_seat_keys
   where id = v_seed.id and token_hash = p_token_hash for update;
  v_now := clock_timestamp();
  if v_key.id is null or v_key.revoked_at is not null or v_key.expires_at <= v_now then return null; end if;
  if row(v_key.session_id, v_key.seat_name, v_key.issued_by, v_key.host_id, v_key.lease_epoch)
     is distinct from row(v_seed.session_id, v_seed.seat_name, v_seed.issued_by, v_seed.host_id, v_seed.lease_epoch) then
    return null;
  end if;
  if v_key.issued_by = 'host' and (
    v_lease.session_id is null or v_lease.host_id is distinct from v_key.host_id
    or v_lease.lease_epoch is distinct from v_key.lease_epoch
    or v_lease.released_at is not null or v_lease.lease_expires_at <= v_now
  ) then return null; end if;
  update council_seat_keys set claimed_at = coalesce(claimed_at, v_now) where id = v_key.id;
  return jsonb_build_object('session_id', v_key.session_id, 'seat_name', v_key.seat_name,
                           'code', v_code, 'issuer', v_key.issued_by);
end;
$$;

revoke all on function public.resolve_council_seat_key(text) from public, anon, authenticated;
grant execute on function public.resolve_council_seat_key(text) to service_role;

commit;
