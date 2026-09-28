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
