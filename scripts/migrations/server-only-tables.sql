-- Server-only tables. The app reaches every table through the service role, which bypasses
-- row-level security. The "Allow all access" policies that setup used to create applied to every
-- role, so the public anon key could read and write these tables, and any caller could run
-- delete_conversation_with_associations. This drops those policies and revokes both routes.
--
-- Safe to run more than once. Tables or the function missing from an older install are skipped.
-- The final query lists anything anon or authenticated can still reach: expect no rows.

create temporary table if not exists server_only_tables (name text primary key);
insert into server_only_tables (name) values
  ('user_profiles'), ('conversations'), ('messages'), ('embeddings'), ('todos'), ('artifacts'),
  ('vault_pages'), ('agent_runs'), ('memories'), ('scheduled_tasks'), ('processed_emails'),
  ('projects'), ('custom_skills'), ('initiative_log'), ('cron_state'), ('push_subscriptions'),
  ('conversation_cleanup_recommendations'), ('vault_graph_snapshot'), ('vault_page_links')
on conflict do nothing;

do $$
declare
  t text;
begin
  for t in select name from server_only_tables where to_regclass(format('public.%I', name)) is not null loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', 'Allow all access to ' || t, t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
  if to_regprocedure('public.delete_conversation_with_associations(uuid)') is not null then
    revoke all on function public.delete_conversation_with_associations(uuid) from public, anon, authenticated;
    grant execute on function public.delete_conversation_with_associations(uuid) to service_role;
  end if;
end $$;

select 'table' as still_open, s.name as object, r.role as reachable_by
from server_only_tables s cross join (values ('anon'), ('authenticated')) as r(role)
where to_regclass(format('public.%I', s.name)) is not null
  and (has_table_privilege(r.role, format('public.%I', s.name), 'select')
    or has_table_privilege(r.role, format('public.%I', s.name), 'insert')
    or has_table_privilege(r.role, format('public.%I', s.name), 'update')
    or has_table_privilege(r.role, format('public.%I', s.name), 'delete'))
union all
select 'policy', tablename || ': ' || policyname, array_to_string(roles, ', ')
from pg_policies
where schemaname = 'public' and roles && array['public', 'anon', 'authenticated']::name[]
union all
select 'function', 'delete_conversation_with_associations(uuid)', r.role
from (values ('anon'), ('authenticated')) as r(role)
where to_regprocedure('public.delete_conversation_with_associations(uuid)') is not null
  and has_function_privilege(r.role, 'public.delete_conversation_with_associations(uuid)', 'execute');
