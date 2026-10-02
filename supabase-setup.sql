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

-- Every owner-scoped row hangs off this one profile. A database that already holds
-- duplicates skips the index until scripts/migrations/owner-profile-consolidation.sql runs.
do $$
begin
  if (select count(*) from user_profiles) <= 1 then
    create unique index if not exists user_profiles_single_owner on user_profiles ((true));
  else
    raise warning 'user_profiles holds more than one row; run scripts/migrations/owner-profile-consolidation.sql';
  end if;
end $$;

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

-- Server-only: the app uses the service role, which bypasses RLS. With no policies and no
-- anon or authenticated grants, the public anon key reaches nothing. The drops remove the
-- "Allow all access" policies that earlier versions created for every role.
alter table user_profiles enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table embeddings enable row level security;
alter table todos enable row level security;
alter table artifacts enable row level security;

drop policy if exists "Allow all access to user_profiles" on user_profiles;
revoke all on user_profiles from public, anon, authenticated;

drop policy if exists "Allow all access to conversations" on conversations;
revoke all on conversations from public, anon, authenticated;

drop policy if exists "Allow all access to messages" on messages;
revoke all on messages from public, anon, authenticated;

drop policy if exists "Allow all access to embeddings" on embeddings;
revoke all on embeddings from public, anon, authenticated;

drop policy if exists "Allow all access to todos" on todos;
revoke all on todos from public, anon, authenticated;

drop policy if exists "Allow all access to artifacts" on artifacts;
revoke all on artifacts from public, anon, authenticated;

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
revoke all on vault_pages from public, anon, authenticated;

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
revoke all on agent_runs from public, anon, authenticated;

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
revoke all on memories from public, anon, authenticated;

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
revoke all on scheduled_tasks from public, anon, authenticated;

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
revoke all on processed_emails from public, anon, authenticated;

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
revoke all on projects from public, anon, authenticated;

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
revoke all on custom_skills from public, anon, authenticated;

-- Default profile so the app has something to read on first run; re-runs must not add a second.
insert into user_profiles (display_name, system_prompt)
select
  'Owner',
  'You are Zuychin, a helpful, warm, and intelligent personal AI assistant. You have long-term memory and can remember past conversations. Be concise but thorough. Use a friendly, natural tone.'
where not exists (select 1 from user_profiles)
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
revoke all on initiative_log from public, anon, authenticated;

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
revoke all on cron_state from public, anon, authenticated;

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
revoke all on push_subscriptions from public, anon, authenticated;
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

-- ===== Council work campaign wave =====
alter table council_sessions
  add column if not exists repo_path text,
  add column if not exists base_branch text,
  add column if not exists council_type text not null default 'debate'
    check (council_type in ('debate', 'code', 'research', 'audit', 'debug'));

create table if not exists council_campaigns (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references council_sessions(id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'complete', 'blocked', 'cancelled')),
  repo_path text not null,
  base_branch text not null default 'main',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists council_work_items (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references council_campaigns(id) on delete cascade,
  sequence integer not null check (sequence > 0),
  agent_name text not null,
  title text not null check (char_length(title) <= 160),
  instructions text not null check (char_length(instructions) <= 8000),
  acceptance_criteria jsonb not null default '[]',
  status text not null default 'queued' check (status in ('queued', 'in_progress', 'awaiting_review', 'verified', 'blocked', 'cancelled')),
  heartbeat_at timestamptz,
  attempts integer not null default 0,
  progress text,
  commit_hash text,
  verification text,
  blocked_reason text,
  started_at timestamptz,
  completed_at timestamptz,
  reviewed_at timestamptz,
  unique (campaign_id, sequence)
);
create index if not exists idx_council_work_items_agent on council_work_items (campaign_id, agent_name, status, sequence);
alter table council_campaigns enable row level security;
alter table council_work_items enable row level security;

create or replace function create_council_campaign(p_session_id uuid, p_created_by text, p_work_items jsonb)
returns jsonb language plpgsql as $$
declare v_session council_sessions; v_campaign council_campaigns; v_item jsonb; v_index integer := 0;
begin
  select * into v_session from council_sessions where id = p_session_id for update;
  if v_session.id is null then raise exception 'council session not found'; end if;
  if v_session.status <> 'closed' then raise exception 'council must be closed before work begins'; end if;
  if v_session.closer_name <> p_created_by then raise exception 'only the designated closer can create a campaign'; end if;
  if v_session.repo_path is null or v_session.base_branch is null then raise exception 'this council has no registered workspace'; end if;
  if jsonb_typeof(p_work_items) <> 'array' or jsonb_array_length(p_work_items) = 0 then raise exception 'a campaign needs at least one work item'; end if;
  select * into v_campaign from council_campaigns where session_id = p_session_id;
  if v_campaign.id is not null then return jsonb_build_object('campaign_id', v_campaign.id, 'created', false); end if;
  for v_item in select value from jsonb_array_elements(p_work_items) loop
    v_index := v_index + 1;
    if not exists (select 1 from council_participants where session_id = p_session_id and name = coalesce(v_item->>'agent_name', '') and kind = 'agent') then
      raise exception 'work item % has an agent outside the council roster', v_index;
    end if;
    if coalesce(char_length(v_item->>'title'), 0) = 0 or coalesce(char_length(v_item->>'instructions'), 0) = 0 then
      raise exception 'work item % needs a title and instructions', v_index;
    end if;
  end loop;
  insert into council_campaigns (session_id, repo_path, base_branch)
  values (p_session_id, v_session.repo_path, v_session.base_branch) returning * into v_campaign;
  insert into council_work_items (campaign_id, sequence, agent_name, title, instructions, acceptance_criteria)
  select v_campaign.id, row_number() over (), item->>'agent_name', item->>'title', item->>'instructions', coalesce(item->'acceptance_criteria', '[]'::jsonb)
    from jsonb_array_elements(p_work_items) item;
  return jsonb_build_object('campaign_id', v_campaign.id, 'created', true);
end;
$$;

create or replace function claim_council_work_item(p_session_id uuid, p_agent_name text)
returns jsonb language plpgsql as $$
declare v_item council_work_items; v_campaign council_campaigns;
begin
  select * into v_campaign from council_campaigns where session_id = p_session_id for update;
  if v_campaign.id is null or v_campaign.status <> 'running' then return null; end if;
  select w.* into v_item from council_work_items w where w.campaign_id = v_campaign.id and w.agent_name = p_agent_name and w.status = 'in_progress' order by w.sequence limit 1 for update;
  if v_item.id is null then
    select w.* into v_item from council_work_items w where w.campaign_id = v_campaign.id and w.agent_name = p_agent_name and w.status = 'queued' order by w.sequence limit 1 for update skip locked;
    if v_item.id is null then return null; end if;
    update council_work_items set status = 'in_progress', attempts = attempts + 1, started_at = coalesce(started_at, now()), heartbeat_at = now() where id = v_item.id returning * into v_item;
  else
    update council_work_items set heartbeat_at = now() where id = v_item.id returning * into v_item;
  end if;
  return to_jsonb(v_item);
end;
$$;

create or replace function heartbeat_council_work_item(p_item_id uuid, p_agent_name text, p_progress text)
returns boolean language plpgsql as $$
begin
  update council_work_items set heartbeat_at = now(), progress = coalesce(p_progress, progress) where id = p_item_id and agent_name = p_agent_name and status = 'in_progress';
  return found;
end;
$$;

create or replace function complete_council_work_item(p_item_id uuid, p_agent_name text, p_commit_hash text, p_verification text)
returns boolean language plpgsql as $$
begin
  update council_work_items set status = 'awaiting_review', heartbeat_at = now(), commit_hash = p_commit_hash, verification = p_verification, completed_at = now() where id = p_item_id and agent_name = p_agent_name and status = 'in_progress';
  return found;
end;
$$;

create or replace function block_council_work_item(p_item_id uuid, p_agent_name text, p_reason text)
returns boolean language plpgsql as $$
declare v_campaign_id uuid;
begin
  update council_work_items set status = 'blocked', blocked_reason = p_reason, heartbeat_at = now() where id = p_item_id and agent_name = p_agent_name and status in ('queued', 'in_progress') returning campaign_id into v_campaign_id;
  if not found then return false; end if;
  update council_campaigns set status = 'blocked' where id = v_campaign_id and not exists (select 1 from council_work_items where campaign_id = v_campaign_id and status in ('queued', 'in_progress', 'awaiting_review'));
  return true;
end;
$$;

-- Dropped first so this file stays re-runnable. The P6 block near the end
-- redefines this with a jsonb return, and Postgres will not change a return
-- type in place; a second run of the whole file would otherwise die here.
-- DROP identifies a function by name and argument types alone, so the same
-- statement clears whichever version is currently installed.
drop function if exists review_council_work_item(uuid, text, boolean, text);
create or replace function review_council_work_item(p_item_id uuid, p_reviewer text, p_accepted boolean, p_note text)
returns boolean language plpgsql as $$
declare v_campaign_id uuid; v_closer text;
begin
  select c.id, s.closer_name into v_campaign_id, v_closer from council_work_items w join council_campaigns c on c.id = w.campaign_id join council_sessions s on s.id = c.session_id where w.id = p_item_id for update;
  if v_campaign_id is null or v_closer <> p_reviewer then return false; end if;
  if p_accepted then
    update council_work_items set status = 'verified', verification = concat_ws(E'\n', verification, 'Review: ' || p_note), reviewed_at = now() where id = p_item_id and status = 'awaiting_review';
  else
    update council_work_items set status = 'queued', progress = concat_ws(E'\n', progress, 'Review feedback: ' || p_note), heartbeat_at = null, completed_at = null where id = p_item_id and status = 'awaiting_review';
  end if;
  if not found then return false; end if;
  update council_campaigns set status = case
      when not exists (select 1 from council_work_items where campaign_id = v_campaign_id and status <> 'verified') then 'complete'
      when exists (select 1 from council_work_items where campaign_id = v_campaign_id and status = 'blocked')
       and not exists (select 1 from council_work_items where campaign_id = v_campaign_id and status in ('queued', 'in_progress', 'awaiting_review')) then 'blocked'
      else 'running' end,
    completed_at = case when not exists (select 1 from council_work_items where campaign_id = v_campaign_id and status <> 'verified') then now() else null end where id = v_campaign_id;
  return true;
end;
$$;


-- Conservative, user-approved conversation deletion suggestions.
create table if not exists conversation_cleanup_recommendations (
  conversation_id uuid primary key references conversations(id) on delete cascade,
  title_snapshot text not null,
  conversation_updated_at timestamptz not null,
  score integer not null check (score between 0 and 100),
  reason text not null,
  reviewed_at timestamptz not null default now(),
  dismissed_at timestamptz
);

create index if not exists idx_conversation_cleanup_pending
  on conversation_cleanup_recommendations (reviewed_at desc)
  where dismissed_at is null;

alter table conversation_cleanup_recommendations enable row level security;

drop policy if exists "Allow all access to conversation_cleanup_recommendations" on conversation_cleanup_recommendations;
revoke all on conversation_cleanup_recommendations from public, anon, authenticated;

-- Conversation-owned records must leave with the conversation, not become orphans.
alter table agent_runs drop constraint if exists agent_runs_conversation_id_fkey;
alter table agent_runs add constraint agent_runs_conversation_id_fkey
  foreign key (conversation_id) references conversations(id) on delete cascade;
alter table scheduled_tasks drop constraint if exists scheduled_tasks_conversation_id_fkey;
alter table scheduled_tasks add constraint scheduled_tasks_conversation_id_fkey
  foreign key (conversation_id) references conversations(id) on delete cascade;

create or replace function delete_conversation_with_associations(target_conversation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count bigint;
begin
  -- Raw history embeddings carry their conversation link inside metadata.
  delete from embeddings
  where metadata ->> 'conversationId' = target_conversation_id::text
     or metadata ->> 'conversation_id' = target_conversation_id::text;

  delete from conversations where id = target_conversation_id;
  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$$;

revoke all on function delete_conversation_with_associations(uuid) from public, anon, authenticated;
grant execute on function delete_conversation_with_associations(uuid) to service_role;


-- ===== Knowledge graph wave =====

-- Derived state only: both tables are rebuilt from the GitHub vault by the graph
-- build and can be dropped at any time without data loss.
create table if not exists vault_graph_snapshot (
  id text primary key default 'current',
  payload jsonb not null,
  node_count integer not null default 0,
  edge_count integer not null default 0,
  build_ms integer,
  built_at timestamptz not null default now()
);

alter table vault_graph_snapshot enable row level security;
drop policy if exists "Allow all access to vault_graph_snapshot" on vault_graph_snapshot;
revoke all on vault_graph_snapshot from public, anon, authenticated;

-- vault_pages.content is truncated at 8000 chars, so wikilinks cannot be
-- re-derived from it. The graph build parses full GitHub text and lands the
-- complete adjacency here for any reader that needs it without a repo crawl.
create table if not exists vault_page_links (
  source_path text not null,
  target_path text not null,
  mutual boolean not null default false,
  primary key (source_path, target_path)
);

create index if not exists idx_vault_page_links_target on vault_page_links (target_path);

alter table vault_page_links enable row level security;
drop policy if exists "Allow all access to vault_page_links" on vault_page_links;
revoke all on vault_page_links from public, anon, authenticated;


-- ===== Council ACP host wave =====

-- Set for agents scripts/council-host.mts owns over ACP: it pushes their turns
-- with session/prompt instead of them long-polling. The two must never both
-- run for one participant - the host's ack would advance cursor_seq past
-- messages the agent never read - so council_wait and council_speak refuse to
-- block for a dispatch-mode participant.
alter table council_participants
  add column if not exists dispatch_mode boolean not null default false;

-- Signature change: p_dispatch_mode is new. null means "leave it as it is", so
-- a re-join to recover a truncated context cannot silently flip an agent out of
-- host dispatch and back into long-polling.
drop function if exists join_council(uuid, text, text);
create or replace function join_council(
  p_session_id uuid, p_agent_name text, p_expertise text default '',
  p_dispatch_mode boolean default null
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
         dispatch_mode = coalesce(p_dispatch_mode, dispatch_mode),
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

-- ===== P1: council correctness wave =====
-- Lease duration lives in these function bodies rather than in a new parameter:
-- adding an argument to an existing function creates an OVERLOAD, not a
-- replacement, and PostgREST then cannot resolve the named-argument call.

alter table council_work_items
  add column if not exists lease_owner text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists max_attempts integer not null default 3;

-- Split out of create_council_campaign so the close path can check a work plan
-- BEFORE the verdict CAS commits. Deliberately omits the 'closed' status check:
-- at validation time the council is still open. Returns null when valid.
create or replace function validate_council_work_items(
  p_session_id uuid, p_created_by text, p_work_items jsonb
) returns text language plpgsql as $$
declare v_session council_sessions; v_item jsonb; v_index integer := 0;
begin
  select * into v_session from council_sessions where id = p_session_id;
  if v_session.id is null then return 'council session not found'; end if;
  if v_session.closer_name <> p_created_by then return 'only the designated closer can create a campaign'; end if;
  if v_session.repo_path is null or v_session.base_branch is null then return 'this council has no registered workspace'; end if;
  if jsonb_typeof(p_work_items) <> 'array' or jsonb_array_length(p_work_items) = 0 then return 'a campaign needs at least one work item'; end if;
  for v_item in select value from jsonb_array_elements(p_work_items) loop
    v_index := v_index + 1;
    if not exists (select 1 from council_participants where session_id = p_session_id and name = coalesce(v_item->>'agent_name', '') and kind = 'agent') then
      return format('work item %s has an agent outside the council roster', v_index);
    end if;
    if coalesce(char_length(v_item->>'title'), 0) = 0 or coalesce(char_length(v_item->>'instructions'), 0) = 0 then
      return format('work item %s needs a title and instructions', v_index);
    end if;
  end loop;
  return null;
end;
$$;

create or replace function create_council_campaign(p_session_id uuid, p_created_by text, p_work_items jsonb)
returns jsonb language plpgsql as $$
declare v_session council_sessions; v_campaign council_campaigns; v_reason text;
begin
  select * into v_session from council_sessions where id = p_session_id for update;
  if v_session.id is null then raise exception 'council session not found'; end if;
  if v_session.status <> 'closed' then raise exception 'council must be closed before work begins'; end if;
  select * into v_campaign from council_campaigns where session_id = p_session_id;
  if v_campaign.id is not null then return jsonb_build_object('campaign_id', v_campaign.id, 'created', false); end if;
  v_reason := validate_council_work_items(p_session_id, p_created_by, p_work_items);
  if v_reason is not null then raise exception '%', v_reason; end if;
  insert into council_campaigns (session_id, repo_path, base_branch)
  values (p_session_id, v_session.repo_path, v_session.base_branch) returning * into v_campaign;
  insert into council_work_items (campaign_id, sequence, agent_name, title, instructions, acceptance_criteria)
  select v_campaign.id, row_number() over (), item->>'agent_name', item->>'title', item->>'instructions', coalesce(item->'acceptance_criteria', '[]'::jsonb)
    from jsonb_array_elements(p_work_items) item;
  return jsonb_build_object('campaign_id', v_campaign.id, 'created', true);
end;
$$;

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
  v_ob_intent text; v_ob_target text; v_ob_answered boolean;
  v_cleared boolean := false; v_new_status text;
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

  -- Obligation discipline. Without these checks any agent could mark any
  -- question answered, including one owed by somebody else, and the caller was
  -- told the obligation cleared whether or not a row actually changed.
  if p_reply_to_seq is not null then
    select intent, addressed_to, answered
      into v_ob_intent, v_ob_target, v_ob_answered
      from council_messages where session_id = p_session_id and seq = p_reply_to_seq;
    if v_ob_intent is null then
      return jsonb_build_object('ok', false, 'reason', 'no_such_seq', 'round', v_rnd);
    end if;
    if p_intent in ('answer', 'concede') then
      if v_ob_intent not in ('challenge', 'ask') then
        return jsonb_build_object('ok', false, 'reason', 'not_an_obligation', 'round', v_rnd);
      end if;
      if v_ob_answered then
        return jsonb_build_object('ok', false, 'reason', 'already_answered', 'round', v_rnd);
      end if;
      if v_ob_target <> p_speaker and v_ob_target <> 'all' then
        return jsonb_build_object('ok', false, 'reason', 'not_addressed_to_you', 'round', v_rnd);
      end if;
    end if;
  end if;

  update council_sessions
     set last_seq = last_seq + 1,
         last_message_at = now(),
         floor_holder = null,
         floor_granted_at = null,
         -- Only a real agent turn resets the stall counter. A moderator nudge
         -- resetting it would restart the escalation ladder that fired it.
         silent_grants = case when p_role = 'agent' then 0 else silent_grants end,
         -- The final permitted message must also end the debate. Without this
         -- the session stays 'open' while every further append is refused on
         -- the cap, and the agents spin until the session expires.
         status = case when last_seq + 1 >= v_max_msgs and status = 'open'
                       then 'concluding' else status end
   where id = p_session_id and last_seq < v_max_msgs
  returning last_seq, status into v_seq, v_new_status;
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
     where session_id = p_session_id and seq = p_reply_to_seq and not answered;
    v_cleared := found;
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
       where id = p_session_id
      returning status into v_new_status;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'duplicate', false, 'seq', v_seq,
                            'round', v_rnd, 'advanced', v_advanced,
                            'cleared', v_cleared, 'status', v_new_status);
end;
$$;

-- Reclaims lapsed leases before serving new work. Without this a dead agent
-- holds an item in 'in_progress' forever: the old body only ever re-served an
-- in_progress item to the SAME agent, so the campaign could never finish.
create or replace function claim_council_work_item(p_session_id uuid, p_agent_name text)
returns jsonb language plpgsql as $$
declare v_item council_work_items; v_campaign council_campaigns; v_status text;
begin
  select * into v_campaign from council_campaigns where session_id = p_session_id for update;
  if v_campaign.id is null or v_campaign.status <> 'running' then return null; end if;

  -- A lapsed lease is not a failed attempt. attempts counts claims, and an agent
  -- waiting out a four-minute host check can lose its lease with nothing wrong
  -- with the work; charging that to max_attempts blocked CN-73YD's item at
  -- attempts = 4 against a ceiling of 3. The ceiling now lives on rejections.
  update council_work_items
     set status = 'queued',
         lease_owner = null, lease_expires_at = null, heartbeat_at = null
   where campaign_id = v_campaign.id
     and status = 'in_progress'
     and lease_expires_at is not null
     and lease_expires_at < now();

  -- A reclaim that blocks the last live item ends the campaign, matching what
  -- block_council_work_item already does on the cooperative path.
  update council_campaigns set status = 'blocked'
   where id = v_campaign.id
     and not exists (select 1 from council_work_items
                      where campaign_id = v_campaign.id
                        and status in ('queued', 'in_progress', 'awaiting_review'));
  select status into v_status from council_campaigns where id = v_campaign.id;
  if v_status <> 'running' then return null; end if;

  select w.* into v_item from council_work_items w
   where w.campaign_id = v_campaign.id and w.agent_name = p_agent_name
     and w.status = 'in_progress' order by w.sequence limit 1 for update;
  if v_item.id is null then
    select w.* into v_item from council_work_items w
     where w.campaign_id = v_campaign.id and w.agent_name = p_agent_name
       and w.status = 'queued' order by w.sequence limit 1 for update skip locked;
    if v_item.id is null then return null; end if;
    update council_work_items
       set status = 'in_progress', attempts = attempts + 1,
           started_at = coalesce(started_at, now()), heartbeat_at = now(),
           lease_owner = p_agent_name, lease_expires_at = now() + interval '45 minutes'
     where id = v_item.id returning * into v_item;
  else
    update council_work_items
       set heartbeat_at = now(), lease_owner = p_agent_name,
           lease_expires_at = now() + interval '45 minutes'
     where id = v_item.id returning * into v_item;
  end if;
  return to_jsonb(v_item);
end;
$$;

create or replace function heartbeat_council_work_item(p_item_id uuid, p_agent_name text, p_progress text)
returns boolean language plpgsql as $$
begin
  update council_work_items
     set heartbeat_at = now(), progress = coalesce(p_progress, progress),
         lease_expires_at = now() + interval '45 minutes'
   where id = p_item_id and agent_name = p_agent_name and status = 'in_progress';
  return found;
end;
$$;

-- ===== P2: harness containment =====
-- Why a column and not the status enum: status records whether the run threw,
-- stop_reason records why it stopped. A run can be 'done' and still have
-- exhausted its round budget or lost a worker to its deadline, and recording
-- that as plain success was the misleading part.
alter table agent_runs add column if not exists stop_reason text;

-- ===== P3: owner channel and live control =====
-- Pause is a flag, not a status: a council can be frozen while 'open' or
-- 'concluding' and must thaw into exactly the state it left, and every existing
-- status check would otherwise have to learn about pausing.

alter table council_sessions
  add column if not exists paused_at timestamptz,
  add column if not exists paused_total_seconds integer not null default 0;

-- The private thread between the owner and Zuychin. Deliberately NOT
-- council_messages: agents never see this, and it is excluded from the filed
-- transcript. relayed_seq links a turn to the moderator message it produced.
create table if not exists council_owner_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references council_sessions(id) on delete cascade,
  role text not null check (role in ('owner', 'zuychin')),
  body text not null,
  relayed_seq integer,
  created_at timestamptz not null default now()
);
create index if not exists idx_council_owner_messages
  on council_owner_messages (session_id, created_at);
alter table council_owner_messages enable row level security;

create or replace function pause_council(p_session_id uuid)
returns jsonb language plpgsql as $$
declare v_row council_sessions;
begin
  update council_sessions set paused_at = now()
   where id = p_session_id and status in ('open', 'concluding') and paused_at is null
  returning * into v_row;
  if v_row.id is not null then
    return jsonb_build_object('ok', true, 'already', false);
  end if;
  select * into v_row from council_sessions where id = p_session_id;
  if v_row.id is null then return jsonb_build_object('ok', false, 'reason', 'no_session'); end if;
  if v_row.status not in ('open', 'concluding') then
    return jsonb_build_object('ok', false, 'reason', 'not_running', 'status', v_row.status);
  end if;
  if v_row.paused_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  return jsonb_build_object('ok', false, 'reason', 'not_running', 'status', v_row.status);
end;
$$;

create or replace function resume_council(p_session_id uuid)
returns jsonb language plpgsql as $$
declare v_row council_sessions; v_paused integer; v_now timestamptz;
begin
  select * into v_row from council_sessions where id = p_session_id for update;
  if v_row.id is null then return jsonb_build_object('ok', false, 'reason', 'no_session'); end if;
  if v_row.status not in ('open', 'concluding') then
    return jsonb_build_object('ok', false, 'reason', 'not_running', 'status', v_row.status);
  end if;
  if v_row.paused_at is null then return jsonb_build_object('ok', true, 'already', true); end if;
  -- Sample after locking: a waiting request must not resume using stale transaction time.
  v_now := clock_timestamp();
  if v_row.paused_at <= v_now - interval '168 hours' then
    update council_sessions set status = 'expired' where id = p_session_id;
    return jsonb_build_object('ok', false, 'reason', 'pause_expired');
  end if;
  v_paused := greatest(0, floor(extract(epoch from (v_now - v_row.paused_at)))::integer);

  -- Restore running deadlines without charging the owner for paused time.
  update council_sessions
     set paused_at = null,
         paused_total_seconds = paused_total_seconds + v_paused,
         expires_at = expires_at + make_interval(secs => v_paused),
         last_message_at = last_message_at + make_interval(secs => v_paused),
         floor_holder = null,
         floor_granted_at = null
   where id = p_session_id;

  -- Paused participants must not resume with stale quorum presence.
  update council_participants set last_seen_at = v_now
   where session_id = p_session_id and status in ('invited', 'active');

  return jsonb_build_object('ok', true, 'already', false, 'paused_seconds', v_paused);
