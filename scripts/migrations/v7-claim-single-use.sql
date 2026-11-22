-- Single-use agent claims. Apply manually after council-agent-claims.sql; safe to re-run.
-- A claim may be retried for 60 seconds after its first exchange (a lost response), then never again,
-- so a claim copied from a chat transcript cannot recover the key for the rest of its 15 minutes.
begin;

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
       or v_claim.claimed_at <= clock_timestamp() - interval '60 seconds'
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

revoke all on function public.exchange_agent_claim(text, text, text) from public, anon, authenticated;
grant execute on function public.exchange_agent_claim(text, text, text) to service_role;

commit;
