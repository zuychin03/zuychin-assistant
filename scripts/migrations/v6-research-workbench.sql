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
