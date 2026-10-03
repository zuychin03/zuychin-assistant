-- ===== Owner Council runtime inventory =====
begin;

create or replace function public.list_council_runtime_inventory(p_after uuid default null)
returns table (
  session_id uuid, code text, status text, paused_at timestamptz,
  host_generation text, policy_version text, has_execution_history boolean
) language sql stable security invoker set search_path = public, pg_temp as $$
  select s.id, s.code, s.status, s.paused_at, s.host_generation, s.policy_version,
         exists (select 1 from council_agent_executions e where e.session_id = s.id)
    from council_sessions s
   where (p_after is null or s.id > p_after)
     and (
       s.status in ('open', 'concluding', 'awaiting_owner') or
       (s.status = 'closed' and exists (
         select 1 from council_campaigns c where c.session_id = s.id and (
           c.status in ('running', 'blocked') or
           (c.status = 'complete' and coalesce(c.integration_status, 'pending') in ('pending', 'running'))
         )
       ))
     )
   order by s.id
   limit 51;
$$;

revoke all on function public.list_council_runtime_inventory(uuid) from public, anon, authenticated;
grant execute on function public.list_council_runtime_inventory(uuid) to service_role;

commit;
