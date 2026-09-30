import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { PGlite } from "@electric-sql/pglite";
import { withMcpAuth } from "mcp-handler";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mcp-auth.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "offline-anon-fixture";
process.env.SUPABASE_SERVICE_ROLE_KEY = "offline-service-fixture";
process.env.MCP_API_KEY = "retired-shared-write-fixture";
process.env.MCP_API_KEY_READONLY = "retired-shared-read-fixture";
process.env.MCP_COUNCIL_HOST_KEY = "dedicated-host-fixture";

const db = new PGlite();
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const warnings: unknown[][] = [];
let rpcResponse: { data: unknown; status: number } | undefined;
let networkFailure = false;
let requests = 0;
let passed = 0;
let failed = 0;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = (prefix: string) => prefix + randomBytes(32).toString("hex");
const future = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

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
        networkFailure = false;
        warnings.length = 0;
        process.env.MCP_API_KEY = "retired-shared-write-fixture";
        process.env.MCP_API_KEY_READONLY = "retired-shared-read-fixture";
        process.env.MCP_COUNCIL_HOST_KEY = "dedicated-host-fixture";
    }
}

globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, "https://mcp-auth.invalid", "MCP auth tests must remain offline");
    assert.equal(request.method, "POST");
    const procedures: Record<string, string> = {
        "/rest/v1/rpc/resolve_agent_client_key": "resolve_agent_client_key",
        "/rest/v1/rpc/resolve_council_seat_key": "resolve_council_seat_key",
    };
    const procedure = procedures[url.pathname];
    assert(procedure, "unexpected offline RPC");
    const body = await request.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ["p_token_hash"]);
    assert.match(String(body.p_token_hash), /^[a-f0-9]{64}$/);
    requests++;
    if (networkFailure) throw new Error("offline network failure");
    if (rpcResponse) return Response.json(rpcResponse.data, { status: rpcResponse.status });
    return Response.json(await scalar(`select public.${procedure}($1) as value`, [body.p_token_hash]));
};
console.warn = (...args: unknown[]) => { warnings.push(args); };

