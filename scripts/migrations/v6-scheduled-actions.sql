-- Assistant scheduled runs and owner-reviewed actions.
begin;
create table if not exists public.assistant_task_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  user_profile_id uuid not null references public.user_profiles(id),
  request_id uuid not null unique,
  task_title text not null,
  task_snapshot jsonb not null,
  trigger text not null check (trigger in ('schedule','manual')),
  status text not null default 'running' check (status in ('running','ok','error','interrupted')),
  started_at timestamptz not null default now(),
  execution_started_at timestamptz,
  expires_at timestamptz not null default now() + interval '10 minutes',
  finished_at timestamptz,
  detail text
);
create unique index if not exists assistant_task_single_run on public.assistant_task_runs(task_id) where status = 'running';
create index if not exists assistant_task_run_owner on public.assistant_task_runs(user_profile_id, started_at desc);
alter table public.assistant_task_runs add column if not exists delivery_started_at timestamptz;
alter table public.scheduled_tasks add column if not exists latest_run_id uuid;
create table if not exists public.assistant_action_approvals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  run_id uuid not null references public.assistant_task_runs(id),
  user_profile_id uuid not null references public.user_profiles(id),
  task_title text not null,
  tool text not null check (tool ~ '^[a-z][a-z0-9_]{0,79}$' and tool not like 'council_%'),
  args jsonb not null check (jsonb_typeof(args) = 'object' and octet_length(args::text) <= 200000),
  args_hash text not null check (args_hash ~ '^[a-f0-9]{64}$'),
  instruction text not null,
  source_context text not null default '',
  status text not null default 'pending' check (status in ('pending','executing','succeeded','rejected','expired','outcome_unknown')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  decided_at timestamptz,
  execution_token uuid,
  receipt text,
  unique(run_id, tool, args_hash)
);
create index if not exists assistant_approval_owner on public.assistant_action_approvals(user_profile_id, created_at desc);
alter table public.assistant_task_runs enable row level security;
alter table public.assistant_action_approvals enable row level security;
revoke all on public.assistant_task_runs, public.assistant_action_approvals from public, anon, authenticated;
grant select, insert, update on public.assistant_task_runs, public.assistant_action_approvals to service_role;

