-- Passive assistant telemetry only. Apply manually; no provider probes run here.
begin;

create table if not exists public.model_call_observations (
  id uuid primary key,
  execution_scope text not null default 'assistant' check (execution_scope = 'assistant'),
  provider_id text not null check (provider_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$'),
  model_id text not null check (model_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$'),
  purpose text not null check (purpose in ('chat', 'embedding', 'routing', 'worker', 'orchestration', 'compaction', 'continuation', 'extraction', 'summary', 'title', 'search', 'speech')),
  started_at timestamptz not null check (isfinite(started_at)),
  duration_ms double precision not null check (duration_ms >= 0 and duration_ms <= 86400000),
  first_answer_ms double precision check (first_answer_ms >= 0 and first_answer_ms <= duration_ms),
  status text not null check (status in ('success', 'auth', 'rate_limit', 'transient', 'unavailable', 'retired', 'aborted', 'unknown')),
  error_class text check (error_class in ('http', 'abort', 'timeout', 'transport', 'unknown')),
  http_status integer check (http_status between 100 and 599),
  prompt_tokens bigint check (prompt_tokens between 0 and 9007199254740991),
  output_tokens bigint check (output_tokens between 0 and 9007199254740991),
  total_tokens bigint check (total_tokens between 0 and 9007199254740991),
  cached_input_tokens bigint check (cached_input_tokens between 0 and 9007199254740991 and (prompt_tokens is null or cached_input_tokens <= prompt_tokens)),
  usage_completeness text not null check (usage_completeness in ('complete', 'partial', 'unavailable')),
  streaming_observed boolean not null default false,
  tools_observed boolean not null default false,
  vision_observed boolean not null default false,
  grounding_observed boolean not null default false,
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  user_profile_id uuid references public.user_profiles(id) on delete set null,
  recorded_at timestamptz not null default now(),
  check (usage_completeness <> 'complete' or (prompt_tokens is not null and output_tokens is not null and total_tokens is not null)),
  check (status <> 'retired' or http_status is not distinct from 410)
);

alter table public.model_call_observations drop constraint if exists model_call_observations_purpose_check;
alter table public.model_call_observations add constraint model_call_observations_purpose_check
  check (purpose in ('chat', 'embedding', 'routing', 'worker', 'orchestration', 'compaction', 'continuation', 'extraction', 'summary', 'title', 'search', 'speech'));

create index if not exists idx_model_observations_latest
  on public.model_call_observations (provider_id, model_id, started_at desc, id desc);
create index if not exists idx_model_observations_last_success
  on public.model_call_observations (provider_id, model_id, started_at desc) where status = 'success';
create index if not exists idx_model_observations_conversation
  on public.model_call_observations (conversation_id) where conversation_id is not null;
create index if not exists idx_model_observations_message
  on public.model_call_observations (message_id) where message_id is not null;
create index if not exists idx_model_observations_profile
  on public.model_call_observations (user_profile_id) where user_profile_id is not null;

alter table public.model_call_observations enable row level security;
revoke all on public.model_call_observations from public, anon, authenticated;
grant select, insert on public.model_call_observations to service_role;
drop policy if exists model_observations_service_access on public.model_call_observations;
create policy model_observations_service_access on public.model_call_observations
  for all to service_role using (true) with check (true);

create or replace function public.assistant_model_health()
returns table (
  provider_id text, model_id text, total_calls bigint, successful_calls bigint, failed_calls bigint, aborted_calls bigint, unknown_calls bigint,
  latest_at timestamptz, latest_status text, latest_error_class text, latest_http_status integer,
  latest_duration_ms double precision, latest_first_answer_ms double precision,
  last_success_at timestamptz, median_success_duration_ms double precision, median_first_answer_ms double precision,
  first_observed_at timestamptz, streaming_observed_at timestamptz, tools_observed_at timestamptz,
  vision_observed_at timestamptz, grounding_observed_at timestamptz, purposes text[]
)
language sql stable security invoker set search_path = pg_catalog, public as $$
  with scoped as (
    select * from public.model_call_observations where execution_scope = 'assistant'
  ), latest as (
    select distinct on (o.provider_id, o.model_id)
      o.provider_id, o.model_id, o.started_at, o.status, o.error_class, o.http_status, o.duration_ms, o.first_answer_ms
    from scoped o order by o.provider_id, o.model_id, o.started_at desc, o.id desc
  ), summary as (
    select o.provider_id, o.model_id, count(*) as total_calls,
      count(*) filter (where o.status = 'success') as successful_calls,
      count(*) filter (where o.status not in ('success', 'aborted', 'unknown')) as failed_calls,
      count(*) filter (where o.status = 'aborted') as aborted_calls,
      count(*) filter (where o.status = 'unknown') as unknown_calls,
      max(o.started_at) filter (where o.status = 'success') as last_success_at,
      percentile_cont(0.5) within group (order by o.duration_ms) filter (where o.status = 'success') as median_success_duration_ms,
      percentile_cont(0.5) within group (order by o.first_answer_ms) filter (where o.status = 'success' and o.first_answer_ms is not null) as median_first_answer_ms,
      min(o.started_at) as first_observed_at,
      max(o.started_at) filter (where o.streaming_observed) as streaming_observed_at,
      max(o.started_at) filter (where o.tools_observed) as tools_observed_at,
      max(o.started_at) filter (where o.vision_observed) as vision_observed_at,
      max(o.started_at) filter (where o.grounding_observed) as grounding_observed_at,
      array_agg(distinct o.purpose order by o.purpose) as purposes
    from scoped o group by o.provider_id, o.model_id
  )
  select s.provider_id, s.model_id, s.total_calls, s.successful_calls, s.failed_calls, s.aborted_calls, s.unknown_calls,
    l.started_at, l.status, l.error_class, l.http_status, l.duration_ms, l.first_answer_ms,
    s.last_success_at, s.median_success_duration_ms, s.median_first_answer_ms, s.first_observed_at,
    s.streaming_observed_at, s.tools_observed_at, s.vision_observed_at, s.grounding_observed_at, s.purposes
  from summary s join latest l on l.provider_id = s.provider_id and l.model_id = s.model_id;
$$;

revoke all on function public.assistant_model_health() from public, anon, authenticated;
grant execute on function public.assistant_model_health() to service_role;

commit;
