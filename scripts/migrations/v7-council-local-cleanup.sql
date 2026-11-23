-- Local council retirement, P6: drop the tables and functions only the retired local host used
-- (campaigns, work items, host verification, integration, owner notes, durable delivery, guest
-- seat keys). Online councils keep sessions, messages, participants, owner messages, host leases,
-- host-issued seat keys and execution records. Take a database dump before running this.
-- Safe to re-run. No CASCADE: an unexpected dependency fails the whole transaction instead.

begin;

-- Same body without the campaign branch, which only ever renewed keys during a code campaign.
create or replace function public.renew_council_host_lease(
  p_session_id uuid, p_host_id uuid, p_lease_epoch bigint,
  p_duration_seconds integer default 45
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_session council_sessions;
  v_lease council_host_leases;
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
  v_now := clock_timestamp();
  if v_lease.released_at is not null or v_lease.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'lease_expired');
  end if;
  update council_host_leases
     set lease_expires_at = v_now + make_interval(secs => v_duration), last_heartbeat_at = v_now
   where session_id = p_session_id returning * into v_lease;
  return jsonb_build_object(
    'ok', true, 'hostId', v_lease.host_id, 'leaseEpoch', v_lease.lease_epoch,
    'leaseExpiresAt', v_lease.lease_expires_at
  );
end;
$$;

revoke all on function public.renew_council_host_lease(uuid, uuid, bigint, integer) from public, anon, authenticated;
grant execute on function public.renew_council_host_lease(uuid, uuid, bigint, integer) to service_role;

drop trigger if exists council_integration_attempt_immutable on public.council_integration_attempts;

-- Every overload of each name, so older signatures left by earlier migrations go too.
do $$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any (array[
       'ack_council_delivery', 'add_council_owner_note', 'begin_council_integration_attempt',
       'block_council_work_item', 'claim_council_work_item', 'complete_council_work_item',
       'complete_council_work_item_attributed', 'conclude_council', 'council_execution_evidence',
       'council_integration_attempt_immutable', 'council_integration_attempt_json',
       'council_integration_evidence_valid', 'create_council_campaign', 'elect_council_floor',
       'fail_council_delivery', 'finalize_council_integration_attempt',
       'freeze_council_integration_manifest', 'heartbeat_council_work_item', 'issue_council_seat_key',
       'list_council_runtime_inventory', 'mark_council_delivery_in_flight',
       'mark_council_owner_notes_delivered', 'pending_council_owner_notes', 'prepare_council_delivery',
       'record_campaign_integration', 'record_council_integration_v3', 'record_council_verification',
       'record_host_verification', 'requeue_council_work_item', 'resolve_council_seat_key',
       'review_council_work_item', 'set_campaign_integrator', 'touch_council_participant',
       'validate_council_work_items'
     ])
  loop
    execute format('drop function %s', v_fn);
  end loop;
end;
$$;

drop table if exists
  public.council_verification_runs, public.council_integration_attempts, public.council_work_items,
  public.council_campaigns, public.council_owner_notes, public.council_deliveries;

commit;