create or replace function public.assistant_claim_task_run(p_task_id uuid, p_request_id uuid, p_trigger text, p_user_id uuid, p_due_at timestamptz default null, p_next_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare t public.scheduled_tasks; r public.assistant_task_runs;
begin
  if p_trigger not in ('manual','schedule') then raise exception 'Invalid trigger'; end if;
  select * into t from public.scheduled_tasks where id = p_task_id and user_profile_id = p_user_id for update;
  if not found then return jsonb_build_object('error','Task or owner unavailable'); end if;
  select * into r from public.assistant_task_runs where request_id = p_request_id;
  if found then
    if r.task_id <> p_task_id or r.user_profile_id <> p_user_id then return jsonb_build_object('error','Request identity conflict'); end if;
    return jsonb_build_object('status','reused','run',to_jsonb(r));
  end if;
  update public.assistant_task_runs set status='interrupted', finished_at=now(), detail='The runner stopped without a confirmed result.'
    where task_id=p_task_id and status='running' and expires_at <= now();
  select * into r from public.assistant_task_runs where task_id=p_task_id and status='running';
  if found then return jsonb_build_object('status','active','run',to_jsonb(r)); end if;
  if p_trigger = 'schedule' then
    if not t.enabled or t.next_run_at is distinct from p_due_at or t.next_run_at > now() or t.next_run_at is null then
      return jsonb_build_object('status','not_due');
    end if;
    update public.scheduled_tasks set next_run_at=p_next_at, enabled=case when schedule_type='once' then false else enabled end where id=t.id;
  end if;
  insert into public.assistant_task_runs(task_id,user_profile_id,request_id,task_title,task_snapshot,trigger)
    values(t.id,p_user_id,p_request_id,t.title,to_jsonb(t),p_trigger) returning * into r;
  update public.scheduled_tasks set latest_run_id=r.id where id=t.id;
  return jsonb_build_object('status','accepted','run',to_jsonb(r));
end;
$$;

create or replace function public.assistant_start_task_run(p_run_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.assistant_task_runs set execution_started_at=now()
    where id=p_run_id and status='running' and execution_started_at is null and expires_at > now();
  return found;
end;
$$;

create or replace function public.assistant_propose_action(p_run_id uuid,p_tool text,p_args jsonb,p_hash text,p_sources text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.assistant_task_runs; a public.assistant_action_approvals;
begin
  select * into r from public.assistant_task_runs where id=p_run_id and status='running' and expires_at > now() for share;
  if not found then raise exception 'Active scheduled run unavailable'; end if;
  insert into public.assistant_action_approvals(task_id,run_id,user_profile_id,task_title,tool,args,args_hash,instruction,source_context)
    values(r.task_id,r.id,r.user_profile_id,r.task_title,p_tool,p_args,p_hash,left(r.task_snapshot->>'instruction',20000),left(p_sources,16000))
    on conflict(run_id,tool,args_hash) do nothing;
  select * into a from public.assistant_action_approvals where run_id=r.id and tool=p_tool and args_hash=p_hash;
  if a.args <> p_args then raise exception 'Action identity conflict'; end if;
  return to_jsonb(a);
end;
$$;

create or replace function public.assistant_claim_task_delivery(p_run_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare task uuid;
begin
  select task_id into task from public.assistant_task_runs where id=p_run_id;
  perform 1 from public.scheduled_tasks where id=task and latest_run_id=p_run_id for update;
  if not found then return false; end if;
  update public.assistant_task_runs set delivery_started_at=now()
    where id=p_run_id and status='running' and execution_started_at is not null and expires_at>now() and delivery_started_at is null;
  return found;
end;
$$;

create or replace function public.assistant_finish_task_run(p_run_id uuid,p_status text,p_detail text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare task uuid;
begin
  if p_status not in ('ok','error') then raise exception 'Invalid run result'; end if;
  select task_id into task from public.assistant_task_runs where id=p_run_id;
  perform 1 from public.scheduled_tasks where id=task and latest_run_id=p_run_id for update;
  if not found then return false; end if;
  update public.assistant_task_runs set status=p_status,detail=left(p_detail,12000),finished_at=now()
    where id=p_run_id and status='running' and expires_at>now();
  if not found then return false; end if;
  update public.scheduled_tasks set last_run_at=now(),last_status=p_status,last_result=left(p_detail,500) where id=task and latest_run_id=p_run_id;
  return true;
end;
$$;
revoke all on function public.assistant_claim_task_delivery(uuid), public.assistant_finish_task_run(uuid,text,text) from public,anon,authenticated;
grant execute on function public.assistant_claim_task_delivery(uuid), public.assistant_finish_task_run(uuid,text,text) to service_role;

create or replace function public.assistant_decide_action(p_id uuid,p_user_id uuid,p_decision text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.assistant_action_approvals; task_owner uuid;
begin
  if p_decision not in ('approve','reject') then raise exception 'Invalid decision'; end if;
  select task_id into task_owner from public.assistant_action_approvals where id=p_id and user_profile_id=p_user_id;
  if task_owner is null then return null; end if;
  perform 1 from public.scheduled_tasks where id=task_owner and user_profile_id=p_user_id for update;
  if not found then return null; end if;
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

create or replace function public.assistant_finish_action(p_id uuid,p_token uuid,p_status text,p_receipt text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_status not in ('succeeded','outcome_unknown') then raise exception 'Invalid receipt state'; end if;
  update public.assistant_action_approvals set status=p_status,receipt=left(p_receipt,12000)
    where id=p_id and execution_token=p_token and status='executing';
  return found;
end;
$$;

create or replace function public.assistant_delete_task(p_id uuid,p_user_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform 1 from public.scheduled_tasks where id=p_id and user_profile_id=p_user_id for update;
  if not found then return false; end if;
  if exists(select 1 from public.assistant_task_runs where task_id=p_id and status='running' and expires_at > now())
    or exists(select 1 from public.assistant_action_approvals where task_id=p_id and status='executing')
    then return false; end if;
  update public.assistant_action_approvals set status='rejected',decided_at=now(),receipt='Task deleted by its owner.'
    where task_id=p_id and status='pending';
  delete from public.scheduled_tasks where id=p_id and user_profile_id=p_user_id;
  return found;
end;
$$;

create or replace function public.assistant_action_immutable()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if row(old.id,old.task_id,old.run_id,old.user_profile_id,old.task_title,old.tool,old.args,old.args_hash,old.instruction,old.source_context,old.created_at,old.expires_at)
    is distinct from row(new.id,new.task_id,new.run_id,new.user_profile_id,new.task_title,new.tool,new.args,new.args_hash,new.instruction,new.source_context,new.created_at,new.expires_at)
    then raise exception 'Approval payload is immutable'; end if;
  if old.status <> new.status and not (
    (old.status='pending' and new.status in ('executing','rejected','expired'))
    or (old.status='executing' and new.status in ('succeeded','outcome_unknown'))
  ) then raise exception 'Invalid approval transition'; end if;
  return new;
end;
$$;
drop trigger if exists assistant_action_payload_immutable on public.assistant_action_approvals;
create trigger assistant_action_payload_immutable before update on public.assistant_action_approvals
  for each row execute function public.assistant_action_immutable();
revoke all on function public.assistant_action_immutable(), public.assistant_delete_task(uuid,uuid) from public,anon,authenticated;
grant execute on function public.assistant_delete_task(uuid,uuid) to service_role;

revoke all on function public.assistant_claim_task_run(uuid,uuid,text,uuid,timestamptz,timestamptz), public.assistant_start_task_run(uuid),
 public.assistant_propose_action(uuid,text,jsonb,text,text), public.assistant_decide_action(uuid,uuid,text),
 public.assistant_finish_action(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.assistant_claim_task_run(uuid,uuid,text,uuid,timestamptz,timestamptz), public.assistant_start_task_run(uuid),
 public.assistant_propose_action(uuid,text,jsonb,text,text), public.assistant_decide_action(uuid,uuid,text),
 public.assistant_finish_action(uuid,uuid,text,text) to service_role;
commit;
