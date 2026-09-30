-- ===== Council owner merge package =====

create table if not exists council_integration_attempts (
  id uuid primary key,
  session_id uuid not null references council_sessions(id),
  campaign_id uuid not null references council_campaigns(id),
  attempt_number integer not null check (attempt_number > 0),
  host_id uuid not null,
  lease_epoch bigint not null,
  status text not null default 'running' check (status in ('running', 'verified', 'conflict', 'failed')),
  mode text not null check (mode in ('host', 'agent')),
  integrator_agent text,
  manifest jsonb not null,
  manifest_hash text not null,
  base_branch text not null,
  base_sha text not null,
  decision text,
  open_questions jsonb not null default '[]',
  started_at timestamptz not null default clock_timestamp(),
  branch text,
  tip_sha text,
  execution_id uuid references council_agent_executions(id),
  execution_evidence jsonb,
  evidence jsonb,
  result_digest text,
  finished_at timestamptz,
  unique (campaign_id, attempt_number),
  check ((mode = 'host' and integrator_agent is null) or (mode = 'agent' and integrator_agent is not null)),
  check ((status = 'running' and finished_at is null and result_digest is null)
    or (status <> 'running' and finished_at is not null and result_digest is not null))
);
create unique index if not exists idx_council_integration_attempt_running
  on council_integration_attempts(campaign_id) where status = 'running';
create index if not exists idx_council_integration_attempt_history
  on council_integration_attempts(session_id, attempt_number desc);
alter table council_integration_attempts enable row level security;
revoke all on council_integration_attempts from public, anon, authenticated;
grant select, insert, update on council_integration_attempts to service_role;

create or replace function council_integration_attempt_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'integration attempts are immutable'; end if;
  if to_jsonb(new) = to_jsonb(old) then return new; end if;
  if old.status <> 'running' or new.status = 'running'
    or (to_jsonb(new) - array['status','branch','tip_sha','execution_id','execution_evidence','evidence','result_digest','finished_at'])
      is distinct from (to_jsonb(old) - array['status','branch','tip_sha','execution_id','execution_evidence','evidence','result_digest','finished_at']) then
    raise exception 'integration attempt facts and terminal results are immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists council_integration_attempt_immutable on council_integration_attempts;
create trigger council_integration_attempt_immutable before update or delete on council_integration_attempts
  for each row execute function council_integration_attempt_immutable();

create or replace function council_integration_attempt_json(p_attempt council_integration_attempts)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', p_attempt.id, 'sessionId', p_attempt.session_id, 'campaignId', p_attempt.campaign_id,
    'attemptNumber', p_attempt.attempt_number, 'status', p_attempt.status, 'mode', p_attempt.mode,
    'integratorAgent', p_attempt.integrator_agent, 'manifest', p_attempt.manifest,
    'manifestHash', p_attempt.manifest_hash, 'baseBranch', p_attempt.base_branch,
    'baseSha', p_attempt.base_sha, 'decision', p_attempt.decision,
    'openQuestions', p_attempt.open_questions, 'startedAt', p_attempt.started_at
  );
$$;

