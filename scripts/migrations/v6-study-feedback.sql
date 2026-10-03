-- Model feedback on study answers, saved when written and linked from the review it informed.
begin;
do $$ begin
 if to_regclass('public.study_reviews') is null or to_regclass('public.model_call_observations') is null then
   raise exception 'Apply v6-study.sql and v6-model-health.sql before v6-study-feedback.sql.';
 end if;
end $$;
create table if not exists public.study_feedback (
 id uuid primary key, user_profile_id uuid not null references public.user_profiles(id),
 card_id uuid not null references public.study_cards(id),
 card_version integer not null check(card_version > 0),
 response_hash text not null check(response_hash ~ '^[a-f0-9]{64}$'),
 feedback text not null check(length(feedback) between 1 and 8000),
 model text not null check(length(model) between 1 and 200),
 created_at timestamptz not null default now()
);
create index if not exists study_feedback_answer on public.study_feedback(user_profile_id,card_id,card_version,response_hash,created_at desc);
alter table public.study_feedback enable row level security;
revoke all on public.study_feedback from public,anon,authenticated;
grant select,insert on public.study_feedback to service_role;
alter table public.study_reviews add column if not exists feedback_id uuid references public.study_feedback(id);

alter table public.model_call_observations drop constraint if exists model_call_observations_purpose_check;
alter table public.model_call_observations add constraint model_call_observations_purpose_check
  check (purpose in ('chat', 'embedding', 'routing', 'worker', 'orchestration', 'compaction', 'continuation', 'extraction', 'summary', 'title', 'search', 'speech', 'study'));

create or replace function public.assistant_study_feedback(p_user_id uuid,p_body jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.study_cards; f public.study_feedback;
begin
 select * into f from public.study_feedback where id=(p_body->>'id')::uuid;
 if found then
   if f.user_profile_id<>p_user_id or f.card_id<>(p_body->>'cardId')::uuid or f.response_hash<>p_body->>'responseHash' then return jsonb_build_object('error','conflict'); end if;
   return jsonb_build_object('feedback',to_jsonb(f),'reused',true);
 end if;
 select * into c from public.study_cards where id=(p_body->>'cardId')::uuid and user_profile_id=p_user_id;
 if not found then return jsonb_build_object('error','missing'); end if;
 if c.version<>(p_body->>'version')::integer then return jsonb_build_object('error','conflict'); end if;
 insert into public.study_feedback(id,user_profile_id,card_id,card_version,response_hash,feedback,model)
 values((p_body->>'id')::uuid,p_user_id,c.id,c.version,p_body->>'responseHash',p_body->>'feedback',p_body->>'model') returning * into f;
 return jsonb_build_object('feedback',to_jsonb(f),'reused',false);
end; $$;

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
   'reviews',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('feedback',f.feedback,'feedback_model',f.model) order by r.reviewed_at desc,r.id)
     from (select * from public.study_reviews where user_profile_id=p_user_id order by reviewed_at desc,id limit 200) r
     left join public.study_feedback f on f.id=r.feedback_id),'[]'::jsonb));
end; $$;

create or replace function public.assistant_study_review(p_user_id uuid,p_body jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.study_settings; c public.study_cards; r public.study_reviews; f public.study_feedback; today date; used integer;
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
 if p_body->>'feedbackId' is not null then
   select * into f from public.study_feedback where id=(p_body->>'feedbackId')::uuid and user_profile_id=p_user_id;
   if not found or f.card_id<>c.id or f.card_version<>c.version or f.response_hash<>encode(sha256(convert_to(p_body->>'response','UTF8')),'hex') then
     return jsonb_build_object('error','feedback');
   end if;
 end if;
 today := (now() at time zone s.timezone)::date;
 select count(*) into used from public.study_reviews where user_profile_id=p_user_id
   and reviewed_at >= (today::timestamp at time zone s.timezone) and reviewed_at < ((today+1)::timestamp at time zone s.timezone);
 if used>=s.daily_limit then return jsonb_build_object('error','daily_limit'); end if;
 if (p_body->'schedule'->>'due')::timestamptz <= now() then raise exception 'Invalid next review'; end if;
 insert into public.study_reviews(id,card_id,user_profile_id,request_hash,rating,response,reflection,prompt,answer,evidence,card_version,schedule_before,schedule_after,review_log,feedback_id)
 values((p_body->>'id')::uuid,c.id,p_user_id,p_body->>'requestHash',(p_body->>'rating')::integer,p_body->>'response',coalesce(p_body->>'reflection',''),c.prompt,c.answer,c.evidence,c.version,c.schedule,p_body->'schedule',p_body->'log',(p_body->>'feedbackId')::uuid) returning * into r;
 update public.study_cards set schedule=p_body->'schedule',due_at=(p_body->'schedule'->>'due')::timestamptz,version=version+1,updated_at=now() where id=c.id;
 return jsonb_build_object('review',to_jsonb(r),'reused',false);
end; $$;

create or replace function public.assistant_study_immutable()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_table_name in ('study_reviews','study_feedback') then raise exception 'Study review history is immutable'; end if;
 if row(old.id,old.user_profile_id,old.kind,old.evidence,old.request_hash,old.created_at) is distinct from row(new.id,new.user_profile_id,new.kind,new.evidence,new.request_hash,new.created_at) then raise exception 'Study source evidence is immutable'; end if;
 return new;
end; $$;
drop trigger if exists study_feedback_immutable on public.study_feedback;
create trigger study_feedback_immutable before update or delete on public.study_feedback for each row execute function public.assistant_study_immutable();
revoke all on function public.assistant_study_feedback(uuid,jsonb),public.assistant_study_report(uuid),public.assistant_study_review(uuid,jsonb),public.assistant_study_immutable() from public,anon,authenticated;
grant execute on function public.assistant_study_feedback(uuid,jsonb),public.assistant_study_report(uuid),public.assistant_study_review(uuid,jsonb) to service_role;
commit;