end;
$$;

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
  v_ob_intent text; v_ob_target text; v_ob_answered boolean;
  v_cleared boolean := false; v_new_status text; v_paused timestamptz;
begin
  -- FOR UPDATE, not FOR SHARE: share locks are mutually compatible, so two
  -- concurrent appends would both pass and collide on unique(session_id, seq).
  select status, round, max_messages, floor_holder, floor_granted_at, paused_at
    into v_status, v_rnd, v_max_msgs, v_floor, v_granted, v_paused
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

  -- The moderator still speaks while paused: that is the channel the owner's
  -- relay, the pause notice and the resume notice all travel on.
  if v_paused is not null and p_role = 'agent' then
    return jsonb_build_object('ok', false, 'reason', 'paused', 'round', v_rnd);
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

  -- Obligation discipline. Without these checks any agent could mark any
  -- question answered, including one owed by somebody else, and the caller was
  -- told the obligation cleared whether or not a row actually changed.
  if p_reply_to_seq is not null then
    select intent, addressed_to, answered
      into v_ob_intent, v_ob_target, v_ob_answered
      from council_messages where session_id = p_session_id and seq = p_reply_to_seq;
    if v_ob_intent is null then
      return jsonb_build_object('ok', false, 'reason', 'no_such_seq', 'round', v_rnd);
    end if;
    if p_intent in ('answer', 'concede') then
      if v_ob_intent not in ('challenge', 'ask') then
        return jsonb_build_object('ok', false, 'reason', 'not_an_obligation', 'round', v_rnd);
      end if;
      if v_ob_answered then
        return jsonb_build_object('ok', false, 'reason', 'already_answered', 'round', v_rnd);
      end if;
      if v_ob_target <> p_speaker and v_ob_target <> 'all' then
        return jsonb_build_object('ok', false, 'reason', 'not_addressed_to_you', 'round', v_rnd);
      end if;
    end if;
  end if;

  update council_sessions
     set last_seq = last_seq + 1,
         last_message_at = now(),
         -- A moderator post must NOT revoke a granted floor. The grant exists
         -- to unstick a silent round; an owner relay landing mid-grant would
         -- strand exactly the round it was meant to help.
         floor_holder = case when p_role = 'agent' then null else floor_holder end,
         floor_granted_at = case when p_role = 'agent' then null else floor_granted_at end,
         -- Only a real agent turn resets the stall counter. A moderator nudge
         -- resetting it would restart the escalation ladder that fired it.
         silent_grants = case when p_role = 'agent' then 0 else silent_grants end,
         -- The final permitted AGENT message ends the debate. Moderator posts
         -- are exempt from the cap (below) so relays cannot shorten a council,
         -- and so they must not trigger the transition either.
         status = case when p_role = 'agent' and last_seq + 1 >= v_max_msgs and status = 'open'
                       then 'concluding' else status end
   where id = p_session_id and (p_role <> 'agent' or last_seq < v_max_msgs)
  returning last_seq, status into v_seq, v_new_status;
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
     where session_id = p_session_id and seq = p_reply_to_seq and not answered;
    v_cleared := found;
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
       where id = p_session_id
      returning status into v_new_status;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'duplicate', false, 'seq', v_seq,
                            'round', v_rnd, 'advanced', v_advanced,
                            'cleared', v_cleared, 'status', v_new_status);
end;
$$;

-- ===== P4: owner-gated closure =====
-- 'awaiting_owner' sits between concluding and closed: the closer records a
-- verdict but does not finalise it. The existing invariant that every
-- non-closed state stays concludeable is preserved, because by the time a
-- session is in this state the verdict already exists.

alter table council_sessions drop constraint if exists council_sessions_status_check;
alter table council_sessions add constraint council_sessions_status_check
  check (status in ('open', 'concluding', 'awaiting_owner', 'closed', 'expired'));

alter table council_sessions
  add column if not exists verdict_proposed_at timestamptz,
  add column if not exists standby_expires_at timestamptz,
  add column if not exists continue_count integer not null default 0,
  -- Held until the owner accepts: the campaign is created on accept, not on
  -- conclude, so the plan has to survive the wait somewhere.
  add column if not exists proposed_work_items jsonb;

create or replace function propose_council_verdict(
  p_session_id uuid, p_closer text, p_verdict text,
  p_open_questions jsonb default '[]',
  p_work_items jsonb default null,
  p_standby_seconds integer default 86400
) returns jsonb language plpgsql as $$
declare v_row council_sessions;
begin
  update council_sessions
     set status = 'awaiting_owner',
         verdict = p_verdict,
         open_questions = coalesce(p_open_questions, '[]'::jsonb),
         proposed_work_items = p_work_items,
         verdict_proposed_at = now(),
         standby_expires_at = now() + make_interval(secs => p_standby_seconds),
         floor_holder = null, floor_granted_at = null
   where id = p_session_id and status in ('open', 'concluding', 'expired')
  returning * into v_row;
  if v_row.id is null then
    select * into v_row from council_sessions where id = p_session_id;
    return jsonb_build_object('changed', false, 'status', v_row.status,
                              'verdict', v_row.verdict, 'closer', v_row.closer_name,
                              'vault_path', v_row.vault_path);
  end if;
  return jsonb_build_object('changed', true, 'round', v_row.round, 'messages', v_row.last_seq);
end;
$$;

-- The CAS that actually ends a council. Returns the held work plan so the
-- caller can create the campaign in the same step the verdict becomes final.
create or replace function accept_council_verdict(p_session_id uuid)
returns jsonb language plpgsql as $$
declare v_row council_sessions;
begin
  update council_sessions set status = 'closed', closed_at = now()
   where id = p_session_id and status = 'awaiting_owner'
  returning * into v_row;
  if v_row.id is null then
    select * into v_row from council_sessions where id = p_session_id;
    return jsonb_build_object('changed', false, 'status', v_row.status,
                              'verdict', v_row.verdict, 'closer', v_row.closer_name,
                              'vault_path', v_row.vault_path);
  end if;
  return jsonb_build_object('changed', true, 'verdict', v_row.verdict,
                            'closer', v_row.closer_name,
                            'work_items', v_row.proposed_work_items);
end;
$$;

-- Reopening without redistributing work reproduces the stall that ended the
-- round, so the caller posts an assignment; this only restores the capacity to
-- act on it. Budgets are extended rather than reset: the transcript so far is
-- still the council's history.
create or replace function continue_council(p_session_id uuid, p_extra_rounds integer default 3)
returns jsonb language plpgsql as $$
declare v_row council_sessions; v_extra integer;
begin
  v_extra := greatest(1, coalesce(p_extra_rounds, 3));
  update council_sessions
     set status = 'open',
         verdict = null,
         open_questions = '[]'::jsonb,
         proposed_work_items = null,
         verdict_proposed_at = null,
         standby_expires_at = null,
         continue_count = continue_count + 1,
         max_rounds = max_rounds + v_extra,
         max_messages = max_messages + v_extra * 10,
         last_message_at = now(),
         expires_at = greatest(expires_at, now() + interval '90 minutes'),
         floor_holder = null, floor_granted_at = null
   where id = p_session_id and status = 'awaiting_owner'
  returning * into v_row;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_awaiting_owner');
  end if;
  -- Everyone gets their slots back and stops looking stale, or the first round
  -- after a resume starves on quota and drops agents from the quorum.
  update council_participants
     set posts_this_round = 0,
         last_seen_at = now(),
         status = case when status = 'passed' then 'active' else status end
   where session_id = p_session_id and status <> 'left';
  return jsonb_build_object('ok', true, 'round', v_row.round,
                            'max_rounds', v_row.max_rounds,
                            'continue_count', v_row.continue_count);
end;
$$;

-- Agents hold in standby while the owner decides. The moderator still speaks:
-- that is how the standby notice and any continue assignment reach them.
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
  v_ob_intent text; v_ob_target text; v_ob_answered boolean;
  v_cleared boolean := false; v_new_status text; v_paused timestamptz;
begin
  -- FOR UPDATE, not FOR SHARE: share locks are mutually compatible, so two
  -- concurrent appends would both pass and collide on unique(session_id, seq).
  select status, round, max_messages, floor_holder, floor_granted_at, paused_at
    into v_status, v_rnd, v_max_msgs, v_floor, v_granted, v_paused
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

  -- The moderator still speaks while paused or in standby: that is the channel
  -- the owner's relay, the pause notice and the standby notice travel on.
  if v_paused is not null and p_role = 'agent' then
    return jsonb_build_object('ok', false, 'reason', 'paused', 'round', v_rnd);
  end if;
  if v_status = 'awaiting_owner' and p_role = 'agent' then
    return jsonb_build_object('ok', false, 'reason', 'awaiting_owner', 'round', v_rnd);
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

  -- Obligation discipline. Without these checks any agent could mark any
  -- question answered, including one owed by somebody else, and the caller was
  -- told the obligation cleared whether or not a row actually changed.
  if p_reply_to_seq is not null then
    select intent, addressed_to, answered
      into v_ob_intent, v_ob_target, v_ob_answered
      from council_messages where session_id = p_session_id and seq = p_reply_to_seq;
    if v_ob_intent is null then
      return jsonb_build_object('ok', false, 'reason', 'no_such_seq', 'round', v_rnd);
    end if;
    if p_intent in ('answer', 'concede') then
      if v_ob_intent not in ('challenge', 'ask') then
        return jsonb_build_object('ok', false, 'reason', 'not_an_obligation', 'round', v_rnd);
      end if;
      if v_ob_answered then
        return jsonb_build_object('ok', false, 'reason', 'already_answered', 'round', v_rnd);
      end if;
      if v_ob_target <> p_speaker and v_ob_target <> 'all' then
        return jsonb_build_object('ok', false, 'reason', 'not_addressed_to_you', 'round', v_rnd);
      end if;
    end if;
  end if;

  update council_sessions
     set last_seq = last_seq + 1,
         last_message_at = now(),
         -- A moderator post must NOT revoke a granted floor. The grant exists
         -- to unstick a silent round; an owner relay landing mid-grant would
         -- strand exactly the round it was meant to help.
         floor_holder = case when p_role = 'agent' then null else floor_holder end,
         floor_granted_at = case when p_role = 'agent' then null else floor_granted_at end,
         -- Only a real agent turn resets the stall counter. A moderator nudge
         -- resetting it would restart the escalation ladder that fired it.
         silent_grants = case when p_role = 'agent' then 0 else silent_grants end,
         -- The final permitted AGENT message ends the debate. Moderator posts
         -- are exempt from the cap (below) so relays cannot shorten a council,
         -- and so they must not trigger the transition either.
         status = case when p_role = 'agent' and last_seq + 1 >= v_max_msgs and status = 'open'
                       then 'concluding' else status end
   where id = p_session_id and (p_role <> 'agent' or last_seq < v_max_msgs)
  returning last_seq, status into v_seq, v_new_status;
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
     where session_id = p_session_id and seq = p_reply_to_seq and not answered;
    v_cleared := found;
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
       where id = p_session_id
      returning status into v_new_status;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'duplicate', false, 'seq', v_seq,
                            'round', v_rnd, 'advanced', v_advanced,
                            'cleared', v_cleared, 'status', v_new_status);
end;
$$;

-- ===== P5: guest seats =====
-- A credential that reaches one seat in one council and nothing else. The
-- remote-agent brief used to hand a collaborator MCP_API_KEY, which grants the
-- whole knowledge base, the vault and every council. Only the hash is stored,
-- so the table is not a second copy of the secret.

create table if not exists council_seat_keys (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references council_sessions(id) on delete cascade,
  seat_name text not null,
  token_hash text not null unique,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- First use, not last: the key stays valid for the council's life. "One-time"
  -- means one seat in one council, not one request.
  claimed_at timestamptz,
  revoked_at timestamptz,
  unique (session_id, seat_name)
);
create index if not exists idx_council_seat_keys_hash on council_seat_keys (token_hash);
alter table council_seat_keys enable row level security;

-- Runs on every authenticated call a guest makes, so it is one indexed point
-- read plus a claim stamp. Returns null for anything not currently usable;
-- the caller must not distinguish "wrong key" from "expired key" to a guest.
create or replace function resolve_council_seat_key(p_token_hash text)
returns jsonb language plpgsql as $$
declare v_row council_seat_keys; v_status text; v_code text;
begin
  select * into v_row from council_seat_keys where token_hash = p_token_hash;
  if v_row.id is null then return null; end if;
  if v_row.revoked_at is not null then return null; end if;
  if v_row.expires_at < now() then return null; end if;
  select status, code into v_status, v_code from council_sessions where id = v_row.session_id;
  if v_status is null or v_status = 'closed' then return null; end if;
  update council_seat_keys set claimed_at = coalesce(claimed_at, now()) where id = v_row.id;
  return jsonb_build_object('session_id', v_row.session_id, 'seat_name', v_row.seat_name,
                            'code', v_code);
end;
$$;

-- Re-issuing for the same seat replaces the old hash, so a key handed to the
-- wrong machine can be revoked by simply minting another.
create or replace function issue_council_seat_key(
  p_session_id uuid, p_seat_name text, p_token_hash text, p_expires_at timestamptz
) returns jsonb language plpgsql as $$
declare v_kind text;
begin
  select kind into v_kind from council_participants
   where session_id = p_session_id and name = p_seat_name;
  if v_kind is null then
    return jsonb_build_object('ok', false, 'reason', 'not_on_roster');
  end if;
  if v_kind <> 'agent' then
    return jsonb_build_object('ok', false, 'reason', 'not_an_agent_seat');
  end if;
  insert into council_seat_keys (session_id, seat_name, token_hash, expires_at)
  values (p_session_id, p_seat_name, p_token_hash, p_expires_at)
  on conflict (session_id, seat_name) do update
    set token_hash = excluded.token_hash,
        expires_at = excluded.expires_at,
        issued_at = now(),
        claimed_at = null,
        revoked_at = null;
  return jsonb_build_object('ok', true);
end;
$$;

-- ===== P6: verified merges =====
-- An agent saying "tests pass" is a claim, not evidence. The host owns the repo
-- and can check the commit itself, so agent-reported and host-observed
-- verification are stored separately and only the second one can close an item.

alter table council_work_items
  add column if not exists host_verified boolean,
  add column if not exists host_verification text,
  add column if not exists host_checked_at timestamptz,
  -- Paths the item was scoped to. Empty means unconstrained, which is what
  -- every item created before this wave is.
  add column if not exists declared_paths jsonb not null default '[]';

alter table council_campaigns
  add column if not exists integrator_agent text,
  add column if not exists integration_branch text,
  add column if not exists integration_status text
    check (integration_status in ('pending', 'running', 'verified', 'conflict', 'failed')),
  add column if not exists integration_report text,
  add column if not exists integration_checked_at timestamptz;

-- A failed host check returns the item to its owner rather than leaving it in
-- review, so the campaign cannot sit waiting on a human to reject something the
-- machine already disproved.
create or replace function record_host_verification(
  p_item_id uuid, p_passed boolean, p_report text
) returns boolean language plpgsql as $$
begin
  update council_work_items
     set host_verified = p_passed,
         host_verification = left(coalesce(p_report, ''), 8000),
         host_checked_at = now(),
         status = case when p_passed then status else 'queued' end,
         progress = case when p_passed then progress
                         else concat_ws(E'\n', progress, 'Host check failed: ' || left(coalesce(p_report, ''), 1000)) end
   where id = p_item_id and status = 'awaiting_review';
  return found;
end;
$$;

-- Return type changes from boolean to jsonb, so the old signature has to go
-- first: Postgres refuses to replace a function with a different return type.
drop function if exists review_council_work_item(uuid, text, boolean, text);
create or replace function review_council_work_item(
  p_item_id uuid, p_reviewer text, p_accepted boolean, p_note text
) returns jsonb language plpgsql as $$
declare v_campaign_id uuid; v_closer text; v_host boolean;
begin
  select c.id, s.closer_name, w.host_verified
    into v_campaign_id, v_closer, v_host
    from council_work_items w
    join council_campaigns c on c.id = w.campaign_id
    join council_sessions s on s.id = c.session_id
   where w.id = p_item_id for update;
  if v_campaign_id is null then return jsonb_build_object('ok', false, 'reason', 'no_such_item'); end if;
  if v_closer <> p_reviewer then return jsonb_build_object('ok', false, 'reason', 'not_the_closer'); end if;

  -- The whole point of the wave: acceptance requires evidence the host gathered
  -- itself, not the agent's account of its own work.
  if p_accepted and coalesce(v_host, false) is not true then
    return jsonb_build_object('ok', false, 'reason', 'not_host_verified');
  end if;

  if p_accepted then
    update council_work_items
       set status = 'verified',
           verification = concat_ws(E'\n', verification, 'Review: ' || p_note),
           reviewed_at = now()
     where id = p_item_id and status = 'awaiting_review';
  else
    update council_work_items
       set status = 'queued',
           progress = concat_ws(E'\n', progress, 'Review feedback: ' || p_note),
           heartbeat_at = null, completed_at = null,
           lease_owner = null, lease_expires_at = null,
           host_verified = null, host_verification = null, host_checked_at = null
     where id = p_item_id and status = 'awaiting_review';
  end if;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_awaiting_review'); end if;

  update council_campaigns set status = case
      when not exists (select 1 from council_work_items where campaign_id = v_campaign_id and status <> 'verified') then 'complete'
      when exists (select 1 from council_work_items where campaign_id = v_campaign_id and status = 'blocked')
       and not exists (select 1 from council_work_items where campaign_id = v_campaign_id and status in ('queued', 'in_progress', 'awaiting_review')) then 'blocked'
      else 'running' end,
    completed_at = case when not exists (select 1 from council_work_items where campaign_id = v_campaign_id and status <> 'verified') then now() else null end
  where id = v_campaign_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function set_campaign_integrator(p_session_id uuid, p_agent text)
returns jsonb language plpgsql as $$
declare v_campaign council_campaigns; v_kind text;
begin
  select * into v_campaign from council_campaigns where session_id = p_session_id for update;
  if v_campaign.id is null then return jsonb_build_object('ok', false, 'reason', 'no_campaign'); end if;
  if v_campaign.status <> 'complete' then
    return jsonb_build_object('ok', false, 'reason', 'campaign_incomplete', 'status', v_campaign.status);
  end if;
  select kind into v_kind from council_participants
   where session_id = p_session_id and name = p_agent and kind = 'agent';
  if v_kind is null then return jsonb_build_object('ok', false, 'reason', 'not_on_roster'); end if;
  update council_campaigns
     set integrator_agent = p_agent,
         integration_status = 'pending',
         integration_report = null,
         integration_checked_at = null
   where id = v_campaign.id;
  return jsonb_build_object('ok', true, 'campaign_id', v_campaign.id);
end;
$$;

create or replace function record_campaign_integration(
  p_session_id uuid, p_status text, p_branch text, p_report text
) returns jsonb language plpgsql as $$
declare v_campaign council_campaigns;
begin
  select * into v_campaign from council_campaigns where session_id = p_session_id for update;
  if v_campaign.id is null then return jsonb_build_object('ok', false, 'reason', 'no_campaign'); end if;
  if p_status not in ('pending', 'running', 'verified', 'conflict', 'failed') then
    return jsonb_build_object('ok', false, 'reason', 'bad_status');
  end if;
  update council_campaigns
     set integration_status = p_status,
         integration_branch = coalesce(p_branch, integration_branch),
         integration_report = left(coalesce(p_report, ''), 16000),
         integration_checked_at = now()
   where id = v_campaign.id;
  return jsonb_build_object('ok', true);
end;
$$;

-- ===== P7: mutation journal =====
-- Resume currently tells the model in prose not to redo completed work. This
-- makes it enforceable: a mutation is recorded BEFORE it runs, keyed to the
-- logical task rather than the attempt, so a resumed run recognises what
-- already happened instead of taking the model's word for it.

-- The logical task a run belongs to. A resumption carries its predecessor's
-- root, which is what makes the operation key stable across attempts.
alter table agent_runs add column if not exists root_run_id uuid;

create table if not exists agent_tool_calls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references agent_runs(id) on delete cascade,
  root_run_id uuid,
  operation_key text not null unique,
  tool text not null,
  effect text not null check (effect in ('read', 'write', 'external_send')),
  args_hash text not null,
  status text not null default 'proposed'
    check (status in ('proposed', 'started', 'succeeded', 'failed', 'outcome_unknown')),
  receipt jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists idx_agent_tool_calls_root on agent_tool_calls (root_run_id, tool);
alter table agent_tool_calls enable row level security;

-- Insert-or-report in one statement. The unique constraint on operation_key is
-- the mutex: two racing attempts cannot both believe they own the call.
create or replace function claim_tool_call(
  p_operation_key text, p_run_id uuid, p_root_run_id uuid,
  p_tool text, p_effect text, p_args_hash text
) returns jsonb language plpgsql as $$
declare v_row agent_tool_calls;
begin
  insert into agent_tool_calls (run_id, root_run_id, operation_key, tool, effect, args_hash, status)
  values (p_run_id, p_root_run_id, p_operation_key, p_tool, p_effect, p_args_hash, 'started')
  on conflict (operation_key) do nothing
  returning * into v_row;
  if v_row.id is not null then
    return jsonb_build_object('claimed', true, 'id', v_row.id);
  end if;
  select * into v_row from agent_tool_calls where operation_key = p_operation_key;
  return jsonb_build_object('claimed', false, 'id', v_row.id, 'status', v_row.status,
                            'receipt', v_row.receipt, 'effect', v_row.effect,
                            'age_seconds', floor(extract(epoch from (now() - v_row.created_at)))::integer);
end;
$$;

-- Lets a caller retake a claim it can prove is dead. Only ever used for 'write'
-- effects: an external send whose outcome is unknown must not be reissued on a
-- guess about how long it has been.
create or replace function retake_tool_call(p_id uuid, p_run_id uuid)
returns boolean language plpgsql as $$
begin
  update agent_tool_calls
     set status = 'started', run_id = p_run_id, created_at = now(), finished_at = null
   where id = p_id and status in ('started', 'failed') and effect = 'write';
  return found;
end;
$$;

create or replace function finish_tool_call(p_id uuid, p_status text, p_receipt jsonb)
returns boolean language plpgsql as $$
begin
  if p_status not in ('succeeded', 'failed', 'outcome_unknown') then return false; end if;
  update agent_tool_calls
     set status = p_status, receipt = p_receipt, finished_at = now()
   where id = p_id;
  return found;
end;
$$;

-- ===== Council V3 wave =====

alter table council_sessions
  add column if not exists protocol_version integer not null default 2,
  add column if not exists base_sha text;

alter table council_sessions drop constraint if exists council_sessions_protocol_version_check;
alter table council_sessions add constraint council_sessions_protocol_version_check
  check (protocol_version in (2, 3));

-- Host lease

create table if not exists council_host_leases (
  session_id uuid primary key references council_sessions(id) on delete cascade,
  host_id uuid not null,
  lease_epoch bigint not null check (lease_epoch > 0),
  lease_expires_at timestamptz not null,
  last_heartbeat_at timestamptz not null,
  claimed_at timestamptz not null,
  released_at timestamptz
);
alter table council_host_leases enable row level security;

create or replace function claim_council_host_lease(
  p_session_id uuid, p_host_id uuid, p_duration_seconds integer default 45
) returns jsonb language plpgsql as $$
declare v_session council_sessions; v_lease council_host_leases; v_duration integer;
begin
  v_duration := greatest(15, least(coalesce(p_duration_seconds, 45), 300));
  select * into v_session from council_sessions where id = p_session_id for update;
  if v_session.id is null then return jsonb_build_object('ok', false, 'reason', 'no_session'); end if;
  if v_session.protocol_version <> 3 then return jsonb_build_object('ok', false, 'reason', 'not_v3'); end if;
  if v_session.status = 'expired' then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;

  select * into v_lease from council_host_leases where session_id = p_session_id for update;
  if v_lease.session_id is null then
    insert into council_host_leases (
      session_id, host_id, lease_epoch, lease_expires_at, last_heartbeat_at, claimed_at
    ) values (
      p_session_id, p_host_id, 1, now() + make_interval(secs => v_duration), now(), now()
    ) returning * into v_lease;
  elsif v_lease.host_id = p_host_id and v_lease.released_at is null
        and v_lease.lease_expires_at > now() then
    update council_host_leases
       set lease_expires_at = now() + make_interval(secs => v_duration),
           last_heartbeat_at = now()
     where session_id = p_session_id returning * into v_lease;
  elsif v_lease.released_at is not null or v_lease.lease_expires_at <= now() then
    update council_host_leases
       set host_id = p_host_id,
           lease_epoch = lease_epoch + 1,
           lease_expires_at = now() + make_interval(secs => v_duration),
           last_heartbeat_at = now(),
           claimed_at = now(),
           released_at = null
     where session_id = p_session_id returning * into v_lease;
  else
    return jsonb_build_object(
      'ok', false, 'reason', 'lease_held', 'leaseExpiresAt', v_lease.lease_expires_at
    );
  end if;
  return jsonb_build_object(
    'ok', true, 'hostId', v_lease.host_id, 'leaseEpoch', v_lease.lease_epoch,
    'leaseExpiresAt', v_lease.lease_expires_at
  );
end;
$$;

create or replace function renew_council_host_lease(
  p_session_id uuid, p_host_id uuid, p_lease_epoch bigint,
  p_duration_seconds integer default 45
) returns jsonb language plpgsql as $$
declare v_lease council_host_leases; v_duration integer;
begin
  v_duration := greatest(15, least(coalesce(p_duration_seconds, 45), 300));
  select * into v_lease from council_host_leases where session_id = p_session_id for update;
  if v_lease.session_id is null then return jsonb_build_object('ok', false, 'reason', 'no_lease'); end if;
  if v_lease.host_id <> p_host_id or v_lease.lease_epoch <> p_lease_epoch then
    return jsonb_build_object('ok', false, 'reason', 'stale_epoch');
  end if;
  if v_lease.released_at is not null or v_lease.lease_expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'lease_expired');
  end if;
  update council_host_leases
     set lease_expires_at = now() + make_interval(secs => v_duration),
         last_heartbeat_at = now()
   where session_id = p_session_id returning * into v_lease;
  return jsonb_build_object(
    'ok', true, 'hostId', v_lease.host_id, 'leaseEpoch', v_lease.lease_epoch,
    'leaseExpiresAt', v_lease.lease_expires_at
  );
