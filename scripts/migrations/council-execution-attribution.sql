-- ===== Council execution attribution =====
begin;

alter table public.council_agent_executions
  add column if not exists seat_token_hash text;
create unique index if not exists idx_council_execution_seat_token
  on public.council_agent_executions(seat_token_hash) where seat_token_hash is not null;

alter table public.council_seat_keys
  add column if not exists execution_id uuid references public.council_agent_executions(id),
  add column if not exists execution_binding_required boolean not null default false;
alter table public.council_messages
  add column if not exists execution_id uuid references public.council_agent_executions(id);
alter table public.council_work_items
  add column if not exists submitted_execution_id uuid references public.council_agent_executions(id),
  add column if not exists accepted_execution_id uuid references public.council_agent_executions(id);
alter table public.council_verification_runs
  add column if not exists execution_id uuid references public.council_agent_executions(id);

create or replace function public.council_execution_facts_immutable()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if (to_jsonb(new) - 'ended_at' - 'stop_reason') is distinct from
     (to_jsonb(old) - 'ended_at' - 'stop_reason') or
     (old.ended_at is not null and new.ended_at is distinct from old.ended_at) or
     (old.stop_reason is not null and new.stop_reason is distinct from old.stop_reason) then
    raise exception 'Council execution facts are immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists council_execution_facts_immutable on public.council_agent_executions;
create trigger council_execution_facts_immutable before update on public.council_agent_executions
  for each row execute function public.council_execution_facts_immutable();

create or replace function public.council_execution_evidence(
  p_execution_id uuid, p_session_id uuid, p_agent_name text
) returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'executionId', e.id, 'agentName', p.name, 'connectorKind', e.connector_kind,
    'identityAssurance', e.identity_assurance, 'provider', e.provider,
    'adapterVersion', e.adapter_version, 'requestedModel', e.requested_model,
    'effectiveModel', e.effective_model, 'requestedReasoningEffort', e.requested_reasoning_effort,
    'effectiveReasoningEffort', e.effective_reasoning_effort, 'modelSource', e.model_source
  ) from council_agent_executions e join council_participants p on p.id = e.participant_id
   where e.id = p_execution_id and e.session_id = p_session_id
     and p.session_id = p_session_id and p.name = p_agent_name and p.kind = 'agent';
$$;

create or replace function public.council_validate_execution_write(
  p_session_id uuid, p_agent_name text, p_seat_token_hash text, p_expected_execution_id uuid
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_session council_sessions; v_key council_seat_keys; v_seed council_seat_keys;
  v_lease council_host_leases; v_execution council_agent_executions;
  v_participant uuid; v_now timestamptz;
begin
  select * into v_session from council_sessions where id = p_session_id for update;
  if v_session.id is null or v_session.status = 'expired' then
    return jsonb_build_object('ok', false, 'reason', 'inactive_session');
  end if;
  select * into v_seed from council_seat_keys where token_hash = p_seat_token_hash;
  if v_seed.id is null or v_seed.session_id is distinct from p_session_id then
    return jsonb_build_object('ok', false, 'reason', 'invalid_credential');
  end if;
  if v_seed.issued_by = 'host' then
    select * into v_lease from council_host_leases where session_id = p_session_id for share;
  end if;
  select * into v_key from council_seat_keys
   where id = v_seed.id and token_hash = p_seat_token_hash for update;
  v_now := clock_timestamp();
  if v_key.id is null or v_key.session_id is distinct from p_session_id
     or v_key.seat_name is distinct from p_agent_name or v_key.revoked_at is not null
     or v_key.expires_at <= v_now or
     row(v_key.issued_by, v_key.host_id, v_key.lease_epoch) is distinct from
     row(v_seed.issued_by, v_seed.host_id, v_seed.lease_epoch) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_credential');
  end if;
  if v_key.issued_by = 'host' and (
    v_lease.session_id is null or v_lease.host_id is distinct from v_key.host_id
    or v_lease.lease_epoch is distinct from v_key.lease_epoch
    or v_lease.released_at is not null or v_lease.lease_expires_at <= v_now
  ) then return jsonb_build_object('ok', false, 'reason', 'stale_host'); end if;
  if v_key.execution_id is distinct from p_expected_execution_id then
    return jsonb_build_object('ok', false, 'reason', 'execution_mismatch');
  end if;
  if not v_key.execution_binding_required then
    if v_key.execution_id is not null then
      return jsonb_build_object('ok', false, 'reason', 'invalid_binding');
    end if;
    return jsonb_build_object('ok', true, 'executionId', null);
  end if;
  if v_key.issued_by <> 'host' or v_key.execution_id is null then
    return jsonb_build_object('ok', false, 'reason', 'execution_not_bound');
  end if;
  select id into v_participant from council_participants
   where session_id = p_session_id and name = p_agent_name and kind = 'agent' for share;
  select * into v_execution from council_agent_executions where id = v_key.execution_id for share;
  if v_participant is null or v_execution.id is null or v_execution.ended_at is not null
     or v_execution.session_id is distinct from p_session_id
     or v_execution.participant_id is distinct from v_participant
     or v_execution.host_id is distinct from v_key.host_id
     or v_execution.lease_epoch is distinct from v_key.lease_epoch
     or v_execution.seat_token_hash is distinct from p_seat_token_hash then
    return jsonb_build_object('ok', false, 'reason', 'inactive_execution');
  end if;
  v_now := clock_timestamp();
  if v_key.expires_at <= v_now or v_lease.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'expired_credential');
  end if;
  return jsonb_build_object('ok', true, 'executionId', v_execution.id);
