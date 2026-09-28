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
