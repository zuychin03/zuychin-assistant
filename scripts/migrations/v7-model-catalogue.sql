-- Stored model catalogue for provider discovery (V7). Apply manually; safe to re-run.
-- Seeds every chat model the code listed on 18/11/2026 so saved choices keep resolving once code shrinks to pins.
begin;
do $$ begin
  if to_regclass('public.model_call_observations') is null then
    raise exception 'Apply v6-model-health.sql before v7-model-catalogue.sql.';
  end if;
end $$;

create table if not exists public.model_catalogue (
  provider_id text not null check (provider_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$'),
  model_id text not null check (model_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$'),
  origin text not null check (origin in ('seed', 'discovered')),
  label text not null check (char_length(label) between 1 and 200),
  short_name text not null check (short_name ~ '^[a-z0-9][a-z0-9._:+-]{0,99}$'),
  description text check (char_length(description) <= 400),
  developer text check (char_length(developer) <= 100),
  free boolean not null default false,
  metered boolean not null default true,
  may_train boolean,
  context_tokens integer check (context_tokens > 0),
  max_output_tokens integer check (max_output_tokens > 0),
  inputs text[] not null default '{}',
  listed_tools boolean,
  listed_structured boolean,
  listed_thinking boolean,
  probe_status text not null default 'untested' check (probe_status in ('untested', 'passed', 'failed', 'inconclusive')),
  probe_attempts integer not null default 0 check (probe_attempts >= 0),
  probed_at timestamptz,
  probe_chat_ms double precision check (probe_chat_ms >= 0 and probe_chat_ms <= 86400000),
  probe_detail jsonb,
  supports_tools boolean,
  supports_search boolean,
  supports_vision boolean,
  supports_thinking boolean,
  supports_structured boolean,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz,
  missed_checks integer not null default 0 check (missed_checks >= 0),
  missing_since timestamptz,
  notified_missing_at timestamptz,
  approved_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (provider_id, model_id)
);
create unique index if not exists model_catalogue_short_name on public.model_catalogue (provider_id, short_name);

create table if not exists public.model_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null check (trigger in ('cron', 'manual')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  summary jsonb not null default '{}'::jsonb
);
-- One running discovery at a time; the run code marks a stale 'running' row failed before inserting.
create unique index if not exists model_discovery_runs_one_running on public.model_discovery_runs ((true)) where status = 'running';
create index if not exists model_discovery_runs_started on public.model_discovery_runs (started_at desc);

alter table public.model_catalogue enable row level security;
alter table public.model_discovery_runs enable row level security;
revoke all on public.model_catalogue from public, anon, authenticated;
revoke all on public.model_discovery_runs from public, anon, authenticated;
grant select, insert, update on public.model_catalogue to service_role;
grant select, insert, update on public.model_discovery_runs to service_role;
drop policy if exists model_catalogue_service_access on public.model_catalogue;
create policy model_catalogue_service_access on public.model_catalogue
  for all to service_role using (true) with check (true);
drop policy if exists model_discovery_runs_service_access on public.model_discovery_runs;
create policy model_discovery_runs_service_access on public.model_discovery_runs
  for all to service_role using (true) with check (true);

alter table public.model_call_observations drop constraint if exists model_call_observations_purpose_check;
alter table public.model_call_observations add constraint model_call_observations_purpose_check
  check (purpose in ('chat', 'embedding', 'routing', 'worker', 'orchestration', 'compaction', 'continuation', 'extraction', 'summary', 'title', 'search', 'speech', 'study', 'probe'));

insert into public.model_catalogue (
  provider_id, model_id, label, short_name, description, developer, free, metered, max_output_tokens, inputs,
  supports_tools, supports_search, supports_vision, supports_thinking, supports_structured,
  origin, probe_status, approved_at
)
select v.*, 'seed', 'untested', now() from (values
  ('gemini', 'gemini-3.8-flash', 'Gemini 3.8 Flash', 'gemini-3.8-flash', 'Multimodal Flash model with configurable thinking, function calling and structured output.', 'Google DeepMind', false, false, 65536, array['Text', 'Image', 'Audio', 'Video', 'PDF']::text[], true, true, true, true, true),
  ('gemini', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 'gemini-3.5-flash-lite', 'Flash-Lite model for low-latency multimodal tasks, with thinking and function calling.', 'Google DeepMind', false, false, 65536, array['Text', 'Image', 'Audio', 'Video', 'PDF']::text[], true, true, true, true, true),
  ('gemini-free', 'gemini-3.8-flash', 'Gemini 3.8 Flash (free)', 'gemini-3.8-flash-free', 'Multimodal Flash model with configurable thinking, function calling and structured output.', 'Google DeepMind', true, false, 65536, array['Text', 'Image', 'Audio', 'Video', 'PDF']::text[], true, true, true, true, true),
  ('gemini-free', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite (free)', 'gemini-3.5-flash-lite-free', 'Flash-Lite model for low-latency multimodal tasks, with thinking and function calling.', 'Google DeepMind', true, false, 65536, array['Text', 'Image', 'Audio', 'Video', 'PDF']::text[], true, true, true, true, true),
  ('openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'Nemotron 3 Ultra (free)', 'nemotron-3-ultra', 'Hybrid Mamba-Attention mixture-of-experts model for text reasoning, coding and tool-driven workflows.', 'NVIDIA', true, false, 65536, array['Text']::text[], true, true, false, true, null),
  ('openrouter', 'poolside/laguna-s-2.1:free', 'Laguna S 2.1 (free)', 'laguna-s-2.1', 'Coding model for software engineering, terminal workflows and tool-driven agents.', 'Poolside', true, false, 32768, array['Text']::text[], true, true, false, true, null),
  ('openrouter', 'google/gemma-4-31b-it:free', 'Gemma 4 31B IT (free)', 'gemma-4', 'Dense multimodal Gemma model with image and video understanding, multilingual text and function calling.', 'Google DeepMind', true, false, 32768, array['Text', 'Image', 'Video']::text[], true, true, true, true, null),
  ('openrouter', 'google/gemma-4-26b-a4b-it', 'Gemma 4 26B A4B', 'gemma-4-26b', 'Sparse multimodal Gemma model with native function calling and structured output.', 'Google DeepMind', false, true, 16384, array['Text', 'Image', 'Video']::text[], true, true, true, true, true),
  ('openrouter', 'nvidia/nemotron-3.5-lightning:free', 'Nemotron 3.5 Lightning (free)', 'nemotron-3.5-lightning', 'Sparse text model for reasoning and agent workflows with tool calling. Endpoint latency varies by provider.', 'NVIDIA', true, false, 65536, array['Text']::text[], true, true, false, true, null),
  ('kilo', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'Nemotron 3 Ultra (free)', 'nemotron-3-ultra', 'Hybrid Mamba-Attention mixture-of-experts model for text reasoning, coding and tool-driven workflows.', 'NVIDIA', true, false, 65536, array['Text']::text[], true, true, false, true, null),
  ('kilo', 'nvidia/nemotron-3.5-lightning:free', 'Nemotron 3.5 Lightning (free)', 'nemotron-3.5-lightning', 'Sparse text model for reasoning and agent workflows with tool calling. Endpoint latency varies by provider.', 'NVIDIA', true, false, 65536, array['Text']::text[], true, false, false, true, null),
  ('kilo', 'inclusionai/ling-3.0-flash-vl:free', 'Ling 3.0 Flash VL (free)', 'ling-3.0-flash-vl', 'Multimodal Flash model for image understanding, reasoning and tool-driven workflows.', 'InclusionAI', true, false, 32768, array['Text', 'Image']::text[], true, true, true, true, null),
  ('kilo', 'stepfun/step-3.7-flash:free', 'Step 3.7 Flash (free)', 'step-3.7-flash', 'Efficient multimodal model for coding, reasoning and agent tasks. Available through Kilo''s free endpoint.', 'StepFun', true, false, 262144, array['Text', 'Image']::text[], true, true, true, true, null),
  ('kilo', 'poolside/laguna-s-2.1:free', 'Laguna S 2.1 (free)', 'laguna-s-2.1', 'Coding model for software engineering, terminal workflows and tool-driven agents.', 'Poolside', true, false, 32768, array['Text']::text[], true, true, false, true, null),
  ('nvidia-nim', 'nvidia/nemotron-3-ultra-550b-a55b', 'Nemotron 3 Ultra (free)', 'nemotron-3-ultra', 'Hybrid Mamba-Attention mixture-of-experts model for text reasoning, coding and tool-driven workflows.', 'NVIDIA', true, false, 131072, array['Text']::text[], true, true, false, true, true),
  ('nvidia-nim', 'google/gemma-4-31b-it', 'Gemma 4 31B IT (free)', 'gemma-4', 'Dense multimodal Gemma model with image and video understanding, multilingual text and function calling.', 'Google DeepMind', true, false, 131072, array['Text', 'Image', 'Video']::text[], true, true, true, false, true),
  ('nvidia-nim', 'z-ai/glm-5.3-flash', 'GLM-5.3 Flash (free)', 'glm-5.3-flash', 'Multimodal Flash model for reasoning and tool-driven tasks, with image understanding.', 'Z.ai', true, false, null, array['Text', 'Image']::text[], true, true, true, true, null),
  ('nvidia-nim', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'Nemotron 3.5 Lightning (free)', 'nemotron-3.5-lightning', 'Sparse text model for reasoning and agent workflows with tool calling. Endpoint latency varies by provider.', 'NVIDIA', true, false, null, array['Text']::text[], true, true, false, true, null),
  ('nvidia-nim', 'poolside/laguna-xs-2.1', 'Laguna XS 2.1 (free)', 'laguna-xs-2.1', 'Compact Laguna model for coding and tool-driven software workflows.', 'Poolside', true, false, null, array['Text']::text[], true, true, false, false, true),
  ('deepseek', 'deepseek-flash', 'DeepSeek V4.1 Flash', 'deepseek-v4.1-flash-api', 'Multimodal Flash model with reasoning and image understanding. Tool support depends on the serving endpoint.', 'DeepSeek', false, true, 393216, array['Text', 'Image']::text[], true, true, true, true, null),
  ('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', 'deepseek-v4-pro-api', 'Text reasoning model for coding and agent workflows. The direct API supports function calling and JSON-object output.', 'DeepSeek', false, true, 393216, array['Text']::text[], true, true, false, true, null),
  ('tokenrouter', 'moonshotai/kimi-k3-free', 'Kimi K3 (free)', 'kimi-k3', 'Multimodal mixture-of-experts model for reasoning, coding and tool-driven tasks with a long context window.', 'Moonshot AI', true, false, null, array['Text', 'Image']::text[], true, true, true, true, null)
) as v (
  provider_id, model_id, label, short_name, description, developer, free, metered, max_output_tokens, inputs,
  supports_tools, supports_search, supports_vision, supports_thinking, supports_structured
)
on conflict (provider_id, model_id) do nothing;

commit;
