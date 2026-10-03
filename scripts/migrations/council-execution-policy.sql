-- ===== Council execution policy version =====
begin;

alter table public.council_sessions
  add column if not exists host_generation text,
  add column if not exists policy_version text;
alter table public.council_agent_executions
  add column if not exists policy_version text;

alter table public.council_sessions drop constraint if exists council_session_policy_pair;
alter table public.council_sessions add constraint council_session_policy_pair check (
  (host_generation is null and policy_version is null) or
  (host_generation is not null and policy_version is not null and
   host_generation = 'typescript-node' and policy_version = 'typescript-node-v3-2026-09-30')
);
alter table public.council_agent_executions drop constraint if exists council_execution_policy_known;
alter table public.council_agent_executions add constraint council_execution_policy_known check (
  policy_version is null or (host_generation is not null and
    policy_version = 'typescript-node-v3-2026-09-30' and host_generation = 'typescript-node')
);

create or replace function public.council_session_policy_immutable()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if old.policy_version is not null and
     row(new.host_generation, new.policy_version) is distinct from row(old.host_generation, old.policy_version) then
    raise exception 'Council execution policy is immutable';
  end if;
  if old.policy_version is null and new.policy_version is not null and
     exists (select 1 from council_agent_executions where session_id = old.id) then
    raise exception 'Historical Council execution policy is unknown';
  end if;
  return new;
end;
$$;
drop trigger if exists council_session_policy_immutable on public.council_sessions;
create trigger council_session_policy_immutable before update on public.council_sessions
  for each row execute function public.council_session_policy_immutable();

create or replace function public.council_start_policy_execution_record(
  p_session_id uuid, p_agent_name text, p_host_id uuid, p_lease_epoch bigint,
  p_host_generation text, p_connector_kind text, p_connector_capabilities jsonb,
  p_capability_source text, p_identity_assurance text, p_provider text,
  p_adapter_version text, p_requested_model text, p_effective_model text,
  p_requested_reasoning_effort text, p_effective_reasoning_effort text,
  p_model_source text, p_branch_name text, p_worktree_path text, p_base_sha text,
  p_seat_token_hash text, p_policy_version text
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session council_sessions; v_participant uuid; v_previous uuid; v_id uuid;
        v_lease council_host_leases; v_now timestamptz;
begin
  select * into v_session from council_sessions where id = p_session_id for update;
  if v_session.id is null or v_session.status = 'expired' then
    return jsonb_build_object('ok', false, 'reason', 'inactive_session');
  end if;
  select * into v_lease from council_host_leases where session_id = p_session_id for share;
  v_now := clock_timestamp();
  if v_lease.session_id is null or v_lease.host_id is distinct from p_host_id
     or v_lease.lease_epoch is distinct from p_lease_epoch or v_lease.released_at is not null
     or v_lease.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'stale_host');
  end if;
  if p_policy_version is not null and p_policy_version <> 'typescript-node-v3-2026-09-30' then
    return jsonb_build_object('ok', false, 'reason', 'unsupported_policy_version');
  end if;
  if v_session.policy_version is not null then
    if row(p_host_generation, p_policy_version) is distinct from
       row(v_session.host_generation, v_session.policy_version) then
      return jsonb_build_object('ok', false, 'reason', 'execution_policy_mismatch');
    end if;
  elsif p_policy_version is not null then
    if p_host_generation is distinct from 'typescript-node' then
      return jsonb_build_object('ok', false, 'reason', 'unsupported_policy_version');
    end if;
    if exists (select 1 from council_agent_executions where session_id = p_session_id) then
      return jsonb_build_object('ok', false, 'reason', 'unknown_execution_policy');
    end if;
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
  if v_session.policy_version is null and p_policy_version is not null then
    update council_sessions set host_generation = p_host_generation, policy_version = p_policy_version
     where id = p_session_id;
  end if;
  select id into v_previous from council_agent_executions
   where participant_id = v_participant order by started_at desc, id desc limit 1;
  update council_agent_executions
     set ended_at = coalesce(ended_at, clock_timestamp()), stop_reason = coalesce(stop_reason, 'replaced')
   where participant_id = v_participant and ended_at is null;
  insert into council_agent_executions (
    session_id, participant_id, host_id, lease_epoch, host_generation, policy_version,
    connector_kind, connector_capabilities, capability_source, identity_assurance,
    provider, adapter_version, requested_model, effective_model,
    requested_reasoning_effort, effective_reasoning_effort, model_source,
    branch_name, worktree_path, base_sha, predecessor_execution_id, seat_token_hash, started_at
  ) values (
    p_session_id, v_participant, p_host_id, p_lease_epoch, p_host_generation, p_policy_version,
    p_connector_kind, coalesce(p_connector_capabilities, '{}'), p_capability_source,
    p_identity_assurance, p_provider, p_adapter_version, p_requested_model,
    p_effective_model, p_requested_reasoning_effort, p_effective_reasoning_effort,
    p_model_source, p_branch_name, p_worktree_path, p_base_sha, v_previous, p_seat_token_hash, clock_timestamp()
  ) returning id into v_id;
  return jsonb_build_object('ok', true, 'executionId', v_id,
    'hostGeneration', p_host_generation, 'policyVersion', p_policy_version);