end;
$$;

create or replace function public.issue_council_host_seat_key(
  p_session_id uuid, p_seat_name text, p_token_hash text,
  p_expires_at timestamptz, p_host_id uuid, p_lease_epoch bigint
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session council_sessions; v_lease council_host_leases; v_kind text; v_now timestamptz;
begin
  select * into v_session from council_sessions where id = p_session_id for share;
  if v_session.id is null or v_session.status = 'expired' then
    return jsonb_build_object('ok', false, 'reason', 'inactive_session');
  end if;
  select * into v_lease from council_host_leases where session_id = p_session_id for update;
  v_now := clock_timestamp();
  if v_lease.session_id is null or v_lease.host_id is distinct from p_host_id
     or v_lease.lease_epoch is distinct from p_lease_epoch or v_lease.released_at is not null
     or v_lease.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'stale_host');
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
    session_id, seat_name, token_hash, expires_at, issued_by, host_id, lease_epoch,
    execution_id, execution_binding_required
  ) values (
    p_session_id, p_seat_name, p_token_hash, least(p_expires_at, v_now + interval '24 hours'),
    'host', p_host_id, p_lease_epoch, null, false
  ) on conflict (session_id, seat_name) do update
    set token_hash = excluded.token_hash, expires_at = excluded.expires_at,
        issued_at = clock_timestamp(), claimed_at = null, revoked_at = null,
        issued_by = 'host', host_id = excluded.host_id, lease_epoch = excluded.lease_epoch,
        execution_id = null, execution_binding_required = false;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.issue_council_bound_host_seat_key(
  p_session_id uuid, p_seat_name text, p_token_hash text,
  p_expires_at timestamptz, p_host_id uuid, p_lease_epoch bigint
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_result jsonb;
begin
  if exists (select 1 from council_agent_executions where seat_token_hash = p_token_hash) then
    return jsonb_build_object('ok', false, 'reason', 'credential_already_used');
  end if;
  v_result := issue_council_host_seat_key(p_session_id, p_seat_name, p_token_hash,
    p_expires_at, p_host_id, p_lease_epoch);
  if v_result->>'ok' <> 'true' then return v_result; end if;
  update council_seat_keys set execution_binding_required = true
   where session_id = p_session_id and seat_name = p_seat_name and token_hash = p_token_hash;
  return jsonb_build_object('ok', true, 'executionBindingRequired', true);
end;
$$;

create or replace function public.start_council_bound_agent_execution(
  p_session_id uuid, p_agent_name text, p_host_id uuid, p_lease_epoch bigint,
  p_host_generation text, p_connector_kind text, p_connector_capabilities jsonb,
  p_capability_source text, p_identity_assurance text, p_provider text,
  p_adapter_version text, p_requested_model text, p_effective_model text,
  p_requested_reasoning_effort text, p_effective_reasoning_effort text,
  p_model_source text, p_branch_name text, p_worktree_path text, p_base_sha text,
  p_seat_token_hash text
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_key council_seat_keys; v_lease council_host_leases; v_result jsonb;
        v_status text; v_now timestamptz; v_participant uuid;
begin
  select status into v_status from council_sessions where id = p_session_id for update;
  if v_status is null or v_status = 'expired' then
    return jsonb_build_object('ok', false, 'reason', 'inactive_session');
  end if;
  select * into v_lease from council_host_leases where session_id = p_session_id for share;
  select * into v_key from council_seat_keys
   where session_id = p_session_id and seat_name = p_agent_name and token_hash = p_seat_token_hash for update;
  select id into v_participant from council_participants
   where session_id = p_session_id and name = p_agent_name and kind = 'agent' for update;
  if v_participant is null then return jsonb_build_object('ok', false, 'reason', 'not_on_roster'); end if;
  perform 1 from council_agent_executions where participant_id = v_participant and ended_at is null for update;
  v_now := clock_timestamp();
  if v_lease.session_id is null or v_lease.host_id is distinct from p_host_id
     or v_lease.lease_epoch is distinct from p_lease_epoch or v_lease.released_at is not null
     or v_lease.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'stale_host');
  end if;
  if v_key.id is null or v_key.issued_by <> 'host' or not v_key.execution_binding_required
     or v_key.host_id is distinct from p_host_id or v_key.lease_epoch is distinct from p_lease_epoch
     or v_key.revoked_at is not null or v_key.expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'invalid_credential');
  end if;
  if v_key.execution_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'execution_already_bound');
  end if;
  v_result := council_start_execution_record(p_session_id, p_agent_name, p_host_id, p_lease_epoch,
    p_host_generation, p_connector_kind, p_connector_capabilities, p_capability_source,
    p_identity_assurance, p_provider, p_adapter_version, p_requested_model, p_effective_model,
    p_requested_reasoning_effort, p_effective_reasoning_effort, p_model_source,
    p_branch_name, p_worktree_path, p_base_sha, p_seat_token_hash);
  if v_result->>'ok' <> 'true' then return v_result; end if;
  update council_seat_keys set execution_id = (v_result->>'executionId')::uuid where id = v_key.id;
  return v_result || jsonb_build_object('seatBound', true);
