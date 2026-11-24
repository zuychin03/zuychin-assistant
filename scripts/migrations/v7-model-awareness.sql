-- Model awareness (V7): purpose tags, drafted and approved profiles, worker feedback, speed and feedback summaries.
-- Apply manually after v7-model-catalogue.sql; safe to re-run.
begin;
do $$ begin
  if to_regclass('public.model_catalogue') is null then
    raise exception 'Apply v7-model-catalogue.sql before v7-model-awareness.sql.';
  end if;
  if to_regclass('public.agent_runs') is null then
    raise exception 'The agent_runs table is missing. Apply supabase-setup.sql first.';
  end if;
end $$;

create table if not exists public.model_profiles (
  provider_id text not null,
  model_id text not null,
  tags text[] not null default '{}'
    check (tags <@ array['research', 'coding', 'reasoning', 'writing', 'vision', 'long-context', 'multilingual', 'agentic']::text[]),
  tags_source text not null default 'seed' check (tags_source in ('seed', 'lookup', 'owner')),
  profile jsonb check (profile is null or (jsonb_typeof(profile) = 'object' and octet_length(profile::text) <= 20000)),
  approved_at timestamptz,
  draft jsonb check (draft is null or (jsonb_typeof(draft) = 'object' and octet_length(draft::text) <= 20000)),
  draft_status text not null default 'none' check (draft_status in ('none', 'pending', 'ready', 'failed')),
  draft_error text check (char_length(draft_error) <= 500),
  drafted_at timestamptz,
  lookup_attempts integer not null default 0 check (lookup_attempts >= 0),
  vault_path text check (char_length(vault_path) <= 300),
  vault_synced_at timestamptz,
  vault_error text check (char_length(vault_error) <= 500),
  removed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (provider_id, model_id),
  foreign key (provider_id, model_id) references public.model_catalogue (provider_id, model_id) on delete cascade
);
-- Owner removal from the selectable list; added separately so a re-run upgrades an earlier copy of this table.
alter table public.model_profiles add column if not exists removed_at timestamptz;

create table if not exists public.model_feedback (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null check (provider_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$'),
  model_id text not null check (model_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$'),
  purpose text check (purpose in ('research', 'coding', 'reasoning', 'writing', 'vision', 'long-context', 'multilingual', 'agentic')),
  source text not null check (source in ('lead', 'auto')),
  useful boolean not null,
  reason text check (char_length(reason) <= 200),
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_model_feedback_model on public.model_feedback (provider_id, model_id, created_at desc);
create index if not exists idx_model_feedback_run on public.model_feedback (agent_run_id) where agent_run_id is not null;

alter table public.model_profiles enable row level security;
alter table public.model_feedback enable row level security;
revoke all on public.model_profiles from public, anon, authenticated;
revoke all on public.model_feedback from public, anon, authenticated;
grant select, insert, update on public.model_profiles to service_role;
grant select, insert on public.model_feedback to service_role;
-- The dashboard deletes discovered models their provider has retired.
grant delete on public.model_catalogue to service_role;
drop policy if exists model_profiles_service_access on public.model_profiles;
create policy model_profiles_service_access on public.model_profiles
  for all to service_role using (true) with check (true);
drop policy if exists model_feedback_service_access on public.model_feedback;
create policy model_feedback_service_access on public.model_feedback
  for all to service_role using (true) with check (true);

alter table public.model_call_observations drop constraint if exists model_call_observations_purpose_check;
alter table public.model_call_observations add constraint model_call_observations_purpose_check
  check (purpose in ('chat', 'embedding', 'routing', 'worker', 'orchestration', 'compaction', 'continuation', 'extraction', 'summary', 'title', 'search', 'speech', 'study', 'probe', 'lookup', 'consult', 'council', 'transcription'));

-- Successful calls in the window; tokens per second counts output after the first answer, from complete usage only.
create or replace function public.assistant_model_speed(p_days integer default 14)
returns table (
  provider_id text, model_id text, timed_calls bigint,
  median_first_answer_ms double precision, p90_first_answer_ms double precision, median_duration_ms double precision,
  median_tokens_per_second double precision, succeeded bigint, failed bigint, last_success_at timestamptz
)
language sql stable security invoker set search_path = pg_catalog, public as $$
  select o.provider_id, o.model_id,
    count(*) filter (where o.status = 'success' and o.first_answer_ms is not null),
    percentile_cont(0.5) within group (order by o.first_answer_ms) filter (where o.status = 'success' and o.first_answer_ms is not null),
    percentile_cont(0.9) within group (order by o.first_answer_ms) filter (where o.status = 'success' and o.first_answer_ms is not null),
    percentile_cont(0.5) within group (order by o.duration_ms) filter (where o.status = 'success'),
    percentile_cont(0.5) within group (order by o.output_tokens / ((o.duration_ms - o.first_answer_ms) / 1000.0))
      filter (where o.status = 'success' and o.usage_completeness = 'complete' and o.output_tokens > 0
        and o.first_answer_ms is not null and o.duration_ms - o.first_answer_ms >= 250),
    count(*) filter (where o.status = 'success'),
    count(*) filter (where o.status not in ('success', 'aborted', 'unknown')),
    max(o.started_at) filter (where o.status = 'success')
  from public.model_call_observations o
  where o.execution_scope = 'assistant' and o.purpose not in ('embedding', 'speech')
    and o.started_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 14), 90)))
  group by o.provider_id, o.model_id;
