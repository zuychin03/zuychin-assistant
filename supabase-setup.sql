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
-- GITHUB_VAULT_* env vars); this table is only the semantic index over it -
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
-- Work/study facts enter as invisible 'candidate' rows and are promoted to
-- 'confirmed' once the same pattern repeats in a different conversation/day
-- (tracked via evidence_count + last_evidence_key). Personal-life facts are
-- confirmed immediately.
alter table memories add column if not exists status text not null default 'confirmed'
  check (status in ('candidate', 'confirmed'));
alter table memories add column if not exists evidence_count int not null default 1;
alter table memories add column if not exists last_evidence_key text;

drop function if exists match_memories(vector, float, int, uuid, text, uuid);
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
  similarity float,
  status text,
  evidence_count int
)
language plpgsql
as $$
begin
  return query
  select q.id, q.fact, q.category, q.project_id, q.similarity, q.status, q.evidence_count
  from (
    select
      m.id,
      m.fact,
      m.category,
      m.project_id,
      1 - (m.embedding <=> query_embedding) as similarity,
      m.status,
      m.evidence_count
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

-- Email-trigger dedup ledger: every scanned email gets a row (obligation found
-- or not) so the email-triggers cron never processes a message twice.
create table if not exists processed_emails (
  gmail_message_id text primary key,
  processed_at timestamptz not null default now(),
  outcome jsonb not null default '{}'
);

alter table processed_emails enable row level security;

drop policy if exists "Allow all access to processed_emails" on processed_emails;
create policy "Allow all access to processed_emails" on processed_emails for all using (true) with check (true);

-- Hybrid search (BM25 + vector, reciprocal rank fusion). vault_pages gains the
-- page text so keyword search has something to match; legacy rows stay empty
-- (vector-only) until the page is next written or ingested.
alter table vault_pages add column if not exists content text not null default '';

alter table vault_pages add column if not exists fts tsvector
  generated always as (to_tsvector('english', title || ' ' || summary || ' ' || content)) stored;

create index if not exists idx_vault_pages_fts on vault_pages using gin (fts);

alter table embeddings add column if not exists fts tsvector
  generated always as (to_tsvector('english', content)) stored;

create index if not exists idx_embeddings_fts on embeddings using gin (fts);

-- Vector top-20 and keyword top-20 fused with reciprocal rank fusion
-- (score = 1/(60+vec_rank) + 1/(60+kw_rank)). Both arms stay model-partitioned,
-- matching match_vault_pages semantics. A stop-word-only query_text produces an
-- empty tsquery (numnode = 0) and degrades to vector-only; keyword-only hits
-- come back with similarity 0.
create or replace function hybrid_match_vault_pages(
  query_embedding vector,
  query_text text default '',
  match_count int default 8,
  filter_model text default 'gemini-embedding-2-preview'
)
returns table (
  id uuid,
  path text,
  title text,
  summary text,
  category text,
  similarity float,
  score float
)
language plpgsql
as $$
declare
  q tsquery := websearch_to_tsquery('english', coalesce(query_text, ''));
begin
  return query
  with vec as (
    select v.id,
           row_number() over (order by v.embedding <=> query_embedding) as rnk,
           1 - (v.embedding <=> query_embedding) as sim
    from vault_pages v
    where v.embedding_model = filter_model and v.embedding is not null
    order by v.embedding <=> query_embedding
    limit 20
  ),
  kw as (
    select v.id,
           row_number() over (order by ts_rank_cd(v.fts, q) desc) as rnk
    from vault_pages v
    where numnode(q) > 0 and v.fts @@ q and v.embedding_model = filter_model
    order by ts_rank_cd(v.fts, q) desc
    limit 20
  ),
  fused as (
    select coalesce(vec.id, kw.id) as page_id,
           coalesce(vec.sim, 0)::float as sim,
           (coalesce(1.0 / (60 + vec.rnk), 0) + coalesce(1.0 / (60 + kw.rnk), 0))::float as rrf
    from vec full outer join kw on vec.id = kw.id
  )
  select p.id, p.path, p.title, p.summary, p.category, f.sim, f.rrf
  from fused f
  join vault_pages p on p.id = f.page_id
  order by f.rrf desc
  limit match_count;
end;
$$;

-- Same fusion over the raw-message knowledge base. The keyword arm keeps the
-- model filter because the same note is stored once per embedding-model
-- partition - an unfiltered arm would return cross-partition duplicates.
create or replace function hybrid_match_knowledge(
  query_embedding vector,
  query_text text default '',
  match_count int default 5,
  filter_user_id uuid default null,
  filter_model text default 'gemini-embedding-2-preview'
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float,
  score float
)
language plpgsql
as $$
declare
  q tsquery := websearch_to_tsquery('english', coalesce(query_text, ''));
begin
  return query
  with vec as (
    select e.id,
           row_number() over (order by e.embedding <=> query_embedding) as rnk,
           1 - (e.embedding <=> query_embedding) as sim
    from embeddings e
    where e.embedding_model = filter_model
      and (filter_user_id is null or e.user_profile_id = filter_user_id)
    order by e.embedding <=> query_embedding
    limit 20
  ),
  kw as (
    select e.id,
           row_number() over (order by ts_rank_cd(e.fts, q) desc) as rnk
    from embeddings e
    where numnode(q) > 0 and e.fts @@ q
      and e.embedding_model = filter_model
      and (filter_user_id is null or e.user_profile_id = filter_user_id)
    order by ts_rank_cd(e.fts, q) desc
    limit 20
  ),
  fused as (
    select coalesce(vec.id, kw.id) as row_id,
           coalesce(vec.sim, 0)::float as sim,
           (coalesce(1.0 / (60 + vec.rnk), 0) + coalesce(1.0 / (60 + kw.rnk), 0))::float as rrf
    from vec full outer join kw on vec.id = kw.id
  )
  select em.id, em.content, em.metadata, f.sim, f.rrf
  from fused f
  join embeddings em on em.id = f.row_id
  order by f.rrf desc
  limit match_count;
end;
$$;

-- Projects group conversations in the sidebar and carry per-project
-- instructions that get injected into every chat inside the project.
-- Deleting a project keeps its data: conversations drop back to Ungrouped
-- and project-scoped facts become global (both FKs are on delete set null).
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  user_profile_id uuid references user_profiles(id) on delete cascade,
  name text not null,
  instructions text not null default '',
  color text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trigger_projects_updated_at on projects;
create trigger trigger_projects_updated_at
  before update on projects
  for each row execute function update_updated_at();

alter table projects enable row level security;

drop policy if exists "Allow all access to projects" on projects;
create policy "Allow all access to projects" on projects for all using (true) with check (true);

alter table conversations add column if not exists project_id uuid references projects(id) on delete set null;

create index if not exists idx_conversations_project
  on conversations (project_id, updated_at desc);

-- memories.project_id predates this table (plain uuid); attach the FK now.
alter table memories drop constraint if exists memories_project_id_fkey;
alter table memories add constraint memories_project_id_fkey
  foreign key (project_id) references projects(id) on delete set null;

-- Skills the agent authors for itself. Saved as drafts via the save_skill
-- tool; invisible to the agent until approved (status = 'active') in /admin.
create table if not exists custom_skills (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  when_to_use text not null,
  instructions text not null,
  status text not null default 'draft' check (status in ('draft', 'active')),
  created_by text not null default 'agent' check (created_by in ('agent', 'user')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trigger_custom_skills_updated_at on custom_skills;
create trigger trigger_custom_skills_updated_at
  before update on custom_skills
  for each row execute function update_updated_at();

alter table custom_skills enable row level security;

drop policy if exists "Allow all access to custom_skills" on custom_skills;
create policy "Allow all access to custom_skills" on custom_skills for all using (true) with check (true);

-- Default profile so the app has something to read on first run.
insert into user_profiles (display_name, system_prompt)
values (
  'Owner',
  'You are Zuychin, a helpful, warm, and intelligent personal AI assistant. You have long-term memory and can remember past conversations. Be concise but thorough. Use a friendly, natural tone.'
)
on conflict do nothing;

-- ===== V5 wave =====

-- Every initiative-engine decision, sent or suppressed. Feedback comes from
-- the Telegram 👍/👎 inline keyboard (1 / -1).
create table if not exists initiative_log (
  id uuid primary key default gen_random_uuid(),
  decided_at timestamptz not null default now(),
  should_send boolean not null,
  category text not null,
  reason text,
  message text,
  feedback smallint
);

create index if not exists idx_initiative_log_decided
  on initiative_log (decided_at desc);

create index if not exists idx_initiative_log_category
  on initiative_log (category, decided_at desc);

alter table initiative_log enable row level security;

drop policy if exists "Allow all access to initiative_log" on initiative_log;
create policy "Allow all access to initiative_log" on initiative_log for all using (true) with check (true);

-- Shared k/v state for crons (e.g. the run-review high-water mark). Kept out
-- of user_profiles.preferences: that bag is replaced whole on write.
create table if not exists cron_state (
  key text primary key,
  value jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

drop trigger if exists trigger_cron_state_updated_at on cron_state;
create trigger trigger_cron_state_updated_at
  before update on cron_state
  for each row execute function update_updated_at();

alter table cron_state enable row level security;

drop policy if exists "Allow all access to cron_state" on cron_state;
create policy "Allow all access to cron_state" on cron_state for all using (true) with check (true);

-- Web-push subscriptions (one row per browser). keys = {p256dh, auth}.
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  keys jsonb not null,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table push_subscriptions enable row level security;

drop policy if exists "Allow all access to push_subscriptions" on push_subscriptions;
create policy "Allow all access to push_subscriptions" on push_subscriptions for all using (true) with check (true);
-- Unified knowledge domain. Markdown remains canonical; these rows are rebuildable
-- metadata, search indexes, temporal assertions and audit records.
create table if not exists knowledge_documents (
  id text primary key,
  path text not null unique,
  title text not null,
  summary text not null default '',
  category text not null default 'concepts',
  kind text not null default 'semantic'
    check (kind in ('document', 'semantic', 'episodic', 'procedural', 'working')),
  scope text not null default 'user'
    check (scope in ('user', 'project', 'repository', 'session')),
  status text not null default 'active'
    check (status in ('active', 'suggested', 'superseded', 'archived', 'deleted')),
  trust text not null default 'reviewed'
    check (trust in ('trusted', 'reviewed', 'untrusted')),
  sensitivity text not null default 'private'
    check (sensitivity in ('normal', 'private', 'secret')),
  user_profile_id uuid references user_profiles(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  supersedes_id text references knowledge_documents(id) on delete set null,
  valid_from timestamptz,
  valid_to timestamptz,
  content_hash text not null,
  provenance jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trigger_knowledge_documents_updated_at on knowledge_documents;
create trigger trigger_knowledge_documents_updated_at
  before update on knowledge_documents
  for each row execute function update_updated_at();

create index if not exists idx_knowledge_documents_scope
  on knowledge_documents (scope, project_id, status);
create index if not exists idx_knowledge_documents_hash
  on knowledge_documents (content_hash);

create table if not exists knowledge_chunks (
  id text primary key,
  document_id text not null references knowledge_documents(id) on delete cascade,
  heading text not null default '',
  heading_path text[] not null default '{}',
  ordinal integer not null,
  content text not null,
  content_hash text not null,
  token_count integer not null default 0,
  embedding vector,
  embedding_model text not null default 'gemini-embedding-2-preview',
  fts tsvector generated always as (
    to_tsvector('english', coalesce(heading, '') || ' ' || content)
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, ordinal)
);

drop trigger if exists trigger_knowledge_chunks_updated_at on knowledge_chunks;
create trigger trigger_knowledge_chunks_updated_at
  before update on knowledge_chunks
  for each row execute function update_updated_at();

create index if not exists idx_knowledge_chunks_document
  on knowledge_chunks (document_id, ordinal);
create index if not exists idx_knowledge_chunks_model
  on knowledge_chunks (embedding_model);
create index if not exists idx_knowledge_chunks_fts
  on knowledge_chunks using gin (fts);

create table if not exists knowledge_links (
  id uuid primary key default gen_random_uuid(),
  source_document_id text not null references knowledge_documents(id) on delete cascade,
  source_chunk_id text references knowledge_chunks(id) on delete set null,
  target_document_id text references knowledge_documents(id) on delete cascade,
  target_ref text not null,
  relation text not null default 'related',
  rationale text,
  created_at timestamptz not null default now(),
  unique (source_document_id, target_ref, relation)
);

create index if not exists idx_knowledge_links_target
  on knowledge_links (target_document_id);

create table if not exists knowledge_assertions (
  id uuid primary key default gen_random_uuid(),
  assertion text not null,
  kind text not null default 'semantic'
    check (kind in ('semantic', 'episodic', 'procedural', 'working')),
  scope text not null default 'user'
    check (scope in ('user', 'project', 'repository', 'session')),
  status text not null default 'active'
    check (status in ('active', 'suggested', 'superseded', 'archived', 'deleted')),
  trust text not null default 'untrusted'
    check (trust in ('trusted', 'reviewed', 'untrusted')),
  confidence real not null default 0.5 check (confidence >= 0 and confidence <= 1),
  user_profile_id uuid references user_profiles(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  source_document_id text references knowledge_documents(id) on delete set null,
  source_chunk_id text references knowledge_chunks(id) on delete set null,
  supersedes_id uuid references knowledge_assertions(id) on delete set null,
  valid_from timestamptz,
  valid_to timestamptz,
  observed_at timestamptz not null default now(),
  retired_at timestamptz,
  provenance jsonb not null default '[]',
  embedding vector,
  embedding_model text not null default 'gemini-embedding-2-preview',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trigger_knowledge_assertions_updated_at on knowledge_assertions;
create trigger trigger_knowledge_assertions_updated_at
  before update on knowledge_assertions
  for each row execute function update_updated_at();

create index if not exists idx_knowledge_assertions_scope
  on knowledge_assertions (scope, project_id, status);
create index if not exists idx_knowledge_assertions_model
  on knowledge_assertions (embedding_model);

create table if not exists knowledge_events (
  id uuid primary key default gen_random_uuid(),
  document_id text references knowledge_documents(id) on delete set null,
  assertion_id uuid references knowledge_assertions(id) on delete set null,
  action text not null check (action in (
    'created', 'updated', 'corrected', 'promoted', 'merged', 'archived',
    'restored', 'deleted', 'indexed', 'imported'
  )),
  actor text not null check (actor in ('user', 'assistant', 'system')),
  detail jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);

create index if not exists idx_knowledge_events_document
  on knowledge_events (document_id, occurred_at desc);

create table if not exists knowledge_sync_state (
  source text primary key,
  cursor text,
  last_complete_scan_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

drop trigger if exists trigger_knowledge_sync_state_updated_at on knowledge_sync_state;
create trigger trigger_knowledge_sync_state_updated_at
  before update on knowledge_sync_state
  for each row execute function update_updated_at();

create table if not exists knowledge_suggestions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in (
    'duplicate', 'contradiction', 'stale', 'orphan', 'broken_link',
    'missing_identity', 'merge', 'link', 'promotion'
  )),
  status text not null default 'open'
    check (status in ('open', 'accepted', 'dismissed')),
  severity text not null default 'info'
    check (severity in ('info', 'warning', 'critical')),
  document_ids text[] not null default '{}',
  title text not null,
  detail text not null,
  evidence jsonb not null default '{}',
  confidence real not null default 0.5 check (confidence >= 0 and confidence <= 1),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_knowledge_suggestions_status
  on knowledge_suggestions (status, created_at desc);

-- Curator scans replace only open generated findings and never partially clear the queue.
create or replace function replace_open_knowledge_suggestions(
  p_kinds text[],
  p_suggestions jsonb
)
returns integer
language plpgsql
as $$
declare
  inserted_count integer;
begin
  delete from knowledge_suggestions
  where status = 'open' and kind = any(p_kinds);

  insert into knowledge_suggestions (
    kind, status, severity, document_ids, title, detail, evidence, confidence
  )
  select
    item->>'kind',
    'open',
    coalesce(item->>'severity', 'info'),
    array(select jsonb_array_elements_text(coalesce(item->'document_ids', '[]'::jsonb))),
    item->>'title',
    item->>'detail',
    coalesce(item->'evidence', '{}'::jsonb),
    least(1, greatest(0, coalesce((item->>'confidence')::real, 0.5)))
  from jsonb_array_elements(coalesce(p_suggestions, '[]'::jsonb)) item
  where item->>'kind' = any(p_kinds);

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;


alter table knowledge_documents enable row level security;
alter table knowledge_chunks enable row level security;
alter table knowledge_links enable row level security;
alter table knowledge_assertions enable row level security;
alter table knowledge_events enable row level security;
alter table knowledge_sync_state enable row level security;
alter table knowledge_suggestions enable row level security;

-- Knowledge data is server-only. The service role bypasses RLS; the anon key
-- receives no direct table policy and must use authenticated application routes.
drop policy if exists "Allow all access to embeddings" on embeddings;
drop policy if exists "Allow all access to vault_pages" on vault_pages;
drop policy if exists "Allow all access to memories" on memories;

-- Atomic chunk replacement: failures roll back the delete and preserve the prior index.
create or replace function replace_knowledge_chunks(
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
    token_count, embedding, embedding_model
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
    item->>'embedding_model'
  from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) item;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function hybrid_recall_knowledge_chunks(
  query_embedding vector,
  query_text text default '',
  match_count integer default 20,
  filter_model text default 'gemini-embedding-2-preview',
  filter_project uuid default null
)
returns table (
  document_id text,
  chunk_id text,
  path text,
  title text,
  heading text,
  content text,
  category text,
  kind text,
  trust text,
  provenance jsonb,
  updated_at timestamptz,
  semantic_score float,
  lexical_score float
)
language plpgsql
as $$
declare
  q tsquery := websearch_to_tsquery('english', coalesce(query_text, ''));
begin
  return query
  with eligible as (
    select c.*, d.path, d.title, d.category, d.kind, d.trust, d.provenance,
           d.updated_at as document_updated_at
    from knowledge_chunks c
    join knowledge_documents d on d.id = c.document_id
    where c.embedding_model = filter_model
      and d.status = 'active'
      and (d.scope <> 'project' or d.project_id = filter_project)
  ),
  vec as (
    select e.id,
           row_number() over (order by e.embedding <=> query_embedding) as rank,
           greatest(0, 1 - (e.embedding <=> query_embedding))::float as score
    from eligible e
    where e.embedding is not null
    order by e.embedding <=> query_embedding
    limit greatest(match_count * 2, 40)
  ),
  kw as (
    select e.id,
           row_number() over (order by ts_rank_cd(e.fts, q) desc) as rank,
           least(1, ts_rank_cd(e.fts, q) * 4)::float as score
    from eligible e
    where numnode(q) > 0 and e.fts @@ q
    order by ts_rank_cd(e.fts, q) desc
    limit greatest(match_count * 2, 40)
  ),
  fused as (
    select coalesce(vec.id, kw.id) as id,
           coalesce(vec.score, 0)::float as semantic_score,
           coalesce(kw.score, 0)::float as lexical_score,
           (coalesce(1.0 / (60 + vec.rank), 0)
             + coalesce(1.0 / (60 + kw.rank), 0))::float as rrf
    from vec full outer join kw on vec.id = kw.id
  )
  select
    e.document_id,
    e.id,
    e.path,
    e.title,
    e.heading,
    e.content,
    e.category,
    e.kind,
    e.trust,
    e.provenance,
    e.document_updated_at,
    f.semantic_score,
    f.lexical_score
  from fused f
  join eligible e on e.id = f.id
  order by f.rrf desc
  limit match_count;
end;
$$;

-- ===== Council wave =====

-- zuychin-council: a debate channel for the user's external coding agents,
-- which connect as MCP clients and hold rounds by appending here while a
-- long-poll tool tails the log. An MCP server cannot wake an idle agent, so
-- every mechanism below is something a participant's own tool call discovers
-- and executes for everyone, made exactly-once by compare-and-swap on this row.
create table if not exists council_sessions (
  id uuid primary key default gen_random_uuid(),
  -- Retyped by the human into 3 terminals: no 0/O/1/I in the alphabet.
  code text not null unique,
  user_profile_id uuid references user_profiles(id) on delete cascade,
  topic text not null,
  brief text not null default '',
  closer_name text not null,
  -- 'concluding' still accepts final positions; only 'closed' refuses appends.
  -- Every non-'closed' state must remain concludeable or a council that spends
  -- its round budget can never record the verdict it reached.
  status text not null default 'open'
    check (status in ('open', 'concluding', 'closed', 'expired')),
  round integer not null default 1,
  max_rounds integer not null default 6,
  max_messages integer not null default 60,
  -- Allocated by append_council_message as last_seq = last_seq + 1 in the same
  -- transaction as the insert, so allocation happens under this row's write
  -- lock: seq order == commit order, which is the only reason a seq > cursor
  -- poll can never skip a message. A Postgres sequence would break this
  -- (nextval takes no row lock, so a lower seq can commit second).
  last_seq integer not null default 0,
  last_message_at timestamptz not null default now(),
  -- Set by the join that first brings 2 live participants together. No floor is
  -- granted before this, or the first agent to arrive monologues alone.
  quorum_at timestamptz,
  floor_holder text,
  floor_granted_at timestamptz,
  -- CAS token for floor election: a waiter installs a grant only if neither the
  -- epoch nor last_seq moved since it observed silence.
  floor_epoch integer not null default 0,
  silent_grants integer not null default 0,
  verdict text,
  open_questions jsonb not null default '[]',
  archive_status text not null default 'pending'
    check (archive_status in ('pending', 'filed', 'failed', 'skipped')),
  vault_path text,
  expires_at timestamptz not null default now() + interval '90 minutes',
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (last_seq >= 0)
);

drop trigger if exists trigger_council_sessions_updated_at on council_sessions;
create trigger trigger_council_sessions_updated_at
  before update on council_sessions
  for each row execute function update_updated_at();

create index if not exists idx_council_sessions_status
  on council_sessions (status, expires_at);

-- append_council_message is the SOLE writer of seq. A direct insert here breaks
-- the gapless-cursor invariant with no error, and neither tsc nor eslint can
-- see it.
create table if not exists council_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references council_sessions(id) on delete cascade,
  seq integer not null check (seq > 0),
  round integer not null,
  speaker text not null,
  role text not null default 'agent'
    check (role in ('agent', 'moderator', 'system')),
  addressed_to text not null default 'all',
  intent text not null check (intent in (
    'propose', 'challenge', 'answer', 'concede', 'refine', 'ask',
    'pass', 'moderate', 'verdict', 'system'
  )),
  reply_to_seq integer,
  body text not null check (char_length(body) <= 6000),
  -- A client tool-call timeout does not stop the server-side insert, so a
  -- retried council_speak arrives twice. Caller-supplied key first; the hash is
  -- the fallback for an LLM that regenerates a fresh key on retry.
  client_key text not null,
  body_hash text not null,
  answered boolean not null default false,
  created_at timestamptz not null default now(),
  unique (session_id, seq),
  unique (session_id, speaker, client_key)
);

-- unique (session_id, seq) already builds the btree the poll cursor uses; this
-- one serves the dedupe lookup and the "what did X say" read.
create index if not exists idx_council_messages_speaker
  on council_messages (session_id, speaker, seq desc);

create table if not exists council_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references council_sessions(id) on delete cascade,
  name text not null,
  kind text not null default 'agent' check (kind in ('agent', 'moderator')),
  expertise text not null default '',
  status text not null default 'invited'
    check (status in ('invited', 'active', 'passed', 'left')),
  posts_total integer not null default 0,
  posts_this_round integer not null default 0,
  -- ACKNOWLEDGED read watermark. Never derived from the speaker's own new seq:
  -- doing so acks peer messages it never read and silently drops them forever.
  cursor_seq integer not null default 0,
  -- Two-phase ack. A delivered batch lands here; the arrival of this
  -- participant's NEXT call is the proof the response reached it, and promotes
  -- it into cursor_seq. Survives an LLM that forgets to echo sinceSeq.
  pending_ack_seq integer not null default 0,
  expired_grants integer not null default 0,
  wait_calls integer not null default 0,
  joined_seq integer not null default 0,
  joined_at timestamptz,
  -- Refreshed every 10s from inside the poll loop, not at its edges: a 30s
  -- window would otherwise make a healthy waiter look dead for 30s at a time.
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (session_id, name)
);

create index if not exists idx_council_participants_live
  on council_participants (session_id, status, last_seen_at desc);

-- Server-only, same stance as the knowledge_* tables: the service role bypasses
-- RLS and the anon key receives no table policy.
alter table council_sessions enable row level security;
alter table council_messages enable row level security;
alter table council_participants enable row level security;

-- Every council utterance in one transaction: idempotency, quota, gapless seq,
-- floor consumption, round advance and lifecycle. Returns jsonb (not the house
-- returns integer) because the caller needs seq + round + the quota verdict to
-- render its reply, and a second read would double write latency.
-- Correctness depends on READ COMMITTED: at REPEATABLE READ the blocked
-- transaction would keep its stale snapshot. Do not raise
-- default_transaction_isolation on this project.
create or replace function append_council_message(
  p_session_id uuid,
  p_speaker text,
  p_role text,
  p_intent text,
  p_body text,
  p_client_key text,
  p_addressed_to text default 'all',
  p_reply_to_seq integer default null,
  p_ack_seq integer default null,
  p_posts_per_round integer default 2,
  p_stale_seconds integer default 180
)
returns jsonb
language plpgsql
as $$
declare
  v_status text; v_max_msgs integer; v_floor text; v_granted timestamptz;
  v_rnd integer; v_posts integer; v_kind text; v_seq integer; v_hash text;
  v_pending integer; v_advanced boolean := false; v_existing integer;
begin
  -- FOR UPDATE, not FOR SHARE: share locks are mutually compatible, so two
  -- concurrent appends would both pass and collide on unique(session_id, seq).
  select status, round, max_messages, floor_holder, floor_granted_at
    into v_status, v_rnd, v_max_msgs, v_floor, v_granted
  from council_sessions where id = p_session_id for update;
  if v_status is null then
    return jsonb_build_object('ok', false, 'reason', 'no_session');
  end if;

  -- Dedupe BEFORE quota: a retry of a message that already committed must
  -- report success, not "nothing was recorded" about something that was.
  v_hash := md5(v_rnd || ':' || p_intent || ':' || p_body);
  select seq into v_existing from council_messages
   where session_id = p_session_id and speaker = p_speaker
     and (client_key = p_client_key or body_hash = v_hash)
   order by seq desc limit 1;
  if v_existing is not null then
    return jsonb_build_object('ok', true, 'duplicate', true, 'seq', v_existing, 'round', v_rnd);
  end if;

  if v_status = 'closed' then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'round', v_rnd);
  end if;
  if p_role = 'agent' then
    select posts_this_round, kind into v_posts, v_kind
    from council_participants where session_id = p_session_id and name = p_speaker;
    if v_kind is null then
      return jsonb_build_object('ok', false, 'reason', 'not_a_participant');
    end if;
    -- The floor grant carries a quota override. Without it a stuck round hands
    -- the floor to an agent whose every post is then rejected on quota, and
    -- since only a successful append clears floor_holder the floor is never
    -- released: the exact deadlock the grant exists to break.
    if p_intent <> 'pass' and v_posts >= p_posts_per_round
       and coalesce(v_floor, '') <> p_speaker then
      return jsonb_build_object('ok', false, 'reason', 'quota', 'round', v_rnd, 'posts', v_posts);
    end if;
    if v_status = 'expired' then
      return jsonb_build_object('ok', false, 'reason', 'expired', 'round', v_rnd);
    end if;
  end if;

  update council_sessions
     set last_seq = last_seq + 1,
         last_message_at = now(),
         floor_holder = null,
         floor_granted_at = null,
         -- Only a real agent turn resets the stall counter. A moderator nudge
         -- resetting it would restart the escalation ladder that fired it.
         silent_grants = case when p_role = 'agent' then 0 else silent_grants end
   where id = p_session_id and last_seq < v_max_msgs
  returning last_seq into v_seq;
  if v_seq is null then
    return jsonb_build_object('ok', false, 'reason', 'message_cap', 'round', v_rnd);
  end if;

  insert into council_messages (
    session_id, seq, round, speaker, role, addressed_to, intent,
    reply_to_seq, body, client_key, body_hash
  ) values (
    p_session_id, v_seq, v_rnd, p_speaker, p_role, coalesce(p_addressed_to, 'all'),
    p_intent, p_reply_to_seq, left(p_body, 6000), p_client_key, v_hash
  );

  if p_reply_to_seq is not null and p_intent in ('answer', 'concede') then
    update council_messages set answered = true
     where session_id = p_session_id and seq = p_reply_to_seq;
  end if;

  if p_role = 'agent' then
    update council_participants
       set posts_total = posts_total + 1,
           posts_this_round = posts_this_round + 1,
           expired_grants = 0,
           last_seen_at = now(),
           status = case when p_intent = 'pass' then 'passed' else 'active' end,
           -- Explicit ack only. greatest() keeps it monotonic and idempotent.
           cursor_seq = greatest(cursor_seq, coalesce(p_ack_seq, pending_ack_seq, cursor_seq))
     where session_id = p_session_id and name = p_speaker;

    -- Round advances when every LIVE agent has used its full allowance or
    -- passed. Stale and never-joined participants are excluded, or one absent
    -- agent blocks the advance forever and everyone starves on quota.
    -- The condition is posts_this_round < p_posts_per_round, not = 0: a = 0
    -- quorum flips the round after one pass around the table and silently
    -- evaporates everyone's second slot.
    select count(*) into v_pending
      from council_participants
     where session_id = p_session_id and kind = 'agent'
       and status in ('invited', 'active')
       and posts_this_round < p_posts_per_round
       and last_seen_at > now() - make_interval(secs => p_stale_seconds);
    if v_pending = 0 then
      v_advanced := true;
      update council_participants
         set posts_this_round = 0,
             status = case when status = 'passed' then 'active' else status end
       where session_id = p_session_id and status <> 'left';
      update council_sessions
         set round = round + 1,
             status = case when round + 1 > max_rounds and status = 'open'
                           then 'concluding' else status end
       where id = p_session_id;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'duplicate', false, 'seq', v_seq,
                            'round', v_rnd, 'advanced', v_advanced);
end;
$$;

-- Election runs server-side so N racing waiters cannot compute different
-- winners. The (floor_epoch, last_seq) guards refuse a grant if a message
-- landed or another waiter already won between observation and claim. The
-- caller need not be the winner: whoever ticks first grants on everyone's
-- behalf and the winner reads it on its next tick, <=3s later.
create or replace function elect_council_floor(
  p_session_id uuid,
  p_expected_epoch integer,
  p_expected_last_seq integer,
  p_silence_seconds integer default 8,
  p_floor_ttl_seconds integer default 50,
  p_waiter_fresh_seconds integer default 30
)
returns jsonb
language plpgsql
as $$
declare v_addressed text; v_prev text; v_winner text; v_epoch integer; v_live integer;
begin
  select floor_holder into v_prev
    from council_sessions where id = p_session_id;

  select count(*) into v_live from council_participants
   where session_id = p_session_id and kind = 'agent' and status <> 'left'
     and last_seen_at > now() - make_interval(secs => p_waiter_fresh_seconds);
  if v_live < 1 then
    return jsonb_build_object('granted', false, 'reason', 'no_fresh_waiter');
  end if;

  -- A direct handoff skips the silence timer, so the named target sorts first.
  select m.addressed_to into v_addressed from council_messages m
   where m.session_id = p_session_id and m.seq = p_expected_last_seq
     and m.addressed_to <> 'all';

  select p.name into v_winner from council_participants p
   where p.session_id = p_session_id and p.kind = 'agent' and p.status <> 'left'
     and p.last_seen_at > now() - make_interval(secs => p_waiter_fresh_seconds)
     and p.expired_grants < 2
   order by (p.name is distinct from v_addressed), p.posts_total asc, p.joined_seq asc
   limit 1;
  if v_winner is null then
    return jsonb_build_object('granted', false, 'reason', 'no_eligible_waiter');
  end if;

  update council_sessions
     set floor_holder = v_winner, floor_granted_at = now(),
         floor_epoch = floor_epoch + 1, silent_grants = silent_grants + 1
   where id = p_session_id
     and status in ('open', 'concluding')
     and expires_at > now()
     and quorum_at is not null
     and floor_epoch = p_expected_epoch
     and last_seq = p_expected_last_seq
     -- Reclaimable when the previous grant aged out. Vercel hard-kills at
     -- maxDuration without running finally blocks, so a grant is never released
     -- by cleanup, only by an append or by age.
     and (floor_holder is null
          or floor_granted_at < now() - make_interval(secs => p_floor_ttl_seconds))
     and (v_winner = v_addressed
          or greatest(last_message_at, coalesce(floor_granted_at, last_message_at))
              < now() - make_interval(secs => p_silence_seconds))
  returning floor_epoch into v_epoch;
  if v_epoch is null then
    return jsonb_build_object('granted', false, 'reason', 'stale_observation');
  end if;

  if v_prev is not null and v_prev <> v_winner then
    update council_participants set expired_grants = expired_grants + 1
     where session_id = p_session_id and name = v_prev;
  end if;
  return jsonb_build_object('granted', true, 'holder', v_winner, 'epoch', v_epoch);
end;
$$;

-- Called at the top of every council tool and every ~10s inside the poll loop.
-- returns boolean so a misspelled agentName is a loud "you are not a
-- participant" instead of a silent zero-row no-op that makes the agent
-- permanently invisible to election while it polls happily to expiry.
create or replace function touch_council_participant(
  p_session_id uuid, p_agent_name text,
  p_pending_ack integer default null, p_count_wait boolean default false
)
returns boolean
language plpgsql
as $$
declare v_id uuid;
begin
  update council_participants
     set last_seen_at = now(),
         wait_calls = wait_calls + case when p_count_wait then 1 else 0 end,
         -- Promote the previous window's delivery: this call proves it landed.
         cursor_seq = greatest(cursor_seq, pending_ack_seq),
         pending_ack_seq = greatest(pending_ack_seq, coalesce(p_pending_ack, 0))
   where session_id = p_session_id and name = p_agent_name and status <> 'left'
  returning id into v_id;
  return v_id is not null;
end;
$$;

-- Idempotent join; sets quorum_at on the join that first brings two live agents
-- together, which is what gates the very first floor grant.
create or replace function join_council(
  p_session_id uuid, p_agent_name text, p_expertise text default ''
)
returns jsonb
language plpgsql
as $$
declare v_kind text; v_live integer;
begin
  select kind into v_kind from council_participants
   where session_id = p_session_id and name = p_agent_name;
  if v_kind is null then
    return jsonb_build_object('ok', false, 'reason', 'not_on_roster');
  end if;
  update council_participants
     set status = case when status = 'invited' then 'active' else status end,
         expertise = case when p_expertise <> '' then p_expertise else expertise end,
         joined_at = coalesce(joined_at, now()), last_seen_at = now()
   where session_id = p_session_id and name = p_agent_name;
  select count(*) into v_live from council_participants
   where session_id = p_session_id and kind = 'agent' and joined_at is not null;
  if v_live >= 2 then
    update council_sessions set quorum_at = coalesce(quorum_at, now())
     where id = p_session_id;
  end if;
  return jsonb_build_object('ok', true, 'live', v_live);
end;
$$;

-- Single-writer close. Accepts every non-closed state, including 'expired': a
-- council that spent its round budget or ran out the clock is the NORMAL
-- ending, and gating the CAS on 'open' would make its verdict unwritable.
create or replace function conclude_council(
  p_session_id uuid, p_closer text, p_verdict text, p_open_questions jsonb default '[]'
)
returns jsonb
language plpgsql
as $$
declare v_row council_sessions;
begin
  update council_sessions
     set status = 'closed', verdict = p_verdict,
         open_questions = coalesce(p_open_questions, '[]'::jsonb),
         closed_at = now(), floor_holder = null, floor_granted_at = null
   where id = p_session_id and status in ('open', 'concluding', 'expired')
  returning * into v_row;
  if v_row.id is null then
    select * into v_row from council_sessions where id = p_session_id;
    return jsonb_build_object('changed', false, 'verdict', v_row.verdict,
                              'closer', v_row.closer_name, 'vault_path', v_row.vault_path);
  end if;
  return jsonb_build_object('changed', true, 'round', v_row.round, 'messages', v_row.last_seq);
end;
$$;

-- WebAuthn passkeys and TOTP recovery for the single private Zuychin account.
-- Only the service-role client may read these tables: public keys are safe to
-- store, but challenges and encrypted TOTP secrets must never be browser-visible.
create table if not exists auth_passkeys (
  credential_id text primary key,
  user_id text not null default 'owner',
  public_key text not null,
  counter bigint not null default 0,
  transports jsonb not null default '[]'::jsonb,
  device_type text not null check (device_type in ('singleDevice', 'multiDevice')),
  backed_up boolean not null default false,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists idx_auth_passkeys_owner on auth_passkeys (user_id, created_at);

create table if not exists auth_challenges (
  id uuid primary key,
  user_id text not null default 'owner',
  purpose text not null check (purpose in ('passkey_auth', 'passkey_register', 'totp_recovery')),
  challenge text not null,
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 5),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_auth_challenges_expiry on auth_challenges (expires_at);

create table if not exists auth_totp (
  user_id text primary key default 'owner',
  secret_ciphertext text not null,
  enabled_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table auth_passkeys enable row level security;
alter table auth_challenges enable row level security;
alter table auth_totp enable row level security;

-- The application uses SUPABASE_SERVICE_ROLE_KEY. Do not add anon policies to
-- these tables: every read and write is server-side after auth verification.