end;
$$;

create or replace function public.append_council_message_attributed(
  p_session_id uuid, p_speaker text, p_role text, p_intent text, p_body text, p_client_key text,
  p_seat_token_hash text, p_expected_execution_id uuid,
  p_addressed_to text default 'all', p_reply_to_seq integer default null,
  p_ack_seq integer default null, p_posts_per_round integer default 2, p_stale_seconds integer default 180
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_identity jsonb; v_result jsonb; v_execution uuid;
begin
  if p_role is distinct from 'agent' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_role');
  end if;
  v_identity := council_validate_execution_write(p_session_id, p_speaker, p_seat_token_hash, p_expected_execution_id);
  if v_identity->>'ok' <> 'true' then return v_identity; end if;
  v_result := append_council_message(p_session_id, p_speaker, p_role, p_intent, p_body, p_client_key,
    p_addressed_to, p_reply_to_seq, p_ack_seq, p_posts_per_round, p_stale_seconds);
  if v_result->>'ok' = 'true' then
    if coalesce((v_result->>'duplicate')::boolean, false) is false then
      update council_messages set execution_id = (v_identity->>'executionId')::uuid
       where session_id = p_session_id and seq = (v_result->>'seq')::integer;
    end if;
    select execution_id into v_execution from council_messages
     where session_id = p_session_id and seq = (v_result->>'seq')::integer;
    v_result := v_result || jsonb_build_object('executionId', v_execution);
  end if;
  return v_result;
end;
$$;

create or replace function public.complete_council_work_item(
  p_item_id uuid, p_agent_name text, p_commit_hash text, p_verification text
) returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session_id uuid; v_campaign council_campaigns;
begin
  select c.session_id into v_session_id from council_work_items i
    join council_campaigns c on c.id = i.campaign_id where i.id = p_item_id;
  if v_session_id is null then return false; end if;
  perform 1 from council_sessions where id = v_session_id for update;
  select * into v_campaign from council_campaigns where session_id = v_session_id;
  if v_campaign.integration_manifest is not null then return false; end if;
  update council_work_items
     set status = 'awaiting_review', heartbeat_at = clock_timestamp(), commit_hash = p_commit_hash,
         verification = p_verification, completed_at = clock_timestamp(),
         submitted_execution_id = null, accepted_execution_id = null, accepted_commit_sha = null,
         verification_run_id = null, host_verified = null, host_verification = null, host_checked_at = null,
         reviewed_at = null
   where id = p_item_id and campaign_id = v_campaign.id and agent_name = p_agent_name and status = 'in_progress';
  return found;
end;
$$;

create or replace function public.complete_council_work_item_attributed(
  p_item_id uuid, p_agent_name text, p_commit_hash text, p_verification text,
  p_seat_token_hash text, p_expected_execution_id uuid
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session_id uuid; v_identity jsonb;
begin
  select c.session_id into v_session_id from council_work_items i
    join council_campaigns c on c.id = i.campaign_id where i.id = p_item_id;
  if v_session_id is null then return jsonb_build_object('ok', false, 'reason', 'no_item'); end if;
  v_identity := council_validate_execution_write(v_session_id, p_agent_name, p_seat_token_hash, p_expected_execution_id);
  if v_identity->>'ok' <> 'true' then return v_identity; end if;
  if p_commit_hash is null or p_commit_hash !~ '^[0-9a-fA-F]{40}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_commit');
  end if;
  if not complete_council_work_item(p_item_id, p_agent_name, lower(p_commit_hash), p_verification) then
    return jsonb_build_object('ok', false, 'reason', 'not_active_work');
  end if;
  update council_work_items set submitted_execution_id = (v_identity->>'executionId')::uuid where id = p_item_id;
  return v_identity;
end;
$$;

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
        issued_by = 'owner', host_id = null, lease_epoch = null,
        execution_id = null, execution_binding_required = false;
  return jsonb_build_object('ok', true);
end;
$$;

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
                           'code', v_code, 'issuer', v_key.issued_by, 'execution_id', v_key.execution_id,
                           'execution_binding_required', v_key.execution_binding_required,
                           'host_id', v_key.host_id, 'lease_epoch', v_key.lease_epoch);
