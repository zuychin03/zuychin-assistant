-- Model types for the stored catalogue (V7): embedding, speech and transcription rows beside chat rows.
-- Apply manually after v7-model-catalogue.sql; safe to re-run. Additive: new columns with defaults, one widened
-- check and four seed rows for the models the code pins.
begin;
do $$ begin
  if to_regclass('public.model_catalogue') is null then
    raise exception 'Apply v7-model-catalogue.sql before v7-model-types.sql.';
  end if;
end $$;

alter table public.model_catalogue add column if not exists kind text not null default 'chat';
alter table public.model_catalogue drop constraint if exists model_catalogue_kind_check;
alter table public.model_catalogue add constraint model_catalogue_kind_check
  check (kind in ('chat', 'embedding', 'speech', 'transcription'));

-- Native vector length for embedding rows; pgvector stores up to 16,000.
alter table public.model_catalogue add column if not exists dimension integer;
alter table public.model_catalogue drop constraint if exists model_catalogue_dimension_check;
alter table public.model_catalogue add constraint model_catalogue_dimension_check check (dimension between 1 and 16000);

alter table public.model_catalogue add column if not exists expires_at timestamptz;
alter table public.model_catalogue add column if not exists expires_source text;
alter table public.model_catalogue drop constraint if exists model_catalogue_expires_source_check;
alter table public.model_catalogue add constraint model_catalogue_expires_source_check
  check (expires_source in ('listing', 'lookup', 'gone'));
-- The smallest notice threshold (30 or 7 days) already sent for the current expires_at.
alter table public.model_catalogue add column if not exists notified_expiry_days integer;
alter table public.model_catalogue drop constraint if exists model_catalogue_notified_expiry_days_check;
alter table public.model_catalogue add constraint model_catalogue_notified_expiry_days_check check (notified_expiry_days >= 0);
alter table public.model_catalogue add column if not exists expiry_checked_at timestamptz;

-- The knowledge partition id an embedding route reproduces, proven by an identical-vector probe.
alter table public.model_catalogue add column if not exists space_of text;
alter table public.model_catalogue drop constraint if exists model_catalogue_space_of_check;
alter table public.model_catalogue add constraint model_catalogue_space_of_check
  check (space_of ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$');

alter table public.model_catalogue add column if not exists traits jsonb not null default '{}'::jsonb;
alter table public.model_catalogue drop constraint if exists model_catalogue_traits_check;
alter table public.model_catalogue add constraint model_catalogue_traits_check check (jsonb_typeof(traits) = 'object');

create index if not exists model_catalogue_kind on public.model_catalogue (kind);

alter table public.model_call_observations drop constraint if exists model_call_observations_purpose_check;
alter table public.model_call_observations add constraint model_call_observations_purpose_check
  check (purpose in ('chat', 'embedding', 'routing', 'worker', 'orchestration', 'compaction', 'continuation', 'extraction', 'summary', 'title', 'search', 'speech', 'study', 'probe', 'lookup', 'consult', 'council', 'transcription', 'rerank', 'parse', 'image', 'decision', 'live', 'translate'));

insert into public.model_catalogue (
  provider_id, model_id, kind, label, short_name, description, developer, free, metered, inputs, dimension,
  origin, probe_status, approved_at
)
select v.*, 'seed', 'untested', now() from (values
  ('nvidia-nim', 'nvidia/nemotron-3.5-embed-1b', 'embedding', 'Nemotron 3.5 Embed 1B (free, 2048d)', 'nemotron-3.5-embed-1b', 'Multilingual retrieval embedding model. Query and passage inputs are embedded differently.', 'NVIDIA', true, false, array['Text'], 2048),
  ('gemini', 'gemini-embedding-2', 'embedding', 'Gemini Embedding 2 (768d)', 'gemini-embedding-2', 'Text embedding model, reduced to 768 dimensions in this app.', 'Google DeepMind', false, true, array['Text'], 768),
  ('gemini', 'gemini-3.8-flash-lite-tts', 'speech', 'Gemini 3.8 Flash Lite TTS', 'gemini-3.8-flash-lite-tts', 'Speech generation with Gemini prebuilt voices. Returns 24 kHz PCM.', 'Google DeepMind', false, true, array['Text'], null),
  ('gemini-free', 'gemini-3.8-flash-lite-tts', 'speech', 'Gemini 3.8 Flash Lite TTS (free)', 'gemini-3.8-flash-lite-tts-free', 'Speech generation with Gemini prebuilt voices. Returns 24 kHz PCM.', 'Google DeepMind', true, false, array['Text'], null)
) as v (
  provider_id, model_id, kind, label, short_name, description, developer, free, metered, inputs, dimension
)
on conflict (provider_id, model_id) do nothing;

notify pgrst, 'reload schema';
commit;