try {
    const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
    await db.exec(`
        create role anon; create role authenticated; create role service_role bypassrls;
        create table council_sessions(id uuid primary key, status text, code text);
        create table council_host_leases(
            session_id uuid, host_id uuid, lease_epoch bigint, released_at timestamptz, lease_expires_at timestamptz
        );
    `);
    const seatTableStart = setup.indexOf("create table if not exists council_seat_keys (");
    const seatTableEnd = setup.indexOf("create index", seatTableStart);
    assert(seatTableStart >= 0 && seatTableEnd > seatTableStart);
    await db.exec(setup.slice(seatTableStart, seatTableEnd));
    await db.exec("alter table council_seat_keys add column issued_by text not null default 'owner', add column host_id uuid, add column lease_epoch bigint, add column execution_id uuid, add column execution_binding_required boolean not null default false");
    const seatResolvers = [...setup.matchAll(/create or replace function (?:public\.)?resolve_council_seat_key\(p_token_hash text\)[\s\S]*?\$\$;/g)];
    assert(seatResolvers.length > 0);
    await db.exec(seatResolvers.at(-1)![0]);
    const waveStart = setup.indexOf("-- ===== Council V3.5 wave:");
    const waveEnd = setup.indexOf("-- V6 assistant features", waveStart);
    assert(waveStart >= 0 && waveEnd > waveStart);
    await db.exec(setup.slice(waveStart, waveEnd));
    await db.exec(await readFile(new URL("./migrations/council-agent-claims.sql", import.meta.url), "utf8"));

    const { verifyMcpToken } = await import("../src/lib/agents/mcp-auth.ts");
    const handler = withMcpAuth(async (request: Request) => {
        const { clientId, scopes } = (request as Request & { auth: AuthInfo }).auth;
        return Response.json({ clientId, scopes });
    }, verifyMcpToken, { required: true });
    const authenticate = (bearer?: string) => handler(new Request("https://app.invalid/api/mcp/mcp", {
        headers: bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` },
    }));
    const deny = async (bearer?: string) => {
        const result = await authenticate(bearer);
        assert.equal(result.status, 401);
        assert.equal((await result.json()).error, "invalid_token");
    };
    const identity = async (bearer: string) => {
        const result = await authenticate(bearer);
        assert.equal(result.status, 200);
        return await result.json() as { clientId: string; scopes: string[] };
    };
    const namedClient = async (scopes: string[], level = "read") => {
        const clientId = randomUUID();
        const displayName = `offline-${clientId}`;
        const key = token("zck_");
        await db.query("insert into agent_clients(id,display_name) values ($1,$2)", [clientId, displayName]);
        await db.query("insert into agent_client_keys(client_id,token_hash,key_prefix,scopes,purpose,access_level) values ($1,$2,'zck_',$3,'knowledge',$4)", [clientId, hash(key), scopes, level]);
        return { clientId, displayName, key };
    };
    const seat = async () => {
        const sessionId = randomUUID();
        const hostId = randomUUID();
        const key = token("zcs_");
        await db.query("insert into council_sessions values ($1,'active','CN-TEST')", [sessionId]);
        await db.query("insert into council_host_leases values ($1,$2,3,null,$3)", [sessionId, hostId, future()]);
        await db.query("insert into council_seat_keys(session_id,seat_name,token_hash,expires_at,issued_by,host_id,lease_epoch) values ($1,'agent:one',$2,$3,'host',$4,3)", [sessionId, hash(key), future(), hostId]);
        return { sessionId, key };
    };

    for (const key of ["retired-shared-write-fixture", "retired-shared-read-fixture"]) {
        await check(`configured ${key.includes("write") ? "write" : "read"} shared bearer is rejected`, async () => {
            await deny(key);
        });
    }

    await check("missing, empty, unknown and malformed bearer credentials are rejected", async () => {
        const before = requests;
        for (const key of [undefined, "", "unknown-fixture", "zkc_claim-fixture"]) await deny(key);
        assert.equal(requests, before);
        for (const key of ["zck_", "zcs_", token("zck_"), token("zcs_")]) await deny(key);
        assert.equal((await handler(new Request("https://app.invalid/api/mcp/mcp", {
            headers: { Authorization: "Basic dedicated-host-fixture" },
        }))).status, 401);
    });

    await check("the dedicated host keeps only the host scope without a database lookup", async () => {
        const before = requests;
        networkFailure = true;
        assert.deepEqual(await identity("dedicated-host-fixture"), { clientId: "council-host", scopes: ["council:host"] });
        assert.equal(requests, before);
        delete process.env.MCP_COUNCIL_HOST_KEY;
        await deny("dedicated-host-fixture");
    });

    for (const [level, scopes] of Object.entries({
        read: ["knowledge:read"],
        notes: ["knowledge:read", "notes:write"],
        full: ["knowledge:read", "notes:write", "vault:write"],
        council: ["knowledge:read", "notes:write", "vault:write", "council:owner"],
    })) {
        await check(`a named ${level} client retains its exact identity and grants`, async () => {
            const client = await namedClient(scopes, level);
            assert.deepEqual(await identity(client.key), { clientId: `agent:${client.clientId}:${client.displayName}`, scopes });
        });
    }

    for (const setting of ["empty", "unset"] as const) {
        await check(`named clients authenticate with both shared settings ${setting}`, async () => {
            const client = await namedClient(["knowledge:read"]);
            if (setting === "empty") {
                process.env.MCP_API_KEY = "";
                process.env.MCP_API_KEY_READONLY = "";
            } else {
                delete process.env.MCP_API_KEY;
                delete process.env.MCP_API_KEY_READONLY;
            }
            assert.deepEqual(await identity(client.key), { clientId: `agent:${client.clientId}:${client.displayName}`, scopes: ["knowledge:read"] });
            await deny();
        });
    }

    await check("a named read key gains no scopes from either retired shared setting", async () => {
        const client = await namedClient(["knowledge:read"]);
        process.env.MCP_API_KEY = client.key;
        process.env.MCP_API_KEY_READONLY = client.key;
        assert.deepEqual(await identity(client.key), { clientId: `agent:${client.clientId}:${client.displayName}`, scopes: ["knowledge:read"] });
    });

    await check("a host-issued seat retains only its session and seat identity", async () => {
        const grant = await seat();
        assert.deepEqual(await identity(grant.key), { clientId: `council-seat:${grant.sessionId}:agent:one`, scopes: ["council:seat"] });
    });

    for (const rejection of ["revoked-key", "revoked-client", "expired-key"] as const) {
        await check(`${rejection} cannot fall back to a configured shared bearer`, async () => {
            const client = await namedClient(["knowledge:read"]);
            if (rejection === "revoked-key") await db.query("update agent_client_keys set revoked_at=now() where client_id=$1", [client.clientId]);
            if (rejection === "revoked-client") await db.query("update agent_clients set revoked_at=now() where id=$1", [client.clientId]);
            if (rejection === "expired-key") await db.query("update agent_client_keys set expires_at=$1 where client_id=$2", [past(), client.clientId]);
            process.env.MCP_API_KEY = client.key;
            process.env.MCP_API_KEY_READONLY = client.key;
            await deny(client.key);
        });
    }

    for (const rejection of ["revoked-seat", "expired-seat", "expired-session", "released-lease", "expired-lease", "stale-lease"] as const) {
        await check(`${rejection} is rejected without a shared-key fallback`, async () => {
            const grant = await seat();
            if (rejection === "revoked-seat") await db.query("update council_seat_keys set revoked_at=now() where session_id=$1", [grant.sessionId]);
            if (rejection === "expired-seat") await db.query("update council_seat_keys set expires_at=$1 where session_id=$2", [past(), grant.sessionId]);
            if (rejection === "expired-session") await db.query("update council_sessions set status='expired' where id=$1", [grant.sessionId]);
            if (rejection === "released-lease") await db.query("update council_host_leases set released_at=now() where session_id=$1", [grant.sessionId]);
            if (rejection === "expired-lease") await db.query("update council_host_leases set lease_expires_at=$1 where session_id=$2", [past(), grant.sessionId]);
            if (rejection === "stale-lease") await db.query("update council_host_leases set lease_epoch=4 where session_id=$1", [grant.sessionId]);
            process.env.MCP_API_KEY = grant.key;
            await deny(grant.key);
        });
    }

    for (const prefix of ["zck_", "zcs_"]) {
        await check(`${prefix} resolution fails closed on missing or malformed identity data`, async () => {
            for (const data of [null, {}, [], "invalid", { client_id: "incomplete" }, { key_id: "incomplete" }, { session_id: "incomplete" }, { seat_name: "incomplete" }]) {
                rpcResponse = { data, status: 200 };
                await deny(token(prefix));
            }
        });
        await check(`${prefix} resolution fails closed on RPC and network errors`, async () => {
            rpcResponse = { data: { code: "XX000", message: "offline RPC failure" }, status: 500 };
            await deny(token(prefix));
            rpcResponse = undefined;
            networkFailure = true;
            await deny(token(prefix));
            assert.equal(warnings.length, 2);
        });
    }
} finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    await db.close();
}

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
