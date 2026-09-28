-- REVIEW PROPOSAL ONLY. Do not include in automatic setup or apply without owner approval.
-- Empty, mixed-owner, unowned-message and multi-profile databases remain unchanged.
begin;
select c.id as eligible_conversation_id, c.title, count(m.id) as owned_messages
from public.conversations c join public.messages m on m.conversation_id = c.id
where c.user_profile_id is null and (select count(*) from public.user_profiles) = 1
group by c.id, c.title
having bool_and(m.user_profile_id is not distinct from (select id from public.user_profiles limit 1));
do $$
declare
  profile_id uuid;
  affected_count integer;
begin
  if (select count(*) from public.user_profiles) <> 1 then
    raise exception 'Legacy ownership review requires exactly one profile';
  end if;
  select id into profile_id from public.user_profiles;
  update public.conversations c set user_profile_id = profile_id
    where c.user_profile_id is null
      and exists (select 1 from public.messages m where m.conversation_id = c.id)
      and not exists (select 1 from public.messages m where m.conversation_id = c.id and m.user_profile_id is distinct from profile_id);
  get diagnostics affected_count = row_count;
  raise notice 'Eligible legacy conversations assigned inside this rollback-only preview: %', affected_count;
end;
$$;
-- Review the affected row count before replacing ROLLBACK with COMMIT.
rollback;