$$;

create or replace function public.assistant_model_feedback(p_days integer default 30)
returns table (provider_id text, model_id text, purpose text, useful bigint, not_useful bigint, last_at timestamptz)
language sql stable security invoker set search_path = pg_catalog, public as $$
  select f.provider_id, f.model_id, f.purpose, count(*) filter (where f.useful), count(*) filter (where not f.useful), max(f.created_at)
  from public.model_feedback f
  where f.created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)))
  group by f.provider_id, f.model_id, f.purpose;
$$;

-- Null p_tags keeps the tags, null p_profile keeps the approved profile; the model approval and the profile land together.
create or replace function public.model_profile_approve(
  p_provider_id text, p_model_id text, p_tags text[], p_profile jsonb, p_approve_model boolean default false
)
returns text
language plpgsql volatile security invoker set search_path = pg_catalog, public as $$
begin
  if not exists (select 1 from public.model_catalogue c where c.provider_id = p_provider_id and c.model_id = p_model_id) then
    return 'not_found';
  end if;
  insert into public.model_profiles as p (provider_id, model_id, tags, tags_source, profile, approved_at, updated_at)
  values (p_provider_id, p_model_id, coalesce(p_tags, '{}'), 'owner', p_profile, case when p_profile is null then null else now() end, now())
  on conflict (provider_id, model_id) do update set
    tags = coalesce(p_tags, p.tags),
    tags_source = case when p_tags is null then p.tags_source else 'owner' end,
    profile = coalesce(p_profile, p.profile),
    approved_at = case when p_profile is null then p.approved_at else now() end,
    draft_status = case when p_profile is not null and p.draft_status = 'ready' then 'none' else p.draft_status end,
    updated_at = now();
  if p_approve_model then
    update public.model_catalogue c set approved_at = coalesce(c.approved_at, now()), updated_at = now()
    where c.provider_id = p_provider_id and c.model_id = p_model_id;
  end if;
  return 'ok';
end;
$$;

revoke all on function public.assistant_model_speed(integer) from public, anon, authenticated;
revoke all on function public.assistant_model_feedback(integer) from public, anon, authenticated;
revoke all on function public.model_profile_approve(text, text, text[], jsonb, boolean) from public, anon, authenticated;
grant execute on function public.assistant_model_speed(integer) to service_role;
grant execute on function public.assistant_model_feedback(integer) to service_role;
grant execute on function public.model_profile_approve(text, text, text[], jsonb, boolean) to service_role;