create or replace function council_integration_evidence_valid(p_evidence jsonb)
returns boolean language plpgsql immutable as $$
declare v_receipt jsonb; v_value jsonb; v_refs jsonb; v_text text;
begin
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'object'
    or p_evidence->'version' is distinct from '1'::jsonb
    or p_evidence->'redactionVersion' is distinct from '1'::jsonb
    or (select count(*) from jsonb_object_keys(p_evidence)) <> 8
    or not p_evidence ?& array['version','redactionVersion','receipts','changedPaths','diffSummary','protectedRefs','conflictNotes','manualChecks']
    or exists (select 1 from jsonb_object_keys(p_evidence) k where k not in ('version','redactionVersion','receipts','changedPaths','diffSummary','protectedRefs','conflictNotes','manualChecks')) then return false; end if;
  if jsonb_typeof(p_evidence->'receipts') <> 'array' or jsonb_array_length(p_evidence->'receipts') > 64 then return false; end if;
  for v_receipt in select value from jsonb_array_elements(p_evidence->'receipts') loop
    if jsonb_typeof(v_receipt) <> 'object' or (select count(*) from jsonb_object_keys(v_receipt)) <> 6
      or not v_receipt ?& array['command','exitCode','durationMs','outputDigest','outputTail','timedOut'] then return false; end if;
    if jsonb_typeof(v_receipt->'command') <> 'array' or jsonb_array_length(v_receipt->'command') not between 1 and 64 then return false; end if;
    for v_value in select value from jsonb_array_elements(v_receipt->'command') loop
      if jsonb_typeof(v_value) <> 'string' or length(v_value #>> '{}') > 2048 then return false; end if;
    end loop;
    if (v_receipt->'exitCode' <> 'null'::jsonb and (jsonb_typeof(v_receipt->'exitCode') <> 'number' or (v_receipt->>'exitCode') !~ '^-?[0-9]+$'))
      or jsonb_typeof(v_receipt->'durationMs') <> 'number' or (v_receipt->>'durationMs')::numeric < 0
      or jsonb_typeof(v_receipt->'outputDigest') <> 'string' or (v_receipt->>'outputDigest') !~* '^[a-f0-9]{64}$'
      or jsonb_typeof(v_receipt->'outputTail') <> 'string' or length(v_receipt->>'outputTail') > 4000
      or jsonb_typeof(v_receipt->'timedOut') <> 'boolean' then return false; end if;
  end loop;
  if p_evidence->'changedPaths' <> 'null'::jsonb then
    if jsonb_typeof(p_evidence->'changedPaths') <> 'array' or jsonb_array_length(p_evidence->'changedPaths') > 500 then return false; end if;
    for v_value in select value from jsonb_array_elements(p_evidence->'changedPaths') loop
      v_text := v_value #>> '{}';
      if jsonb_typeof(v_value) <> 'string' or length(v_text) not between 1 and 1024
        or v_text ~ '[:\\]' or v_text ~ U&'[\0001-\001f\007f-\009f\202a-\202e\2066-\2069]'
        or exists (select 1 from unnest(string_to_array(v_text,'/')) p where p in ('','.','..')) then return false; end if;
    end loop;
  end if;
  if p_evidence->'diffSummary' <> 'null'::jsonb and (jsonb_typeof(p_evidence->'diffSummary') <> 'string' or length(p_evidence->>'diffSummary') > 16000) then return false; end if;
  if p_evidence->'conflictNotes' <> 'null'::jsonb and (jsonb_typeof(p_evidence->'conflictNotes') <> 'string' or length(p_evidence->>'conflictNotes') > 8000) then return false; end if;
  if p_evidence->'manualChecks' <> 'null'::jsonb then
    if jsonb_typeof(p_evidence->'manualChecks') <> 'array' or jsonb_array_length(p_evidence->'manualChecks') > 32 then return false; end if;
    for v_value in select value from jsonb_array_elements(p_evidence->'manualChecks') loop
      if jsonb_typeof(v_value) <> 'string' or length(v_value #>> '{}') > 1000 then return false; end if;
    end loop;
  end if;
  if jsonb_typeof(p_evidence->'protectedRefs') <> 'object'
    or (select count(*) from jsonb_object_keys(p_evidence->'protectedRefs')) <> 2
    or not (p_evidence->'protectedRefs') ?& array['before','after'] then return false; end if;
  for v_refs in select value from jsonb_each(p_evidence->'protectedRefs') loop
    if v_refs <> 'null'::jsonb then
      if jsonb_typeof(v_refs) <> 'object' or (select count(*) from jsonb_object_keys(v_refs)) > 64 then return false; end if;
      for v_text, v_value in select key,value from jsonb_each(v_refs) loop
        if length(v_text) not between 1 and 300 or v_text !~* '^[a-z0-9][a-z0-9/_.-]*$'
          or v_text in ('__proto__','constructor','prototype')
          or (v_value <> 'null'::jsonb and (jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') !~* '^[a-f0-9]{40}$')) then return false; end if;
      end loop;
    end if;
  end loop;
  return true;
exception when others then return false;
end;
$$;

create or replace function begin_council_integration_attempt(
  p_session_id uuid, p_host_id uuid, p_lease_epoch bigint, p_attempt_id uuid, p_expected_integrator text
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session council_sessions; v_campaign council_campaigns; v_attempt council_integration_attempts;
  v_running council_integration_attempts; v_now timestamptz; v_hash text; v_number integer;
begin
  select * into v_session from council_sessions where id = p_session_id for update;
  if v_session.id is null then return jsonb_build_object('ok',false,'reason','no_session'); end if;
  perform 1 from council_host_leases where session_id = p_session_id for share;
  select * into v_campaign from council_campaigns where session_id = p_session_id for update;
  v_now := clock_timestamp();
  if not exists (select 1 from council_host_leases where session_id = p_session_id and host_id = p_host_id
    and lease_epoch = p_lease_epoch and released_at is null and lease_expires_at > v_now) then
    return jsonb_build_object('ok',false,'reason','stale_host');
  end if;
  if v_campaign.id is null then return jsonb_build_object('ok',false,'reason','no_campaign'); end if;
  if v_campaign.status <> 'complete' then return jsonb_build_object('ok',false,'reason','campaign_incomplete'); end if;
  if v_campaign.integration_manifest is null or jsonb_typeof(v_campaign.integration_manifest) <> 'object'
    or v_campaign.integration_manifest->>'campaignId' is distinct from v_campaign.id::text
    or v_campaign.integration_manifest->>'baseSha' is distinct from v_campaign.base_sha
    or jsonb_typeof(v_campaign.integration_manifest->'items') is distinct from 'array'
    or v_campaign.base_sha !~ '^[a-f0-9]{40}$' then return jsonb_build_object('ok',false,'reason','manifest_not_frozen'); end if;
  if p_expected_integrator is distinct from v_campaign.integrator_agent then return jsonb_build_object('ok',false,'reason','integrator_changed'); end if;
  if p_attempt_id is null then return jsonb_build_object('ok',false,'reason','invalid_attempt'); end if;
  v_hash := encode(sha256(convert_to(v_campaign.integration_manifest::text,'UTF8')),'hex');
  select * into v_attempt from council_integration_attempts where id = p_attempt_id;
  if v_attempt.id is not null and v_attempt.campaign_id <> v_campaign.id then return jsonb_build_object('ok',false,'reason','attempt_conflict'); end if;
  select * into v_attempt from council_integration_attempts where id = p_attempt_id and campaign_id = v_campaign.id for update;
  if v_attempt.id is not null then
    if not exists (select 1 from council_host_leases where session_id = p_session_id and host_id = p_host_id
      and lease_epoch = p_lease_epoch and released_at is null and lease_expires_at > clock_timestamp()) then return jsonb_build_object('ok',false,'reason','stale_host'); end if;
    if v_attempt.host_id is distinct from p_host_id or v_attempt.lease_epoch is distinct from p_lease_epoch
      or v_attempt.integrator_agent is distinct from p_expected_integrator or v_attempt.manifest_hash is distinct from v_hash then
      return jsonb_build_object('ok',false,'reason','attempt_conflict');
    end if;
    return jsonb_build_object('ok',true,'attempt',council_integration_attempt_json(v_attempt));
  end if;
  select * into v_running from council_integration_attempts where campaign_id = v_campaign.id and status = 'running' for update;
  v_now := clock_timestamp();
  if not exists (select 1 from council_host_leases where session_id = p_session_id and host_id = p_host_id
    and lease_epoch = p_lease_epoch and released_at is null and lease_expires_at > v_now) then return jsonb_build_object('ok',false,'reason','stale_host'); end if;
  if v_running.id is not null then
    if v_running.host_id = p_host_id and v_running.lease_epoch = p_lease_epoch then return jsonb_build_object('ok',false,'reason','attempt_running'); end if;
    update council_integration_attempts set status = 'failed', finished_at = v_now,
      result_digest = encode(sha256(convert_to(jsonb_build_object('reason','superseded_host','attemptId',v_running.id)::text,'UTF8')),'hex')
      where id = v_running.id;
  end if;
  select coalesce(max(attempt_number),0)+1 into v_number from council_integration_attempts where campaign_id = v_campaign.id;
  insert into council_integration_attempts(id,session_id,campaign_id,attempt_number,host_id,lease_epoch,mode,
    integrator_agent,manifest,manifest_hash,base_branch,base_sha,decision,open_questions,started_at)
  values(p_attempt_id,p_session_id,v_campaign.id,v_number,p_host_id,p_lease_epoch,
    case when p_expected_integrator is null then 'host' else 'agent' end,p_expected_integrator,
    v_campaign.integration_manifest,v_hash,v_campaign.base_branch,v_campaign.base_sha,v_session.verdict,
    coalesce(v_session.open_questions,'[]'::jsonb),v_now) returning * into v_attempt;
  update council_campaigns set integration_status='running', integration_branch=null, integration_tip_sha=null,
    integration_report=null, integration_checked_at=null where id=v_campaign.id;
  return jsonb_build_object('ok',true,'attempt',council_integration_attempt_json(v_attempt));
end;
$$;

create or replace function finalize_council_integration_attempt(
  p_attempt_id uuid, p_host_id uuid, p_lease_epoch bigint, p_status text,
  p_branch text, p_tip_sha text, p_execution_id uuid, p_evidence jsonb
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session_id uuid; v_campaign council_campaigns; v_attempt council_integration_attempts;
  v_execution council_agent_executions; v_execution_evidence jsonb; v_now timestamptz; v_digest text;
begin
  select session_id into v_session_id from council_integration_attempts where id=p_attempt_id;
  if v_session_id is null then return jsonb_build_object('ok',false,'reason','no_attempt'); end if;
  perform 1 from council_sessions where id = v_session_id for update;
  perform 1 from council_host_leases where session_id = v_session_id for share;
  select * into v_campaign from council_campaigns where session_id = v_session_id for update;
  select * into v_attempt from council_integration_attempts where id=p_attempt_id for update;
  v_now := clock_timestamp();
  if v_attempt.host_id is distinct from p_host_id or v_attempt.lease_epoch is distinct from p_lease_epoch
    or not exists (select 1 from council_host_leases where session_id=v_session_id and host_id=p_host_id
      and lease_epoch=p_lease_epoch and released_at is null and lease_expires_at > v_now) then
    return jsonb_build_object('ok',false,'reason','stale_host');
  end if;
  if p_status is null or p_status not in ('verified','conflict','failed')
    or (p_branch is not null and (length(p_branch) not between 1 and 200 or p_branch ~ '[[:cntrl:]]'))
    or (p_tip_sha is not null and p_tip_sha !~* '^[a-f0-9]{40}$')
    or council_integration_evidence_valid(p_evidence) is not true then return jsonb_build_object('ok',false,'reason','invalid_result'); end if;
  v_digest := encode(sha256(convert_to(jsonb_build_object('status',p_status,'branch',p_branch,'tipSha',p_tip_sha,
    'executionId',p_execution_id,'evidence',p_evidence)::text,'UTF8')),'hex');
  if v_attempt.status <> 'running' then
    if v_attempt.result_digest = v_digest then return jsonb_build_object('ok',true,'attemptId',v_attempt.id); end if;
    return jsonb_build_object('ok',false,'reason','result_conflict');
  end if;
  if v_campaign.integration_manifest is distinct from v_attempt.manifest
    or v_campaign.integrator_agent is distinct from v_attempt.integrator_agent then return jsonb_build_object('ok',false,'reason','campaign_changed'); end if;
  if v_attempt.mode = 'host' and p_execution_id is not null then return jsonb_build_object('ok',false,'reason','unexpected_execution'); end if;
  if p_execution_id is not null then
    select * into v_execution from council_agent_executions where id=p_execution_id for share;
    if v_execution.id is null or v_execution.session_id is distinct from v_session_id
      or v_execution.host_id is distinct from p_host_id or v_execution.lease_epoch is distinct from p_lease_epoch
      or v_execution.seat_token_hash is null or v_execution.started_at < v_attempt.started_at
      or (p_branch is not null and v_execution.branch_name is distinct from p_branch)
      or v_execution.base_sha is distinct from v_attempt.base_sha
      or not exists (select 1 from council_participants where id=v_execution.participant_id
        and session_id=v_session_id and name=v_attempt.integrator_agent) then return jsonb_build_object('ok',false,'reason','execution_mismatch'); end if;
    v_execution_evidence := council_execution_evidence(p_execution_id,v_session_id,v_attempt.integrator_agent);
    if v_execution_evidence is null then return jsonb_build_object('ok',false,'reason','execution_mismatch'); end if;
  end if;
  if p_status = 'verified' and (
    p_branch is null or p_tip_sha is null or (v_attempt.mode = 'agent' and p_execution_id is null)
    or p_evidence->'changedPaths' = 'null'::jsonb or p_evidence->'diffSummary' = 'null'::jsonb
    or jsonb_array_length(p_evidence->'receipts') = 0
    or exists (select 1 from jsonb_array_elements(p_evidence->'receipts') r where r->'exitCode' <> '0'::jsonb or r->'timedOut' <> 'false'::jsonb)
    or jsonb_typeof(p_evidence#>'{protectedRefs,before}') <> 'object'
    or p_evidence#>'{protectedRefs,before}' = '{}'::jsonb
    or p_evidence#>'{protectedRefs,before}' is distinct from p_evidence#>'{protectedRefs,after}'
  ) then return jsonb_build_object('ok',false,'reason','not_verified'); end if;
  if not exists (select 1 from council_host_leases where session_id=v_session_id and host_id=p_host_id
    and lease_epoch=p_lease_epoch and released_at is null and lease_expires_at > clock_timestamp()) then return jsonb_build_object('ok',false,'reason','stale_host'); end if;
  update council_integration_attempts set status=p_status,branch=p_branch,tip_sha=p_tip_sha,execution_id=p_execution_id,
    execution_evidence=v_execution_evidence,evidence=p_evidence,result_digest=v_digest,finished_at=clock_timestamp()
    where id=v_attempt.id;
  update council_campaigns set integration_status=p_status,integration_branch=p_branch,integration_tip_sha=p_tip_sha,
    integration_report=coalesce(p_evidence->>'diffSummary',p_evidence->>'conflictNotes'),integration_checked_at=clock_timestamp()
    where id=v_campaign.id;
  return jsonb_build_object('ok',true,'attemptId',v_attempt.id);
end;
$$;

create or replace function record_council_integration_v3(
  p_session_id uuid, p_reporter text, p_host_id uuid, p_lease_epoch bigint,
  p_status text, p_branch text, p_tip_sha text, p_report text
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_campaign council_campaigns;
begin
  perform 1 from council_sessions where id=p_session_id for update;
  perform 1 from council_host_leases where session_id=p_session_id for share;
  select * into v_campaign from council_campaigns where session_id=p_session_id for update;
  if v_campaign.id is null then return jsonb_build_object('ok',false,'reason','no_campaign'); end if;
  if not exists (select 1 from council_host_leases where session_id=p_session_id and host_id=p_host_id
    and lease_epoch=p_lease_epoch and released_at is null and lease_expires_at > clock_timestamp()) then return jsonb_build_object('ok',false,'reason','not_authorized'); end if;
  if exists (select 1 from council_integration_attempts where campaign_id=v_campaign.id) then return jsonb_build_object('ok',false,'reason','attempt_protocol_required'); end if;
  if p_status is null or p_status not in ('pending','running','verified','conflict','failed') then return jsonb_build_object('ok',false,'reason','bad_status'); end if;
  if v_campaign.integration_manifest is null then return jsonb_build_object('ok',false,'reason','manifest_not_frozen'); end if;
  update council_campaigns set integration_status=p_status,integration_branch=coalesce(p_branch,integration_branch),
    integration_tip_sha=coalesce(p_tip_sha,integration_tip_sha),integration_report=left(coalesce(p_report,''),16000),
    integration_checked_at=clock_timestamp() where id=v_campaign.id;
  return jsonb_build_object('ok',true);
end;
$$;

create or replace function set_campaign_integrator(p_session_id uuid, p_agent text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_campaign council_campaigns;
begin
  perform 1 from council_sessions where id=p_session_id for update;
  select * into v_campaign from council_campaigns where session_id=p_session_id for update;
  if v_campaign.id is null then return jsonb_build_object('ok',false,'reason','no_campaign'); end if;
  if v_campaign.status <> 'complete' then return jsonb_build_object('ok',false,'reason','campaign_incomplete','status',v_campaign.status); end if;
  if not exists (select 1 from council_participants where session_id=p_session_id and name=p_agent and kind='agent') then return jsonb_build_object('ok',false,'reason','not_on_roster'); end if;
  if exists (select 1 from council_integration_attempts where campaign_id=v_campaign.id and status='running') then
    if v_campaign.integrator_agent is not distinct from p_agent then return jsonb_build_object('ok',true,'campaign_id',v_campaign.id); end if;
    return jsonb_build_object('ok',false,'reason','attempt_running');
  end if;
  update council_campaigns set integrator_agent=p_agent,integration_status='pending',
    integration_report=null,integration_checked_at=null where id=v_campaign.id;
  return jsonb_build_object('ok',true,'campaign_id',v_campaign.id);
end;
$$;

do $$
declare v_function regprocedure;
begin
  for v_function in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('council_integration_attempt_immutable','council_integration_attempt_json','council_integration_evidence_valid',
      'begin_council_integration_attempt','finalize_council_integration_attempt','record_council_integration_v3','set_campaign_integrator') loop
    execute format('revoke all on function %s from public, anon, authenticated',v_function);
    execute format('grant execute on function %s to service_role',v_function);
  end loop;
end;
$$;
