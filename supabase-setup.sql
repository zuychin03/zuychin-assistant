-- Zuychin Assistant - database setup
-- Run this once in the Supabase SQL Editor (Dashboard > SQL Editor) on a new project.
-- It is safe to re-run: everything uses IF NOT EXISTS / OR REPLACE.

-- pgvector is needed for the RAG memory.
create extension if not exists vector;

-- updated_at helper used by a few tables.
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Profiles. The app is single-user, so there's normally just one row.
create table if not exists user_profiles (
  id uuid primary key default gen_random_uuid(),
  display_name text not null default 'User',
  system_prompt text default 'You are Zuychin, a helpful and friendly personal AI assistant.',
  preferences jsonb default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trigger_user_profiles_updated_at on user_profiles;
create trigger trigger_user_profiles_updated_at
  before update on user_profiles
  for each row execute function update_updated_at();

-- Conversations group messages in the chat sidebar.
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  user_profile_id uuid references user_profiles(id) on delete cascade,
  title text default 'New Chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trigger_conversations_updated_at on conversations;
create trigger trigger_conversations_updated_at
  before update on conversations
  for each row execute function update_updated_at();

create index if not exists idx_conversations_profile_time
  on conversations (user_profile_id, updated_at desc);

-- Chat history across every channel.
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  user_profile_id uuid references user_profiles(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  channel text not null default 'web' check (channel in ('web', 'discord', 'telegram')),
  image_url text,
  metadata jsonb default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_messages_profile_time
  on messages (user_profile_id, created_at desc);

create index if not exists idx_messages_conversation
  on messages (conversation_id, created_at asc);

-- Vector store for long-term memory.
-- The embedding column is dimension-agnostic on purpose: different embedding
-- models produce different sized vectors, so we tag each row with the model that
-- made it and only ever compare vectors from the same model.
create table if not exists embeddings (
  id uuid primary key default gen_random_uuid(),
  user_profile_id uuid references user_profiles(id) on delete cascade,
  content text not null,
  embedding vector,
  embedding_model text not null default 'gemini-embedding-2-preview',
  metadata jsonb default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_embeddings_model
  on embeddings (embedding_model);

-- To-do list used by the assistant tools.
create table if not exists todos (
  id uuid primary key default gen_random_uuid(),
  user_profile_id uuid references user_profiles(id) on delete cascade,
  title text not null,
  description text default '',
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'done')),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  due_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trigger_todos_updated_at on todos;
create trigger trigger_todos_updated_at
  before update on todos
  for each row execute function update_updated_at();

create index if not exists idx_todos_status
  on todos (status, created_at desc);

-- Files the assistant generates during agent runs (report documents, code files,
-- zip bundles). Small payloads are stored inline: text artifacts in content_text,
-- binary ones (docx/pdf/zip) base64-encoded in content_base64. Move to Supabase
-- Storage if outputs grow large.
create table if not exists artifacts (
  id uuid primary key default gen_random_uuid(),
  user_profile_id uuid references user_profiles(id) on delete set null,
  conversation_id uuid references conversations(id) on delete cascade,
  message_id uuid references messages(id) on delete set null,
  kind text not null default 'document' check (kind in ('document', 'code', 'archive')),
  filename text not null,
  mime_type text not null,
  content_text text,
  content_base64 text,
  size integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_artifacts_conversation
  on artifacts (conversation_id, created_at desc);

-- Row level security. This is a single-user app, so the policies just allow the
-- configured key full access. Tighten these with auth.uid() checks if you ever
-- make it multi-user.
alter table user_profiles enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table embeddings enable row level security;
alter table todos enable row level security;
alter table artifacts enable row level security;

drop policy if exists "Allow all access to user_profiles" on user_profiles;
create policy "Allow all access to user_profiles" on user_profiles for all using (true) with check (true);

drop policy if exists "Allow all access to conversations" on conversations;
create policy "Allow all access to conversations" on conversations for all using (true) with check (true);

drop policy if exists "Allow all access to messages" on messages;
create policy "Allow all access to messages" on messages for all using (true) with check (true);

drop policy if exists "Allow all access to embeddings" on embeddings;
create policy "Allow all access to embeddings" on embeddings for all using (true) with check (true);

drop policy if exists "Allow all access to todos" on todos;
create policy "Allow all access to todos" on todos for all using (true) with check (true);

drop policy if exists "Allow all access to artifacts" on artifacts;
create policy "Allow all access to artifacts" on artifacts for all using (true) with check (true);

-- Vector search. Filters by model first so only same-dimension rows are compared,
-- then ranks by cosine similarity.
create or replace function match_embeddings(
  query_embedding vector,
  match_threshold float default 0.7,
  match_count int default 5,
  filter_user_id uuid default null,
  filter_model text default 'gemini-embedding-2-preview'
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select q.id, q.content, q.metadata, q.similarity
  from (
    select
      e.id,
      e.content,
      e.metadata,
      1 - (e.embedding <=> query_embedding) as similarity
    from embeddings e
    where
      e.embedding_model = filter_model
      and (filter_user_id is null or e.user_profile_id = filter_user_id)
  ) q
  where q.similarity > match_threshold
  order by q.similarity desc
  limit match_count;
end;
$$;

-- Second-brain vault page index. The vault itself (interlinked Markdown wiki
-- pages) lives in a private GitHub repo (see vault-template/ and the
-- GITHUB_VAULT_* env vars); this table is only the semantic index over it —
-- one row per wiki page with its embedding, so vault_search can do pgvector
-- lookups without touching GitHub. Model-aware like the embeddings table.
create table if not exists vault_pages (
  id uuid primary key default gen_random_uuid(),
  path text not null unique,
  title text not null,
  summary text not null default '',
  category text not null default 'concepts',
  embedding vector,
  embedding_model text not null default 'gemini-embedding-2-preview',
  updated_at timestamptz not null default now()
);

create index if not exists idx_vault_pages_model
  on vault_pages (embedding_model);

alter table vault_pages enable row level security;

drop policy if exists "Allow all access to vault_pages" on vault_pages;
create policy "Allow all access to vault_pages" on vault_pages for all using (true) with check (true);

create or replace function match_vault_pages(
  query_embedding vector,
  match_threshold float default 0.5,
  match_count int default 8,
  filter_model text default 'gemini-embedding-2-preview'
)
returns table (
  id uuid,
  path text,
  title text,
  summary text,
  category text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select q.id, q.path, q.title, q.summary, q.category, q.similarity
  from (
    select
      v.id,
      v.path,
      v.title,
      v.summary,
      v.category,
      1 - (v.embedding <=> query_embedding) as similarity
    from vault_pages v
    where
      v.embedding_model = filter_model
      and v.embedding is not null
  ) q
  where q.similarity > match_threshold
  order by q.similarity desc
  limit match_count;
end;
$$;

-- Agent run traces. One row per agent-mode run: live status, the plan, a capped
-- event log (tool calls, subagents, artifacts), token usage, and the final reply.
-- Rows stuck in 'running' past the Vercel function ceiling are swept to 'timeout'
-- lazily on read (hard kills skip finally blocks, so the writer can't be trusted
-- to close its own row).
create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_profile_id uuid references user_profiles(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  message text not null,
  status text not null default 'running' check (status in ('running', 'done', 'error', 'timeout')),
  model text,
  plan jsonb not null default '[]',
  events jsonb not null default '[]',
  reply text,
  error text,
  usage jsonb not null default '{}',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

drop trigger if exists trigger_agent_runs_updated_at on agent_runs;
create trigger trigger_agent_runs_updated_at
  before update on agent_runs
  for each row execute function update_updated_at();

create index if not exists idx_agent_runs_time
  on agent_runs (started_at desc);

alter table agent_runs enable row level security;

drop policy if exists "Allow all access to agent_runs" on agent_runs;
create policy "Allow all access to agent_runs" on agent_runs for all using (true) with check (true);

-- Extracted long-term facts (Mem0-style). A post-turn extraction pass distills
-- durable user facts from conversations and consolidates them (add/update/delete
-- against near-duplicates), separate from the raw-message embeddings table.
-- project_id is a plain uuid until the projects table exists (FK added there).
-- Model-partitioned like the embeddings table.
create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  user_profile_id uuid references user_profiles(id) on delete cascade,
  project_id uuid,
  fact text not null,
  category text not null default 'other'
    check (category in ('identity', 'preference', 'relationship', 'project', 'routine', 'fact', 'other')),
  source text not null default 'chat',
  embedding vector,
  embedding_model text not null default 'gemini-embedding-2-preview',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trigger_memories_updated_at on memories;
create trigger trigger_memories_updated_at
  before update on memories
  for each row execute function update_updated_at();

create index if not exists idx_memories_model
  on memories (embedding_model);

alter table memories enable row level security;

drop policy if exists "Allow all access to memories" on memories;
create policy "Allow all access to memories" on memories for all using (true) with check (true);

-- filter_project null -> global facts only; set -> global + that project's facts.
create or replace function match_memories(
  query_embedding vector,
  match_threshold float default 0.5,
  match_count int default 8,
  filter_user_id uuid default null,
  filter_model text default 'gemini-embedding-2-preview',
  filter_project uuid default null
)
returns table (
  id uuid,
  fact text,
  category text,
  project_id uuid,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select q.id, q.fact, q.category, q.project_id, q.similarity
  from (
    select
      m.id,
      m.fact,
      m.category,
      m.project_id,
      1 - (m.embedding <=> query_embedding) as similarity
    from memories m
    where
      m.embedding_model = filter_model
      and m.embedding is not null
      and (filter_user_id is null or m.user_profile_id = filter_user_id)
      and (m.project_id is null or m.project_id = filter_project)
  ) q
  where q.similarity > match_threshold
  order by q.similarity desc
  limit match_count;
end;
$$;

-- User-schedulable tasks: the assistant runs `instruction` through ragChat on a
-- schedule and delivers the reply to `channel`. Recurring tasks store a 5-field
-- cron string evaluated in `timezone`; one-off tasks store run_at and disable
-- after firing. The dispatcher claims rows optimistically by bumping next_run_at
-- before running (a crashed run skips one occurrence instead of double-firing).
create table if not exists scheduled_tasks (
  id uuid primary key default gen_random_uuid(),
  user_profile_id uuid references user_profiles(id) on delete cascade,
  title text not null,
  instruction text not null,
  schedule_type text not null check (schedule_type in ('once', 'recurring')),
  cron text,
  run_at timestamptz,
  timezone text not null default 'Australia/Sydney',
  channel text not null default 'telegram' check (channel in ('telegram', 'discord', 'web')),
  conversation_id uuid references conversations(id) on delete set null,
  agent_mode boolean not null default false,
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text check (last_status in ('ok', 'error')),
  last_result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trigger_scheduled_tasks_updated_at on scheduled_tasks;
create trigger trigger_scheduled_tasks_updated_at
  before update on scheduled_tasks
  for each row execute function update_updated_at();

create index if not exists idx_scheduled_tasks_due
  on scheduled_tasks (enabled, next_run_at);

alter table scheduled_tasks enable row level security;

drop policy if exists "Allow all access to scheduled_tasks" on scheduled_tasks;
create policy "Allow all access to scheduled_tasks" on scheduled_tasks for all using (true) with check (true);

-- Due-todo nagging (reminders cron): when the last nag went out, so overdue
-- tasks re-nag roughly daily instead of every cron tick.
alter table todos add column if not exists reminded_at timestamptz;

-- Default profile so the app has something to read on first run.
insert into user_profiles (display_name, system_prompt)
values (
  'Owner',
  'You are Zuychin, a helpful, warm, and intelligent personal AI assistant. You have long-term memory and can remember past conversations. Be concise but thorough. Use a friendly, natural tone.'
)
on conflict do nothing;
