-- Provider API keys saved from the dashboard, Groq seeds and OpenCode Console cleanup (V7). Apply manually; safe to re-run.
-- Rows hold AES-256-GCM ciphertext only. The master key never reaches the database; key_ref is a one-way fingerprint of it.
begin;

create table if not exists public.provider_keys (
  provider_id text not null check (provider_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  key_ref text not null check (key_ref ~ '^[0-9a-f]{16}$'),
  ciphertext text not null check (char_length(ciphertext) between 40 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider_id, key_ref)
);

alter table public.provider_keys enable row level security;
revoke all on public.provider_keys from public, anon, authenticated;

-- Groq's free chat models (19/11/2026), unapproved: probes run on their own, automatic routes wait for Approve.
-- OpenCode's free models answer 403 outside OpenCode, so their rows go; their profiles follow by cascade.
do $$ begin
  if to_regclass('public.model_catalogue') is not null then
    insert into public.model_catalogue (
      provider_id, model_id, label, short_name, description, developer, free, metered, max_output_tokens, inputs,
      supports_tools, supports_search, supports_vision, supports_thinking, supports_structured,
      origin, probe_status, approved_at
    )
    select v.*, 'seed', 'untested', null::timestamptz from (values
      ('groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (free)', 'gpt-oss-120b', 'Open-weight OpenAI mixture-of-experts reasoning model with function calling. Groq''s free tier allows 8K tokens per minute.', 'OpenAI', true, false, 65536, array['Text']::text[], true, true, false, true, null::boolean),
      ('groq', 'openai/gpt-oss-20b', 'GPT-OSS 20B (free)', 'gpt-oss-20b', 'Smaller open-weight OpenAI reasoning model with function calling, for fast replies. Groq''s free tier allows 8K tokens per minute.', 'OpenAI', true, false, 65536, array['Text']::text[], true, true, false, true, null::boolean),
      ('groq', 'qwen/qwen3.8-27b', 'Qwen 3.8 27B (free)', 'qwen3.8-27b', 'Qwen preview model with image input, optional reasoning and parallel function calling. Groq''s free tier allows 8K tokens per minute.', 'Alibaba Qwen', true, false, 16384, array['Text', 'Image']::text[], true, true, true, true, null::boolean)
    ) as v (
      provider_id, model_id, label, short_name, description, developer, free, metered, max_output_tokens, inputs,
      supports_tools, supports_search, supports_vision, supports_thinking, supports_structured
    )
    on conflict (provider_id, model_id) do nothing;

    delete from public.model_catalogue
    where provider_id = 'opencode-zen'
      and model_id in ('mimo-v2.6-flash-free', 'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'muse-spark-1.3-contributor-free');
  end if;
  if to_regclass('public.model_profiles') is not null then
    insert into public.model_profiles (provider_id, model_id, tags, tags_source)
    select v.provider_id, v.model_id, v.tags, 'seed'
    from (values
      ('groq', 'openai/gpt-oss-120b', array['research', 'coding', 'reasoning', 'writing', 'agentic']::text[]),
      ('groq', 'openai/gpt-oss-20b', array['coding', 'reasoning', 'agentic']::text[]),
      ('groq', 'qwen/qwen3.8-27b', array['coding', 'reasoning', 'vision', 'multilingual', 'agentic']::text[])
    ) as v (provider_id, model_id, tags)
    join public.model_catalogue c on c.provider_id = v.provider_id and c.model_id = v.model_id
    on conflict (provider_id, model_id) do nothing;
  end if;
end $$;

commit;
