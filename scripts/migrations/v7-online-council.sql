-- Online councils (V7): record council seat calls in model health under their own purpose.
-- Apply manually; safe to re-run, and safe before or after v7-model-awareness.sql (both list 'council').
begin;
do $$ begin
  if to_regclass('public.model_call_observations') is null then
    raise exception 'The model_call_observations table is missing. Apply supabase-setup.sql first.';
  end if;
end $$;

alter table public.model_call_observations drop constraint if exists model_call_observations_purpose_check;
alter table public.model_call_observations add constraint model_call_observations_purpose_check
  check (purpose in ('chat', 'embedding', 'routing', 'worker', 'orchestration', 'compaction', 'continuation', 'extraction', 'summary', 'title', 'search', 'speech', 'study', 'probe', 'lookup', 'consult', 'council', 'transcription'));

commit;
