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
