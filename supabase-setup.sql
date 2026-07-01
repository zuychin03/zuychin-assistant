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

-- Default profile so the app has something to read on first run.
insert into user_profiles (display_name, system_prompt)
values (
  'Owner',
  'You are Zuychin, a helpful, warm, and intelligent personal AI assistant. You have long-term memory and can remember past conversations. Be concise but thorough. Use a friendly, natural tone.'
)
on conflict do nothing;
