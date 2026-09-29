import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://agent-claims.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "offline-anon-fixture";
process.env.SUPABASE_SERVICE_ROLE_KEY = "offline-service-fixture";
process.env.AUTH_SESSION_SECRET = "offline-claim-derivation-fixture";

const db = new PGlite();
const originalFetch = globalThis.fetch;
let rpcResponse: { data: unknown; status: number } | undefined;
let passed = 0;
let failed = 0;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const future = () => new Date(Date.now() + 15 * 60_000).toISOString();
async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
    return (await db.query<{ value: T }>(sql, params)).rows[0]?.value;
}
async function check(name: string, run: () => Promise<void>): Promise<void> {
    try {
        await run();
        passed++;
        console.log(`PASS ${name}`);
    } catch (error) {
        failed++;
        console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unexpected failure"}`);
    } finally {
        rpcResponse = undefined;
        await db.exec("update fixture_claim_failures set mode = null");
    }
}
async function client(): Promise<string> {
    return scalar<string>("insert into agent_clients(display_name) values ($1) returning id as value", [`zz-test-${randomUUID()}`]);
}
async function sqlMint(clientId: string, claimHash: string, scopes: unknown = ["knowledge:read"], level: unknown = "read", expiresAt: unknown = future()) {
    return scalar<{ ok: boolean }>("select public.mint_agent_claim($1,$2,$3,$4,$5) as value", [clientId, claimHash, scopes, level, expiresAt]);
}
async function sqlExchange(claimHash: string) {
    return scalar<{ ok: boolean; access_level?: string; scopes?: string[] }>(
        "select public.exchange_agent_claim($1,$2,'zck_') as value", [claimHash, hash(`key:${claimHash}`)]);
}

globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, "https://agent-claims.invalid", "claim tests must remain offline");
    const body = await request.json() as Record<string, unknown>;
    try {
        if (url.pathname === "/rest/v1/rpc/mint_agent_claim") {
            if (rpcResponse) return Response.json(rpcResponse.data, { status: rpcResponse.status });
            assert.match(String(body.p_claim_hash), /^[a-f0-9]{64}$/);
            assert(!JSON.stringify(body).includes("zkc_"), "plaintext claim sent to SQL");
            const value = await sqlMint(String(body.p_client_id), String(body.p_claim_hash), body.p_scopes, body.p_access_level, body.p_expires_at);
            return Response.json(value);
        }
        if (url.pathname === "/rest/v1/agent_client_claims" && request.method === "PATCH") {
            const clientId = url.searchParams.get("client_id")?.replace(/^eq\./, "");
            await db.query("update agent_client_claims set revoked_at=$1 where client_id=$2 and revoked_at is null and claimed_at is null", [body.revoked_at, clientId]);
            return new Response(null, { status: 204 });
        }
        if (url.pathname === "/rest/v1/agent_client_claims" && request.method === "POST") {
            await db.query("insert into agent_client_claims(client_id,claim_hash,scopes,access_level,expires_at) values ($1,$2,$3,$4,$5)",
                [body.client_id, body.claim_hash, body.scopes, body.access_level, body.expires_at]);
            return new Response(null, { status: 201 });
        }
        assert.fail(`Unexpected offline request: ${request.method} ${url.pathname}`);
    } catch (error) {
        return Response.json({ code: "XX000", message: error instanceof Error ? error.message : "SQL failure", details: null, hint: null }, { status: 400 });
    }
};