end;
$$;

create or replace function public.council_start_execution_record(
  p_session_id uuid, p_agent_name text, p_host_id uuid, p_lease_epoch bigint,
  p_host_generation text, p_connector_kind text, p_connector_capabilities jsonb,
  p_capability_source text, p_identity_assurance text, p_provider text,
  p_adapter_version text, p_requested_model text, p_effective_model text,
  p_requested_reasoning_effort text, p_effective_reasoning_effort text,
  p_model_source text, p_branch_name text, p_worktree_path text, p_base_sha text, p_seat_token_hash text
) returns jsonb language sql security invoker set search_path = public, pg_temp as $$
  select council_start_policy_execution_record(p_session_id, p_agent_name, p_host_id, p_lease_epoch,
    p_host_generation, p_connector_kind, p_connector_capabilities, p_capability_source,
    p_identity_assurance, p_provider, p_adapter_version, p_requested_model, p_effective_model,
    p_requested_reasoning_effort, p_effective_reasoning_effort, p_model_source,
    p_branch_name, p_worktree_path, p_base_sha, p_seat_token_hash, null);
$$;

create or replace function public.council_start_bound_policy_execution(
  p_session_id uuid, p_agent_name text, p_host_id uuid, p_lease_epoch bigint,
  p_host_generation text, p_connector_kind text, p_connector_capabilities jsonb,
  p_capability_source text, p_identity_assurance text, p_provider text,
  p_adapter_version text, p_requested_model text, p_effective_model text,
  p_requested_reasoning_effort text, p_effective_reasoning_effort text,
  p_model_source text, p_branch_name text, p_worktree_path text, p_base_sha text,
  p_seat_token_hash text, p_policy_version text
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
  v_result := council_start_policy_execution_record(p_session_id, p_agent_name, p_host_id, p_lease_epoch,
    p_host_generation, p_connector_kind, p_connector_capabilities, p_capability_source,
    p_identity_assurance, p_provider, p_adapter_version, p_requested_model, p_effective_model,
    p_requested_reasoning_effort, p_effective_reasoning_effort, p_model_source,
    p_branch_name, p_worktree_path, p_base_sha, p_seat_token_hash, p_policy_version);
  if v_result->>'ok' <> 'true' then return v_result; end if;
  update council_seat_keys set execution_id = (v_result->>'executionId')::uuid where id = v_key.id;
  return v_result || jsonb_build_object('seatBound', true);
end;
$$;

create or replace function public.start_council_bound_agent_execution(
  p_session_id uuid, p_agent_name text, p_host_id uuid, p_lease_epoch bigint,
  p_host_generation text, p_connector_kind text, p_connector_capabilities jsonb,
  p_capability_source text, p_identity_assurance text, p_provider text,
  p_adapter_version text, p_requested_model text, p_effective_model text,
  p_requested_reasoning_effort text, p_effective_reasoning_effort text,
  p_model_source text, p_branch_name text, p_worktree_path text, p_base_sha text, p_seat_token_hash text
) returns jsonb language sql security invoker set search_path = public, pg_temp as $$
  select council_start_bound_policy_execution(p_session_id, p_agent_name, p_host_id, p_lease_epoch,
    p_host_generation, p_connector_kind, p_connector_capabilities, p_capability_source,
    p_identity_assurance, p_provider, p_adapter_version, p_requested_model, p_effective_model,
    p_requested_reasoning_effort, p_effective_reasoning_effort, p_model_source,
    p_branch_name, p_worktree_path, p_base_sha, p_seat_token_hash, null);
$$;

create or replace function public.start_council_versioned_bound_execution(
  p_session_id uuid, p_agent_name text, p_host_id uuid, p_lease_epoch bigint,
  p_host_generation text, p_connector_kind text, p_connector_capabilities jsonb,
  p_capability_source text, p_identity_assurance text, p_provider text,
  p_adapter_version text, p_requested_model text, p_effective_model text,
  p_requested_reasoning_effort text, p_effective_reasoning_effort text,
  p_model_source text, p_branch_name text, p_worktree_path text, p_base_sha text,
  p_seat_token_hash text, p_policy_version text
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if p_policy_version is null then
    return jsonb_build_object('ok', false, 'reason', 'unsupported_policy_version');
  end if;
  return council_start_bound_policy_execution(p_session_id, p_agent_name, p_host_id, p_lease_epoch,
    p_host_generation, p_connector_kind, p_connector_capabilities, p_capability_source,
    p_identity_assurance, p_provider, p_adapter_version, p_requested_model, p_effective_model,
    p_requested_reasoning_effort, p_effective_reasoning_effort, p_model_source,
    p_branch_name, p_worktree_path, p_base_sha, p_seat_token_hash, p_policy_version);
end;
$$;

create or replace function public.get_council_execution_boundary(
  p_session_id uuid, p_host_id uuid, p_lease_epoch bigint
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session council_sessions; v_lease council_host_leases;
begin
  select * into v_session from council_sessions where id = p_session_id for share;
  if v_session.id is null or v_session.status = 'expired' then
    return jsonb_build_object('ok', false, 'reason', 'inactive_session');
  end if;
  select * into v_lease from council_host_leases where session_id = p_session_id for share;
  if v_lease.session_id is null or v_lease.host_id is distinct from p_host_id
     or v_lease.lease_epoch is distinct from p_lease_epoch or v_lease.released_at is not null
     or v_lease.lease_expires_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'stale_host');
  end if;
  return jsonb_build_object('ok', true, 'hostGeneration', v_session.host_generation,
    'policyVersion', v_session.policy_version,
    'hasExecutionHistory', exists(select 1 from council_agent_executions where session_id = p_session_id));
end;
$$;

create or replace function public.council_execution_evidence(
  p_execution_id uuid, p_session_id uuid, p_agent_name text
) returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'executionId', e.id, 'agentName', p.name, 'connectorKind', e.connector_kind,
    'identityAssurance', e.identity_assurance, 'provider', e.provider,
    'adapterVersion', e.adapter_version, 'requestedModel', e.requested_model,
    'effectiveModel', e.effective_model, 'requestedReasoningEffort', e.requested_reasoning_effort,
    'effectiveReasoningEffort', e.effective_reasoning_effort, 'modelSource', e.model_source,
    'hostGeneration', e.host_generation, 'policyVersion', e.policy_version
  ) from council_agent_executions e join council_participants p on p.id = e.participant_id
   where e.id = p_execution_id and e.session_id = p_session_id
     and p.session_id = p_session_id and p.name = p_agent_name and p.kind = 'agent';
$$;

do $$ declare f record; begin
  for f in select oid::regprocedure as signature from pg_proc
    where pronamespace = 'public'::regnamespace and proname in (
      'council_session_policy_immutable', 'council_start_policy_execution_record',
      'council_start_execution_record', 'council_start_bound_policy_execution',
      'start_council_bound_agent_execution', 'start_council_versioned_bound_execution',
      'get_council_execution_boundary', 'council_execution_evidence'
    ) loop
    execute format('revoke all on function %s from public, anon, authenticated', f.signature);
    execute format('grant execute on function %s to service_role', f.signature);
  end loop;
end $$;

commit;
