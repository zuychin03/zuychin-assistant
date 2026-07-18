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
-- partition — an unfiltered arm would return cross-partition duplicates.
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
