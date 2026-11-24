-- V8 media kinds for the stored catalogue: rerank, parse, image, decision, live and translate rows, image rows in the
-- knowledge store and made images as artifacts. Apply manually after v7-model-types.sql; safe to re-run. Additive: three
-- widened checks (catalogue kind, observation purpose, artifact kind), seven seed rows, two knowledge_chunks columns with
-- defaults and the chunk writer that fills them.
begin;
do $$ begin
  if to_regclass('public.model_catalogue') is null or not exists (
    select 1 from information_schema.columns where table_schema = 'public' and table_name = 'model_catalogue' and column_name = 'kind'
  ) then
    raise exception 'Apply v7-model-types.sql before v8-media.sql.';
  end if;
end $$;

alter table public.model_catalogue drop constraint if exists model_catalogue_kind_check;
alter table public.model_catalogue add constraint model_catalogue_kind_check
  check (kind in ('chat', 'embedding', 'speech', 'transcription', 'rerank', 'parse', 'image', 'decision', 'live', 'translate'));

alter table public.model_call_observations drop constraint if exists model_call_observations_purpose_check;
alter table public.model_call_observations add constraint model_call_observations_purpose_check
  check (purpose in ('chat', 'embedding', 'routing', 'worker', 'orchestration', 'compaction', 'continuation', 'extraction', 'summary', 'title', 'search', 'speech', 'study', 'probe', 'lookup', 'consult', 'council', 'transcription', 'rerank', 'parse', 'image', 'decision', 'live', 'translate'));

alter table public.artifacts drop constraint if exists artifacts_kind_check;
alter table public.artifacts add constraint artifacts_kind_check check (kind in ('document', 'code', 'archive', 'image'));

-- Seeds: NIM serves rerank, parse and image models off its /v1/models list, so no listing finds them.
-- Riva Translate stays unapproved: it failed its checks on 24/11/2026 and is used only after it passes and is approved.
-- One statement, so a run that splits the file into separate transactions still sees the seeds.
with seeds (provider_id, model_id, kind, label, short_name, description, developer, free, metered, inputs, traits, approve) as (values
  ('nvidia-nim', 'nvidia/nemotron-3.5-rerank-8b', 'rerank', 'Nemotron 3.5 Rerank 8B (free)', 'nemotron-3.5-rerank-8b', 'Scores passages against a query and returns them best first.', 'NVIDIA', true, false, array['Text'], '{}'::jsonb, true),
  ('nvidia-nim', 'nvidia/nemotron-3.5-parse', 'parse', 'Nemotron 3.5 Parse (free)', 'nemotron-3.5-parse', 'Reads a page image into tagged text blocks and LaTeX tables.', 'NVIDIA', true, false, array['Image'], '{}'::jsonb, true),
  ('nvidia-nim', 'black-forest-labs/flux.2-klein-4b', 'image', 'FLUX.2 klein 4B (free)', 'flux.2-klein-4b', 'Makes an image from a text prompt.', 'Black Forest Labs', true, false, array['Text'], '{}'::jsonb, true),
  ('gemini', 'gemini-decision-1', 'decision', 'Gemini Decision 1', 'gemini-decision-1', 'Answers yes/no, choice and score questions about a text with probabilities. Writes no text.', 'Google DeepMind', false, true, array['Text'], '{}'::jsonb, true),
  ('gemini-free', 'gemini-decision-1', 'decision', 'Gemini Decision 1 (free)', 'gemini-decision-1-free', 'Answers yes/no, choice and score questions about a text with probabilities. Writes no text.', 'Google DeepMind', true, false, array['Text'], '{}'::jsonb, true),
  ('gemini-free', 'gemini-3.8-live', 'live', 'Gemini 3.8 Live (free)', 'gemini-3.8-live-free', 'Two-way voice in a live session opened with a short-lived token. Returns 24 kHz PCM audio and transcripts.', 'Google DeepMind', true, false, array['Audio', 'Text'], '{}'::jsonb, true),
  ('nvidia-nim', 'nvidia/riva-translate-4b-instruct-v2', 'translate', 'Riva Translate 4B Instruct v2 (free)', 'riva-translate-4b-instruct-v2', 'Translation model with a fixed prompt template.', 'NVIDIA', true, false, array['Text'],
    '{"promptTemplate": "Translate the following text from {source} to {target}:\n{text}", "languages": ["bg", "cs", "da", "de", "el", "en", "es-es", "es-us", "et", "fi", "fr", "hi", "hr", "hu", "id", "it", "ja", "ko", "lt", "lv", "nl", "no", "pl", "pt-br", "pt-pt", "ro", "ru", "sk", "sl", "sv", "th", "tr", "uk", "vi", "zh-cn", "zh-tw"]}'::jsonb, false)
),
-- A seed id that chat discovery already stored becomes its seed kind and waits for a new approval.
moved as (
  update public.model_catalogue m
  set kind = s.kind, approved_at = null, traits = m.traits || s.traits, updated_at = now()
  from seeds s
  where m.provider_id = s.provider_id and m.model_id = s.model_id and m.kind = 'chat'
)
insert into public.model_catalogue (
  provider_id, model_id, kind, label, short_name, description, developer, free, metered, inputs, traits,
  origin, probe_status, approved_at
)
select provider_id, model_id, kind, label, short_name, description, developer, free, metered, inputs, traits,
  'seed', 'untested', case when approve then now() end
from seeds
on conflict (provider_id, model_id) do nothing;

-- Image rows in the knowledge store: the chunk's text is the caption and page text, the image lives in the vault.
alter table public.knowledge_chunks add column if not exists modality text not null default 'text';
alter table public.knowledge_chunks drop constraint if exists knowledge_chunks_modality_check;
alter table public.knowledge_chunks add constraint knowledge_chunks_modality_check check (modality in ('text', 'image'));
alter table public.knowledge_chunks add column if not exists asset_path text;
alter table public.knowledge_chunks drop constraint if exists knowledge_chunks_asset_path_check;
alter table public.knowledge_chunks add constraint knowledge_chunks_asset_path_check
  check (asset_path ~ '^attachments/[A-Za-z0-9._ /-]+$' and asset_path !~ '\.\.' and char_length(asset_path) <= 320);

-- Photo chunks keep their modality and vault file; text chunks take the defaults. Same signature, so grants stay.
create or replace function public.replace_knowledge_chunks(
  p_document_id text,
  p_chunks jsonb
)
returns integer
language plpgsql
as $$
declare
  inserted_count integer;
begin
  delete from knowledge_chunks where document_id = p_document_id;

  insert into knowledge_chunks (
    id, document_id, heading, heading_path, ordinal, content, content_hash,
    token_count, embedding, embedding_model, modality, asset_path
  )
  select
    item->>'id',
    p_document_id,
    coalesce(item->>'heading', ''),
    coalesce(array(select jsonb_array_elements_text(item->'heading_path')), '{}'),
    (item->>'ordinal')::integer,
    item->>'content',
    item->>'content_hash',
    coalesce((item->>'token_count')::integer, 0),
    (item->>'embedding')::vector,
    item->>'embedding_model',
    coalesce(item->>'modality', 'text'),
    item->>'asset_path'
  from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) item;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

notify pgrst, 'reload schema';
commit;