end;
$$;

create or replace function release_council_host_lease(
  p_session_id uuid, p_host_id uuid, p_lease_epoch bigint
) returns boolean language plpgsql as $$
begin
  update council_host_leases
     set released_at = now(), lease_expires_at = least(lease_expires_at, now())
   where session_id = p_session_id and host_id = p_host_id
     and lease_epoch = p_lease_epoch and released_at is null;
  return found;
end;
$$;

-- Seat identity

alter table council_seat_keys
  add column if not exists issued_by text not null default 'owner',
  add column if not exists host_id uuid,
  add column if not exists lease_epoch bigint;

create or replace function resolve_council_seat_key(p_token_hash text)
returns jsonb language plpgsql as $$
declare v_row council_seat_keys; v_status text; v_code text;
begin
  select * into v_row from council_seat_keys where token_hash = p_token_hash;
  if v_row.id is null or v_row.revoked_at is not null or v_row.expires_at < now() then return null; end if;
  select status, code into v_status, v_code from council_sessions where id = v_row.session_id;
  if v_status is null or v_status = 'expired' then return null; end if;
  if v_row.issued_by = 'host' and not exists (
    select 1 from council_host_leases where session_id = v_row.session_id
      and host_id = v_row.host_id and lease_epoch = v_row.lease_epoch
      and released_at is null and lease_expires_at > now()
  ) then return null; end if;
  update council_seat_keys set claimed_at = coalesce(claimed_at, now()) where id = v_row.id;
  return jsonb_build_object('session_id', v_row.session_id, 'seat_name', v_row.seat_name,
                            'code', v_code, 'issuer', v_row.issued_by);
end;
$$;

create or replace function issue_council_seat_key(
  p_session_id uuid, p_seat_name text, p_token_hash text, p_expires_at timestamptz
) returns jsonb language plpgsql as $$
declare v_kind text;
begin
  select kind into v_kind from council_participants
   where session_id = p_session_id and name = p_seat_name;
  if v_kind is null then return jsonb_build_object('ok', false, 'reason', 'not_on_roster'); end if;
  if v_kind <> 'agent' then return jsonb_build_object('ok', false, 'reason', 'not_an_agent_seat'); end if;
  insert into council_seat_keys (
    session_id, seat_name, token_hash, expires_at, issued_by, host_id, lease_epoch
  ) values (
    p_session_id, p_seat_name, p_token_hash, p_expires_at, 'owner', null, null
  ) on conflict (session_id, seat_name) do update
    set token_hash = excluded.token_hash, expires_at = excluded.expires_at,
        issued_at = now(), claimed_at = null, revoked_at = null,
        issued_by = 'owner', host_id = null, lease_epoch = null;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function issue_council_host_seat_key(
  p_session_id uuid, p_seat_name text, p_token_hash text,
  p_expires_at timestamptz, p_host_id uuid, p_lease_epoch bigint
) returns jsonb language plpgsql as $$
declare v_kind text; v_lease council_host_leases;
begin
  select * into v_lease from council_host_leases where session_id = p_session_id for update;
  if v_lease.session_id is null or v_lease.host_id <> p_host_id
     or v_lease.lease_epoch <> p_lease_epoch or v_lease.released_at is not null
     or v_lease.lease_expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'stale_host');
  end if;
  select kind into v_kind from council_participants
   where session_id = p_session_id and name = p_seat_name;
  if v_kind is null then return jsonb_build_object('ok', false, 'reason', 'not_on_roster'); end if;
  if v_kind <> 'agent' then return jsonb_build_object('ok', false, 'reason', 'not_an_agent_seat'); end if;

  insert into council_seat_keys (
    session_id, seat_name, token_hash, expires_at, issued_by, host_id, lease_epoch
  ) values (
    p_session_id, p_seat_name, p_token_hash, p_expires_at, 'host', p_host_id, p_lease_epoch
  )
  on conflict (session_id, seat_name) do update
    set token_hash = excluded.token_hash,
        expires_at = excluded.expires_at,
        issued_at = now(), claimed_at = null, revoked_at = null,
        issued_by = 'host', host_id = excluded.host_id, lease_epoch = excluded.lease_epoch;
  return jsonb_build_object('ok', true);
end;
$$;

-- Durable delivery

create table if not exists council_deliveries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references council_sessions(id) on delete cascade,
  participant_id uuid not null references council_participants(id) on delete cascade,
  host_id uuid not null,
  lease_epoch bigint not null,
  from_seq integer not null check (from_seq >= 0),
  through_seq integer not null check (through_seq >= from_seq),
  prompt_hash text not null,
  prompt_body text not null,
  status text not null check (status in ('prepared', 'in_flight', 'acknowledged', 'failed')),
  attempt integer not null default 1 check (attempt > 0),
  prepared_at timestamptz not null default now(),
  sent_at timestamptz,
  acknowledged_at timestamptz,
  failed_at timestamptz,
  error text
);
alter table council_deliveries drop constraint if exists council_deliveries_session_id_participant_id_through_seq_prompt_hash_key;
create unique index if not exists idx_council_deliveries_active_identity
  on council_deliveries (session_id, participant_id, through_seq, prompt_hash)
  where status in ('prepared', 'in_flight', 'failed');
create index if not exists idx_council_deliveries_pending
  on council_deliveries (session_id, participant_id, prepared_at)
  where status in ('prepared', 'in_flight', 'failed');
alter table council_deliveries enable row level security;

create or replace function prepare_council_delivery(
  p_session_id uuid, p_agent_name text, p_host_id uuid, p_lease_epoch bigint,
  p_from_seq integer, p_through_seq integer, p_prompt_hash text, p_prompt_body text
) returns jsonb language plpgsql as $$
declare v_lease council_host_leases; v_participant council_participants;
        v_delivery council_deliveries; v_redelivered boolean := false;
begin
  select * into v_lease from council_host_leases where session_id = p_session_id for update;
  if v_lease.session_id is null or v_lease.host_id <> p_host_id
     or v_lease.lease_epoch <> p_lease_epoch or v_lease.released_at is not null
     or v_lease.lease_expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'stale_host');
  end if;
  select * into v_participant from council_participants
   where session_id = p_session_id and name = p_agent_name for update;
  if v_participant.id is null then return jsonb_build_object('ok', false, 'reason', 'not_participant'); end if;
  if v_participant.dispatch_mode is not true then
    return jsonb_build_object('ok', false, 'reason', 'not_host_managed');
  end if;

  select * into v_delivery from council_deliveries
   where session_id = p_session_id and participant_id = v_participant.id
     and status in ('prepared', 'in_flight', 'failed')
   order by prepared_at limit 1 for update;

  if v_delivery.id is not null then
    v_redelivered := v_delivery.host_id <> p_host_id
      or v_delivery.lease_epoch <> p_lease_epoch
      or v_delivery.status in ('in_flight', 'failed');
    if v_delivery.host_id <> p_host_id or v_delivery.lease_epoch <> p_lease_epoch
       or v_delivery.status = 'failed' then
      update council_deliveries
         set host_id = p_host_id, lease_epoch = p_lease_epoch,
             status = 'prepared', attempt = attempt + 1,
             prepared_at = now(), sent_at = null, failed_at = null, error = null
       where id = v_delivery.id returning * into v_delivery;
    end if;
  else
    if p_through_seq < p_from_seq then
      return jsonb_build_object('ok', false, 'reason', 'bad_range');
    end if;
    insert into council_deliveries (
      session_id, participant_id, host_id, lease_epoch, from_seq, through_seq,
      prompt_hash, prompt_body, status
    ) values (
      p_session_id, v_participant.id, p_host_id, p_lease_epoch,
      greatest(v_participant.cursor_seq, p_from_seq), p_through_seq,
      p_prompt_hash, p_prompt_body, 'prepared'
    ) returning * into v_delivery;
  end if;

  return jsonb_build_object('ok', true, 'delivery', jsonb_build_object(
    'id', v_delivery.id, 'participant_id', v_delivery.participant_id,
    'from_seq', v_delivery.from_seq, 'through_seq', v_delivery.through_seq,
    'prompt_hash', v_delivery.prompt_hash, 'prompt_body', v_delivery.prompt_body,
    'status', v_delivery.status, 'attempt', v_delivery.attempt,
    'redelivered', v_redelivered
  ));
end;
$$;

create or replace function mark_council_delivery_in_flight(
  p_delivery_id uuid, p_host_id uuid, p_lease_epoch bigint
) returns boolean language plpgsql as $$
begin
  update council_deliveries d set status = 'in_flight', sent_at = coalesce(sent_at, now())
   where d.id = p_delivery_id and d.host_id = p_host_id and d.lease_epoch = p_lease_epoch
     and d.status in ('prepared', 'in_flight')
     and exists (
       select 1 from council_host_leases l where l.session_id = d.session_id
        and l.host_id = p_host_id and l.lease_epoch = p_lease_epoch
        and l.released_at is null and l.lease_expires_at > now()
     );
  return found;
end;
$$;

create or replace function fail_council_delivery(
  p_delivery_id uuid, p_host_id uuid, p_lease_epoch bigint, p_error text
) returns boolean language plpgsql as $$
begin
  update council_deliveries d
     set status = 'failed', failed_at = now(), error = left(coalesce(p_error, ''), 2000)
   where d.id = p_delivery_id and d.host_id = p_host_id and d.lease_epoch = p_lease_epoch
     and d.status in ('prepared', 'in_flight')
     and exists (
       select 1 from council_host_leases l where l.session_id = d.session_id
        and l.host_id = p_host_id and l.lease_epoch = p_lease_epoch
        and l.released_at is null and l.lease_expires_at > now()
     );
  return found;
end;
$$;

create or replace function ack_council_delivery(
  p_delivery_id uuid, p_host_id uuid, p_lease_epoch bigint
) returns jsonb language plpgsql as $$
declare v_delivery council_deliveries;
begin
  select * into v_delivery from council_deliveries where id = p_delivery_id for update;
  if v_delivery.id is null then return jsonb_build_object('ok', false, 'reason', 'no_delivery'); end if;
  if v_delivery.host_id <> p_host_id or v_delivery.lease_epoch <> p_lease_epoch then
    return jsonb_build_object('ok', false, 'reason', 'stale_epoch');
  end if;
  if v_delivery.status = 'acknowledged' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'throughSeq', v_delivery.through_seq);
  end if;
  if not exists (
    select 1 from council_host_leases l where l.session_id = v_delivery.session_id
      and l.host_id = p_host_id and l.lease_epoch = p_lease_epoch
      and l.released_at is null and l.lease_expires_at > now()
  ) then return jsonb_build_object('ok', false, 'reason', 'stale_host'); end if;
  if v_delivery.status <> 'in_flight' then
    return jsonb_build_object('ok', false, 'reason', 'not_in_flight');
  end if;

  update council_participants
     set cursor_seq = greatest(cursor_seq, v_delivery.through_seq),
         pending_ack_seq = greatest(pending_ack_seq, v_delivery.through_seq),
         last_seen_at = now()
   where id = v_delivery.participant_id;
  update council_deliveries
     set status = 'acknowledged', acknowledged_at = now(), error = null
   where id = v_delivery.id;
  return jsonb_build_object('ok', true, 'throughSeq', v_delivery.through_seq);
end;
$$;

-- Execution evidence

create table if not exists council_agent_executions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references council_sessions(id) on delete cascade,
  participant_id uuid not null references council_participants(id) on delete cascade,
  host_id uuid not null,
  lease_epoch bigint not null,
  host_generation text not null,
  connector_kind text not null check (connector_kind in (
    'acp', 'mcp', 'managed_api', 'managed_cli', 'text_only', 'manual'
  )),
  connector_capabilities jsonb not null default '{}',
  capability_source text not null check (capability_source in ('probed', 'configured', 'declared')),
  identity_assurance text not null check (identity_assurance in (
    'verified_seat', 'host_bound', 'owner_relay', 'unverified_declaration'
  )),
  provider text,
  adapter_version text,
  requested_model text,
  effective_model text,
  requested_reasoning_effort text,
  effective_reasoning_effort text,
  model_source text,
  branch_name text,
  worktree_path text,
  base_sha text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  stop_reason text,
  predecessor_execution_id uuid references council_agent_executions(id)
);
create index if not exists idx_council_agent_executions_participant
  on council_agent_executions (participant_id, started_at desc);
alter table council_agent_executions enable row level security;

create or replace function start_council_agent_execution(
  p_session_id uuid, p_agent_name text, p_host_id uuid, p_lease_epoch bigint,
  p_host_generation text, p_connector_kind text, p_connector_capabilities jsonb,
  p_capability_source text, p_identity_assurance text, p_provider text,
  p_adapter_version text, p_requested_model text, p_effective_model text,
  p_requested_reasoning_effort text, p_effective_reasoning_effort text,
  p_model_source text, p_branch_name text, p_worktree_path text, p_base_sha text
) returns jsonb language plpgsql as $$
declare v_participant uuid; v_previous uuid; v_id uuid;
begin
  if not exists (
    select 1 from council_host_leases where session_id = p_session_id
      and host_id = p_host_id and lease_epoch = p_lease_epoch
      and released_at is null and lease_expires_at > now()
  ) then return jsonb_build_object('ok', false, 'reason', 'stale_host'); end if;
  select id into v_participant from council_participants
   where session_id = p_session_id and name = p_agent_name and kind = 'agent';
  if v_participant is null then return jsonb_build_object('ok', false, 'reason', 'not_on_roster'); end if;
  select id into v_previous from council_agent_executions
   where participant_id = v_participant order by started_at desc limit 1;
  update council_agent_executions
     set ended_at = coalesce(ended_at, now()), stop_reason = coalesce(stop_reason, 'replaced')
   where participant_id = v_participant and ended_at is null;
  insert into council_agent_executions (
    session_id, participant_id, host_id, lease_epoch, host_generation,
    connector_kind, connector_capabilities, capability_source, identity_assurance,
    provider, adapter_version, requested_model, effective_model,
    requested_reasoning_effort, effective_reasoning_effort, model_source,
    branch_name, worktree_path, base_sha, predecessor_execution_id
  ) values (
    p_session_id, v_participant, p_host_id, p_lease_epoch, p_host_generation,
    p_connector_kind, coalesce(p_connector_capabilities, '{}'), p_capability_source,
    p_identity_assurance, p_provider, p_adapter_version, p_requested_model,
    p_effective_model, p_requested_reasoning_effort, p_effective_reasoning_effort,
    p_model_source, p_branch_name, p_worktree_path, p_base_sha, v_previous
  ) returning id into v_id;
  return jsonb_build_object('ok', true, 'executionId', v_id);
end;
$$;

create or replace function stop_council_agent_execution(
  p_execution_id uuid, p_host_id uuid, p_lease_epoch bigint, p_stop_reason text
) returns boolean language plpgsql as $$
begin
  update council_agent_executions e
     set ended_at = coalesce(ended_at, now()), stop_reason = coalesce(stop_reason, left(p_stop_reason, 500))
   where e.id = p_execution_id and e.host_id = p_host_id and e.lease_epoch = p_lease_epoch
     and exists (select 1 from council_host_leases l where l.session_id = e.session_id
       and l.host_id = p_host_id and l.lease_epoch = p_lease_epoch
       and l.released_at is null and l.lease_expires_at > now());
  return found;
end;
$$;

-- Exact commit and integration

alter table council_campaigns
  add column if not exists base_sha text,
  add column if not exists verification_profile text not null default 'standard',
  add column if not exists integration_manifest jsonb,
  add column if not exists manifest_frozen_at timestamptz,
  add column if not exists integration_tip_sha text;

alter table council_work_items
  add column if not exists branch_name text,
  add column if not exists accepted_commit_sha text,
  add column if not exists verification_profile text not null default 'standard',
  add column if not exists verification_run_id uuid,
  add column if not exists dependencies jsonb not null default '[]';

create or replace function create_council_campaign(
  p_session_id uuid, p_created_by text, p_work_items jsonb
) returns jsonb language plpgsql as $$
declare v_session council_sessions; v_campaign council_campaigns; v_reason text;
begin
  select * into v_session from council_sessions where id = p_session_id for update;
  if v_session.id is null then raise exception 'council session not found'; end if;
  if v_session.status <> 'closed' then raise exception 'council must be closed before work begins'; end if;
  select * into v_campaign from council_campaigns where session_id = p_session_id;
  if v_campaign.id is not null then return jsonb_build_object('campaign_id', v_campaign.id, 'created', false); end if;
  v_reason := validate_council_work_items(p_session_id, p_created_by, p_work_items);
  if v_reason is not null then raise exception '%', v_reason; end if;
  if v_session.protocol_version = 3 and v_session.base_sha is null then
    raise exception 'Council V3 code campaigns require a frozen base commit';
  end if;
  insert into council_campaigns (
    session_id, repo_path, base_branch, base_sha, verification_profile
  ) values (
    p_session_id, v_session.repo_path, v_session.base_branch, v_session.base_sha, 'standard'
  ) returning * into v_campaign;
  insert into council_work_items (
    campaign_id, sequence, agent_name, title, instructions, acceptance_criteria,
    declared_paths, verification_profile, dependencies
  )
  select v_campaign.id, row_number() over (), item->>'agent_name', item->>'title',
         item->>'instructions', coalesce(item->'acceptance_criteria', '[]'::jsonb),
         coalesce(item->'declared_paths', '[]'::jsonb),
         coalesce(nullif(item->>'verification_profile', ''), 'standard'),
         coalesce(item->'dependencies', '[]'::jsonb)
    from jsonb_array_elements(p_work_items) item;
  return jsonb_build_object('campaign_id', v_campaign.id, 'created', true);
end;
$$;

create table if not exists council_verification_runs (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references council_work_items(id) on delete cascade,
  host_id uuid not null,
  lease_epoch bigint not null,
  commit_sha text not null,
  base_sha text not null,
  branch_name text not null,
  profile_id text not null,
  command_receipts jsonb not null default '[]',
  output_digest text not null,
  passed boolean not null,
  report text not null,
  checked_at timestamptz not null default now()
);
create index if not exists idx_council_verification_runs_item
  on council_verification_runs (work_item_id, checked_at desc);
alter table council_verification_runs enable row level security;

-- The abandonment ceiling counts rework, not claims. attempts increments every
-- time an item is picked up, including after a lapsed lease, so it charged the
-- item for the host being slow; rejections only moves when a host check fails
-- or the closer sends work back.
alter table council_work_items
  add column if not exists rejections integer not null default 0;

create or replace function record_council_verification(
  p_item_id uuid, p_host_id uuid, p_lease_epoch bigint, p_commit_sha text,
  p_base_sha text, p_branch_name text, p_profile_id text,
  p_command_receipts jsonb, p_output_digest text, p_passed boolean, p_report text
) returns jsonb language plpgsql as $$
declare v_item council_work_items; v_campaign council_campaigns; v_session_id uuid; v_run uuid;
begin
  select * into v_item from council_work_items where id = p_item_id for update;
  if v_item.id is null then return jsonb_build_object('ok', false, 'reason', 'no_item'); end if;
  select * into v_campaign from council_campaigns where id = v_item.campaign_id;
  v_session_id := v_campaign.session_id;
  if not exists (
    select 1 from council_host_leases where session_id = v_session_id
      and host_id = p_host_id and lease_epoch = p_lease_epoch
      and released_at is null and lease_expires_at > now()
  ) then return jsonb_build_object('ok', false, 'reason', 'stale_host'); end if;
  if v_item.status <> 'awaiting_review' then
    return jsonb_build_object('ok', false, 'reason', 'not_awaiting_review');
  end if;
  if v_item.commit_hash is distinct from p_commit_sha then
    return jsonb_build_object('ok', false, 'reason', 'commit_mismatch');
  end if;
  if v_campaign.base_sha is distinct from p_base_sha then
    return jsonb_build_object('ok', false, 'reason', 'base_mismatch');
  end if;
  insert into council_verification_runs (
    work_item_id, host_id, lease_epoch, commit_sha, base_sha, branch_name,
    profile_id, command_receipts, output_digest, passed, report
  ) values (
    p_item_id, p_host_id, p_lease_epoch, p_commit_sha, p_base_sha, p_branch_name,
    p_profile_id, coalesce(p_command_receipts, '[]'), p_output_digest, p_passed,
    left(coalesce(p_report, ''), 16000)
  ) returning id into v_run;
  update council_work_items
     set host_verified = p_passed,
         host_verification = left(coalesce(p_report, ''), 16000),
         host_checked_at = now(), verification_run_id = v_run,
         branch_name = p_branch_name, verification_profile = p_profile_id,
         rejections = case when p_passed then rejections else rejections + 1 end,
         status = case
           when p_passed then status
           when rejections + 1 >= max_attempts then 'blocked'
           else 'queued' end,
         blocked_reason = case
           when not p_passed and rejections + 1 >= max_attempts
             then 'host check failed ' || (rejections + 1) || ' time(s); needs a human'
           else blocked_reason end,
         progress = case when p_passed then progress else concat_ws(E'\n', progress,
           'Host check failed: ' || left(coalesce(p_report, ''), 1000)) end
   where id = p_item_id;
  -- Matches what block_council_work_item does on the cooperative path: an item
  -- blocked here can be the last live one.
  update council_campaigns set status = 'blocked'
   where id = v_campaign.id
     and not exists (select 1 from council_work_items
                      where campaign_id = v_campaign.id
                        and status in ('queued', 'in_progress', 'awaiting_review'));
  return jsonb_build_object('ok', true, 'verificationRunId', v_run, 'passed', p_passed);
end;
$$;

create or replace function freeze_council_integration_manifest(
  p_session_id uuid, p_host_id uuid, p_lease_epoch bigint
) returns jsonb language plpgsql as $$
declare v_campaign council_campaigns; v_manifest jsonb;
begin
  select * into v_campaign from council_campaigns where session_id = p_session_id for update;
  if v_campaign.id is null then return jsonb_build_object('ok', false, 'reason', 'no_campaign'); end if;
  if not exists (
    select 1 from council_host_leases where session_id = p_session_id
      and host_id = p_host_id and lease_epoch = p_lease_epoch
      and released_at is null and lease_expires_at > now()
  ) then return jsonb_build_object('ok', false, 'reason', 'stale_host'); end if;
  if v_campaign.integration_manifest is not null then
    return jsonb_build_object('ok', true, 'manifest', v_campaign.integration_manifest, 'frozen', true);
  end if;
  if v_campaign.status <> 'complete' or exists (
    select 1 from council_work_items where campaign_id = v_campaign.id
      and (status <> 'verified' or accepted_commit_sha is null)
  ) then return jsonb_build_object('ok', false, 'reason', 'campaign_incomplete'); end if;
  select jsonb_build_object(
    'version', 1, 'campaignId', v_campaign.id, 'baseSha', v_campaign.base_sha,
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'itemId', id, 'sequence', sequence, 'agentName', agent_name,
      'branch', branch_name, 'commitSha', accepted_commit_sha,
      'verificationRunId', verification_run_id, 'dependencies', dependencies
    ) order by sequence), '[]'::jsonb)
  ) into v_manifest from council_work_items where campaign_id = v_campaign.id;
  update council_campaigns
     set integration_manifest = v_manifest, manifest_frozen_at = now(),
         integration_status = coalesce(integration_status, 'pending')
   where id = v_campaign.id;
  return jsonb_build_object('ok', true, 'manifest', v_manifest, 'frozen', false);
end;
$$;

drop function if exists review_council_work_item(uuid, text, boolean, text);
create or replace function review_council_work_item(
  p_item_id uuid, p_reviewer text, p_accepted boolean, p_note text
) returns jsonb language plpgsql as $$
declare v_item council_work_items; v_campaign council_campaigns;
        v_closer text; v_run council_verification_runs;
begin
  select * into v_item from council_work_items where id = p_item_id for update;
  if v_item.id is null then return jsonb_build_object('ok', false, 'reason', 'no_such_item'); end if;
  select * into v_campaign from council_campaigns where id = v_item.campaign_id;
  select closer_name into v_closer from council_sessions where id = v_campaign.session_id;
  if v_closer <> p_reviewer then return jsonb_build_object('ok', false, 'reason', 'not_the_closer'); end if;
  if v_item.status <> 'awaiting_review' then
    return jsonb_build_object('ok', false, 'reason', 'not_awaiting_review');
  end if;
  if p_accepted then
    select * into v_run from council_verification_runs where id = v_item.verification_run_id;
    if v_run.id is null or v_run.passed is not true
       or v_run.commit_sha is distinct from v_item.commit_hash
       or v_run.base_sha is distinct from v_campaign.base_sha
       or v_run.profile_id is distinct from v_item.verification_profile then
      return jsonb_build_object('ok', false, 'reason', 'not_exactly_verified');
    end if;
    update council_work_items
       set status = 'verified', accepted_commit_sha = commit_hash,
           verification = concat_ws(E'\n', verification, 'Review: ' || p_note), reviewed_at = now()
     where id = p_item_id;
  else
    update council_work_items
       set rejections = rejections + 1,
           status = case when rejections + 1 >= max_attempts then 'blocked' else 'queued' end,
           blocked_reason = case when rejections + 1 >= max_attempts
             then 'sent back ' || (rejections + 1) || ' time(s); needs a human'
             else blocked_reason end,
           progress = concat_ws(E'\n', progress, 'Review feedback: ' || p_note),
           heartbeat_at = null, completed_at = null, lease_owner = null, lease_expires_at = null,
           host_verified = null, host_verification = null, host_checked_at = null,
           verification_run_id = null, accepted_commit_sha = null
     where id = p_item_id;
  end if;
  update council_campaigns set status = case
      when not exists (select 1 from council_work_items where campaign_id = v_campaign.id and status <> 'verified') then 'complete'
      when exists (select 1 from council_work_items where campaign_id = v_campaign.id and status = 'blocked')
       and not exists (select 1 from council_work_items where campaign_id = v_campaign.id and status in ('queued', 'in_progress', 'awaiting_review')) then 'blocked'
      else 'running' end,
    completed_at = case when not exists (
      select 1 from council_work_items where campaign_id = v_campaign.id and status <> 'verified'
    ) then now() else null end
  where id = v_campaign.id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function record_council_integration_v3(
  p_session_id uuid, p_reporter text, p_host_id uuid, p_lease_epoch bigint,
  p_status text, p_branch text, p_tip_sha text, p_report text
) returns jsonb language plpgsql as $$
declare v_campaign council_campaigns; v_host_ok boolean;
begin
  select * into v_campaign from council_campaigns where session_id = p_session_id for update;
  if v_campaign.id is null then return jsonb_build_object('ok', false, 'reason', 'no_campaign'); end if;
  if p_status not in ('pending', 'running', 'verified', 'conflict', 'failed') then
    return jsonb_build_object('ok', false, 'reason', 'bad_status');
  end if;
  select exists (
    select 1 from council_host_leases where session_id = p_session_id
      and host_id = p_host_id and lease_epoch = p_lease_epoch
      and released_at is null and lease_expires_at > now()
  ) into v_host_ok;
  if not v_host_ok then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  if v_campaign.integration_manifest is null then
    return jsonb_build_object('ok', false, 'reason', 'manifest_not_frozen');
  end if;
  update council_campaigns
     set integration_status = p_status,
         integration_branch = coalesce(p_branch, integration_branch),
         integration_tip_sha = coalesce(p_tip_sha, integration_tip_sha),
         integration_report = left(coalesce(p_report, ''), 16000),
         integration_checked_at = now()
   where id = v_campaign.id;
  return jsonb_build_object('ok', true);