try {
    await db.exec(`
        create role anon; create role authenticated; create role service_role bypassrls;
        grant usage on schema public to anon, authenticated, service_role;
        create table council_sessions(id uuid primary key);
        create table council_seat_keys(id uuid primary key);
    `);
    const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
    const wave = setup.slice(setup.indexOf("-- ===== Council V3.5 wave:"), setup.indexOf("-- V6 assistant features"));
    assert(wave.startsWith("-- ===== Council V3.5 wave:"));
    await db.exec(wave);
    await db.exec("grant all on all tables in schema public to anon, authenticated; grant all on all sequences in schema public to anon, authenticated");
    const marker = "-- ===== Atomic named-client claim replacement =====";
    const migration = setup.includes(marker) ? setup.slice(setup.indexOf(marker)) : "";
    if (migration) { await db.exec(migration); await db.exec(migration); }
    await db.exec(`
        create table fixture_claim_failures(mode text);
        grant select on fixture_claim_failures to service_role;
        insert into fixture_claim_failures values (null);
        create function fixture_fail_claim_write() returns trigger language plpgsql as $$
        begin
          if exists(select 1 from fixture_claim_failures where mode = lower(TG_OP)) then
            raise exception 'untrusted database failure details';
          end if;
          return new;
        end;
        $$;
        create trigger fixture_claim_failure before insert or update on agent_client_claims
        for each row execute function fixture_fail_claim_write();
    `);
    const { mintKnowledgeClaim } = await import("../src/lib/agents/clients.ts");

    await check("a failed revocation never returns a replacement or leaves two pending claims", async () => {
        const id = await client();
        const original = await mintKnowledgeClaim({ clientId: id, accessLevel: "read" });
        await db.exec("update fixture_claim_failures set mode='update'");
        await assert.rejects(mintKnowledgeClaim({ clientId: id, accessLevel: "notes" }));
        assert.equal(await scalar("select count(*)::int as value from agent_client_claims where client_id=$1 and revoked_at is null", [id]), 1);
        assert.equal(await scalar("select revoked_at as value from agent_client_claims where claim_hash=$1", [hash(original.claim)]), null);
    });

    await check("a failed replacement insert rolls back revocation of the prior claim", async () => {
        const id = await client();
        const original = await mintKnowledgeClaim({ clientId: id, accessLevel: "read" });
        await db.exec("update fixture_claim_failures set mode='insert'");
        await assert.rejects(mintKnowledgeClaim({ clientId: id, accessLevel: "full" }));
        assert.equal(await scalar("select revoked_at as value from agent_client_claims where claim_hash=$1", [hash(original.claim)]), null);
        assert.equal((await sqlExchange(hash(original.claim))).ok, true);
    });

    await check("replacement invalidates the old claim while preserving a 15-minute hash-only claim", async () => {
        const id = await client();
        const old = await mintKnowledgeClaim({ clientId: id, accessLevel: "read" });
        const started = Date.now();
        const next = await mintKnowledgeClaim({ clientId: id, accessLevel: "notes" });
        assert.match(next.claim, /^zkc_[a-f0-9]{64}$/);
        assert(Date.parse(next.expiresAt) >= started + 15 * 60_000);
        assert(Date.parse(next.expiresAt) <= Date.now() + 15 * 60_000);
        assert.equal((await sqlExchange(hash(old.claim))).ok, false);
        assert.deepEqual((await sqlExchange(hash(next.claim))).scopes, ["knowledge:read", "notes:write"]);
        const row = await scalar<{ claim_hash: string }>("select to_jsonb(c) as value from agent_client_claims c where claim_hash=$1", [hash(next.claim)]);
        assert.equal(row.claim_hash, hash(next.claim));
        assert(!JSON.stringify(row).includes(next.claim));
    });

    await check("mint refuses absent and revoked clients without inserting claims", async () => {
        await assert.rejects(mintKnowledgeClaim({ clientId: randomUUID(), accessLevel: "read" }));
        const id = await client();
        await db.query("select revoke_agent_client($1)", [id]);
        await assert.rejects(mintKnowledgeClaim({ clientId: id, accessLevel: "read" }));
        assert.equal(await scalar("select count(*)::int as value from agent_client_claims where client_id=$1", [id]), 0);
    });

    for (const response of [null, {}, [], { ok: false }, { ok: "true" }, { ok: true, reason: "unusable" }]) {
        await check(`mint fails closed for unusable RPC response ${JSON.stringify(response)}`, async () => {
            const id = await client();
            rpcResponse = { data: response, status: 200 };
            await assert.rejects(mintKnowledgeClaim({ clientId: id, accessLevel: "read" }));
        });
    }
    await check("RPC failures expose only a bounded error", async () => {
        const id = await client();
        rpcResponse = { data: { code: "XX000", message: "private-database-detail".repeat(200), details: null, hint: null }, status: 400 };
        await assert.rejects(mintKnowledgeClaim({ clientId: id, accessLevel: "read" }), error =>
            error instanceof Error && error.message.length < 100 && !error.message.includes("private-database-detail"));
    });

    await check("the SQL mint accepts every canonical access level without adding authority", async () => {
        for (const [level, scopes] of [
            ["read", ["knowledge:read"]],
            ["notes", ["knowledge:read", "notes:write"]],
            ["full", ["knowledge:read", "notes:write", "vault:write"]],
            ["council", ["knowledge:read", "notes:write", "vault:write", "council:owner"]],
        ] as const) {
            const digest = hash(randomUUID());
            assert.equal((await sqlMint(await client(), digest, [...scopes], level)).ok, true);
            const exchanged = await sqlExchange(digest);
            assert.equal(exchanged.access_level, level);
            assert.deepEqual(exchanged.scopes, [...scopes]);
        }
    });

    await check("invalid scope, access, hash and expired input cannot revoke an existing claim", async () => {
        const id = await client();
        const original = await mintKnowledgeClaim({ clientId: id, accessLevel: "read" });
        for (const [digest, scopes, level, expiry] of [
            [hash("extra"), ["knowledge:read", "council:owner"], "read", future()],
            [hash("missing"), [], "full", future()],
            [hash("null-scope"), null, "read", future()],
            [hash("bad-level"), ["knowledge:read"], "admin", future()],
            [hash("null-level"), ["knowledge:read"], null, future()],
            ["zkc_plaintext", ["knowledge:read"], "read", future()],
            [null, ["knowledge:read"], "read", future()],
            [hash("expired"), ["knowledge:read"], "read", new Date(Date.now() - 1_000).toISOString()],
            [hash("null-expiry"), ["knowledge:read"], "read", null],
        ]) {
            const result = await sqlMint(id, digest as string, scopes, level, expiry);
            assert.equal(result.ok, false);
        }
        assert.equal(await scalar("select revoked_at as value from agent_client_claims where claim_hash=$1", [hash(original.claim)]), null);
        assert.equal(await scalar("select count(*)::int as value from agent_client_claims where client_id=$1", [id]), 1);
    });

    await check("duplicate hash insert failure preserves the previous live claim", async () => {
        const id = await client();
        const original = await mintKnowledgeClaim({ clientId: id, accessLevel: "read" });
        await assert.rejects(sqlMint(id, hash(original.claim)), /duplicate key/);
        assert.equal((await sqlExchange(hash(original.claim))).ok, true);
    });

    await check("exchange retries remain idempotent and revocation prevents replay", async () => {
        const id = await client();
        const claim = await mintKnowledgeClaim({ clientId: id, accessLevel: "read" });
        assert.equal((await sqlExchange(hash(claim.claim))).ok, true);
        assert.equal((await sqlExchange(hash(claim.claim))).ok, true);
        assert.equal(await scalar("select count(*)::int as value from agent_client_keys where client_id=$1", [id]), 1);
        await db.query("select revoke_agent_client($1)", [id]);
        assert.equal((await sqlExchange(hash(claim.claim))).ok, false);
        assert.equal(await scalar("select count(*)::int as value from agent_client_keys where client_id=$1 and revoked_at is null", [id]), 0);
    });

    await check("expired claims cannot exchange", async () => {
        const id = await client();
        const claim = await mintKnowledgeClaim({ clientId: id, accessLevel: "read" });
        await db.query("update agent_client_claims set expires_at=now()-interval '1 second' where client_id=$1", [id]);
        assert.equal((await sqlExchange(hash(claim.claim))).ok, false);
    });

    await check("exchange cannot bind a claim to another client's existing key", async () => {
        const firstId = await client(), secondId = await client();
        const first = await mintKnowledgeClaim({ clientId: firstId, accessLevel: "read" });
        const second = await mintKnowledgeClaim({ clientId: secondId, accessLevel: "read" });
        await sqlExchange(hash(first.claim));
        const attempt = await scalar<{ ok: boolean }>("select exchange_agent_claim($1,$2,'zck_') as value", [hash(second.claim), hash(`key:${hash(first.claim)}`)]);
        assert.equal(attempt.ok, false);
        assert.equal(await scalar("select issued_key_id as value from agent_client_claims where claim_hash=$1", [hash(second.claim)]), null);
    });

    await check("a new claim cannot reuse a different claim's existing key for the same client", async () => {
        const id = await client();
        const first = await mintKnowledgeClaim({ clientId: id, accessLevel: "read" });
        await sqlExchange(hash(first.claim));
        const second = await mintKnowledgeClaim({ clientId: id, accessLevel: "notes" });
        const attempt = await scalar<{ ok: boolean }>("select exchange_agent_claim($1,$2,'zck_') as value", [hash(second.claim), hash(`key:${hash(first.claim)}`)]);
        assert.equal(attempt.ok, false);
        assert.equal((await sqlExchange(hash(first.claim))).ok, true);
    });

    await check("a claimed retry cannot replace its original key with a different token hash", async () => {
        const id = await client();
        const claim = await mintKnowledgeClaim({ clientId: id, accessLevel: "read" });
        await sqlExchange(hash(claim.claim));
        const attempt = await scalar<{ ok: boolean }>("select exchange_agent_claim($1,$2,'zck_') as value", [hash(claim.claim), hash("different-retry-token")]);
        assert.equal(attempt.ok, false);
        assert.equal((await sqlExchange(hash(claim.claim))).ok, true);
    });

    await check("claim retries cannot revive an expired issued key", async () => {
        const id = await client();
        const claim = await mintKnowledgeClaim({ clientId: id, accessLevel: "read" });
        await sqlExchange(hash(claim.claim));
        await db.query("update agent_client_keys set expires_at=now()-interval '1 second' where client_id=$1", [id]);
        assert.equal((await sqlExchange(hash(claim.claim))).ok, false);
    });

    await check("only service_role can execute the mint RPC after repeated migration application", async () => {
        const id = await client();
        for (const role of ["anon", "authenticated"]) {
            await db.exec(`set role ${role}`);
            try { await assert.rejects(sqlMint(id, hash(role)), /permission denied/); }
            finally { await db.exec("reset role"); }
        }
        assert.equal(await scalar("select has_function_privilege('public', 'public.mint_agent_claim(uuid,text,text[],text,timestamptz)', 'execute') as value"), false);
        await db.exec("set role service_role");
        try { assert.equal((await sqlMint(id, hash("service-role"))).ok, true); }
        finally { await db.exec("reset role"); }
    });

    await check("the standalone migration exactly matches the authoritative setup block", async () => {
        assert.equal(migration.trim(), (await readFile(new URL("./migrations/council-agent-claims.sql", import.meta.url), "utf8")).trim());
    });

    await check("anon and authenticated cannot read or mutate credential tables", async () => {
        for (const role of ["anon", "authenticated"]) {
            await db.exec(`set role ${role}`);
            try {
                for (const table of ["agent_clients", "agent_client_keys", "agent_client_claims", "agent_claim_attempts"]) {
                    for (const statement of [`select * from ${table}`, `insert into ${table} default values`, `update ${table} set ${table === "agent_claim_attempts" ? "succeeded=false" : "revoked_at=now()"}`, `delete from ${table}`]) {
                        await assert.rejects(db.exec(statement), /permission denied/);
                    }
                }
                await assert.rejects(db.exec("select nextval('agent_claim_attempts_id_seq')"), /permission denied/);
            } finally { await db.exec("reset role"); }
        }
    });

    await check("anon and authenticated cannot bypass the claim route through credential RPCs", async () => {
        const id = await client();
        for (const role of ["anon", "authenticated"]) {
            await db.exec(`set role ${role}`);
            try {
                for (const statement of [
                    "select exchange_agent_claim('fixture','fixture','zck_')",
                    `select revoke_agent_client('${id}')`,
                    "select resolve_agent_client_key('fixture')",
                    "select begin_agent_claim_attempt('fixture')",
                    "select finish_agent_claim_attempt(1,true)",
                ]) await assert.rejects(db.exec(statement), /permission denied/);
            } finally { await db.exec("reset role"); }
        }
    });

    await check("service_role retains the full server credential lifecycle after hardening", async () => {
        await db.exec("set role service_role");
        try {
            const id = await client();
            const digest = hash("service-full-lifecycle");
            assert.equal((await sqlMint(id, digest)).ok, true);
            assert.equal((await sqlExchange(digest)).ok, true);
            assert.equal((await scalar<{ client_id: string }>("select resolve_agent_client_key($1) as value", [hash(`key:${digest}`)])).client_id, id);
            const attempt = await scalar<{ attempt_id: number }>("select begin_agent_claim_attempt('offline-ip') as value");
            await db.query("select finish_agent_claim_attempt($1,true)", [attempt.attempt_id]);
            assert.equal(await scalar("select succeeded as value from agent_claim_attempts where id=$1", [attempt.attempt_id]), true);
            await db.query("update agent_client_keys set revoked_at=now() where client_id=$1", [id]);
            await db.query("select revoke_agent_client($1)", [id]);
            assert.equal(await scalar("select resolve_agent_client_key($1) as value", [hash(`key:${digest}`)]), null);
            await db.query("delete from agent_clients where id=$1", [id]);
            assert.equal(await scalar("select count(*)::int as value from agent_client_claims where client_id=$1", [id]), 0);
        } finally { await db.exec("reset role"); }
    });
} finally {
    globalThis.fetch = originalFetch;
    await db.close();
}

console.log(`\n${passed} passed, ${failed} failed (offline PGlite, single connection; no concurrency proof).`);
if (failed) process.exitCode = 1;