end;
$$;

create or replace function public.council_start_execution_record(
  p_session_id uuid, p_agent_name text, p_host_id uuid, p_lease_epoch bigint,
  p_host_generation text, p_connector_kind text, p_connector_capabilities jsonb,
  p_capability_source text, p_identity_assurance text, p_provider text,
  p_adapter_version text, p_requested_model text, p_effective_model text,
  p_requested_reasoning_effort text, p_effective_reasoning_effort text,
  p_model_source text, p_branch_name text, p_worktree_path text, p_base_sha text, p_seat_token_hash text
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_participant uuid; v_previous uuid; v_id uuid; v_lease council_host_leases; v_status text; v_now timestamptz;
begin
  select status into v_status from council_sessions where id = p_session_id for update;
  if v_status is null or v_status = 'expired' then
    return jsonb_build_object('ok', false, 'reason', 'inactive_session');
  end if;
  select * into v_lease from council_host_leases where session_id = p_session_id for share;
  v_now := clock_timestamp();
  if v_lease.session_id is null or v_lease.host_id is distinct from p_host_id
     or v_lease.lease_epoch is distinct from p_lease_epoch or v_lease.released_at is not null
     or v_lease.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'stale_host');
  end if;
  if p_seat_token_hash is not null and exists (
    select 1 from council_agent_executions where seat_token_hash = p_seat_token_hash
  ) then return jsonb_build_object('ok', false, 'reason', 'credential_already_used'); end if;
  select id into v_participant from council_participants
   where session_id = p_session_id and name = p_agent_name and kind = 'agent' for update;
  if v_participant is null then return jsonb_build_object('ok', false, 'reason', 'not_on_roster'); end if;
  perform 1 from council_agent_executions where participant_id = v_participant and ended_at is null for update;
  if v_lease.lease_expires_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'stale_host');
  end if;
  select id into v_previous from council_agent_executions
   where participant_id = v_participant order by started_at desc, id desc limit 1;
  update council_agent_executions
     set ended_at = coalesce(ended_at, clock_timestamp()), stop_reason = coalesce(stop_reason, 'replaced')
   where participant_id = v_participant and ended_at is null;
  insert into council_agent_executions (
    session_id, participant_id, host_id, lease_epoch, host_generation,
    connector_kind, connector_capabilities, capability_source, identity_assurance,
    provider, adapter_version, requested_model, effective_model,
    requested_reasoning_effort, effective_reasoning_effort, model_source,
    branch_name, worktree_path, base_sha, predecessor_execution_id, seat_token_hash, started_at
  ) values (
    p_session_id, v_participant, p_host_id, p_lease_epoch, p_host_generation,
    p_connector_kind, coalesce(p_connector_capabilities, '{}'), p_capability_source,
    p_identity_assurance, p_provider, p_adapter_version, p_requested_model,
    p_effective_model, p_requested_reasoning_effort, p_effective_reasoning_effort,
    p_model_source, p_branch_name, p_worktree_path, p_base_sha, v_previous, p_seat_token_hash, clock_timestamp()
  ) returning id into v_id;
  return jsonb_build_object('ok', true, 'executionId', v_id);