end;
$$;

-- ===== Council V3 cleanup =====
-- Both were superseded by the V3 exact-commit contract and have no callers.
-- record_host_verification is the dangerous one: it still sets host_verified,
-- so it reads like it authorises acceptance, but review_council_work_item now
-- requires a matching council_verification_runs row and ignores that flag.

drop function if exists record_host_verification(uuid, boolean, text);
drop function if exists record_campaign_integration(uuid, text, text, text);

-- ===== Council V3.5 wave: agent clients and issued credentials =====
-- One row per agent installation, which is the unit the owner revokes. Keys
-- hang off it, so revoking a client revokes everything it holds.

create table if not exists agent_clients (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  kind text not null default 'remote_agent'
    check (kind in ('local_host', 'remote_agent', 'owner_tool')),
  provider_hint text,
  note text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create unique index if not exists agent_clients_live_name
  on agent_clients (lower(display_name)) where revoked_at is null;

-- Only the hash is ever stored. Plaintext is returned once at mint time and is
-- not recoverable; re-issuing replaces the row, which is also how a mis-sent
-- credential is retired.
create table if not exists agent_client_keys (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references agent_clients(id) on delete cascade,
  token_hash text not null unique,
  key_prefix text not null,
  scopes text[] not null,
  purpose text not null check (purpose in ('knowledge', 'council_seat')),
  access_level text check (access_level in ('read', 'notes', 'full', 'council')),
  session_id uuid references council_sessions(id) on delete cascade,
  seat_name text,
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  claimed_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);

create unique index if not exists agent_client_keys_one_live_knowledge
  on agent_client_keys (client_id)
  where purpose = 'knowledge' and revoked_at is null;

create unique index if not exists agent_client_keys_one_live_seat
  on agent_client_keys (client_id, session_id, seat_name)
  where purpose = 'council_seat' and revoked_at is null;

create index if not exists agent_client_keys_client on agent_client_keys (client_id);

-- A seat key issued for a known agent is attributable across councils. Keys
-- issued for a one-off guest leave this null and behave exactly as before.
alter table council_seat_keys add column if not exists client_id uuid
  references agent_clients(id) on delete set null;

-- The knowledge brief carries a claim, never the durable key: a knowledge key
-- is permanent, and a brief is a document whose purpose is to be pasted around.
create table if not exists agent_client_claims (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references agent_clients(id) on delete cascade,
  claim_hash text not null unique,
  scopes text[] not null,
  access_level text not null check (access_level in ('read', 'notes', 'full', 'council')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  issued_key_id uuid references agent_client_keys(id) on delete set null,
  revoked_at timestamptz
);

create index if not exists agent_client_claims_client on agent_client_claims (client_id);

-- 'council' is opt-in convene authority for one named client, added after the
-- tables above already existed. The inline checks cover a fresh install; these
-- replace the constraint on one that is already deployed.
alter table agent_client_keys drop constraint if exists agent_client_keys_access_level_check;
alter table agent_client_keys add constraint agent_client_keys_access_level_check
  check (access_level in ('read', 'notes', 'full', 'council'));

alter table agent_client_claims drop constraint if exists agent_client_claims_access_level_check;
alter table agent_client_claims add constraint agent_client_claims_access_level_check
  check (access_level in ('read', 'notes', 'full', 'council'));

-- /api/agent/claim is the only unauthenticated write surface, and the app is
-- serverless, so an in-process counter would reset per cold start and give an
-- attacker a fresh allowance each time. The counter has to live here.
create table if not exists agent_claim_attempts (
  id bigserial primary key,
  ip_hash text not null,
  succeeded boolean not null default false,
  at timestamptz not null default now()
);

create index if not exists agent_claim_attempts_ip on agent_claim_attempts (ip_hash, at desc);
create index if not exists agent_claim_attempts_at on agent_claim_attempts (at desc);

create or replace function resolve_agent_client_key(p_token_hash text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_key agent_client_keys%rowtype;
  v_client agent_clients%rowtype;
begin
  select * into v_key from agent_client_keys where token_hash = p_token_hash;
  if not found or v_key.revoked_at is not null then return null; end if;
  if v_key.expires_at is not null and v_key.expires_at <= now() then return null; end if;

  select * into v_client from agent_clients where id = v_key.client_id;
  if not found or v_client.revoked_at is not null then return null; end if;

  -- Throttled so an agent in a tool loop does not write on every call.
  if v_key.last_used_at is null or v_key.last_used_at < now() - interval '60 seconds' then
    update agent_client_keys set last_used_at = now() where id = v_key.id;
    update agent_clients set last_seen_at = now() where id = v_client.id;
  end if;

  return jsonb_build_object(
    'client_id', v_client.id,
    'display_name', v_client.display_name,
    'key_id', v_key.id,
    'purpose', v_key.purpose,
    'scopes', to_jsonb(v_key.scopes),
    'session_id', v_key.session_id,
    'seat_name', v_key.seat_name
  );
end;
$$;

-- Idempotent within the claim's TTL. The caller derives the key deterministically
-- from the claim plaintext, so a retry recomputes the same token and lands on the
-- same hash; that is what lets this be idempotent without ever storing plaintext.
create or replace function exchange_agent_claim(
  p_claim_hash text,
  p_token_hash text,
  p_key_prefix text
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_claim agent_client_claims%rowtype;
  v_client agent_clients%rowtype;
  v_key agent_client_keys%rowtype;
begin
  select * into v_claim from agent_client_claims
   where claim_hash = p_claim_hash for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unusable'); end if;
  if v_claim.revoked_at is not null or v_claim.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'unusable');
  end if;

  select * into v_client from agent_clients where id = v_claim.client_id;
  if not found or v_client.revoked_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'unusable');
  end if;

  select * into v_key from agent_client_keys where token_hash = p_token_hash;
  if found then
    -- A revoked key must not be re-minted by replaying the claim.
    if v_key.revoked_at is not null then
      return jsonb_build_object('ok', false, 'reason', 'unusable');
    end if;
  else
    update agent_client_keys set revoked_at = now()
     where client_id = v_claim.client_id and purpose = 'knowledge' and revoked_at is null;

    insert into agent_client_keys (
      client_id, token_hash, key_prefix, scopes, purpose, access_level, claimed_at
    ) values (
      v_claim.client_id, p_token_hash, p_key_prefix, v_claim.scopes, 'knowledge',
      v_claim.access_level, now()
    ) returning * into v_key;
  end if;

  update agent_client_claims
     set claimed_at = coalesce(claimed_at, now()), issued_key_id = v_key.id
   where id = v_claim.id;
  update agent_clients set last_seen_at = now() where id = v_client.id;

  return jsonb_build_object(
    'ok', true,
    'client_id', v_client.id,
    'display_name', v_client.display_name,
    'scopes', to_jsonb(v_claim.scopes),
    'access_level', v_claim.access_level
  );
end;
$$;

create or replace function revoke_agent_client(p_client_id uuid)
returns jsonb
language plpgsql
security definer
as $$
begin
  update agent_client_keys set revoked_at = now()
   where client_id = p_client_id and revoked_at is null;
  update agent_client_claims set revoked_at = now()
   where client_id = p_client_id and revoked_at is null;
  update agent_clients set revoked_at = now()
   where id = p_client_id and revoked_at is null;
  return jsonb_build_object('ok', true);
end;
$$;

-- Two calls so the limit is checked BEFORE the exchange runs, not after: the
-- attempt is booked first and its outcome stamped once known, which also keeps
-- the global failure backstop from counting successes.
create or replace function begin_agent_claim_attempt(p_ip_hash text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_ip integer;
  v_global integer;
  v_id bigint;
begin
  select count(*) into v_ip from agent_claim_attempts
   where ip_hash = p_ip_hash and at > now() - interval '15 minutes';
  select count(*) into v_global from agent_claim_attempts
   where succeeded = false and at > now() - interval '1 hour';

  insert into agent_claim_attempts (ip_hash, succeeded)
  values (p_ip_hash, false) returning id into v_id;
  delete from agent_claim_attempts where at < now() - interval '2 hours';

  return jsonb_build_object('attempt_id', v_id, 'ip_attempts', v_ip, 'global_failures', v_global);
end;
$$;

create or replace function finish_agent_claim_attempt(p_attempt_id bigint, p_succeeded boolean)
returns void
language sql
security definer
as $$
  update agent_claim_attempts set succeeded = p_succeeded where id = p_attempt_id;
$$;

-- V6 assistant features

-- v6-capture-inbox.sql
create table if not exists public.capture_inbox (
    profile_id uuid not null references public.user_profiles(id) on delete cascade,
    id uuid not null,
    source jsonb not null check (jsonb_typeof(source) = 'object' and octet_length(source::text) <= 3000000),
    source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
    receipt jsonb check (receipt is null or jsonb_typeof(receipt) = 'object'),
    ingest_claim jsonb check (ingest_claim is null or jsonb_typeof(ingest_claim) = 'object'),
    created_at timestamptz not null default now(),
    primary key (profile_id, id)
);
create index if not exists capture_inbox_profile_created on public.capture_inbox(profile_id, created_at desc);
alter table public.capture_inbox enable row level security;
revoke all on public.capture_inbox from public, anon, authenticated;
grant select, insert, update, delete on public.capture_inbox to service_role;
alter table public.capture_inbox add column if not exists ingest_claim jsonb;
create or replace function public.assistant_capture_claim(p_profile_id uuid, p_id uuid, p_claim jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare saved jsonb;
begin
    if jsonb_typeof(p_claim) <> 'object' or coalesce(p_claim->>'path', '') = ''
        or coalesce(p_claim->>'contentHash', '') !~ '^[a-f0-9]{64}$' then
        raise exception 'Invalid capture claim';
    end if;
    select ingest_claim into saved from public.capture_inbox where profile_id = p_profile_id and id = p_id for update;
    if not found then raise exception 'Capture not found'; end if;
    if saved is null then
        update public.capture_inbox set ingest_claim = p_claim where profile_id = p_profile_id and id = p_id;
        saved := p_claim;
    end if;
    return saved;
end;
$$;
revoke all on function public.assistant_capture_claim(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.assistant_capture_claim(uuid, uuid, jsonb) to service_role;

-- v6-conversation-branches.sql
-- Apply manually after the base setup. Branches never copy summaries or executable actions.
begin;
create table if not exists public.assistant_conversation_branches (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  user_profile_id uuid not null references public.user_profiles(id) on delete cascade,
  request_id uuid unique not null,
  root_conversation_id uuid not null,
  parent_conversation_id uuid not null,
  parent_message_id uuid not null,
  parent_message_created_at timestamptz not null,
  parent_title text not null,
  requested_title text,
  copied_count integer not null check (copied_count > 0),
  created_at timestamptz not null default now()
);
create table if not exists public.assistant_branch_messages (
  message_id uuid primary key references public.messages(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  source_conversation_id uuid not null,
  source_message_id uuid not null,
  source_created_at timestamptz not null,
  ordinal integer not null,
  unique(conversation_id, ordinal)
);
create index if not exists assistant_branch_root on public.assistant_conversation_branches(root_conversation_id, created_at);
alter table public.assistant_conversation_branches enable row level security;
alter table public.assistant_branch_messages enable row level security;
revoke all on public.assistant_conversation_branches, public.assistant_branch_messages from public, anon, authenticated;
grant all on public.assistant_conversation_branches, public.assistant_branch_messages to service_role;

create or replace function public.assistant_branch_metadata(p_metadata jsonb, p_conversation uuid, p_message uuid)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'branchOrigin', jsonb_build_object('conversationId', p_conversation, 'messageId', p_message, 'copied', true),
    'knowledgeOnly', case when p_metadata->'knowledgeOnly' = 'true'::jsonb then true end,
    'replyTo', case when p_metadata->'replyTo'->>'role' in ('user', 'assistant')
      and jsonb_typeof(p_metadata->'replyTo'->'content') = 'string'
      then jsonb_build_object('role', p_metadata->'replyTo'->>'role', 'content', p_metadata->'replyTo'->>'content') end,
    'historicalModels', (select jsonb_agg(distinct jsonb_build_object('providerId', observation->>'providerId', 'modelId', observation->>'modelId'))
      from (
        select value observation from jsonb_array_elements(case when jsonb_typeof(p_metadata->'replyTrace'->'calls') = 'array'
          then p_metadata->'replyTrace'->'calls' else '[]'::jsonb end)
          where value->>'purpose' in ('chat', 'worker', 'orchestration') and value->>'status' = 'success'
        union all
        select value observation from jsonb_array_elements(case when jsonb_typeof(p_metadata->'historicalModels') = 'array'
          then p_metadata->'historicalModels' else '[]'::jsonb end)
      ) identities where jsonb_typeof(observation->'providerId') = 'string' and jsonb_typeof(observation->'modelId') = 'string')
  ));
$$;

create or replace function public.assistant_branch_lineage_immutable()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'Conversation branch lineage is immutable' using errcode = '22023';
end;
$$;
drop trigger if exists assistant_branch_lineage_update on public.assistant_conversation_branches;
create trigger assistant_branch_lineage_update before update on public.assistant_conversation_branches
for each row execute function public.assistant_branch_lineage_immutable();
drop trigger if exists assistant_branch_message_lineage_update on public.assistant_branch_messages;
create trigger assistant_branch_message_lineage_update before update on public.assistant_branch_messages
for each row execute function public.assistant_branch_lineage_immutable();

create or replace function public.assistant_branch_conversation_json(p_id uuid)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select to_jsonb(c) || jsonb_build_object('parent_conversation_id', b.parent_conversation_id,
    'parent_message_id', b.parent_message_id, 'copied_count', coalesce(b.copied_count, 0))
  from public.conversations c left join public.assistant_conversation_branches b on b.conversation_id = c.id where c.id = p_id;
$$;

create or replace function public.assistant_fork_conversation(p_conversation_id uuid, p_message_id uuid, p_request_id uuid, p_user_id uuid, p_title text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  parent public.conversations%rowtype;
  existing public.assistant_conversation_branches%rowtype;
  boundary public.messages%rowtype;
  branch_id uuid := gen_random_uuid();
  root_id uuid;
  copied_id uuid;
  records jsonb;
  source jsonb;
  ordinal integer := 0;
begin
  if p_user_id is null or p_request_id is null or (p_title is not null and (length(trim(p_title)) = 0 or length(trim(p_title)) > 120)) then
    raise exception 'Invalid fork request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  select * into existing from public.assistant_conversation_branches where request_id = p_request_id;
  if found then
    if existing.user_profile_id <> p_user_id or existing.parent_conversation_id <> p_conversation_id
      or existing.parent_message_id <> p_message_id or existing.requested_title is distinct from p_title then
      raise exception 'Fork request conflicts with an earlier request' using errcode = '22023';
    end if;
    return public.assistant_branch_conversation_json(existing.conversation_id);
  end if;
  select * into parent from public.conversations where id = p_conversation_id and user_profile_id = p_user_id for update;
  if not found then raise exception 'Conversation unavailable' using errcode = '42501'; end if;
  select * into boundary from public.messages where id = p_message_id and conversation_id = parent.id and user_profile_id = p_user_id for share;
  if not found then raise exception 'Message unavailable' using errcode = 'P0002'; end if;
  select jsonb_agg(to_jsonb(m) order by m.created_at, m.id) into records from (
    select * from public.messages where conversation_id = parent.id and (created_at, id) <= (boundary.created_at, boundary.id)
    order by created_at, id limit 20001
  ) m;
  if jsonb_array_length(records) > 20000 then raise exception 'Branch is too large' using errcode = '54000'; end if;
  if exists (select 1 from jsonb_array_elements(records) m where (m->>'user_profile_id')::uuid is distinct from p_user_id or m->>'channel' is distinct from boundary.channel) then
    raise exception 'Mixed owner or channel prefix cannot be branched' using errcode = '42501';
  end if;
  select root_conversation_id into root_id from public.assistant_conversation_branches where conversation_id = parent.id;
  root_id := coalesce(root_id, parent.id);
  insert into public.conversations(id, user_profile_id, project_id, title)
    values (branch_id, parent.user_profile_id, parent.project_id, coalesce(trim(p_title), left(coalesce(parent.title, 'Conversation'), 110) || ' (branch)'));
  insert into public.assistant_conversation_branches(conversation_id, user_profile_id, request_id, root_conversation_id, parent_conversation_id,
    parent_message_id, parent_message_created_at, parent_title, requested_title, copied_count)
    values (branch_id, p_user_id, p_request_id, root_id, parent.id, boundary.id, boundary.created_at, coalesce(parent.title, 'Conversation'), p_title, jsonb_array_length(records));
  for source in select value from jsonb_array_elements(records) loop
    ordinal := ordinal + 1;
    -- Preserve the source order even when timestamps are equal.
    copied_id := (substr(replace(branch_id::text, '-', ''), 1, 24) || lpad(to_hex(ordinal), 8, '0'))::uuid;
    insert into public.messages(id, conversation_id, user_profile_id, role, content, channel, image_url, metadata, created_at)
      values (copied_id, branch_id, parent.user_profile_id, source->>'role', source->>'content', source->>'channel', source->>'image_url',
        public.assistant_branch_metadata(source->'metadata', parent.id, (source->>'id')::uuid), (source->>'created_at')::timestamptz);
    insert into public.assistant_branch_messages(message_id, conversation_id, source_conversation_id, source_message_id, source_created_at, ordinal)
      values (copied_id, branch_id, parent.id, (source->>'id')::uuid, (source->>'created_at')::timestamptz, ordinal);
  end loop;
  return public.assistant_branch_conversation_json(branch_id);
end;
$$;

create or replace function public.assistant_related_conversations(p_conversation_id uuid, p_user_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with current_conversation as (
    select c.id, coalesce(b.root_conversation_id, c.id) root_id from public.conversations c
    left join public.assistant_conversation_branches b on b.conversation_id = c.id where c.id = p_conversation_id and c.user_profile_id = p_user_id
  ) select jsonb_build_object('current', public.assistant_branch_conversation_json(current_conversation.id),
    'related', coalesce((select jsonb_agg(public.assistant_branch_conversation_json(c.id) order by c.created_at, c.id)
      from public.conversations c left join public.assistant_conversation_branches b on b.conversation_id = c.id
      where c.user_profile_id = p_user_id and c.id <> current_conversation.id
        and (c.id = current_conversation.root_id or b.root_conversation_id = current_conversation.root_id)), '[]'::jsonb)) from current_conversation;
$$;

create or replace function public.assistant_compare_conversations(p_left uuid, p_right uuid, p_user_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with allowed as (
    select c.id, coalesce(b.root_conversation_id, c.id) root_id from public.conversations c
      left join public.assistant_conversation_branches b on b.conversation_id = c.id
      where c.id in (p_left, p_right) and c.user_profile_id = p_user_id
  ), sides as (
    select a.id, jsonb_build_object('conversation', public.assistant_branch_conversation_json(a.id),
      'messages', coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at, m.id) from (
        select id, role, content, channel, image_url, metadata, created_at from public.messages where conversation_id = a.id and user_profile_id = p_user_id
          order by created_at, id limit 20001
      ) m), '[]'::jsonb)) data from allowed a
  ) select jsonb_build_object('left', (select data from sides where id = p_left), 'right', (select data from sides where id = p_right))
    where p_left <> p_right and (select count(*) from allowed) = 2 and (select count(distinct root_id) from allowed) = 1;
$$;

revoke all on function public.assistant_branch_metadata(jsonb, uuid, uuid) from public, anon, authenticated;
revoke all on function public.assistant_branch_lineage_immutable() from public, anon, authenticated;
revoke all on function public.assistant_branch_conversation_json(uuid) from public, anon, authenticated;
revoke all on function public.assistant_fork_conversation(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.assistant_related_conversations(uuid, uuid) from public, anon, authenticated;
revoke all on function public.assistant_compare_conversations(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.assistant_fork_conversation(uuid, uuid, uuid, uuid, text) to service_role;
grant execute on function public.assistant_related_conversations(uuid, uuid) to service_role;
grant execute on function public.assistant_compare_conversations(uuid, uuid, uuid) to service_role;
commit;

-- v6-conversation-context.sql
-- Assistant history only. Apply manually before enabling durable summary reuse.
begin;

create table if not exists public.assistant_context_revisions (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  revision bigint not null default 0
);
create table if not exists public.assistant_conversation_summaries (
  scope_key text primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  generation bigint not null,
  summary jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.assistant_context_revisions enable row level security;
alter table public.assistant_conversation_summaries enable row level security;
revoke all on public.assistant_context_revisions, public.assistant_conversation_summaries from public, anon, authenticated;
grant all on public.assistant_context_revisions, public.assistant_conversation_summaries to service_role;
insert into public.assistant_context_revisions (conversation_id)
select id from public.conversations on conflict do nothing;

create or replace function public.assistant_context_touch()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  old_id uuid;
  new_id uuid;
  target_id uuid;
begin
  if tg_table_name = 'conversations' then
    if tg_op = 'UPDATE' and old.project_id is not distinct from new.project_id then return new; end if;
    new_id := new.id;
  else
    if tg_op = 'UPDATE' and
      row(old.id, old.role, old.content, old.channel, old.user_profile_id, old.conversation_id, old.created_at, old.image_url, old.metadata->'replyTo')
      is not distinct from
      row(new.id, new.role, new.content, new.channel, new.user_profile_id, new.conversation_id, new.created_at, new.image_url, new.metadata->'replyTo')
      then return new;
    end if;
    if tg_op <> 'INSERT' then old_id := old.conversation_id; end if;
    if tg_op <> 'DELETE' then new_id := new.conversation_id; end if;
  end if;
  for target_id in select distinct x from unnest(array[old_id, new_id]) x where x is not null order by x loop
    insert into public.assistant_context_revisions (conversation_id, revision)
      select id, 1 from public.conversations where id = target_id
      on conflict (conversation_id) do update set revision = assistant_context_revisions.revision + 1;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists assistant_context_messages_changed on public.messages;
create trigger assistant_context_messages_changed before insert or update or delete on public.messages
for each row execute function public.assistant_context_touch();
drop trigger if exists assistant_context_conversation_changed on public.conversations;
create trigger assistant_context_conversation_changed after insert or update of project_id on public.conversations
for each row execute function public.assistant_context_touch();

create or replace function public.assistant_context_snapshot(p_conversation_id uuid, p_channel text, p_user_id uuid, p_scope text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'revision', coalesce(r.revision, 0)::text,
    'project_id', c.project_id,
    'summary', case when s.summary is null then null else s.summary || jsonb_build_object('generation', s.generation) end,
    'messages', coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at, m.id) from (
      select id, role, content, channel, created_at, image_url, metadata from public.messages
      where conversation_id = c.id and channel = p_channel and user_profile_id is not distinct from p_user_id
      order by created_at, id limit 20001
    ) m), '[]'::jsonb)
  ) from public.conversations c
  left join public.assistant_context_revisions r on r.conversation_id = c.id
  left join public.assistant_conversation_summaries s on s.scope_key = p_scope and s.conversation_id = c.id
  where c.id = p_conversation_id and c.user_profile_id is not distinct from p_user_id;
$$;

create or replace function public.assistant_context_save(p_conversation_id uuid, p_scope text, p_revision bigint, p_generation bigint, p_summary jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  current_revision bigint;
  saved_rows integer;
begin
  select revision into current_revision from public.assistant_context_revisions
    where conversation_id = p_conversation_id for update;
  if current_revision is null or current_revision <> p_revision then return false; end if;
  if p_generation is null or p_generation < 0 or p_summary->>'scope' is distinct from p_scope
    or p_summary->>'version' is distinct from '1'
    or (p_summary->>'generation')::bigint is distinct from p_generation + 1 then return false; end if;
  if p_generation = 0 then
    insert into public.assistant_conversation_summaries (scope_key, conversation_id, generation, summary)
      values (p_scope, p_conversation_id, 1, p_summary) on conflict do nothing;
  else
    update public.assistant_conversation_summaries set generation = p_generation + 1, summary = p_summary, updated_at = now()
      where scope_key = p_scope and conversation_id = p_conversation_id and generation = p_generation;
  end if;
  get diagnostics saved_rows = row_count;
  return saved_rows = 1;
end;
$$;

revoke all on function public.assistant_context_touch() from public, anon, authenticated;
revoke all on function public.assistant_context_snapshot(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.assistant_context_save(uuid, text, bigint, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.assistant_context_snapshot(uuid, text, uuid, text) to service_role;
grant execute on function public.assistant_context_save(uuid, text, bigint, bigint, jsonb) to service_role;
commit;

-- v6-model-health.sql
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

-- v6-reply-trace.sql
create or replace function public.assistant_reply_trace_save(
    p_message_id uuid,
    p_expected_trace jsonb,
    p_trace jsonb
) returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
    if p_trace is null or jsonb_typeof(p_trace) <> 'object' then
        raise exception 'A reply trace object is required' using errcode = '22023';
    end if;
    update public.messages
    set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('replyTrace', p_trace)
    where id = p_message_id and role = 'assistant'
      and metadata->'replyTrace' is not distinct from p_expected_trace;
    return found;
end;
$$;

revoke all on function public.assistant_reply_trace_save(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.assistant_reply_trace_save(uuid, jsonb, jsonb) to service_role;

-- v6-research-workbench.sql
begin;
create table if not exists public.research_questions (
  id uuid primary key,
  user_profile_id uuid not null references public.user_profiles(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null check (length(title) between 1 and 160),
  question text not null check (length(question) between 1 and 8000),
  status text not null default 'active' check (status in ('active','archived')),
  version integer not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.research_sources (
  id uuid primary key,
  user_profile_id uuid not null references public.user_profiles(id) on delete cascade,
  question_id uuid not null references public.research_questions(id) on delete cascade,
  document_id text not null, path text not null, commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40}$'),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  title text not null check (length(title) between 1 and 160), version integer not null default 1,
  removed_at timestamptz, created_at timestamptz not null default now(),
  unique(question_id, document_id, commit_sha)
);
create table if not exists public.research_entries (
  id uuid primary key,
  user_profile_id uuid not null references public.user_profiles(id) on delete cascade,
  question_id uuid not null references public.research_questions(id) on delete cascade,
  source_id uuid references public.research_sources(id),
  kind text not null check (kind in ('annotation','claim','interpretation','method','finding','limitation')),
  text text not null check (length(text) between 1 and 20000),
  evidence jsonb,
  version integer not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check ((kind = 'interpretation' and evidence is null) or (kind <> 'interpretation' and evidence is not null and source_id is not null))
);
create index if not exists research_questions_project on public.research_questions(user_profile_id, project_id, updated_at desc);
create index if not exists research_sources_question on public.research_sources(question_id, created_at);
create index if not exists research_entries_question on public.research_entries(question_id, created_at);
alter table public.research_questions enable row level security;
alter table public.research_sources enable row level security;
alter table public.research_entries enable row level security;
revoke all on public.research_questions, public.research_sources, public.research_entries from public, anon, authenticated;
grant all on public.research_questions, public.research_sources, public.research_entries to service_role;

create or replace function public.assistant_research_mutate(p_user_id uuid, p_action text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  item_id uuid := (p_payload->>'id')::uuid;
  target_question_id uuid := (p_payload->>'questionId')::uuid;
  expected_version integer := (p_payload->>'version')::integer;
  q public.research_questions%rowtype;
  s public.research_sources%rowtype;
  e public.research_entries%rowtype;
  d public.knowledge_documents%rowtype;
  citation jsonb := nullif(p_payload->'evidence', 'null'::jsonb);
begin
  if p_user_id is null or item_id is null then raise exception 'Invalid research identity' using errcode = '22023'; end if;
  if p_action in ('create_question','update_question') then
    perform 1 from public.projects where id = (p_payload->>'projectId')::uuid and user_profile_id = p_user_id for share;
    if not found then raise exception 'Project unavailable' using errcode = '42501'; end if;
    if p_action = 'create_question' then
      perform pg_advisory_xact_lock(hashtextextended('research-questions:' || p_user_id::text, 0));
      if not exists (select 1 from public.research_questions where id=item_id)
        and (select count(*) from public.research_questions where user_profile_id=p_user_id) >= 500 then
        return jsonb_build_object('capacity','questions');
      end if;
      insert into public.research_questions(id,user_profile_id,project_id,title,question,status)
      values (item_id,p_user_id,(p_payload->>'projectId')::uuid,p_payload->>'title',p_payload->>'question',coalesce(p_payload->>'status','active')) on conflict do nothing;
      select * into q from public.research_questions where id = item_id and user_profile_id = p_user_id;
      if not found then raise exception 'Research identity unavailable' using errcode = '42501'; end if;
      if q.project_id <> (p_payload->>'projectId')::uuid or q.title <> p_payload->>'title' or q.question <> p_payload->>'question' then
        return jsonb_build_object('conflict',true,'current',to_jsonb(q));
      end if;
      return to_jsonb(q);
    end if;
    select * into q from public.research_questions where id = item_id and user_profile_id = p_user_id for update;
    if not found then raise exception 'Question unavailable' using errcode = '42501'; end if;
    if q.version is distinct from expected_version then return jsonb_build_object('conflict',true,'current',to_jsonb(q)); end if;
    if q.project_id <> (p_payload->>'projectId')::uuid then raise exception 'Project is immutable' using errcode = '22023'; end if;
    update public.research_questions set title=p_payload->>'title',question=p_payload->>'question',status=p_payload->>'status',version=version+1,updated_at=now()
      where id=item_id returning * into q;
    return to_jsonb(q);
  end if;
  select * into q from public.research_questions where id=target_question_id and user_profile_id=p_user_id for update;
  if not found then raise exception 'Question unavailable' using errcode = '42501'; end if;
  perform 1 from public.projects where id=q.project_id and user_profile_id=p_user_id for share;
  if not found then raise exception 'Project unavailable' using errcode = '42501'; end if;
  if q.status <> 'active' then raise exception 'Question is archived' using errcode = '22023'; end if;
  if p_action = 'add_source' then
    select * into d from public.knowledge_documents where id=p_payload->>'documentId' for share;
    if not found or d.status <> 'active' or (d.user_profile_id is not null and d.user_profile_id <> p_user_id)
      or (d.project_id=q.project_id or (d.project_id is null and d.scope in ('user','repository'))) is not true then
      raise exception 'Library source unavailable in project' using errcode = '42501';
    end if;
    if not exists (select 1 from public.research_sources where id=item_id)
      and not exists (select 1 from public.research_sources where question_id=q.id and document_id=d.id and commit_sha=p_payload->>'commitSha')
      and (select count(*) from public.research_sources where question_id=q.id) >= 500 then
      return jsonb_build_object('capacity','sources');
    end if;
    insert into public.research_sources(id,user_profile_id,question_id,document_id,path,commit_sha,content_hash,title)
      values (item_id,p_user_id,q.id,d.id,p_payload->>'path',p_payload->>'commitSha',p_payload->>'contentHash',p_payload->>'title') on conflict do nothing;
    select * into s from public.research_sources where question_id=q.id and document_id=d.id and commit_sha=p_payload->>'commitSha' and user_profile_id=p_user_id;
    if not found then raise exception 'Source identity conflict' using errcode = '22023'; end if;
    if s.content_hash <> p_payload->>'contentHash' or s.path <> p_payload->>'path' then raise exception 'Source snapshot changed' using errcode = '22023'; end if;
    if s.removed_at is not null then
      update public.research_sources set removed_at=null,version=version+1 where id=s.id returning * into s;
    end if;
    return to_jsonb(s);
  end if;
  if p_action = 'edit_source' then
    select * into s from public.research_sources where id=item_id and question_id=q.id and user_profile_id=p_user_id for update;
    if not found then raise exception 'Source unavailable' using errcode = '42501'; end if;
    if s.version is distinct from expected_version then return jsonb_build_object('conflict',true,'current',to_jsonb(s)); end if;
    update public.research_sources set title=coalesce(p_payload->>'title',title),
      removed_at=case when p_payload->>'remove'='true' then now() else removed_at end,version=version+1 where id=item_id returning * into s;
    return to_jsonb(s);
  end if;
  if p_action in ('update_entry','delete_entry') then
    select * into e from public.research_entries where id=item_id and question_id=q.id and user_profile_id=p_user_id for update;
    if not found then raise exception 'Note unavailable' using errcode = '42501'; end if;
    if e.version is distinct from expected_version then return jsonb_build_object('conflict',true,'current',to_jsonb(e)); end if;
    if p_action='delete_entry' then delete from public.research_entries where id=item_id; return jsonb_build_object('id',item_id,'deleted',true); end if;
  end if;
  if p_action not in ('create_entry','update_entry') then raise exception 'Unknown research action' using errcode = '22023'; end if;
  if p_payload->>'sourceId' is not null then
    select * into s from public.research_sources where id=(p_payload->>'sourceId')::uuid and question_id=q.id and user_profile_id=p_user_id for share;
    if not found or (s.removed_at is not null and (p_action='create_entry' or e.source_id is distinct from s.id)) then raise exception 'Source unavailable' using errcode = '42501'; end if;
    select * into d from public.knowledge_documents where id=s.document_id for share;
    if not found or d.status <> 'active' or (d.user_profile_id is not null and d.user_profile_id <> p_user_id)
      or (d.project_id=q.project_id or (d.project_id is null and d.scope in ('user','repository'))) is not true then raise exception 'Source scope changed' using errcode = '42501'; end if;
  end if;
  if p_payload->>'kind' <> 'interpretation' then
    if s.id is null or citation is null or citation->>'version' is distinct from '1'
      or citation->>'documentId' is distinct from s.document_id or citation->>'path' is distinct from s.path
      or citation->>'commitSha' is distinct from s.commit_sha or citation->>'contentHash' is distinct from s.content_hash then
      raise exception 'Evidence does not match selected source' using errcode = '22023';
    end if;
  elsif citation is not null then raise exception 'Interpretations must not impersonate quoted evidence' using errcode = '22023'; end if;
  if p_action='create_entry' then
    if not exists (select 1 from public.research_entries where id=item_id)
      and (select count(*) from public.research_entries where question_id=q.id) >= 2000 then
      return jsonb_build_object('capacity','entries');
    end if;
    insert into public.research_entries(id,user_profile_id,question_id,source_id,kind,text,evidence)
      values (item_id,p_user_id,q.id,(p_payload->>'sourceId')::uuid,p_payload->>'kind',p_payload->>'text',citation) on conflict do nothing;
    select * into e from public.research_entries where id=item_id and question_id=q.id and user_profile_id=p_user_id;
    if not found then raise exception 'Note identity conflict' using errcode = '42501'; end if;
    if e.source_id is distinct from (p_payload->>'sourceId')::uuid or e.kind <> p_payload->>'kind'
      or e.text <> p_payload->>'text' or e.evidence is distinct from citation then return jsonb_build_object('conflict',true,'current',to_jsonb(e)); end if;
  else
    update public.research_entries set source_id=(p_payload->>'sourceId')::uuid,kind=p_payload->>'kind',text=p_payload->>'text',evidence=citation,
      version=version+1,updated_at=now() where id=item_id returning * into e;
  end if;
  return to_jsonb(e);
end;
$$;
revoke all on function public.assistant_research_mutate(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.assistant_research_mutate(uuid,text,jsonb) to service_role;
commit;

-- v6-scheduled-actions.sql
-- Assistant scheduled runs and owner-reviewed actions.
begin;
create table if not exists public.assistant_task_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  user_profile_id uuid not null references public.user_profiles(id),
  request_id uuid not null unique,
  task_title text not null,
  task_snapshot jsonb not null,
  trigger text not null check (trigger in ('schedule','manual')),
  status text not null default 'running' check (status in ('running','ok','error','interrupted')),
  started_at timestamptz not null default now(),
  execution_started_at timestamptz,
  expires_at timestamptz not null default now() + interval '10 minutes',
  finished_at timestamptz,
  detail text
);
create unique index if not exists assistant_task_single_run on public.assistant_task_runs(task_id) where status = 'running';
create index if not exists assistant_task_run_owner on public.assistant_task_runs(user_profile_id, started_at desc);
alter table public.assistant_task_runs add column if not exists delivery_started_at timestamptz;
alter table public.scheduled_tasks add column if not exists latest_run_id uuid;
create table if not exists public.assistant_action_approvals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  run_id uuid not null references public.assistant_task_runs(id),
  user_profile_id uuid not null references public.user_profiles(id),
  task_title text not null,
  tool text not null check (tool ~ '^[a-z][a-z0-9_]{0,79}$' and tool not like 'council_%'),
  args jsonb not null check (jsonb_typeof(args) = 'object' and octet_length(args::text) <= 200000),
  args_hash text not null check (args_hash ~ '^[a-f0-9]{64}$'),
  instruction text not null,
  source_context text not null default '',
  status text not null default 'pending' check (status in ('pending','executing','succeeded','rejected','expired','outcome_unknown')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  decided_at timestamptz,
  execution_token uuid,
  receipt text,
  unique(run_id, tool, args_hash)
);
create index if not exists assistant_approval_owner on public.assistant_action_approvals(user_profile_id, created_at desc);
alter table public.assistant_task_runs enable row level security;
alter table public.assistant_action_approvals enable row level security;
revoke all on public.assistant_task_runs, public.assistant_action_approvals from public, anon, authenticated;
grant select, insert, update on public.assistant_task_runs, public.assistant_action_approvals to service_role;

create or replace function public.assistant_claim_task_run(p_task_id uuid, p_request_id uuid, p_trigger text, p_user_id uuid, p_due_at timestamptz default null, p_next_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare t public.scheduled_tasks; r public.assistant_task_runs;
begin
  if p_trigger not in ('manual','schedule') then raise exception 'Invalid trigger'; end if;
  select * into t from public.scheduled_tasks where id = p_task_id and user_profile_id = p_user_id for update;
  if not found then return jsonb_build_object('error','Task or owner unavailable'); end if;
  select * into r from public.assistant_task_runs where request_id = p_request_id;
  if found then
    if r.task_id <> p_task_id or r.user_profile_id <> p_user_id then return jsonb_build_object('error','Request identity conflict'); end if;
    return jsonb_build_object('status','reused','run',to_jsonb(r));
  end if;
  update public.assistant_task_runs set status='interrupted', finished_at=now(), detail='The runner stopped without a confirmed result.'
    where task_id=p_task_id and status='running' and expires_at <= now();
  select * into r from public.assistant_task_runs where task_id=p_task_id and status='running';
  if found then return jsonb_build_object('status','active','run',to_jsonb(r)); end if;
  if p_trigger = 'schedule' then
    if not t.enabled or t.next_run_at is distinct from p_due_at or t.next_run_at > now() or t.next_run_at is null then
      return jsonb_build_object('status','not_due');
    end if;
    update public.scheduled_tasks set next_run_at=p_next_at, enabled=case when schedule_type='once' then false else enabled end where id=t.id;
  end if;
  insert into public.assistant_task_runs(task_id,user_profile_id,request_id,task_title,task_snapshot,trigger)
    values(t.id,p_user_id,p_request_id,t.title,to_jsonb(t),p_trigger) returning * into r;
  update public.scheduled_tasks set latest_run_id=r.id where id=t.id;
  return jsonb_build_object('status','accepted','run',to_jsonb(r));
end;
$$;

create or replace function public.assistant_start_task_run(p_run_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.assistant_task_runs set execution_started_at=now()
    where id=p_run_id and status='running' and execution_started_at is null and expires_at > now();
  return found;
end;
$$;

create or replace function public.assistant_propose_action(p_run_id uuid,p_tool text,p_args jsonb,p_hash text,p_sources text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.assistant_task_runs; a public.assistant_action_approvals;
begin
  select * into r from public.assistant_task_runs where id=p_run_id and status='running' and expires_at > now() for share;
  if not found then raise exception 'Active scheduled run unavailable'; end if;
  insert into public.assistant_action_approvals(task_id,run_id,user_profile_id,task_title,tool,args,args_hash,instruction,source_context)
    values(r.task_id,r.id,r.user_profile_id,r.task_title,p_tool,p_args,p_hash,left(r.task_snapshot->>'instruction',20000),left(p_sources,16000))
    on conflict(run_id,tool,args_hash) do nothing;
  select * into a from public.assistant_action_approvals where run_id=r.id and tool=p_tool and args_hash=p_hash;
  if a.args <> p_args then raise exception 'Action identity conflict'; end if;
  return to_jsonb(a);
end;
$$;

create or replace function public.assistant_claim_task_delivery(p_run_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare task uuid;
begin
  select task_id into task from public.assistant_task_runs where id=p_run_id;
  perform 1 from public.scheduled_tasks where id=task and latest_run_id=p_run_id for update;
  if not found then return false; end if;
  update public.assistant_task_runs set delivery_started_at=now()
    where id=p_run_id and status='running' and execution_started_at is not null and expires_at>now() and delivery_started_at is null;
  return found;
end;
$$;

create or replace function public.assistant_finish_task_run(p_run_id uuid,p_status text,p_detail text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare task uuid;
begin
  if p_status not in ('ok','error') then raise exception 'Invalid run result'; end if;
  select task_id into task from public.assistant_task_runs where id=p_run_id;
  perform 1 from public.scheduled_tasks where id=task and latest_run_id=p_run_id for update;
  if not found then return false; end if;
  update public.assistant_task_runs set status=p_status,detail=left(p_detail,12000),finished_at=now()
    where id=p_run_id and status='running' and expires_at>now();
  if not found then return false; end if;
  update public.scheduled_tasks set last_run_at=now(),last_status=p_status,last_result=left(p_detail,500) where id=task and latest_run_id=p_run_id;
  return true;
end;
$$;
revoke all on function public.assistant_claim_task_delivery(uuid), public.assistant_finish_task_run(uuid,text,text) from public,anon,authenticated;
grant execute on function public.assistant_claim_task_delivery(uuid), public.assistant_finish_task_run(uuid,text,text) to service_role;

create or replace function public.assistant_decide_action(p_id uuid,p_user_id uuid,p_decision text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.assistant_action_approvals; task_owner uuid;
begin
  if p_decision not in ('approve','reject') then raise exception 'Invalid decision'; end if;
  select task_id into task_owner from public.assistant_action_approvals where id=p_id and user_profile_id=p_user_id;
  if task_owner is null then return null; end if;
  perform 1 from public.scheduled_tasks where id=task_owner and user_profile_id=p_user_id for update;
  if not found then return null; end if;
  select * into a from public.assistant_action_approvals where id=p_id and user_profile_id=p_user_id for update;
  if not found then return null; end if;
  if a.status='pending' and a.expires_at <= now() then
    update public.assistant_action_approvals set status='expired' where id=a.id returning * into a;
  end if;
  if a.status <> 'pending' then return jsonb_build_object('claimed',false,'approval',to_jsonb(a)); end if;
  update public.assistant_action_approvals set status=case when p_decision='approve' then 'executing' else 'rejected' end,
    decided_at=now(), execution_token=case when p_decision='approve' then gen_random_uuid() else null end
    where id=a.id returning * into a;
  return jsonb_build_object('claimed',true,'approval',to_jsonb(a));
end;
$$;

create or replace function public.assistant_finish_action(p_id uuid,p_token uuid,p_status text,p_receipt text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_status not in ('succeeded','outcome_unknown') then raise exception 'Invalid receipt state'; end if;
  update public.assistant_action_approvals set status=p_status,receipt=left(p_receipt,12000)
    where id=p_id and execution_token=p_token and status='executing';
  return found;
end;
$$;

create or replace function public.assistant_delete_task(p_id uuid,p_user_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform 1 from public.scheduled_tasks where id=p_id and user_profile_id=p_user_id for update;
  if not found then return false; end if;
  if exists(select 1 from public.assistant_task_runs where task_id=p_id and status='running' and expires_at > now())
    or exists(select 1 from public.assistant_action_approvals where task_id=p_id and status='executing')
    then return false; end if;
  update public.assistant_action_approvals set status='rejected',decided_at=now(),receipt='Task deleted by its owner.'
    where task_id=p_id and status='pending';
  delete from public.scheduled_tasks where id=p_id and user_profile_id=p_user_id;
  return found;
end;
$$;

create or replace function public.assistant_action_immutable()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if row(old.id,old.task_id,old.run_id,old.user_profile_id,old.task_title,old.tool,old.args,old.args_hash,old.instruction,old.source_context,old.created_at,old.expires_at)
    is distinct from row(new.id,new.task_id,new.run_id,new.user_profile_id,new.task_title,new.tool,new.args,new.args_hash,new.instruction,new.source_context,new.created_at,new.expires_at)
    then raise exception 'Approval payload is immutable'; end if;
  if old.status <> new.status and not (
    (old.status='pending' and new.status in ('executing','rejected','expired'))
    or (old.status='executing' and new.status in ('succeeded','outcome_unknown'))
  ) then raise exception 'Invalid approval transition'; end if;
  return new;
end;
$$;
drop trigger if exists assistant_action_payload_immutable on public.assistant_action_approvals;
create trigger assistant_action_payload_immutable before update on public.assistant_action_approvals
  for each row execute function public.assistant_action_immutable();
revoke all on function public.assistant_action_immutable(), public.assistant_delete_task(uuid,uuid) from public,anon,authenticated;
grant execute on function public.assistant_delete_task(uuid,uuid) to service_role;

revoke all on function public.assistant_claim_task_run(uuid,uuid,text,uuid,timestamptz,timestamptz), public.assistant_start_task_run(uuid),
 public.assistant_propose_action(uuid,text,jsonb,text,text), public.assistant_decide_action(uuid,uuid,text),
 public.assistant_finish_action(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.assistant_claim_task_run(uuid,uuid,text,uuid,timestamptz,timestamptz), public.assistant_start_task_run(uuid),
 public.assistant_propose_action(uuid,text,jsonb,text,text), public.assistant_decide_action(uuid,uuid,text),
 public.assistant_finish_action(uuid,uuid,text,text) to service_role;
commit;

-- v6-study.sql
-- Source-linked study cards and atomic review history.
begin;
create table if not exists public.study_settings (
 user_profile_id uuid primary key references public.user_profiles(id),
 daily_limit integer not null default 20 check(daily_limit between 1 and 200),
 timezone text not null default 'Australia/Sydney',
 version integer not null default 1 check(version > 0)
);
create table if not exists public.study_cards (
 id uuid primary key, user_profile_id uuid not null references public.user_profiles(id),
 deck text not null check(length(deck) between 1 and 120),
 kind text not null check(kind in ('recall','exercise','explain')),
 prompt text not null check(length(prompt) between 1 and 20000),
 answer text not null check(length(answer) between 1 and 20000),
 evidence jsonb not null check(jsonb_typeof(evidence)='object' and evidence->>'version'='1' and length(evidence->>'quote') between 1 and 20000),
 schedule jsonb not null check(jsonb_typeof(schedule)='object'),
 due_at timestamptz not null, active boolean not null default true,
 version integer not null default 1 check(version > 0),
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists study_cards_due on public.study_cards(user_profile_id,active,due_at);
create table if not exists public.study_reviews (
 id uuid primary key, card_id uuid not null references public.study_cards(id),
 user_profile_id uuid not null references public.user_profiles(id),
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 rating integer not null check(rating between 1 and 4),
 response text not null check(length(response) between 1 and 20000),
 reflection text not null default '' check(length(reflection)<=20000),
 reviewed_at timestamptz not null default now(),
 prompt text not null, answer text not null, evidence jsonb not null,
 card_version integer not null, schedule_before jsonb not null, schedule_after jsonb not null, review_log jsonb not null
);
create index if not exists study_reviews_daily on public.study_reviews(user_profile_id,reviewed_at desc);
alter table public.study_settings enable row level security;
alter table public.study_cards enable row level security;
alter table public.study_reviews enable row level security;
revoke all on public.study_settings,public.study_cards,public.study_reviews from public,anon,authenticated;
grant select,insert,update on public.study_settings,public.study_cards to service_role;
grant select,insert on public.study_reviews to service_role;

create or replace function public.assistant_study_report(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.study_settings; today date; used integer;
begin
 insert into public.study_settings(user_profile_id) values(p_user_id) on conflict do nothing;
 select * into s from public.study_settings where user_profile_id=p_user_id;
 today := (now() at time zone s.timezone)::date;
 select count(*) into used from public.study_reviews where user_profile_id=p_user_id
   and reviewed_at >= (today::timestamp at time zone s.timezone) and reviewed_at < ((today+1)::timestamp at time zone s.timezone);
 return jsonb_build_object('settings',to_jsonb(s),'reviewed_today',used,'day',today,'generated_at',now(),
   'cards',coalesce((select jsonb_agg(c order by c.due_at,c.id) from (select * from public.study_cards where user_profile_id=p_user_id order by due_at,id limit 501) c),'[]'::jsonb),
   'reviews',coalesce((select jsonb_agg(r order by r.reviewed_at desc,r.id) from (select * from public.study_reviews where user_profile_id=p_user_id order by reviewed_at desc,id limit 200) r),'[]'::jsonb));
end; $$;

create or replace function public.assistant_study_save(p_user_id uuid,p_action text,p_body jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.study_cards; s public.study_settings; target uuid;
begin
 if p_action='settings' then
   insert into public.study_settings(user_profile_id) values(p_user_id) on conflict do nothing;
   select * into s from public.study_settings where user_profile_id=p_user_id for update;
   if s.version <> (p_body->>'version')::integer then return jsonb_build_object('error','conflict'); end if;
   if not exists(select 1 from pg_timezone_names where name=p_body->>'timezone') then raise exception 'Invalid timezone'; end if;
   update public.study_settings set daily_limit=(p_body->>'dailyLimit')::integer,timezone=p_body->>'timezone',version=version+1 where user_profile_id=p_user_id returning * into s;
   return jsonb_build_object('settings',to_jsonb(s));
 end if;
 if p_action not in ('create','edit') then raise exception 'Invalid operation'; end if;
 target := (p_body->>'id')::uuid;
 if p_action='create' then
   insert into public.study_settings(user_profile_id) values(p_user_id) on conflict do nothing;
   perform 1 from public.study_settings where user_profile_id=p_user_id for update;
   if not exists(select 1 from public.study_cards where id=target)
     and (select count(*) from public.study_cards where user_profile_id=p_user_id)>=500 then return jsonb_build_object('error','capacity'); end if;
   insert into public.study_cards(id,user_profile_id,deck,kind,prompt,answer,evidence,schedule,due_at,request_hash)
   values(target,p_user_id,p_body->>'deck',p_body->>'kind',p_body->>'prompt',p_body->>'answer',p_body->'evidence',p_body->'schedule',(p_body->'schedule'->>'due')::timestamptz,p_body->>'requestHash') on conflict do nothing;
   select * into c from public.study_cards where id=target and user_profile_id=p_user_id for update;
   if not found or c.request_hash <> p_body->>'requestHash' then return jsonb_build_object('error','conflict'); end if;
 else
   select * into c from public.study_cards where id=target and user_profile_id=p_user_id for update;
   if not found then return jsonb_build_object('error','missing'); end if;
   if c.version <> (p_body->>'version')::integer then return jsonb_build_object('error','conflict'); end if;
   update public.study_cards set deck=p_body->>'deck',prompt=p_body->>'prompt',answer=p_body->>'answer',active=(p_body->>'active')::boolean,version=version+1,updated_at=now() where id=target returning * into c;
 end if;
 return jsonb_build_object('card',to_jsonb(c));
end; $$;

create or replace function public.assistant_study_review(p_user_id uuid,p_body jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.study_settings; c public.study_cards; r public.study_reviews; today date; used integer;
begin
 insert into public.study_settings(user_profile_id) values(p_user_id) on conflict do nothing;
 select * into s from public.study_settings where user_profile_id=p_user_id for update;
 select * into r from public.study_reviews where id=(p_body->>'id')::uuid;
 if found then
   if r.user_profile_id<>p_user_id or r.card_id<>(p_body->>'cardId')::uuid or r.request_hash<>p_body->>'requestHash' then return jsonb_build_object('error','conflict'); end if;
   return jsonb_build_object('review',to_jsonb(r),'reused',true);
 end if;
 select * into c from public.study_cards where id=(p_body->>'cardId')::uuid and user_profile_id=p_user_id for update;
 if not found then return jsonb_build_object('error','missing'); end if;
 if c.version<>(p_body->>'version')::integer then return jsonb_build_object('error','conflict'); end if;
 if not c.active or c.due_at>now() then return jsonb_build_object('error','not_due'); end if;
 today := (now() at time zone s.timezone)::date;
 select count(*) into used from public.study_reviews where user_profile_id=p_user_id
   and reviewed_at >= (today::timestamp at time zone s.timezone) and reviewed_at < ((today+1)::timestamp at time zone s.timezone);
 if used>=s.daily_limit then return jsonb_build_object('error','daily_limit'); end if;
 if (p_body->'schedule'->>'due')::timestamptz <= now() then raise exception 'Invalid next review'; end if;
 insert into public.study_reviews(id,card_id,user_profile_id,request_hash,rating,response,reflection,prompt,answer,evidence,card_version,schedule_before,schedule_after,review_log)
 values((p_body->>'id')::uuid,c.id,p_user_id,p_body->>'requestHash',(p_body->>'rating')::integer,p_body->>'response',coalesce(p_body->>'reflection',''),c.prompt,c.answer,c.evidence,c.version,c.schedule,p_body->'schedule',p_body->'log') returning * into r;
 update public.study_cards set schedule=p_body->'schedule',due_at=(p_body->'schedule'->>'due')::timestamptz,version=version+1,updated_at=now() where id=c.id;
 return jsonb_build_object('review',to_jsonb(r),'reused',false);
end; $$;

create or replace function public.assistant_study_immutable()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_table_name='study_reviews' then raise exception 'Study review history is immutable'; end if;
 if row(old.id,old.user_profile_id,old.kind,old.evidence,old.request_hash,old.created_at) is distinct from row(new.id,new.user_profile_id,new.kind,new.evidence,new.request_hash,new.created_at) then raise exception 'Study source evidence is immutable'; end if;
 return new;
end; $$;
drop trigger if exists study_card_source_immutable on public.study_cards;
create trigger study_card_source_immutable before update on public.study_cards for each row execute function public.assistant_study_immutable();
drop trigger if exists study_review_immutable on public.study_reviews;
create trigger study_review_immutable before update or delete on public.study_reviews for each row execute function public.assistant_study_immutable();
revoke all on function public.assistant_study_report(uuid),public.assistant_study_save(uuid,text,jsonb),public.assistant_study_review(uuid,jsonb),public.assistant_study_immutable() from public,anon,authenticated;
grant execute on function public.assistant_study_report(uuid),public.assistant_study_save(uuid,text,jsonb),public.assistant_study_review(uuid,jsonb) to service_role;
commit;

-- ===== Atomic named-client claim replacement =====

begin;

alter table public.agent_clients enable row level security;
alter table public.agent_client_keys enable row level security;
alter table public.agent_client_claims enable row level security;
alter table public.agent_claim_attempts enable row level security;
revoke all on public.agent_clients, public.agent_client_keys, public.agent_client_claims, public.agent_claim_attempts
  from public, anon, authenticated;
grant select, insert, update, delete on public.agent_clients, public.agent_client_keys, public.agent_client_claims, public.agent_claim_attempts
  to service_role;
revoke all on sequence public.agent_claim_attempts_id_seq from public, anon, authenticated;
grant usage, select on sequence public.agent_claim_attempts_id_seq to service_role;

create or replace function public.mint_agent_claim(
  p_client_id uuid,
  p_claim_hash text,
  p_scopes text[],
  p_access_level text,
  p_expires_at timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_scopes text[];
begin
  v_scopes := case p_access_level
    when 'read' then array['knowledge:read']
    when 'notes' then array['knowledge:read', 'notes:write']
    when 'full' then array['knowledge:read', 'notes:write', 'vault:write']
    when 'council' then array['knowledge:read', 'notes:write', 'vault:write', 'council:owner']
    else null
  end;
  if v_scopes is null or p_scopes is distinct from v_scopes
     or p_claim_hash is null or p_claim_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at is null or not isfinite(p_expires_at) then
    return jsonb_build_object('ok', false);
  end if;

  -- All credential lifecycle writes take the client lock first.
  perform 1 from public.agent_clients
   where id = p_client_id and revoked_at is null for update;
  if not found then return jsonb_build_object('ok', false); end if;
  if p_expires_at <= clock_timestamp() then return jsonb_build_object('ok', false); end if;

  update public.agent_client_claims set revoked_at = now()
   where client_id = p_client_id and revoked_at is null and claimed_at is null;
  insert into public.agent_client_claims (client_id, claim_hash, scopes, access_level, expires_at)
  values (p_client_id, p_claim_hash, p_scopes, p_access_level, p_expires_at);
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.mint_agent_claim(uuid, text, text[], text, timestamptz) from public, anon, authenticated;
grant execute on function public.mint_agent_claim(uuid, text, text[], text, timestamptz) to service_role;

create or replace function public.exchange_agent_claim(
  p_claim_hash text,
  p_token_hash text,
  p_key_prefix text
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_claim public.agent_client_claims%rowtype;
  v_client public.agent_clients%rowtype;
  v_key public.agent_client_keys%rowtype;
begin
  select * into v_claim from public.agent_client_claims where claim_hash = p_claim_hash;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unusable'); end if;

  select * into v_client from public.agent_clients where id = v_claim.client_id for update;
  if not found or v_client.revoked_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'unusable');
  end if;

  select * into v_claim from public.agent_client_claims
   where claim_hash = p_claim_hash and client_id = v_client.id for update;
  if not found or v_claim.revoked_at is not null or v_claim.expires_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'unusable');
  end if;

  select * into v_key from public.agent_client_keys where token_hash = p_token_hash;
  if found then
    if v_key.revoked_at is not null or v_key.client_id <> v_client.id or v_key.purpose <> 'knowledge'
       or v_claim.issued_key_id is distinct from v_key.id or v_claim.claimed_at is null
       or (v_key.expires_at is not null and v_key.expires_at <= clock_timestamp()) then
      return jsonb_build_object('ok', false, 'reason', 'unusable');
    end if;
  else
    if v_claim.claimed_at is not null or v_claim.issued_key_id is not null then
      return jsonb_build_object('ok', false, 'reason', 'unusable');
    end if;
    update public.agent_client_keys set revoked_at = now()
     where client_id = v_claim.client_id and purpose = 'knowledge' and revoked_at is null;
    insert into public.agent_client_keys (
      client_id, token_hash, key_prefix, scopes, purpose, access_level, claimed_at
    ) values (
      v_claim.client_id, p_token_hash, p_key_prefix, v_claim.scopes, 'knowledge',
      v_claim.access_level, now()
    ) returning * into v_key;
  end if;

  update public.agent_client_claims
     set claimed_at = coalesce(claimed_at, now()), issued_key_id = v_key.id
   where id = v_claim.id;
  update public.agent_clients set last_seen_at = now() where id = v_client.id;

  return jsonb_build_object(
    'ok', true,
    'client_id', v_client.id,
    'display_name', v_client.display_name,
    'scopes', to_jsonb(v_claim.scopes),
    'access_level', v_claim.access_level
  );
end;
$$;

create or replace function public.revoke_agent_client(p_client_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform 1 from public.agent_clients where id = p_client_id for update;
  if not found then return jsonb_build_object('ok', true); end if;
  update public.agent_client_keys set revoked_at = now()
   where client_id = p_client_id and revoked_at is null;
  update public.agent_client_claims set revoked_at = now()
   where client_id = p_client_id and revoked_at is null;
  update public.agent_clients set revoked_at = now()
   where id = p_client_id and revoked_at is null;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.resolve_agent_client_key(p_token_hash text)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_key public.agent_client_keys%rowtype;
  v_client public.agent_clients%rowtype;
begin
  select * into v_key from public.agent_client_keys where token_hash = p_token_hash;
  if not found then return null; end if;
  select * into v_client from public.agent_clients where id = v_key.client_id for update;
  if not found or v_client.revoked_at is not null then return null; end if;

  select * into v_key from public.agent_client_keys
   where token_hash = p_token_hash and client_id = v_client.id for update;
  if not found or v_key.revoked_at is not null then return null; end if;
  if v_key.expires_at is not null and v_key.expires_at <= clock_timestamp() then return null; end if;

  if v_key.last_used_at is null or v_key.last_used_at < now() - interval '60 seconds' then
    update public.agent_client_keys set last_used_at = now() where id = v_key.id;
    update public.agent_clients set last_seen_at = now() where id = v_client.id;
  end if;

  return jsonb_build_object(
    'client_id', v_client.id,
    'display_name', v_client.display_name,
    'key_id', v_key.id,
    'purpose', v_key.purpose,
    'scopes', to_jsonb(v_key.scopes),
    'session_id', v_key.session_id,
    'seat_name', v_key.seat_name
  );
end;
$$;

alter function public.begin_agent_claim_attempt(text) security invoker;
alter function public.begin_agent_claim_attempt(text) set search_path = public, pg_temp;
alter function public.finish_agent_claim_attempt(bigint, boolean) security invoker;
alter function public.finish_agent_claim_attempt(bigint, boolean) set search_path = public, pg_temp;

revoke all on function public.exchange_agent_claim(text, text, text), public.revoke_agent_client(uuid),
  public.resolve_agent_client_key(text), public.begin_agent_claim_attempt(text), public.finish_agent_claim_attempt(bigint, boolean)
  from public, anon, authenticated;
grant execute on function public.exchange_agent_claim(text, text, text), public.revoke_agent_client(uuid),
  public.resolve_agent_client_key(text), public.begin_agent_claim_attempt(text), public.finish_agent_claim_attempt(bigint, boolean)
  to service_role;

commit;

-- ===== Bounded Council campaign seat renewal =====

begin;

create or replace function public.renew_council_host_lease(
  p_session_id uuid, p_host_id uuid, p_lease_epoch bigint,
  p_duration_seconds integer default 45
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_session council_sessions;
  v_lease council_host_leases;
  v_campaign council_campaigns;
  v_key council_seat_keys;
  v_now timestamptz;
  v_duration integer;
begin
  v_duration := greatest(15, least(coalesce(p_duration_seconds, 45), 300));
  select * into v_session from council_sessions where id = p_session_id for share;
  if v_session.id is null then return jsonb_build_object('ok', false, 'reason', 'no_session'); end if;
  if v_session.protocol_version <> 3 then return jsonb_build_object('ok', false, 'reason', 'not_v3'); end if;
  if v_session.status = 'expired' then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  select * into v_lease from council_host_leases where session_id = p_session_id for update;
  if v_lease.session_id is null then return jsonb_build_object('ok', false, 'reason', 'no_lease'); end if;
  if v_lease.host_id is distinct from p_host_id or v_lease.lease_epoch is distinct from p_lease_epoch then
    return jsonb_build_object('ok', false, 'reason', 'stale_epoch');
  end if;
  select * into v_campaign from council_campaigns where session_id = p_session_id for share;
  v_now := clock_timestamp();
  if v_lease.released_at is not null or v_lease.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'lease_expired');
  end if;
  update council_host_leases
     set lease_expires_at = v_now + make_interval(secs => v_duration), last_heartbeat_at = v_now
   where session_id = p_session_id returning * into v_lease;

  if v_session.status in ('open', 'concluding', 'closed') and v_session.paused_at is null and v_campaign.id is not null and (
    v_campaign.status in ('running', 'blocked') or
    (v_campaign.status = 'complete' and coalesce(v_campaign.integration_status, 'pending') in ('pending', 'running'))
  ) then
    -- Busy credential writes must not stall the host heartbeat.
    for v_key in
      select k.* from council_seat_keys k
       where k.session_id = p_session_id and k.issued_by = 'host'
         and k.host_id = p_host_id and k.lease_epoch = p_lease_epoch
         and k.revoked_at is null and k.expires_at > v_now
         and k.expires_at <= v_now + interval '1 hour'
         and exists (select 1 from council_participants p
           where p.session_id = k.session_id and p.name = k.seat_name and p.kind = 'agent')
       for update of k skip locked
    loop
      v_now := clock_timestamp();
      if v_key.expires_at > v_now then
        update council_seat_keys set expires_at = v_now + interval '24 hours' where id = v_key.id;
      end if;
    end loop;
  end if;
  return jsonb_build_object(
    'ok', true, 'hostId', v_lease.host_id, 'leaseEpoch', v_lease.lease_epoch,
    'leaseExpiresAt', v_lease.lease_expires_at
  );
end;
$$;

revoke all on function public.renew_council_host_lease(uuid, uuid, bigint, integer) from public, anon, authenticated;
grant execute on function public.renew_council_host_lease(uuid, uuid, bigint, integer) to service_role;

create or replace function public.issue_council_seat_key(
  p_session_id uuid, p_seat_name text, p_token_hash text, p_expires_at timestamptz
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session council_sessions; v_campaign council_campaigns; v_kind text; v_now timestamptz;
begin
  select * into v_session from council_sessions where id = p_session_id for share;
  if v_session.id is null or v_session.status not in ('open', 'concluding', 'closed') or v_session.paused_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'inactive_session');
  end if;
  if v_session.status = 'closed' then
    select * into v_campaign from council_campaigns where session_id = p_session_id for share;
    if v_campaign.id is null or not (
      v_campaign.status in ('running', 'blocked') or
      (v_campaign.status = 'complete' and coalesce(v_campaign.integration_status, 'pending') in ('pending', 'running'))
    ) then return jsonb_build_object('ok', false, 'reason', 'inactive_session'); end if;
  end if;
  select kind into v_kind from council_participants
   where session_id = p_session_id and name = p_seat_name for share;
  if v_kind is null then return jsonb_build_object('ok', false, 'reason', 'not_on_roster'); end if;
  if v_kind <> 'agent' then return jsonb_build_object('ok', false, 'reason', 'not_an_agent_seat'); end if;
  v_now := clock_timestamp();
  if p_expires_at is null or not isfinite(p_expires_at) or p_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'invalid_expiry');
  end if;
  insert into council_seat_keys (
    session_id, seat_name, token_hash, expires_at, issued_by, host_id, lease_epoch
  ) values (
    p_session_id, p_seat_name, p_token_hash, least(p_expires_at, v_now + interval '24 hours'), 'owner', null, null
  ) on conflict (session_id, seat_name) do update
    set token_hash = excluded.token_hash, expires_at = excluded.expires_at,
        issued_at = clock_timestamp(), claimed_at = null, revoked_at = null,
        issued_by = 'owner', host_id = null, lease_epoch = null;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.issue_council_seat_key(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.issue_council_seat_key(uuid, text, text, timestamptz) to service_role;

create or replace function public.resolve_council_seat_key(p_token_hash text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_seed council_seat_keys;
  v_key council_seat_keys;
  v_lease council_host_leases;
  v_status text;
  v_code text;
  v_now timestamptz;
begin
  -- The first lookup only chooses the session and lease lock order.
  select * into v_seed from council_seat_keys where token_hash = p_token_hash;
  if v_seed.id is null then return null; end if;
  select status, code into v_status, v_code from council_sessions
   where id = v_seed.session_id for share;
  if v_status is null or v_status = 'expired' then return null; end if;
  if v_seed.issued_by = 'host' then
    select * into v_lease from council_host_leases where session_id = v_seed.session_id for share;
  end if;
  select * into v_key from council_seat_keys
   where id = v_seed.id and token_hash = p_token_hash for update;
  v_now := clock_timestamp();
  if v_key.id is null or v_key.revoked_at is not null or v_key.expires_at <= v_now then return null; end if;
  if row(v_key.session_id, v_key.seat_name, v_key.issued_by, v_key.host_id, v_key.lease_epoch)
     is distinct from row(v_seed.session_id, v_seed.seat_name, v_seed.issued_by, v_seed.host_id, v_seed.lease_epoch) then
    return null;
  end if;
  if v_key.issued_by = 'host' and (
    v_lease.session_id is null or v_lease.host_id is distinct from v_key.host_id
    or v_lease.lease_epoch is distinct from v_key.lease_epoch
    or v_lease.released_at is not null or v_lease.lease_expires_at <= v_now
  ) then return null; end if;
  update council_seat_keys set claimed_at = coalesce(claimed_at, v_now) where id = v_key.id;
  return jsonb_build_object('session_id', v_key.session_id, 'seat_name', v_key.seat_name,
                           'code', v_code, 'issuer', v_key.issued_by);
end;
$$;

revoke all on function public.resolve_council_seat_key(text) from public, anon, authenticated;
grant execute on function public.resolve_council_seat_key(text) to service_role;

commit;

-- ===== Council execution attribution =====
begin;

alter table public.council_agent_executions
  add column if not exists seat_token_hash text;
create unique index if not exists idx_council_execution_seat_token
  on public.council_agent_executions(seat_token_hash) where seat_token_hash is not null;

alter table public.council_seat_keys
  add column if not exists execution_id uuid references public.council_agent_executions(id),
  add column if not exists execution_binding_required boolean not null default false;
alter table public.council_messages
  add column if not exists execution_id uuid references public.council_agent_executions(id);
alter table public.council_work_items
  add column if not exists submitted_execution_id uuid references public.council_agent_executions(id),
  add column if not exists accepted_execution_id uuid references public.council_agent_executions(id);
alter table public.council_verification_runs
  add column if not exists execution_id uuid references public.council_agent_executions(id);

create or replace function public.council_execution_facts_immutable()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if (to_jsonb(new) - 'ended_at' - 'stop_reason') is distinct from
     (to_jsonb(old) - 'ended_at' - 'stop_reason') or
     (old.ended_at is not null and new.ended_at is distinct from old.ended_at) or
     (old.stop_reason is not null and new.stop_reason is distinct from old.stop_reason) then
    raise exception 'Council execution facts are immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists council_execution_facts_immutable on public.council_agent_executions;
create trigger council_execution_facts_immutable before update on public.council_agent_executions
  for each row execute function public.council_execution_facts_immutable();

create or replace function public.council_execution_evidence(
  p_execution_id uuid, p_session_id uuid, p_agent_name text
) returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'executionId', e.id, 'agentName', p.name, 'connectorKind', e.connector_kind,
    'identityAssurance', e.identity_assurance, 'provider', e.provider,
    'adapterVersion', e.adapter_version, 'requestedModel', e.requested_model,
    'effectiveModel', e.effective_model, 'requestedReasoningEffort', e.requested_reasoning_effort,
    'effectiveReasoningEffort', e.effective_reasoning_effort, 'modelSource', e.model_source
  ) from council_agent_executions e join council_participants p on p.id = e.participant_id
   where e.id = p_execution_id and e.session_id = p_session_id
     and p.session_id = p_session_id and p.name = p_agent_name and p.kind = 'agent';
$$;

create or replace function public.council_validate_execution_write(
  p_session_id uuid, p_agent_name text, p_seat_token_hash text, p_expected_execution_id uuid
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_session council_sessions; v_key council_seat_keys; v_seed council_seat_keys;
  v_lease council_host_leases; v_execution council_agent_executions;
  v_participant uuid; v_now timestamptz;
begin
  select * into v_session from council_sessions where id = p_session_id for update;
  if v_session.id is null or v_session.status = 'expired' then
    return jsonb_build_object('ok', false, 'reason', 'inactive_session');
  end if;
  select * into v_seed from council_seat_keys where token_hash = p_seat_token_hash;
  if v_seed.id is null or v_seed.session_id is distinct from p_session_id then
    return jsonb_build_object('ok', false, 'reason', 'invalid_credential');
  end if;
  if v_seed.issued_by = 'host' then
    select * into v_lease from council_host_leases where session_id = p_session_id for share;
  end if;
  select * into v_key from council_seat_keys
   where id = v_seed.id and token_hash = p_seat_token_hash for update;
  v_now := clock_timestamp();
  if v_key.id is null or v_key.session_id is distinct from p_session_id
     or v_key.seat_name is distinct from p_agent_name or v_key.revoked_at is not null
     or v_key.expires_at <= v_now or
     row(v_key.issued_by, v_key.host_id, v_key.lease_epoch) is distinct from
     row(v_seed.issued_by, v_seed.host_id, v_seed.lease_epoch) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_credential');
  end if;
  if v_key.issued_by = 'host' and (
    v_lease.session_id is null or v_lease.host_id is distinct from v_key.host_id
    or v_lease.lease_epoch is distinct from v_key.lease_epoch
    or v_lease.released_at is not null or v_lease.lease_expires_at <= v_now
  ) then return jsonb_build_object('ok', false, 'reason', 'stale_host'); end if;
  if v_key.execution_id is distinct from p_expected_execution_id then
    return jsonb_build_object('ok', false, 'reason', 'execution_mismatch');
  end if;
  if not v_key.execution_binding_required then
    if v_key.execution_id is not null then
      return jsonb_build_object('ok', false, 'reason', 'invalid_binding');
    end if;
    return jsonb_build_object('ok', true, 'executionId', null);
  end if;
  if v_key.issued_by <> 'host' or v_key.execution_id is null then
    return jsonb_build_object('ok', false, 'reason', 'execution_not_bound');
  end if;
  select id into v_participant from council_participants
   where session_id = p_session_id and name = p_agent_name and kind = 'agent' for share;
  select * into v_execution from council_agent_executions where id = v_key.execution_id for share;
  if v_participant is null or v_execution.id is null or v_execution.ended_at is not null
     or v_execution.session_id is distinct from p_session_id
     or v_execution.participant_id is distinct from v_participant
     or v_execution.host_id is distinct from v_key.host_id
     or v_execution.lease_epoch is distinct from v_key.lease_epoch
     or v_execution.seat_token_hash is distinct from p_seat_token_hash then
    return jsonb_build_object('ok', false, 'reason', 'inactive_execution');
  end if;
  v_now := clock_timestamp();
  if v_key.expires_at <= v_now or v_lease.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'expired_credential');
  end if;
  return jsonb_build_object('ok', true, 'executionId', v_execution.id);
end;
$$;

create or replace function public.issue_council_host_seat_key(
  p_session_id uuid, p_seat_name text, p_token_hash text,
  p_expires_at timestamptz, p_host_id uuid, p_lease_epoch bigint
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session council_sessions; v_lease council_host_leases; v_kind text; v_now timestamptz;
begin
  select * into v_session from council_sessions where id = p_session_id for share;
  if v_session.id is null or v_session.status = 'expired' then
    return jsonb_build_object('ok', false, 'reason', 'inactive_session');
  end if;
  select * into v_lease from council_host_leases where session_id = p_session_id for update;
  v_now := clock_timestamp();
  if v_lease.session_id is null or v_lease.host_id is distinct from p_host_id
     or v_lease.lease_epoch is distinct from p_lease_epoch or v_lease.released_at is not null
     or v_lease.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'stale_host');
  end if;
  select kind into v_kind from council_participants
   where session_id = p_session_id and name = p_seat_name for share;
  if v_kind is null then return jsonb_build_object('ok', false, 'reason', 'not_on_roster'); end if;
  if v_kind <> 'agent' then return jsonb_build_object('ok', false, 'reason', 'not_an_agent_seat'); end if;
  v_now := clock_timestamp();
  if p_expires_at is null or not isfinite(p_expires_at) or p_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'invalid_expiry');
  end if;
  insert into council_seat_keys (
    session_id, seat_name, token_hash, expires_at, issued_by, host_id, lease_epoch,
    execution_id, execution_binding_required
  ) values (
    p_session_id, p_seat_name, p_token_hash, least(p_expires_at, v_now + interval '24 hours'),
    'host', p_host_id, p_lease_epoch, null, false
  ) on conflict (session_id, seat_name) do update
    set token_hash = excluded.token_hash, expires_at = excluded.expires_at,
        issued_at = clock_timestamp(), claimed_at = null, revoked_at = null,
        issued_by = 'host', host_id = excluded.host_id, lease_epoch = excluded.lease_epoch,
        execution_id = null, execution_binding_required = false;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.issue_council_bound_host_seat_key(
  p_session_id uuid, p_seat_name text, p_token_hash text,
  p_expires_at timestamptz, p_host_id uuid, p_lease_epoch bigint
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_result jsonb;
begin
  if exists (select 1 from council_agent_executions where seat_token_hash = p_token_hash) then
    return jsonb_build_object('ok', false, 'reason', 'credential_already_used');
  end if;
  v_result := issue_council_host_seat_key(p_session_id, p_seat_name, p_token_hash,
    p_expires_at, p_host_id, p_lease_epoch);
  if v_result->>'ok' <> 'true' then return v_result; end if;
  update council_seat_keys set execution_binding_required = true
   where session_id = p_session_id and seat_name = p_seat_name and token_hash = p_token_hash;
  return jsonb_build_object('ok', true, 'executionBindingRequired', true);
end;
$$;

create or replace function public.start_council_bound_agent_execution(
  p_session_id uuid, p_agent_name text, p_host_id uuid, p_lease_epoch bigint,
  p_host_generation text, p_connector_kind text, p_connector_capabilities jsonb,
  p_capability_source text, p_identity_assurance text, p_provider text,
  p_adapter_version text, p_requested_model text, p_effective_model text,
  p_requested_reasoning_effort text, p_effective_reasoning_effort text,
  p_model_source text, p_branch_name text, p_worktree_path text, p_base_sha text,
  p_seat_token_hash text
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_key council_seat_keys; v_lease council_host_leases; v_result jsonb;
        v_status text; v_now timestamptz; v_participant uuid;
begin
  select status into v_status from council_sessions where id = p_session_id for update;
  if v_status is null or v_status = 'expired' then
    return jsonb_build_object('ok', false, 'reason', 'inactive_session');
  end if;
  select * into v_lease from council_host_leases where session_id = p_session_id for share;
  select * into v_key from council_seat_keys
   where session_id = p_session_id and seat_name = p_agent_name and token_hash = p_seat_token_hash for update;
  select id into v_participant from council_participants
   where session_id = p_session_id and name = p_agent_name and kind = 'agent' for update;
  if v_participant is null then return jsonb_build_object('ok', false, 'reason', 'not_on_roster'); end if;
  perform 1 from council_agent_executions where participant_id = v_participant and ended_at is null for update;
  v_now := clock_timestamp();
  if v_lease.session_id is null or v_lease.host_id is distinct from p_host_id
     or v_lease.lease_epoch is distinct from p_lease_epoch or v_lease.released_at is not null
     or v_lease.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'stale_host');
  end if;
  if v_key.id is null or v_key.issued_by <> 'host' or not v_key.execution_binding_required
     or v_key.host_id is distinct from p_host_id or v_key.lease_epoch is distinct from p_lease_epoch
     or v_key.revoked_at is not null or v_key.expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'invalid_credential');
  end if;
  if v_key.execution_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'execution_already_bound');
  end if;
  v_result := council_start_execution_record(p_session_id, p_agent_name, p_host_id, p_lease_epoch,
    p_host_generation, p_connector_kind, p_connector_capabilities, p_capability_source,
    p_identity_assurance, p_provider, p_adapter_version, p_requested_model, p_effective_model,
    p_requested_reasoning_effort, p_effective_reasoning_effort, p_model_source,
    p_branch_name, p_worktree_path, p_base_sha, p_seat_token_hash);
  if v_result->>'ok' <> 'true' then return v_result; end if;
  update council_seat_keys set execution_id = (v_result->>'executionId')::uuid where id = v_key.id;
  return v_result || jsonb_build_object('seatBound', true);
end;
$$;

create or replace function public.append_council_message_attributed(
  p_session_id uuid, p_speaker text, p_role text, p_intent text, p_body text, p_client_key text,
  p_seat_token_hash text, p_expected_execution_id uuid,
  p_addressed_to text default 'all', p_reply_to_seq integer default null,
  p_ack_seq integer default null, p_posts_per_round integer default 2, p_stale_seconds integer default 180
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_identity jsonb; v_result jsonb; v_execution uuid;
begin
  if p_role is distinct from 'agent' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_role');
  end if;
  v_identity := council_validate_execution_write(p_session_id, p_speaker, p_seat_token_hash, p_expected_execution_id);
  if v_identity->>'ok' <> 'true' then return v_identity; end if;
  v_result := append_council_message(p_session_id, p_speaker, p_role, p_intent, p_body, p_client_key,
    p_addressed_to, p_reply_to_seq, p_ack_seq, p_posts_per_round, p_stale_seconds);
  if v_result->>'ok' = 'true' then
    if coalesce((v_result->>'duplicate')::boolean, false) is false then
      update council_messages set execution_id = (v_identity->>'executionId')::uuid
       where session_id = p_session_id and seq = (v_result->>'seq')::integer;
    end if;
    select execution_id into v_execution from council_messages
     where session_id = p_session_id and seq = (v_result->>'seq')::integer;
    v_result := v_result || jsonb_build_object('executionId', v_execution);
  end if;
  return v_result;
end;
$$;

create or replace function public.complete_council_work_item(
  p_item_id uuid, p_agent_name text, p_commit_hash text, p_verification text
) returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session_id uuid; v_campaign council_campaigns;
begin
  select c.session_id into v_session_id from council_work_items i
    join council_campaigns c on c.id = i.campaign_id where i.id = p_item_id;
  if v_session_id is null then return false; end if;
  perform 1 from council_sessions where id = v_session_id for update;
  select * into v_campaign from council_campaigns where session_id = v_session_id;
  if v_campaign.integration_manifest is not null then return false; end if;
  update council_work_items
     set status = 'awaiting_review', heartbeat_at = clock_timestamp(), commit_hash = p_commit_hash,
         verification = p_verification, completed_at = clock_timestamp(),
         submitted_execution_id = null, accepted_execution_id = null, accepted_commit_sha = null,
         verification_run_id = null, host_verified = null, host_verification = null, host_checked_at = null,
         reviewed_at = null
   where id = p_item_id and campaign_id = v_campaign.id and agent_name = p_agent_name and status = 'in_progress';
  return found;
end;
$$;

create or replace function public.complete_council_work_item_attributed(
  p_item_id uuid, p_agent_name text, p_commit_hash text, p_verification text,
  p_seat_token_hash text, p_expected_execution_id uuid
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session_id uuid; v_identity jsonb;
begin
  select c.session_id into v_session_id from council_work_items i
    join council_campaigns c on c.id = i.campaign_id where i.id = p_item_id;
  if v_session_id is null then return jsonb_build_object('ok', false, 'reason', 'no_item'); end if;
  v_identity := council_validate_execution_write(v_session_id, p_agent_name, p_seat_token_hash, p_expected_execution_id);
  if v_identity->>'ok' <> 'true' then return v_identity; end if;
  if p_commit_hash is null or p_commit_hash !~ '^[0-9a-fA-F]{40}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_commit');
  end if;
  if not complete_council_work_item(p_item_id, p_agent_name, lower(p_commit_hash), p_verification) then
    return jsonb_build_object('ok', false, 'reason', 'not_active_work');
  end if;
  update council_work_items set submitted_execution_id = (v_identity->>'executionId')::uuid where id = p_item_id;
  return v_identity;
end;
$$;

create or replace function public.issue_council_seat_key(
  p_session_id uuid, p_seat_name text, p_token_hash text, p_expires_at timestamptz
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session council_sessions; v_campaign council_campaigns; v_kind text; v_now timestamptz;
begin
  select * into v_session from council_sessions where id = p_session_id for share;
  if v_session.id is null or v_session.status not in ('open', 'concluding', 'closed') or v_session.paused_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'inactive_session');
  end if;
  if v_session.status = 'closed' then
    select * into v_campaign from council_campaigns where session_id = p_session_id for share;
    if v_campaign.id is null or not (
      v_campaign.status in ('running', 'blocked') or
      (v_campaign.status = 'complete' and coalesce(v_campaign.integration_status, 'pending') in ('pending', 'running'))
    ) then return jsonb_build_object('ok', false, 'reason', 'inactive_session'); end if;
  end if;
  select kind into v_kind from council_participants
   where session_id = p_session_id and name = p_seat_name for share;
  if v_kind is null then return jsonb_build_object('ok', false, 'reason', 'not_on_roster'); end if;
  if v_kind <> 'agent' then return jsonb_build_object('ok', false, 'reason', 'not_an_agent_seat'); end if;
  v_now := clock_timestamp();
  if p_expires_at is null or not isfinite(p_expires_at) or p_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'invalid_expiry');
  end if;
  insert into council_seat_keys (
    session_id, seat_name, token_hash, expires_at, issued_by, host_id, lease_epoch
  ) values (
    p_session_id, p_seat_name, p_token_hash, least(p_expires_at, v_now + interval '24 hours'), 'owner', null, null
  ) on conflict (session_id, seat_name) do update
    set token_hash = excluded.token_hash, expires_at = excluded.expires_at,
        issued_at = clock_timestamp(), claimed_at = null, revoked_at = null,
        issued_by = 'owner', host_id = null, lease_epoch = null,
        execution_id = null, execution_binding_required = false;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.resolve_council_seat_key(p_token_hash text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_seed council_seat_keys;
  v_key council_seat_keys;
  v_lease council_host_leases;
  v_status text;
  v_code text;
  v_now timestamptz;
begin
  -- The first lookup only chooses the session and lease lock order.
  select * into v_seed from council_seat_keys where token_hash = p_token_hash;
  if v_seed.id is null then return null; end if;
  select status, code into v_status, v_code from council_sessions
   where id = v_seed.session_id for share;
  if v_status is null or v_status = 'expired' then return null; end if;
  if v_seed.issued_by = 'host' then
    select * into v_lease from council_host_leases where session_id = v_seed.session_id for share;
  end if;
  select * into v_key from council_seat_keys
   where id = v_seed.id and token_hash = p_token_hash for update;
  v_now := clock_timestamp();
  if v_key.id is null or v_key.revoked_at is not null or v_key.expires_at <= v_now then return null; end if;
  if row(v_key.session_id, v_key.seat_name, v_key.issued_by, v_key.host_id, v_key.lease_epoch)
     is distinct from row(v_seed.session_id, v_seed.seat_name, v_seed.issued_by, v_seed.host_id, v_seed.lease_epoch) then
    return null;
  end if;
  if v_key.issued_by = 'host' and (
    v_lease.session_id is null or v_lease.host_id is distinct from v_key.host_id
    or v_lease.lease_epoch is distinct from v_key.lease_epoch
    or v_lease.released_at is not null or v_lease.lease_expires_at <= v_now
  ) then return null; end if;
  update council_seat_keys set claimed_at = coalesce(claimed_at, v_now) where id = v_key.id;
  return jsonb_build_object('session_id', v_key.session_id, 'seat_name', v_key.seat_name,
                           'code', v_code, 'issuer', v_key.issued_by, 'execution_id', v_key.execution_id,
                           'execution_binding_required', v_key.execution_binding_required,
                           'host_id', v_key.host_id, 'lease_epoch', v_key.lease_epoch);
end;
$$;

create or replace function public.council_start_execution_record(
  p_session_id uuid, p_agent_name text, p_host_id uuid, p_lease_epoch bigint,
  p_host_generation text, p_connector_kind text, p_connector_capabilities jsonb,
  p_capability_source text, p_identity_assurance text, p_provider text,
  p_adapter_version text, p_requested_model text, p_effective_model text,
  p_requested_reasoning_effort text, p_effective_reasoning_effort text,
  p_model_source text, p_branch_name text, p_worktree_path text, p_base_sha text, p_seat_token_hash text
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_participant uuid; v_previous uuid; v_id uuid; v_lease council_host_leases; v_status text; v_now timestamptz;
begin
  select status into v_status from council_sessions where id = p_session_id for update;
  if v_status is null or v_status = 'expired' then
    return jsonb_build_object('ok', false, 'reason', 'inactive_session');
  end if;
  select * into v_lease from council_host_leases where session_id = p_session_id for share;
  v_now := clock_timestamp();
  if v_lease.session_id is null or v_lease.host_id is distinct from p_host_id
     or v_lease.lease_epoch is distinct from p_lease_epoch or v_lease.released_at is not null
     or v_lease.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'stale_host');
  end if;
  if p_seat_token_hash is not null and exists (
    select 1 from council_agent_executions where seat_token_hash = p_seat_token_hash
  ) then return jsonb_build_object('ok', false, 'reason', 'credential_already_used'); end if;
  select id into v_participant from council_participants
   where session_id = p_session_id and name = p_agent_name and kind = 'agent' for update;
  if v_participant is null then return jsonb_build_object('ok', false, 'reason', 'not_on_roster'); end if;
  perform 1 from council_agent_executions where participant_id = v_participant and ended_at is null for update;
  if v_lease.lease_expires_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'stale_host');
  end if;
  select id into v_previous from council_agent_executions
   where participant_id = v_participant order by started_at desc, id desc limit 1;
  update council_agent_executions
     set ended_at = coalesce(ended_at, clock_timestamp()), stop_reason = coalesce(stop_reason, 'replaced')
   where participant_id = v_participant and ended_at is null;
  insert into council_agent_executions (
    session_id, participant_id, host_id, lease_epoch, host_generation,
    connector_kind, connector_capabilities, capability_source, identity_assurance,
    provider, adapter_version, requested_model, effective_model,
    requested_reasoning_effort, effective_reasoning_effort, model_source,
    branch_name, worktree_path, base_sha, predecessor_execution_id, seat_token_hash, started_at
  ) values (
    p_session_id, v_participant, p_host_id, p_lease_epoch, p_host_generation,
    p_connector_kind, coalesce(p_connector_capabilities, '{}'), p_capability_source,
    p_identity_assurance, p_provider, p_adapter_version, p_requested_model,
    p_effective_model, p_requested_reasoning_effort, p_effective_reasoning_effort,
    p_model_source, p_branch_name, p_worktree_path, p_base_sha, v_previous, p_seat_token_hash, clock_timestamp()
  ) returning id into v_id;
  return jsonb_build_object('ok', true, 'executionId', v_id);
end;
$$;

create or replace function public.start_council_agent_execution(
  p_session_id uuid, p_agent_name text, p_host_id uuid, p_lease_epoch bigint,
  p_host_generation text, p_connector_kind text, p_connector_capabilities jsonb,
  p_capability_source text, p_identity_assurance text, p_provider text,
  p_adapter_version text, p_requested_model text, p_effective_model text,
  p_requested_reasoning_effort text, p_effective_reasoning_effort text,
  p_model_source text, p_branch_name text, p_worktree_path text, p_base_sha text
) returns jsonb language sql security invoker set search_path = public, pg_temp as $$
  select council_start_execution_record(p_session_id, p_agent_name, p_host_id, p_lease_epoch,
    p_host_generation, p_connector_kind, p_connector_capabilities, p_capability_source,
    p_identity_assurance, p_provider, p_adapter_version, p_requested_model, p_effective_model,
    p_requested_reasoning_effort, p_effective_reasoning_effort, p_model_source,
    p_branch_name, p_worktree_path, p_base_sha, null);
$$;

create or replace function public.stop_council_agent_execution(
  p_execution_id uuid, p_host_id uuid, p_lease_epoch bigint, p_stop_reason text
) returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session_id uuid; v_lease council_host_leases;
begin
  select session_id into v_session_id from council_agent_executions where id = p_execution_id;
  if v_session_id is null then return false; end if;
  perform 1 from council_sessions where id = v_session_id for update;
  select * into v_lease from council_host_leases where session_id = v_session_id for share;
  if v_lease.session_id is null or v_lease.host_id is distinct from p_host_id
     or v_lease.lease_epoch is distinct from p_lease_epoch or v_lease.released_at is not null
     or v_lease.lease_expires_at <= clock_timestamp() then return false; end if;
  update council_agent_executions
     set ended_at = coalesce(ended_at, clock_timestamp()), stop_reason = coalesce(stop_reason, left(p_stop_reason, 500))
   where id = p_execution_id and session_id = v_session_id and host_id = p_host_id and lease_epoch = p_lease_epoch;
  return found;
end;
$$;

create or replace function record_council_verification(
  p_item_id uuid, p_host_id uuid, p_lease_epoch bigint, p_commit_sha text,
  p_base_sha text, p_branch_name text, p_profile_id text,
  p_command_receipts jsonb, p_output_digest text, p_passed boolean, p_report text
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_item council_work_items; v_campaign council_campaigns; v_session_id uuid; v_run uuid;
begin
  select c.session_id into v_session_id from council_work_items i
    join council_campaigns c on c.id = i.campaign_id where i.id = p_item_id;
  if v_session_id is null then return jsonb_build_object('ok', false, 'reason', 'no_item'); end if;
  perform 1 from council_sessions where id = v_session_id for update;
  perform 1 from council_host_leases where session_id = v_session_id for share;
  select * into v_campaign from council_campaigns where session_id = v_session_id;
  if v_campaign.integration_manifest is not null then
    return jsonb_build_object('ok', false, 'reason', 'manifest_frozen');
  end if;
  select * into v_item from council_work_items where id = p_item_id for update;
  if v_item.id is null then return jsonb_build_object('ok', false, 'reason', 'no_item'); end if;
  select * into v_campaign from council_campaigns where id = v_item.campaign_id;
  v_session_id := v_campaign.session_id;
  if not exists (
    select 1 from council_host_leases where session_id = v_session_id
      and host_id = p_host_id and lease_epoch = p_lease_epoch
      and released_at is null and lease_expires_at > clock_timestamp()
  ) then return jsonb_build_object('ok', false, 'reason', 'stale_host'); end if;
  if v_item.status <> 'awaiting_review' then
    return jsonb_build_object('ok', false, 'reason', 'not_awaiting_review');
  end if;
  if v_item.commit_hash is distinct from p_commit_sha then
    return jsonb_build_object('ok', false, 'reason', 'commit_mismatch');
  end if;
  if v_campaign.base_sha is distinct from p_base_sha then
    return jsonb_build_object('ok', false, 'reason', 'base_mismatch');
  end if;
  if v_item.submitted_execution_id is not null and
     council_execution_evidence(v_item.submitted_execution_id, v_session_id, v_item.agent_name) is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_execution');
  end if;
  insert into council_verification_runs (
    work_item_id, host_id, lease_epoch, commit_sha, base_sha, branch_name,
    profile_id, command_receipts, output_digest, passed, report, execution_id
  ) values (
    p_item_id, p_host_id, p_lease_epoch, p_commit_sha, p_base_sha, p_branch_name,
    p_profile_id, coalesce(p_command_receipts, '[]'), p_output_digest, p_passed,
    left(coalesce(p_report, ''), 16000), v_item.submitted_execution_id
  ) returning id into v_run;
  update council_work_items
     set host_verified = p_passed,
         host_verification = left(coalesce(p_report, ''), 16000),
         host_checked_at = now(), verification_run_id = v_run,
         branch_name = p_branch_name, verification_profile = p_profile_id,
         rejections = case when p_passed then rejections else rejections + 1 end,
         status = case
           when p_passed then status
           when rejections + 1 >= max_attempts then 'blocked'
           else 'queued' end,
         blocked_reason = case
           when not p_passed and rejections + 1 >= max_attempts
             then 'host check failed ' || (rejections + 1) || ' time(s); needs a human'
           else blocked_reason end,
         progress = case when p_passed then progress else concat_ws(E'\n', progress,
           'Host check failed: ' || left(coalesce(p_report, ''), 1000)) end
   where id = p_item_id;
  -- The final failed item can leave the campaign blocked.
  update council_campaigns set status = 'blocked'
   where id = v_campaign.id
     and not exists (select 1 from council_work_items
                      where campaign_id = v_campaign.id
                        and status in ('queued', 'in_progress', 'awaiting_review'));
  return jsonb_build_object('ok', true, 'verificationRunId', v_run, 'passed', p_passed);
end;
$$;

create or replace function review_council_work_item(
  p_item_id uuid, p_reviewer text, p_accepted boolean, p_note text
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_item council_work_items; v_campaign council_campaigns;
        v_closer text; v_run council_verification_runs; v_session_id uuid;
begin
  select c.session_id into v_session_id from council_work_items i
    join council_campaigns c on c.id = i.campaign_id where i.id = p_item_id;
  if v_session_id is null then return jsonb_build_object('ok', false, 'reason', 'no_such_item'); end if;
  perform 1 from council_sessions where id = v_session_id for update;
  select * into v_campaign from council_campaigns where session_id = v_session_id;
  if v_campaign.integration_manifest is not null then
    return jsonb_build_object('ok', false, 'reason', 'manifest_frozen');
  end if;
  select * into v_item from council_work_items where id = p_item_id for update;
  if v_item.id is null then return jsonb_build_object('ok', false, 'reason', 'no_such_item'); end if;
  select * into v_campaign from council_campaigns where id = v_item.campaign_id;
  select closer_name into v_closer from council_sessions where id = v_campaign.session_id;
  if v_closer <> p_reviewer then return jsonb_build_object('ok', false, 'reason', 'not_the_closer'); end if;
  if v_item.status <> 'awaiting_review' then
    return jsonb_build_object('ok', false, 'reason', 'not_awaiting_review');
  end if;
  if p_accepted then
    select * into v_run from council_verification_runs where id = v_item.verification_run_id;
    if v_run.id is null or v_run.passed is not true
       or v_run.work_item_id is distinct from v_item.id
       or v_run.execution_id is distinct from v_item.submitted_execution_id
       or v_run.commit_sha is distinct from v_item.commit_hash
       or v_run.base_sha is distinct from v_campaign.base_sha
       or v_run.profile_id is distinct from v_item.verification_profile then
      return jsonb_build_object('ok', false, 'reason', 'not_exactly_verified');
    end if;
    update council_work_items
       set status = 'verified', accepted_commit_sha = commit_hash, accepted_execution_id = submitted_execution_id,
           verification = concat_ws(E'\n', verification, 'Review: ' || p_note), reviewed_at = now()
     where id = p_item_id;
  else
    update council_work_items
       set rejections = rejections + 1,
           status = case when rejections + 1 >= max_attempts then 'blocked' else 'queued' end,
           blocked_reason = case when rejections + 1 >= max_attempts
             then 'sent back ' || (rejections + 1) || ' time(s); needs a human'
             else blocked_reason end,
           progress = concat_ws(E'\n', progress, 'Review feedback: ' || p_note),
           heartbeat_at = null, completed_at = null, lease_owner = null, lease_expires_at = null,
           host_verified = null, host_verification = null, host_checked_at = null,
           verification_run_id = null, accepted_commit_sha = null, accepted_execution_id = null
     where id = p_item_id;
  end if;
  update council_campaigns set status = case
      when not exists (select 1 from council_work_items where campaign_id = v_campaign.id and status <> 'verified') then 'complete'
      when exists (select 1 from council_work_items where campaign_id = v_campaign.id and status = 'blocked')
       and not exists (select 1 from council_work_items where campaign_id = v_campaign.id and status in ('queued', 'in_progress', 'awaiting_review')) then 'blocked'
      else 'running' end,
    completed_at = case when not exists (
      select 1 from council_work_items where campaign_id = v_campaign.id and status <> 'verified'
    ) then now() else null end
  where id = v_campaign.id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function freeze_council_integration_manifest(
  p_session_id uuid, p_host_id uuid, p_lease_epoch bigint
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_campaign council_campaigns; v_manifest jsonb;
begin
  perform 1 from council_sessions where id = p_session_id for update;
  perform 1 from council_host_leases where session_id = p_session_id for share;
  select * into v_campaign from council_campaigns where session_id = p_session_id for update;
  if v_campaign.id is null then return jsonb_build_object('ok', false, 'reason', 'no_campaign'); end if;
  if not exists (
    select 1 from council_host_leases where session_id = p_session_id
      and host_id = p_host_id and lease_epoch = p_lease_epoch
      and released_at is null and lease_expires_at > clock_timestamp()
  ) then return jsonb_build_object('ok', false, 'reason', 'stale_host'); end if;
  if v_campaign.integration_manifest is not null then
    return jsonb_build_object('ok', true, 'manifest', v_campaign.integration_manifest, 'frozen', true);
  end if;
  if v_campaign.status <> 'complete' or exists (
    select 1 from council_work_items where campaign_id = v_campaign.id
      and (status <> 'verified' or accepted_commit_sha is null)
  ) then return jsonb_build_object('ok', false, 'reason', 'campaign_incomplete'); end if;
  if exists (
    select 1 from council_work_items i left join council_verification_runs r on r.id = i.verification_run_id
     where i.campaign_id = v_campaign.id and (
       r.id is null or r.work_item_id is distinct from i.id or r.passed is not true
       or r.commit_sha is distinct from i.accepted_commit_sha or i.commit_hash is distinct from i.accepted_commit_sha
       or r.base_sha is distinct from v_campaign.base_sha or r.profile_id is distinct from i.verification_profile
       or r.execution_id is distinct from i.accepted_execution_id
       or i.submitted_execution_id is distinct from i.accepted_execution_id
       or (i.accepted_execution_id is not null and council_execution_evidence(i.accepted_execution_id, p_session_id, i.agent_name) is null)
     )
  ) then return jsonb_build_object('ok', false, 'reason', 'not_exactly_verified'); end if;
  select jsonb_build_object(
    'version', 1, 'campaignId', v_campaign.id, 'baseSha', v_campaign.base_sha,
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'itemId', id, 'sequence', sequence, 'agentName', agent_name,
      'branch', branch_name, 'commitSha', accepted_commit_sha,
      'verificationRunId', verification_run_id, 'dependencies', dependencies,
      'acceptedExecutionId', accepted_execution_id,
      'executionEvidence', council_execution_evidence(accepted_execution_id, p_session_id, agent_name)
    ) order by sequence), '[]'::jsonb)
  ) into v_manifest from council_work_items where campaign_id = v_campaign.id;
  update council_campaigns
     set integration_manifest = v_manifest, manifest_frozen_at = now(),
         integration_status = coalesce(integration_status, 'pending')
   where id = v_campaign.id;
  return jsonb_build_object('ok', true, 'manifest', v_manifest, 'frozen', false);
end;
$$;

create or replace function join_council(
  p_session_id uuid, p_agent_name text, p_expertise text default '',
  p_dispatch_mode boolean default null
)
returns jsonb
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare v_kind text; v_live integer;
begin
  perform 1 from council_sessions where id = p_session_id for update;
  select kind into v_kind from council_participants
   where session_id = p_session_id and name = p_agent_name;
  if v_kind is null then
    return jsonb_build_object('ok', false, 'reason', 'not_on_roster');
  end if;
  update council_participants
     set status = case when status = 'invited' then 'active' else status end,
         expertise = case when p_expertise <> '' then p_expertise else expertise end,
         dispatch_mode = coalesce(p_dispatch_mode, dispatch_mode),
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

create or replace function claim_council_work_item(p_session_id uuid, p_agent_name text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_item council_work_items; v_campaign council_campaigns; v_status text;
begin
  perform 1 from council_sessions where id = p_session_id for update;
  select * into v_campaign from council_campaigns where session_id = p_session_id for update;
  if v_campaign.id is null or v_campaign.status <> 'running' or v_campaign.integration_manifest is not null then return null; end if;

  update council_work_items
     set status = 'queued',
         lease_owner = null, lease_expires_at = null, heartbeat_at = null
   where campaign_id = v_campaign.id
     and status = 'in_progress'
     and lease_expires_at is not null
     and lease_expires_at < now();

  update council_campaigns set status = 'blocked'
   where id = v_campaign.id
     and not exists (select 1 from council_work_items
                      where campaign_id = v_campaign.id
                        and status in ('queued', 'in_progress', 'awaiting_review'));
  select status into v_status from council_campaigns where id = v_campaign.id;
  if v_status <> 'running' then return null; end if;

  select w.* into v_item from council_work_items w
   where w.campaign_id = v_campaign.id and w.agent_name = p_agent_name
     and w.status = 'in_progress' order by w.sequence limit 1 for update;
  if v_item.id is null then
    select w.* into v_item from council_work_items w
     where w.campaign_id = v_campaign.id and w.agent_name = p_agent_name
       and w.status = 'queued' order by w.sequence limit 1 for update skip locked;
    if v_item.id is null then return null; end if;
    update council_work_items
       set status = 'in_progress', attempts = attempts + 1,
           started_at = coalesce(started_at, now()), heartbeat_at = now(),
           lease_owner = p_agent_name, lease_expires_at = now() + interval '45 minutes'
     where id = v_item.id returning * into v_item;
  else
    update council_work_items
       set heartbeat_at = now(), lease_owner = p_agent_name,
           lease_expires_at = now() + interval '45 minutes'
     where id = v_item.id returning * into v_item;
  end if;
  return to_jsonb(v_item);
end;
$$;

create or replace function block_council_work_item(p_item_id uuid, p_agent_name text, p_reason text)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_campaign_id uuid; v_session_id uuid;
begin
  select c.session_id into v_session_id from council_work_items i
    join council_campaigns c on c.id = i.campaign_id where i.id = p_item_id;
  if v_session_id is null then return false; end if;
  perform 1 from council_sessions where id = v_session_id for update;
  if exists (select 1 from council_campaigns where session_id = v_session_id and integration_manifest is not null) then return false; end if;
  update council_work_items set status = 'blocked', blocked_reason = p_reason, heartbeat_at = now() where id = p_item_id and agent_name = p_agent_name and status in ('queued', 'in_progress') returning campaign_id into v_campaign_id;
  if not found then return false; end if;
  update council_campaigns set status = 'blocked' where id = v_campaign_id and not exists (select 1 from council_work_items where campaign_id = v_campaign_id and status in ('queued', 'in_progress', 'awaiting_review'));
  return true;
end;
$$;

do $$
declare v_function regprocedure;
begin
  for v_function in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(array[
      'council_execution_facts_immutable', 'council_execution_evidence', 'council_validate_execution_write',
      'issue_council_host_seat_key', 'issue_council_bound_host_seat_key', 'issue_council_seat_key',
      'resolve_council_seat_key', 'council_start_execution_record', 'start_council_agent_execution',
      'start_council_bound_agent_execution', 'stop_council_agent_execution',
      'append_council_message_attributed', 'complete_council_work_item', 'complete_council_work_item_attributed',
      'record_council_verification', 'review_council_work_item', 'freeze_council_integration_manifest',
      'join_council', 'claim_council_work_item', 'block_council_work_item'
    ])
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;
end;
$$;

commit;

-- ===== Council owner merge package =====

create table if not exists council_integration_attempts (
  id uuid primary key,
  session_id uuid not null references council_sessions(id),
  campaign_id uuid not null references council_campaigns(id),
  attempt_number integer not null check (attempt_number > 0),
  host_id uuid not null,
  lease_epoch bigint not null,
  status text not null default 'running' check (status in ('running', 'verified', 'conflict', 'failed')),
  mode text not null check (mode in ('host', 'agent')),
  integrator_agent text,
  manifest jsonb not null,
  manifest_hash text not null,
  base_branch text not null,
  base_sha text not null,
  decision text,
  open_questions jsonb not null default '[]',
  started_at timestamptz not null default clock_timestamp(),
  branch text,
  tip_sha text,
  execution_id uuid references council_agent_executions(id),
  execution_evidence jsonb,
  evidence jsonb,
  result_digest text,
  finished_at timestamptz,
  unique (campaign_id, attempt_number),
  check ((mode = 'host' and integrator_agent is null) or (mode = 'agent' and integrator_agent is not null)),
  check ((status = 'running' and finished_at is null and result_digest is null)
    or (status <> 'running' and finished_at is not null and result_digest is not null))
);
create unique index if not exists idx_council_integration_attempt_running
  on council_integration_attempts(campaign_id) where status = 'running';
create index if not exists idx_council_integration_attempt_history
  on council_integration_attempts(session_id, attempt_number desc);
alter table council_integration_attempts enable row level security;
revoke all on council_integration_attempts from public, anon, authenticated;
grant select, insert, update on council_integration_attempts to service_role;

create or replace function council_integration_attempt_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'integration attempts are immutable'; end if;
  if to_jsonb(new) = to_jsonb(old) then return new; end if;
  if old.status <> 'running' or new.status = 'running'
    or (to_jsonb(new) - array['status','branch','tip_sha','execution_id','execution_evidence','evidence','result_digest','finished_at'])
      is distinct from (to_jsonb(old) - array['status','branch','tip_sha','execution_id','execution_evidence','evidence','result_digest','finished_at']) then
    raise exception 'integration attempt facts and terminal results are immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists council_integration_attempt_immutable on council_integration_attempts;
create trigger council_integration_attempt_immutable before update or delete on council_integration_attempts
  for each row execute function council_integration_attempt_immutable();

create or replace function council_integration_attempt_json(p_attempt council_integration_attempts)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', p_attempt.id, 'sessionId', p_attempt.session_id, 'campaignId', p_attempt.campaign_id,
    'attemptNumber', p_attempt.attempt_number, 'status', p_attempt.status, 'mode', p_attempt.mode,
    'integratorAgent', p_attempt.integrator_agent, 'manifest', p_attempt.manifest,
    'manifestHash', p_attempt.manifest_hash, 'baseBranch', p_attempt.base_branch,
    'baseSha', p_attempt.base_sha, 'decision', p_attempt.decision,
    'openQuestions', p_attempt.open_questions, 'startedAt', p_attempt.started_at
  );
$$;

create or replace function council_integration_evidence_valid(p_evidence jsonb)
returns boolean language plpgsql immutable as $$
declare v_receipt jsonb; v_value jsonb; v_refs jsonb; v_text text;
begin
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'object'
    or p_evidence->'version' is distinct from '1'::jsonb
    or p_evidence->'redactionVersion' is distinct from '1'::jsonb
    or (select count(*) from jsonb_object_keys(p_evidence)) <> 8
    or not p_evidence ?& array['version','redactionVersion','receipts','changedPaths','diffSummary','protectedRefs','conflictNotes','manualChecks']
    or exists (select 1 from jsonb_object_keys(p_evidence) k where k not in ('version','redactionVersion','receipts','changedPaths','diffSummary','protectedRefs','conflictNotes','manualChecks')) then return false; end if;
  if jsonb_typeof(p_evidence->'receipts') <> 'array' or jsonb_array_length(p_evidence->'receipts') > 64 then return false; end if;
  for v_receipt in select value from jsonb_array_elements(p_evidence->'receipts') loop
    if jsonb_typeof(v_receipt) <> 'object' or (select count(*) from jsonb_object_keys(v_receipt)) <> 6
      or not v_receipt ?& array['command','exitCode','durationMs','outputDigest','outputTail','timedOut'] then return false; end if;
    if jsonb_typeof(v_receipt->'command') <> 'array' or jsonb_array_length(v_receipt->'command') not between 1 and 64 then return false; end if;
    for v_value in select value from jsonb_array_elements(v_receipt->'command') loop
      if jsonb_typeof(v_value) <> 'string' or length(v_value #>> '{}') > 2048 then return false; end if;
    end loop;
    if (v_receipt->'exitCode' <> 'null'::jsonb and (jsonb_typeof(v_receipt->'exitCode') <> 'number' or (v_receipt->>'exitCode') !~ '^-?[0-9]+$'))
      or jsonb_typeof(v_receipt->'durationMs') <> 'number' or (v_receipt->>'durationMs')::numeric < 0
      or jsonb_typeof(v_receipt->'outputDigest') <> 'string' or (v_receipt->>'outputDigest') !~* '^[a-f0-9]{64}$'
      or jsonb_typeof(v_receipt->'outputTail') <> 'string' or length(v_receipt->>'outputTail') > 4000
      or jsonb_typeof(v_receipt->'timedOut') <> 'boolean' then return false; end if;
  end loop;
  if p_evidence->'changedPaths' <> 'null'::jsonb then
    if jsonb_typeof(p_evidence->'changedPaths') <> 'array' or jsonb_array_length(p_evidence->'changedPaths') > 500 then return false; end if;
    for v_value in select value from jsonb_array_elements(p_evidence->'changedPaths') loop
      v_text := v_value #>> '{}';
      if jsonb_typeof(v_value) <> 'string' or length(v_text) not between 1 and 1024
        or v_text ~ '[:\\]' or v_text ~ U&'[\0001-\001f\007f-\009f\202a-\202e\2066-\2069]'
        or exists (select 1 from unnest(string_to_array(v_text,'/')) p where p in ('','.','..')) then return false; end if;
    end loop;
  end if;
  if p_evidence->'diffSummary' <> 'null'::jsonb and (jsonb_typeof(p_evidence->'diffSummary') <> 'string' or length(p_evidence->>'diffSummary') > 16000) then return false; end if;
  if p_evidence->'conflictNotes' <> 'null'::jsonb and (jsonb_typeof(p_evidence->'conflictNotes') <> 'string' or length(p_evidence->>'conflictNotes') > 8000) then return false; end if;
  if p_evidence->'manualChecks' <> 'null'::jsonb then
    if jsonb_typeof(p_evidence->'manualChecks') <> 'array' or jsonb_array_length(p_evidence->'manualChecks') > 32 then return false; end if;
    for v_value in select value from jsonb_array_elements(p_evidence->'manualChecks') loop
      if jsonb_typeof(v_value) <> 'string' or length(v_value #>> '{}') > 1000 then return false; end if;
    end loop;
  end if;
  if jsonb_typeof(p_evidence->'protectedRefs') <> 'object'
    or (select count(*) from jsonb_object_keys(p_evidence->'protectedRefs')) <> 2
    or not (p_evidence->'protectedRefs') ?& array['before','after'] then return false; end if;
  for v_refs in select value from jsonb_each(p_evidence->'protectedRefs') loop
    if v_refs <> 'null'::jsonb then
      if jsonb_typeof(v_refs) <> 'object' or (select count(*) from jsonb_object_keys(v_refs)) > 64 then return false; end if;
      for v_text, v_value in select key,value from jsonb_each(v_refs) loop
        if length(v_text) not between 1 and 300 or v_text !~* '^[a-z0-9][a-z0-9/_.-]*$'
          or v_text in ('__proto__','constructor','prototype')
          or (v_value <> 'null'::jsonb and (jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') !~* '^[a-f0-9]{40}$')) then return false; end if;
      end loop;
    end if;
  end loop;
  return true;
exception when others then return false;
end;
$$;

create or replace function begin_council_integration_attempt(
  p_session_id uuid, p_host_id uuid, p_lease_epoch bigint, p_attempt_id uuid, p_expected_integrator text
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session council_sessions; v_campaign council_campaigns; v_attempt council_integration_attempts;
  v_running council_integration_attempts; v_now timestamptz; v_hash text; v_number integer;
begin
  select * into v_session from council_sessions where id = p_session_id for update;
  if v_session.id is null then return jsonb_build_object('ok',false,'reason','no_session'); end if;
  perform 1 from council_host_leases where session_id = p_session_id for share;
  select * into v_campaign from council_campaigns where session_id = p_session_id for update;
  v_now := clock_timestamp();
  if not exists (select 1 from council_host_leases where session_id = p_session_id and host_id = p_host_id
    and lease_epoch = p_lease_epoch and released_at is null and lease_expires_at > v_now) then
    return jsonb_build_object('ok',false,'reason','stale_host');
  end if;
  if v_campaign.id is null then return jsonb_build_object('ok',false,'reason','no_campaign'); end if;
  if v_campaign.status <> 'complete' then return jsonb_build_object('ok',false,'reason','campaign_incomplete'); end if;
  if v_campaign.integration_manifest is null or jsonb_typeof(v_campaign.integration_manifest) <> 'object'
    or v_campaign.integration_manifest->>'campaignId' is distinct from v_campaign.id::text
    or v_campaign.integration_manifest->>'baseSha' is distinct from v_campaign.base_sha
    or jsonb_typeof(v_campaign.integration_manifest->'items') is distinct from 'array'
    or v_campaign.base_sha !~ '^[a-f0-9]{40}$' then return jsonb_build_object('ok',false,'reason','manifest_not_frozen'); end if;
  if p_expected_integrator is distinct from v_campaign.integrator_agent then return jsonb_build_object('ok',false,'reason','integrator_changed'); end if;
  if p_attempt_id is null then return jsonb_build_object('ok',false,'reason','invalid_attempt'); end if;
  v_hash := encode(sha256(convert_to(v_campaign.integration_manifest::text,'UTF8')),'hex');
  select * into v_attempt from council_integration_attempts where id = p_attempt_id;
  if v_attempt.id is not null and v_attempt.campaign_id <> v_campaign.id then return jsonb_build_object('ok',false,'reason','attempt_conflict'); end if;
  select * into v_attempt from council_integration_attempts where id = p_attempt_id and campaign_id = v_campaign.id for update;
  if v_attempt.id is not null then
    if not exists (select 1 from council_host_leases where session_id = p_session_id and host_id = p_host_id
      and lease_epoch = p_lease_epoch and released_at is null and lease_expires_at > clock_timestamp()) then return jsonb_build_object('ok',false,'reason','stale_host'); end if;
    if v_attempt.host_id is distinct from p_host_id or v_attempt.lease_epoch is distinct from p_lease_epoch
      or v_attempt.integrator_agent is distinct from p_expected_integrator or v_attempt.manifest_hash is distinct from v_hash then
      return jsonb_build_object('ok',false,'reason','attempt_conflict');
    end if;
    return jsonb_build_object('ok',true,'attempt',council_integration_attempt_json(v_attempt));
  end if;
  select * into v_running from council_integration_attempts where campaign_id = v_campaign.id and status = 'running' for update;
  v_now := clock_timestamp();
  if not exists (select 1 from council_host_leases where session_id = p_session_id and host_id = p_host_id
    and lease_epoch = p_lease_epoch and released_at is null and lease_expires_at > v_now) then return jsonb_build_object('ok',false,'reason','stale_host'); end if;
  if v_running.id is not null then
    if v_running.host_id = p_host_id and v_running.lease_epoch = p_lease_epoch then return jsonb_build_object('ok',false,'reason','attempt_running'); end if;
    update council_integration_attempts set status = 'failed', finished_at = v_now,
      result_digest = encode(sha256(convert_to(jsonb_build_object('reason','superseded_host','attemptId',v_running.id)::text,'UTF8')),'hex')
      where id = v_running.id;
  end if;
  select coalesce(max(attempt_number),0)+1 into v_number from council_integration_attempts where campaign_id = v_campaign.id;
  insert into council_integration_attempts(id,session_id,campaign_id,attempt_number,host_id,lease_epoch,mode,
    integrator_agent,manifest,manifest_hash,base_branch,base_sha,decision,open_questions,started_at)
  values(p_attempt_id,p_session_id,v_campaign.id,v_number,p_host_id,p_lease_epoch,
    case when p_expected_integrator is null then 'host' else 'agent' end,p_expected_integrator,
    v_campaign.integration_manifest,v_hash,v_campaign.base_branch,v_campaign.base_sha,v_session.verdict,
    coalesce(v_session.open_questions,'[]'::jsonb),v_now) returning * into v_attempt;
  update council_campaigns set integration_status='running', integration_branch=null, integration_tip_sha=null,
    integration_report=null, integration_checked_at=null where id=v_campaign.id;
  return jsonb_build_object('ok',true,'attempt',council_integration_attempt_json(v_attempt));
end;
$$;

create or replace function finalize_council_integration_attempt(
  p_attempt_id uuid, p_host_id uuid, p_lease_epoch bigint, p_status text,
  p_branch text, p_tip_sha text, p_execution_id uuid, p_evidence jsonb
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_session_id uuid; v_campaign council_campaigns; v_attempt council_integration_attempts;
  v_execution council_agent_executions; v_execution_evidence jsonb; v_now timestamptz; v_digest text;
begin
  select session_id into v_session_id from council_integration_attempts where id=p_attempt_id;
  if v_session_id is null then return jsonb_build_object('ok',false,'reason','no_attempt'); end if;
  perform 1 from council_sessions where id = v_session_id for update;
  perform 1 from council_host_leases where session_id = v_session_id for share;
  select * into v_campaign from council_campaigns where session_id = v_session_id for update;
  select * into v_attempt from council_integration_attempts where id=p_attempt_id for update;
  v_now := clock_timestamp();
  if v_attempt.host_id is distinct from p_host_id or v_attempt.lease_epoch is distinct from p_lease_epoch
    or not exists (select 1 from council_host_leases where session_id=v_session_id and host_id=p_host_id
      and lease_epoch=p_lease_epoch and released_at is null and lease_expires_at > v_now) then
    return jsonb_build_object('ok',false,'reason','stale_host');
  end if;
  if p_status is null or p_status not in ('verified','conflict','failed')
    or (p_branch is not null and (length(p_branch) not between 1 and 200 or p_branch ~ '[[:cntrl:]]'))
    or (p_tip_sha is not null and p_tip_sha !~* '^[a-f0-9]{40}$')
    or council_integration_evidence_valid(p_evidence) is not true then return jsonb_build_object('ok',false,'reason','invalid_result'); end if;
  v_digest := encode(sha256(convert_to(jsonb_build_object('status',p_status,'branch',p_branch,'tipSha',p_tip_sha,
    'executionId',p_execution_id,'evidence',p_evidence)::text,'UTF8')),'hex');
  if v_attempt.status <> 'running' then
    if v_attempt.result_digest = v_digest then return jsonb_build_object('ok',true,'attemptId',v_attempt.id); end if;
    return jsonb_build_object('ok',false,'reason','result_conflict');
  end if;
  if v_campaign.integration_manifest is distinct from v_attempt.manifest
    or v_campaign.integrator_agent is distinct from v_attempt.integrator_agent then return jsonb_build_object('ok',false,'reason','campaign_changed'); end if;
  if v_attempt.mode = 'host' and p_execution_id is not null then return jsonb_build_object('ok',false,'reason','unexpected_execution'); end if;
  if p_execution_id is not null then
    select * into v_execution from council_agent_executions where id=p_execution_id for share;
    if v_execution.id is null or v_execution.session_id is distinct from v_session_id
      or v_execution.host_id is distinct from p_host_id or v_execution.lease_epoch is distinct from p_lease_epoch
      or v_execution.seat_token_hash is null or v_execution.started_at < v_attempt.started_at
      or (p_branch is not null and v_execution.branch_name is distinct from p_branch)
      or v_execution.base_sha is distinct from v_attempt.base_sha
      or not exists (select 1 from council_participants where id=v_execution.participant_id
        and session_id=v_session_id and name=v_attempt.integrator_agent) then return jsonb_build_object('ok',false,'reason','execution_mismatch'); end if;
    v_execution_evidence := council_execution_evidence(p_execution_id,v_session_id,v_attempt.integrator_agent);
    if v_execution_evidence is null then return jsonb_build_object('ok',false,'reason','execution_mismatch'); end if;
  end if;
  if p_status = 'verified' and (
    p_branch is null or p_tip_sha is null or (v_attempt.mode = 'agent' and p_execution_id is null)
    or p_evidence->'changedPaths' = 'null'::jsonb or p_evidence->'diffSummary' = 'null'::jsonb
    or jsonb_array_length(p_evidence->'receipts') = 0
    or exists (select 1 from jsonb_array_elements(p_evidence->'receipts') r where r->'exitCode' <> '0'::jsonb or r->'timedOut' <> 'false'::jsonb)
    or jsonb_typeof(p_evidence#>'{protectedRefs,before}') <> 'object'
    or p_evidence#>'{protectedRefs,before}' = '{}'::jsonb
    or p_evidence#>'{protectedRefs,before}' is distinct from p_evidence#>'{protectedRefs,after}'
  ) then return jsonb_build_object('ok',false,'reason','not_verified'); end if;
  if not exists (select 1 from council_host_leases where session_id=v_session_id and host_id=p_host_id
    and lease_epoch=p_lease_epoch and released_at is null and lease_expires_at > clock_timestamp()) then return jsonb_build_object('ok',false,'reason','stale_host'); end if;
  update council_integration_attempts set status=p_status,branch=p_branch,tip_sha=p_tip_sha,execution_id=p_execution_id,
    execution_evidence=v_execution_evidence,evidence=p_evidence,result_digest=v_digest,finished_at=clock_timestamp()
    where id=v_attempt.id;
  update council_campaigns set integration_status=p_status,integration_branch=p_branch,integration_tip_sha=p_tip_sha,
    integration_report=coalesce(p_evidence->>'diffSummary',p_evidence->>'conflictNotes'),integration_checked_at=clock_timestamp()
    where id=v_campaign.id;
  return jsonb_build_object('ok',true,'attemptId',v_attempt.id);
end;
$$;

create or replace function record_council_integration_v3(
  p_session_id uuid, p_reporter text, p_host_id uuid, p_lease_epoch bigint,
  p_status text, p_branch text, p_tip_sha text, p_report text
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_campaign council_campaigns;
begin
  perform 1 from council_sessions where id=p_session_id for update;
  perform 1 from council_host_leases where session_id=p_session_id for share;
  select * into v_campaign from council_campaigns where session_id=p_session_id for update;
  if v_campaign.id is null then return jsonb_build_object('ok',false,'reason','no_campaign'); end if;
  if not exists (select 1 from council_host_leases where session_id=p_session_id and host_id=p_host_id
    and lease_epoch=p_lease_epoch and released_at is null and lease_expires_at > clock_timestamp()) then return jsonb_build_object('ok',false,'reason','not_authorized'); end if;
  if exists (select 1 from council_integration_attempts where campaign_id=v_campaign.id) then return jsonb_build_object('ok',false,'reason','attempt_protocol_required'); end if;
  if p_status is null or p_status not in ('pending','running','verified','conflict','failed') then return jsonb_build_object('ok',false,'reason','bad_status'); end if;
  if v_campaign.integration_manifest is null then return jsonb_build_object('ok',false,'reason','manifest_not_frozen'); end if;
  update council_campaigns set integration_status=p_status,integration_branch=coalesce(p_branch,integration_branch),
    integration_tip_sha=coalesce(p_tip_sha,integration_tip_sha),integration_report=left(coalesce(p_report,''),16000),
    integration_checked_at=clock_timestamp() where id=v_campaign.id;
  return jsonb_build_object('ok',true);
end;
$$;

create or replace function set_campaign_integrator(p_session_id uuid, p_agent text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_campaign council_campaigns;
begin
  perform 1 from council_sessions where id=p_session_id for update;
  select * into v_campaign from council_campaigns where session_id=p_session_id for update;
  if v_campaign.id is null then return jsonb_build_object('ok',false,'reason','no_campaign'); end if;
  if v_campaign.status <> 'complete' then return jsonb_build_object('ok',false,'reason','campaign_incomplete','status',v_campaign.status); end if;
  if not exists (select 1 from council_participants where session_id=p_session_id and name=p_agent and kind='agent') then return jsonb_build_object('ok',false,'reason','not_on_roster'); end if;
  if exists (select 1 from council_integration_attempts where campaign_id=v_campaign.id and status='running') then
    if v_campaign.integrator_agent is not distinct from p_agent then return jsonb_build_object('ok',true,'campaign_id',v_campaign.id); end if;
    return jsonb_build_object('ok',false,'reason','attempt_running');
  end if;
  update council_campaigns set integrator_agent=p_agent,integration_status='pending',
    integration_report=null,integration_checked_at=null where id=v_campaign.id;
  return jsonb_build_object('ok',true,'campaign_id',v_campaign.id);
end;
$$;

do $$
declare v_function regprocedure;
begin
  for v_function in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('council_integration_attempt_immutable','council_integration_attempt_json','council_integration_evidence_valid',
      'begin_council_integration_attempt','finalize_council_integration_attempt','record_council_integration_v3','set_campaign_integrator') loop
    execute format('revoke all on function %s from public, anon, authenticated',v_function);
    execute format('grant execute on function %s to service_role',v_function);
  end loop;
end;
$$;
