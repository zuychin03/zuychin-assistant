-- Server-only tables. The app reaches every table through the service role, which bypasses
-- row-level security. The "Allow all access" policies that setup used to create applied to every
-- role, so the public anon key could read and write these tables, and any caller could run
-- delete_conversation_with_associations. This drops those policies and revokes both routes.
-- The other tables setup creates never had the policy, but some kept Supabase's default anon and
-- authenticated grants behind row-level security. Those grants are revoked too; their service-role
-- grants are left alone, because some of them deliberately give the service role fewer rights.
--
-- Safe to run more than once. Tables or the function missing from an older install are skipped.
-- The final query lists anything in the public schema that anon or authenticated can still
-- reach, including tables setup does not create: expect no rows.

create temporary table if not exists server_only_tables (name text primary key);
insert into server_only_tables (name) values
  ('user_profiles'), ('conversations'), ('messages'), ('embeddings'), ('todos'), ('artifacts'),
  ('vault_pages'), ('agent_runs'), ('memories'), ('scheduled_tasks'), ('processed_emails'),
  ('projects'), ('custom_skills'), ('initiative_log'), ('cron_state'), ('push_subscriptions'),
  ('conversation_cleanup_recommendations'), ('vault_graph_snapshot'), ('vault_page_links')
on conflict do nothing;

create temporary table if not exists revoke_only_tables (name text primary key);
insert into revoke_only_tables (name) values
  ('knowledge_documents'), ('knowledge_chunks'), ('knowledge_links'), ('knowledge_assertions'),
  ('knowledge_events'), ('knowledge_sync_state'), ('knowledge_suggestions'), ('council_sessions'),
  ('council_messages'), ('council_participants'), ('auth_passkeys'), ('auth_challenges'), ('auth_totp'),
  ('council_campaigns'), ('council_work_items'), ('council_owner_messages'), ('council_seat_keys'),
  ('agent_tool_calls'), ('council_host_leases'), ('council_deliveries'), ('council_agent_executions'),
  ('council_verification_runs'), ('agent_clients'), ('agent_client_keys'), ('agent_client_claims'),
  ('agent_claim_attempts'), ('capture_inbox'), ('assistant_conversation_branches'),
  ('assistant_branch_messages'), ('assistant_context_revisions'), ('assistant_conversation_summaries'),
  ('model_call_observations'), ('research_questions'), ('research_sources'), ('research_entries'),
  ('assistant_task_runs'), ('assistant_action_approvals'), ('study_settings'), ('study_cards'),
  ('study_reviews'), ('council_integration_attempts')
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
  for t in select name from revoke_only_tables where to_regclass(format('public.%I', name)) is not null loop
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
  if to_regprocedure('public.delete_conversation_with_associations(uuid)') is not null then
    revoke all on function public.delete_conversation_with_associations(uuid) from public, anon, authenticated;
    grant execute on function public.delete_conversation_with_associations(uuid) to service_role;
  end if;
end $$;

select 'table' as still_open, c.relname::text as object, r.role as reachable_by
from pg_class c cross join (values ('anon'), ('authenticated')) as r(role)
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
  and (has_table_privilege(r.role, c.oid, 'select')
    or has_table_privilege(r.role, c.oid, 'insert')
    or has_table_privilege(r.role, c.oid, 'update')
    or has_table_privilege(r.role, c.oid, 'delete'))
union all
select 'policy', tablename || ': ' || policyname, array_to_string(roles, ', ')
from pg_policies
where schemaname = 'public' and roles && array['public', 'anon', 'authenticated']::name[]
union all
select 'function', p.oid::regprocedure::text, r.role
from pg_proc p cross join (values ('anon'), ('authenticated')) as r(role)
where p.pronamespace = 'public'::regnamespace and p.prosecdef
  and has_function_privilege(r.role, p.oid, 'execute');