end;
$$;

create or replace function public.start_council_agent_execution(
  p_session_id uuid, p_agent_name text, p_host_id uuid, p_lease_epoch bigint,
  p_host_generation text, p_connector_kind text, p_connector_capabilities jsonb,
  p_capability_source text, p_identity_assurance text, p_provider text,
  p_adapter_version text, p_requested_model text, p_effective_model text,
  p_requested_reasoning_effort text, p_effective_reasoning_effort text,
  p_model_source text, p_branch_name text, p_worktree_path text, p_base_sha text
) returns jsonb language sql security invoker set search_path = public, pg_temp as $$
  select council_start_execution_record(p_session_id, p_agent_name, p_host_id, p_lease_epoch,
    p_host_generation, p_connector_kind, p_connector_capabilities, p_capability_source,
    p_identity_assurance, p_provider, p_adapter_version, p_requested_model, p_effective_model,
    p_requested_reasoning_effort, p_effective_reasoning_effort, p_model_source,
    p_branch_name, p_worktree_path, p_base_sha, null);
$$;

create or replace function public.stop_council_agent_execution(
  p_execution_id uuid, p_host_id uuid, p_lease_epoch bigint, p_stop_reason text
) returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session_id uuid; v_lease council_host_leases;
begin
  select session_id into v_session_id from council_agent_executions where id = p_execution_id;
  if v_session_id is null then return false; end if;
  perform 1 from council_sessions where id = v_session_id for update;
  select * into v_lease from council_host_leases where session_id = v_session_id for share;
  if v_lease.session_id is null or v_lease.host_id is distinct from p_host_id
     or v_lease.lease_epoch is distinct from p_lease_epoch or v_lease.released_at is not null
     or v_lease.lease_expires_at <= clock_timestamp() then return false; end if;
  update council_agent_executions
     set ended_at = coalesce(ended_at, clock_timestamp()), stop_reason = coalesce(stop_reason, left(p_stop_reason, 500))
   where id = p_execution_id and session_id = v_session_id and host_id = p_host_id and lease_epoch = p_lease_epoch;
  return found;
end;
$$;

