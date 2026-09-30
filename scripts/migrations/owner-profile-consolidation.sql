-- Owner profile consolidation. Run once after a database backup, before the V6 migrations.
--
-- Re-running supabase-setup.sql used to seed another profile each time, and the app took
-- whichever row came first, so owner-scoped rows are split across profiles. This keeps one
-- profile, moves every row that references another profile onto it, gives ownerless
-- conversations and messages to it, archives and deletes the other profiles, then adds the
-- index that stops a second profile from being created.
--
-- The kept profile is the one holding the newest message, which is the one the app uses,
-- or the oldest profile when there are no messages. Its name, prompt and preferences stay.
--
-- Preview: run as is. Nothing changes; the result lists what applying would do.
-- Apply: set apply_changes to true below and run again. The work happens in one statement,
-- so a failure leaves the database untouched. Running it again afterwards changes nothing.

drop table if exists pg_temp.owner_consolidation_report;
create temporary table owner_consolidation_report (
  step integer generated always as identity,
  action text not null,
  target text not null,
  rows bigint not null
);

do $$
declare
  apply_changes constant boolean := false;
  requested_owner constant uuid := null; -- optional: the id of a different profile to keep

  seed_prompt constant text := 'You are Zuychin, a helpful, warm, and intelligent personal AI assistant. You have long-term memory and can remember past conversations. Be concise but thorough. Use a friendly, natural tone.';
  keep uuid;
  reason text;
  item record;
  owned_tables oid[];
  resume_triggers text[] := '{}';
  statement text;
  affected bigint;
begin
  insert into owner_consolidation_report (action, target, rows) values ('mode',
    case when apply_changes then 'applied' else 'preview only, nothing was changed; set apply_changes to true to apply' end, 0);

  if not exists (select 1 from public.user_profiles) then
    insert into owner_consolidation_report (action, target, rows) values ('nothing to do', 'no profiles exist', 0);
    return;
  end if;

  if exists (select 1 from pg_constraint where contype = 'f' and confrelid = 'public.user_profiles'::regclass
             and cardinality(conkey) <> 1) then
    raise exception 'A multi-column foreign key references user_profiles; consolidate it by hand.';
  end if;

  if requested_owner is not null then
    select id into keep from public.user_profiles where id = requested_owner;
    if keep is null then
      raise exception 'requested_owner % is not a profile in this database.', requested_owner;
    end if;
    reason := 'requested';
  else
    select m.user_profile_id into keep from public.messages m
    where m.user_profile_id is not null
    order by m.created_at desc, m.id desc limit 1;
    reason := 'holds the newest message';
    if keep is null then
      select id into keep from public.user_profiles order by created_at, id limit 1;
      reason := 'oldest profile, no messages yet';
    end if;
  end if;
  insert into owner_consolidation_report (action, target, rows) values ('keep profile', keep || ' (' || reason || ')', 1);

  for item in
    select id, created_at,
      display_name = 'Owner' and system_prompt is not distinct from seed_prompt
        and coalesce(preferences, '{}'::jsonb) = '{}'::jsonb as seed_copy
    from public.user_profiles where id <> keep order by created_at, id
  loop
    insert into owner_consolidation_report (action, target, rows) values ('remove profile',
      item.id || ' created ' || to_char(item.created_at, 'YYYY-MM-DD')
        || case when item.seed_copy then ', setup seed copy' else ', own settings kept in the archive' end, 1);
  end loop;

  select array_agg(distinct conrelid) into owned_tables
  from pg_constraint where contype = 'f' and confrelid = 'public.user_profiles'::regclass;

  -- Moving rows must not stamp them as edited: conversation order and "updated" dates read updated_at.
  if apply_changes then
    for item in
      select t.tgrelid::regclass as tbl, t.tgname as name
      from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where t.tgrelid = any (owned_tables) and not t.tgisinternal and t.tgenabled <> 'D'
        and p.proname = 'update_updated_at'
    loop
      execute format('alter table %s disable trigger %I', item.tbl, item.name);
      resume_triggers := resume_triggers || format('alter table %s enable trigger %I', item.tbl, item.name);
    end loop;
  end if;

  for item in
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'public.user_profiles'::regclass
    order by c.conrelid::regclass::text, a.attname
  loop
    if apply_changes then
      begin
        execute format('update %s set %I = $1 where %I <> $1', item.tbl, item.col, item.col) using keep;
        get diagnostics affected = row_count;
      exception when others then
        raise exception 'Could not move %.% onto the kept profile: %', item.tbl, item.col, sqlerrm;
      end;
    else
      execute format('select count(*) from %s where %I <> $1', item.tbl, item.col) into affected using keep;
    end if;
    if affected > 0 then
      insert into owner_consolidation_report (action, target, rows) values ('move rows', item.tbl || '.' || item.col, affected);
    end if;
  end loop;

  if apply_changes then
    update public.conversations set user_profile_id = keep where user_profile_id is null;
    get diagnostics affected = row_count;
  else
    select count(*) into affected from public.conversations where user_profile_id is null;
  end if;
  insert into owner_consolidation_report (action, target, rows) values ('assign ownerless', 'conversations', affected);

  if apply_changes then
    update public.messages set user_profile_id = keep where user_profile_id is null;
    get diagnostics affected = row_count;
  else
    select count(*) into affected from public.messages where user_profile_id is null;
  end if;
  insert into owner_consolidation_report (action, target, rows) values ('assign ownerless', 'messages', affected);

  if not apply_changes then
    return;
  end if;

  foreach statement in array resume_triggers loop
    execute statement;
  end loop;

  -- The foreign keys cascade on delete, so nothing may still point at a profile being removed.
  for item in
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'public.user_profiles'::regclass
  loop
    execute format('select count(*) from %s where %I <> $1', item.tbl, item.col) into affected using keep;
    if affected > 0 then
      raise exception '%.% still references another profile (% rows); nothing was changed.', item.tbl, item.col, affected;
    end if;
  end loop;

  create table if not exists public.user_profile_merge_archive (
    id uuid primary key,
    display_name text,
    system_prompt text,
    preferences jsonb,
    created_at timestamptz,
    updated_at timestamptz,
    merged_into uuid not null,
    merged_at timestamptz not null default now()
  );
  alter table public.user_profile_merge_archive enable row level security;
  revoke all on public.user_profile_merge_archive from public, anon, authenticated;
  insert into public.user_profile_merge_archive (id, display_name, system_prompt, preferences, created_at, updated_at, merged_into)
  select id, display_name, system_prompt, preferences, created_at, updated_at, keep
  from public.user_profiles where id <> keep
  on conflict (id) do nothing;
  get diagnostics affected = row_count;
  insert into owner_consolidation_report (action, target, rows) values ('archive profiles', 'user_profile_merge_archive', affected);

  delete from public.user_profiles where id <> keep;
  get diagnostics affected = row_count;
  insert into owner_consolidation_report (action, target, rows) values ('delete profiles', 'user_profiles', affected);

  create unique index if not exists user_profiles_single_owner on public.user_profiles ((true));
  insert into owner_consolidation_report (action, target, rows) values ('single-owner index', 'user_profiles_single_owner', 1);
end $$;

select action, target, rows from owner_consolidation_report order by step;