-- Seeded purpose tags for the code models of 18/11/2026; rows whose catalogue entry is absent are skipped.
insert into public.model_profiles (provider_id, model_id, tags, tags_source)
select v.provider_id, v.model_id, v.tags, 'seed'
from (values
  ('gemini', 'gemini-3.8-flash', array['research', 'coding', 'reasoning', 'writing', 'vision', 'long-context', 'multilingual', 'agentic']::text[]),
  ('gemini', 'gemini-3.5-flash-lite', array['research', 'coding', 'reasoning', 'vision', 'long-context', 'multilingual', 'agentic']::text[]),
  ('gemini-free', 'gemini-3.8-flash', array['research', 'coding', 'reasoning', 'writing', 'vision', 'long-context', 'multilingual', 'agentic']::text[]),
  ('gemini-free', 'gemini-3.5-flash-lite', array['research', 'coding', 'reasoning', 'vision', 'long-context', 'multilingual', 'agentic']::text[]),
  ('openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free', array['research', 'coding', 'reasoning', 'writing', 'long-context', 'agentic']::text[]),
  ('openrouter', 'poolside/laguna-s-2.1:free', array['coding', 'reasoning', 'agentic']::text[]),
  ('openrouter', 'google/gemma-4-31b-it:free', array['coding', 'writing', 'vision', 'multilingual', 'agentic']::text[]),
  ('openrouter', 'google/gemma-4-26b-a4b-it', array['reasoning', 'vision', 'multilingual', 'agentic']::text[]),
  ('openrouter', 'nvidia/nemotron-3.5-lightning:free', array['research', 'coding', 'reasoning', 'long-context', 'agentic']::text[]),
  ('kilo', 'nvidia/nemotron-3-ultra-550b-a55b:free', array['research', 'coding', 'reasoning', 'writing', 'long-context', 'agentic']::text[]),
  ('kilo', 'nvidia/nemotron-3.5-lightning:free', array['research', 'coding', 'reasoning', 'long-context', 'agentic']::text[]),
  ('kilo', 'inclusionai/ling-3.0-flash-vl:free', array['reasoning', 'vision', 'agentic']::text[]),
  ('kilo', 'stepfun/step-3.7-flash:free', array['coding', 'reasoning', 'vision', 'agentic']::text[]),
  ('kilo', 'poolside/laguna-s-2.1:free', array['coding', 'reasoning', 'agentic']::text[]),
  ('nvidia-nim', 'nvidia/nemotron-3-ultra-550b-a55b', array['research', 'coding', 'reasoning', 'writing', 'long-context', 'agentic']::text[]),
  ('nvidia-nim', 'google/gemma-4-31b-it', array['coding', 'writing', 'vision', 'multilingual', 'agentic']::text[]),
  ('nvidia-nim', 'z-ai/glm-5.3-flash', array['research', 'coding', 'reasoning', 'vision', 'agentic']::text[]),
  ('nvidia-nim', 'nvidia/nemotron-3.5-lightning-30b-a3b', array['research', 'coding', 'reasoning', 'long-context', 'agentic']::text[]),
  ('nvidia-nim', 'poolside/laguna-xs-2.1', array['coding', 'agentic']::text[]),
  ('deepseek', 'deepseek-flash', array['coding', 'reasoning', 'vision', 'long-context', 'agentic']::text[]),
  ('deepseek', 'deepseek-v4-pro', array['research', 'coding', 'reasoning', 'writing', 'long-context', 'agentic']::text[]),
  ('tokenrouter', 'moonshotai/kimi-k3-free', array['research', 'coding', 'reasoning', 'writing', 'vision', 'long-context', 'agentic']::text[])
) as v (provider_id, model_id, tags)
join public.model_catalogue c on c.provider_id = v.provider_id and c.model_id = v.model_id
on conflict (provider_id, model_id) do nothing;

commit;