create or replace function record_council_verification(
  p_item_id uuid, p_host_id uuid, p_lease_epoch bigint, p_commit_sha text,
  p_base_sha text, p_branch_name text, p_profile_id text,
  p_command_receipts jsonb, p_output_digest text, p_passed boolean, p_report text
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_item council_work_items; v_campaign council_campaigns; v_session_id uuid; v_run uuid;
begin
  select c.session_id into v_session_id from council_work_items i
    join council_campaigns c on c.id = i.campaign_id where i.id = p_item_id;
  if v_session_id is null then return jsonb_build_object('ok', false, 'reason', 'no_item'); end if;
  perform 1 from council_sessions where id = v_session_id for update;
  perform 1 from council_host_leases where session_id = v_session_id for share;
  select * into v_campaign from council_campaigns where session_id = v_session_id;
  if v_campaign.integration_manifest is not null then
    return jsonb_build_object('ok', false, 'reason', 'manifest_frozen');
  end if;
  select * into v_item from council_work_items where id = p_item_id for update;
  if v_item.id is null then return jsonb_build_object('ok', false, 'reason', 'no_item'); end if;
  select * into v_campaign from council_campaigns where id = v_item.campaign_id;
  v_session_id := v_campaign.session_id;
  if not exists (
    select 1 from council_host_leases where session_id = v_session_id
      and host_id = p_host_id and lease_epoch = p_lease_epoch
      and released_at is null and lease_expires_at > clock_timestamp()
  ) then return jsonb_build_object('ok', false, 'reason', 'stale_host'); end if;
  if v_item.status <> 'awaiting_review' then
    return jsonb_build_object('ok', false, 'reason', 'not_awaiting_review');
  end if;
  if v_item.commit_hash is distinct from p_commit_sha then
    return jsonb_build_object('ok', false, 'reason', 'commit_mismatch');
  end if;
  if v_campaign.base_sha is distinct from p_base_sha then
    return jsonb_build_object('ok', false, 'reason', 'base_mismatch');
  end if;
  if v_item.submitted_execution_id is not null and
     council_execution_evidence(v_item.submitted_execution_id, v_session_id, v_item.agent_name) is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_execution');
  end if;
  insert into council_verification_runs (
    work_item_id, host_id, lease_epoch, commit_sha, base_sha, branch_name,
    profile_id, command_receipts, output_digest, passed, report, execution_id
  ) values (
    p_item_id, p_host_id, p_lease_epoch, p_commit_sha, p_base_sha, p_branch_name,
    p_profile_id, coalesce(p_command_receipts, '[]'), p_output_digest, p_passed,
    left(coalesce(p_report, ''), 16000), v_item.submitted_execution_id
  ) returning id into v_run;
  update council_work_items
     set host_verified = p_passed,
         host_verification = left(coalesce(p_report, ''), 16000),
         host_checked_at = now(), verification_run_id = v_run,
         branch_name = p_branch_name, verification_profile = p_profile_id,
         rejections = case when p_passed then rejections else rejections + 1 end,
         status = case
           when p_passed then status
           when rejections + 1 >= max_attempts then 'blocked'
           else 'queued' end,
         blocked_reason = case
           when not p_passed and rejections + 1 >= max_attempts
             then 'host check failed ' || (rejections + 1) || ' time(s); needs a human'
           else blocked_reason end,
         progress = case when p_passed then progress else concat_ws(E'\n', progress,
           'Host check failed: ' || left(coalesce(p_report, ''), 1000)) end
   where id = p_item_id;
  -- The final failed item can leave the campaign blocked.
  update council_campaigns set status = 'blocked'
   where id = v_campaign.id
     and not exists (select 1 from council_work_items
                      where campaign_id = v_campaign.id
                        and status in ('queued', 'in_progress', 'awaiting_review'));
  return jsonb_build_object('ok', true, 'verificationRunId', v_run, 'passed', p_passed);
end;
$$;

create or replace function review_council_work_item(
  p_item_id uuid, p_reviewer text, p_accepted boolean, p_note text
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_item council_work_items; v_campaign council_campaigns;
        v_closer text; v_run council_verification_runs; v_session_id uuid;
begin
  select c.session_id into v_session_id from council_work_items i
    join council_campaigns c on c.id = i.campaign_id where i.id = p_item_id;
  if v_session_id is null then return jsonb_build_object('ok', false, 'reason', 'no_such_item'); end if;
  perform 1 from council_sessions where id = v_session_id for update;
  select * into v_campaign from council_campaigns where session_id = v_session_id;
  if v_campaign.integration_manifest is not null then
    return jsonb_build_object('ok', false, 'reason', 'manifest_frozen');
  end if;
  select * into v_item from council_work_items where id = p_item_id for update;
  if v_item.id is null then return jsonb_build_object('ok', false, 'reason', 'no_such_item'); end if;
  select * into v_campaign from council_campaigns where id = v_item.campaign_id;
  select closer_name into v_closer from council_sessions where id = v_campaign.session_id;
  if v_closer <> p_reviewer then return jsonb_build_object('ok', false, 'reason', 'not_the_closer'); end if;
  if v_item.status <> 'awaiting_review' then
    return jsonb_build_object('ok', false, 'reason', 'not_awaiting_review');
  end if;
  if p_accepted then
    select * into v_run from council_verification_runs where id = v_item.verification_run_id;
    if v_run.id is null or v_run.passed is not true
       or v_run.work_item_id is distinct from v_item.id
       or v_run.execution_id is distinct from v_item.submitted_execution_id
       or v_run.commit_sha is distinct from v_item.commit_hash
       or v_run.base_sha is distinct from v_campaign.base_sha
       or v_run.profile_id is distinct from v_item.verification_profile then
      return jsonb_build_object('ok', false, 'reason', 'not_exactly_verified');
    end if;
    update council_work_items
       set status = 'verified', accepted_commit_sha = commit_hash, accepted_execution_id = submitted_execution_id,
           verification = concat_ws(E'\n', verification, 'Review: ' || p_note), reviewed_at = now()
     where id = p_item_id;
  else
    update council_work_items
       set rejections = rejections + 1,
           status = case when rejections + 1 >= max_attempts then 'blocked' else 'queued' end,
           blocked_reason = case when rejections + 1 >= max_attempts
             then 'sent back ' || (rejections + 1) || ' time(s); needs a human'
             else blocked_reason end,
           progress = concat_ws(E'\n', progress, 'Review feedback: ' || p_note),
           heartbeat_at = null, completed_at = null, lease_owner = null, lease_expires_at = null,
           host_verified = null, host_verification = null, host_checked_at = null,
           verification_run_id = null, accepted_commit_sha = null, accepted_execution_id = null
     where id = p_item_id;
  end if;
  update council_campaigns set status = case
      when not exists (select 1 from council_work_items where campaign_id = v_campaign.id and status <> 'verified') then 'complete'
      when exists (select 1 from council_work_items where campaign_id = v_campaign.id and status = 'blocked')
       and not exists (select 1 from council_work_items where campaign_id = v_campaign.id and status in ('queued', 'in_progress', 'awaiting_review')) then 'blocked'
      else 'running' end,
    completed_at = case when not exists (
      select 1 from council_work_items where campaign_id = v_campaign.id and status <> 'verified'
    ) then now() else null end
  where id = v_campaign.id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function freeze_council_integration_manifest(
  p_session_id uuid, p_host_id uuid, p_lease_epoch bigint
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_campaign council_campaigns; v_manifest jsonb;
begin
  perform 1 from council_sessions where id = p_session_id for update;
  perform 1 from council_host_leases where session_id = p_session_id for share;
  select * into v_campaign from council_campaigns where session_id = p_session_id for update;
  if v_campaign.id is null then return jsonb_build_object('ok', false, 'reason', 'no_campaign'); end if;
  if not exists (
    select 1 from council_host_leases where session_id = p_session_id
      and host_id = p_host_id and lease_epoch = p_lease_epoch
      and released_at is null and lease_expires_at > clock_timestamp()
  ) then return jsonb_build_object('ok', false, 'reason', 'stale_host'); end if;
  if v_campaign.integration_manifest is not null then
    return jsonb_build_object('ok', true, 'manifest', v_campaign.integration_manifest, 'frozen', true);
  end if;
  if v_campaign.status <> 'complete' or exists (
    select 1 from council_work_items where campaign_id = v_campaign.id
      and (status <> 'verified' or accepted_commit_sha is null)
  ) then return jsonb_build_object('ok', false, 'reason', 'campaign_incomplete'); end if;
  if exists (
    select 1 from council_work_items i left join council_verification_runs r on r.id = i.verification_run_id
     where i.campaign_id = v_campaign.id and (
       r.id is null or r.work_item_id is distinct from i.id or r.passed is not true
       or r.commit_sha is distinct from i.accepted_commit_sha or i.commit_hash is distinct from i.accepted_commit_sha
       or r.base_sha is distinct from v_campaign.base_sha or r.profile_id is distinct from i.verification_profile
       or r.execution_id is distinct from i.accepted_execution_id
       or i.submitted_execution_id is distinct from i.accepted_execution_id
       or (i.accepted_execution_id is not null and council_execution_evidence(i.accepted_execution_id, p_session_id, i.agent_name) is null)
     )
  ) then return jsonb_build_object('ok', false, 'reason', 'not_exactly_verified'); end if;
  select jsonb_build_object(
    'version', 1, 'campaignId', v_campaign.id, 'baseSha', v_campaign.base_sha,
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'itemId', id, 'sequence', sequence, 'agentName', agent_name,
      'branch', branch_name, 'commitSha', accepted_commit_sha,
      'verificationRunId', verification_run_id, 'dependencies', dependencies,
      'acceptedExecutionId', accepted_execution_id,
      'executionEvidence', council_execution_evidence(accepted_execution_id, p_session_id, agent_name)
    ) order by sequence), '[]'::jsonb)
  ) into v_manifest from council_work_items where campaign_id = v_campaign.id;
  update council_campaigns
     set integration_manifest = v_manifest, manifest_frozen_at = now(),
         integration_status = coalesce(integration_status, 'pending')
   where id = v_campaign.id;
  return jsonb_build_object('ok', true, 'manifest', v_manifest, 'frozen', false);
end;
$$;

create or replace function join_council(
  p_session_id uuid, p_agent_name text, p_expertise text default '',
  p_dispatch_mode boolean default null
)
returns jsonb
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare v_kind text; v_live integer;
begin
  perform 1 from council_sessions where id = p_session_id for update;
  select kind into v_kind from council_participants
   where session_id = p_session_id and name = p_agent_name;
  if v_kind is null then
    return jsonb_build_object('ok', false, 'reason', 'not_on_roster');
  end if;
  update council_participants
     set status = case when status = 'invited' then 'active' else status end,
         expertise = case when p_expertise <> '' then p_expertise else expertise end,
         dispatch_mode = coalesce(p_dispatch_mode, dispatch_mode),
         joined_at = coalesce(joined_at, now()), last_seen_at = now()
   where session_id = p_session_id and name = p_agent_name;
  select count(*) into v_live from council_participants
   where session_id = p_session_id and kind = 'agent' and joined_at is not null;
  if v_live >= 2 then
    update council_sessions set quorum_at = coalesce(quorum_at, now())
     where id = p_session_id;
  end if;
  return jsonb_build_object('ok', true, 'live', v_live);
end;
$$;

create or replace function claim_council_work_item(p_session_id uuid, p_agent_name text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_item council_work_items; v_campaign council_campaigns; v_status text;
begin
  perform 1 from council_sessions where id = p_session_id for update;
  select * into v_campaign from council_campaigns where session_id = p_session_id for update;
  if v_campaign.id is null or v_campaign.status <> 'running' or v_campaign.integration_manifest is not null then return null; end if;

  update council_work_items
     set status = 'queued',
         lease_owner = null, lease_expires_at = null, heartbeat_at = null
   where campaign_id = v_campaign.id
     and status = 'in_progress'
     and lease_expires_at is not null
     and lease_expires_at < now();

  update council_campaigns set status = 'blocked'
   where id = v_campaign.id
     and not exists (select 1 from council_work_items
                      where campaign_id = v_campaign.id
                        and status in ('queued', 'in_progress', 'awaiting_review'));
  select status into v_status from council_campaigns where id = v_campaign.id;
  if v_status <> 'running' then return null; end if;

  select w.* into v_item from council_work_items w
   where w.campaign_id = v_campaign.id and w.agent_name = p_agent_name
     and w.status = 'in_progress' order by w.sequence limit 1 for update;
  if v_item.id is null then
    select w.* into v_item from council_work_items w
     where w.campaign_id = v_campaign.id and w.agent_name = p_agent_name
       and w.status = 'queued' order by w.sequence limit 1 for update skip locked;
    if v_item.id is null then return null; end if;
    update council_work_items
       set status = 'in_progress', attempts = attempts + 1,
           started_at = coalesce(started_at, now()), heartbeat_at = now(),
           lease_owner = p_agent_name, lease_expires_at = now() + interval '45 minutes'
     where id = v_item.id returning * into v_item;
  else
    update council_work_items
       set heartbeat_at = now(), lease_owner = p_agent_name,
           lease_expires_at = now() + interval '45 minutes'
     where id = v_item.id returning * into v_item;
  end if;
  return to_jsonb(v_item);
end;
$$;

create or replace function block_council_work_item(p_item_id uuid, p_agent_name text, p_reason text)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_campaign_id uuid; v_session_id uuid;
begin
  select c.session_id into v_session_id from council_work_items i
    join council_campaigns c on c.id = i.campaign_id where i.id = p_item_id;
  if v_session_id is null then return false; end if;
  perform 1 from council_sessions where id = v_session_id for update;
  if exists (select 1 from council_campaigns where session_id = v_session_id and integration_manifest is not null) then return false; end if;
  update council_work_items set status = 'blocked', blocked_reason = p_reason, heartbeat_at = now() where id = p_item_id and agent_name = p_agent_name and status in ('queued', 'in_progress') returning campaign_id into v_campaign_id;
  if not found then return false; end if;
  update council_campaigns set status = 'blocked' where id = v_campaign_id and not exists (select 1 from council_work_items where campaign_id = v_campaign_id and status in ('queued', 'in_progress', 'awaiting_review'));
  return true;
end;
$$;

do $$
declare v_function regprocedure;
begin
  for v_function in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(array[
      'council_execution_facts_immutable', 'council_execution_evidence', 'council_validate_execution_write',
      'issue_council_host_seat_key', 'issue_council_bound_host_seat_key', 'issue_council_seat_key',
      'resolve_council_seat_key', 'council_start_execution_record', 'start_council_agent_execution',
      'start_council_bound_agent_execution', 'stop_council_agent_execution',
      'append_council_message_attributed', 'complete_council_work_item', 'complete_council_work_item_attributed',
      'record_council_verification', 'review_council_work_item', 'freeze_council_integration_manifest',
      'join_council', 'claim_council_work_item', 'block_council_work_item'
    ])
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;
end;
$$;

commit;
