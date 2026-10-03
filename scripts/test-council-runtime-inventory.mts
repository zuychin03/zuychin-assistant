import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { NextRequest } from "next/server";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import { createSessionValue, verifySessionValue } from "../src/lib/auth/session.ts";
import * as authConfig from "../src/lib/auth/config.ts";

const require = createRequire(import.meta.url);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const policy = "typescript-node-v3-2026-09-30";
const setup = readFileSync(new URL("../supabase-setup.sql", import.meta.url), "utf8");
const migration = (() => { try { return readFileSync(new URL("./migrations/council-runtime-inventory.sql", import.meta.url), "utf8"); } catch { return ""; } })();

test("setup mirrors the complete inventory migration", () => {
    assert(migration.trim());
    assert.equal(setup.slice(setup.indexOf("-- ===== Owner Council runtime inventory =====")).trim(), migration.trim());
});

await test("inventory SQL is bounded, private and follows the complete campaign lifecycle", async suite => {
    const db = new PGlite(); suite.after(() => db.close());
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create table user_profiles(id uuid primary key); create table agent_clients(id uuid primary key)");
    for (const ddl of setup.matchAll(/create table if not exists council_[a-z_]+ \([\s\S]*?\n\);/g)) await db.exec(ddl[0]);
    for (const ddl of setup.matchAll(/alter table (?:public\.)?council_[a-z_]+\b[\s\S]*?;/g)) await db.exec(ddl[0]);
    if (migration) await db.exec(migration);
    const value = async <T,>(sql: string, args: unknown[] = []): Promise<T> => (await db.query<{ value: T }>(sql, args)).rows[0].value;
    await suite.test("only the service role can execute the read-only RPC", async () => {
        assert.equal(await value("select count(*)::int as value from pg_proc where proname='list_council_runtime_inventory'"), 1);
        for (const role of ["anon", "authenticated"]) {
            assert.equal(await value("select has_function_privilege($1,oid,'execute') as value from pg_proc where proname='list_council_runtime_inventory'", [role]), false);
        }
        assert.equal(await value("select has_function_privilege('service_role',oid,'execute') as value from pg_proc where proname='list_council_runtime_inventory'"), true);
        assert.equal(await value("select provolatile as value from pg_proc where proname='list_council_runtime_inventory'"), "s");
    });
    if (!migration) return;
    async function seed(n: number, status: string, campaign?: string, integration?: string | null) {
        await db.query("insert into council_sessions(id,code,topic,closer_name,status,protocol_version,host_generation,policy_version) values($1,$2,'private-topic','seat',$3,3,$4,$5)",
            [id(n), `CN-${String(n).padStart(4, "0")}`, status, n === 1 ? null : "typescript-node", n === 1 ? null : policy]);
        if (campaign) await db.query("insert into council_campaigns(session_id,status,repo_path,integration_status) values($1,$2,'private-path',$3)", [id(n), campaign, integration ?? null]);
    }
    for (const [n, status, campaign, integration] of [
        [1, "open"], [2, "concluding"], [3, "awaiting_owner"], [4, "closed", "running"], [5, "closed", "blocked"],
        [6, "closed", "complete", null], [7, "closed", "complete", "pending"], [8, "closed", "complete", "running"],
        [9, "closed", "complete", "verified"], [10, "closed", "complete", "conflict"], [11, "closed", "complete", "failed"],
        [12, "closed", "cancelled", "pending"], [13, "closed"], [14, "expired", "running"],
    ] as const) await seed(n, status, campaign, integration);
    await db.query("update council_sessions set paused_at='2026-09-29T00:00:00Z' where id=$1", [id(2)]);
    await db.query("insert into council_participants(id,session_id,name) values($1,$2,'seat')", [id(999), id(1)]);
    await db.query("insert into council_agent_executions(session_id,participant_id,host_id,lease_epoch,host_generation,connector_kind,capability_source,identity_assurance,worktree_path) values($1,$2,$3,1,'typescript-node','acp','probed','verified_seat','private-worktree')", [id(1), id(999), id(998)]);
    await db.exec("grant select on all tables in schema public to service_role");
    await suite.test("active rows preserve unknown historical policy and omit private fields", async () => {
        await db.exec("begin read only; set local role service_role");
        const rows = (await db.query<Record<string, unknown>>("select * from list_council_runtime_inventory(null)")).rows;
        await db.exec("commit");
        assert.deepEqual(rows.map(row => row.session_id), Array.from({ length: 8 }, (_, i) => id(i + 1)));
        assert.equal(rows[0].host_generation, null); assert.equal(rows[0].policy_version, null); assert.equal(rows[0].has_execution_history, true);
        assert.equal(rows[1].has_execution_history, false); assert.ok(rows[1].paused_at);
        for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["session_id", "code", "status", "paused_at", "host_generation", "policy_version", "has_execution_history"].sort());
        assert(!JSON.stringify(rows).includes("private-"));
    });
    await suite.test("UUID keyset pages are capped with one lookahead and never duplicate", async () => {
        for (let n = 20; n < 100; n++) await seed(n, "open");
        const first = (await db.query<{ session_id: string }>("select * from list_council_runtime_inventory(null)")).rows;
        assert.equal(first.length, 51);
        const second = (await db.query<{ session_id: string }>("select * from list_council_runtime_inventory($1)", [first[49].session_id])).rows;
        assert.equal(second[0].session_id, first[50].session_id);
        assert.equal(new Set([...first.slice(0, 50), ...second].map(row => row.session_id)).size, 88);
    });
});

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://inventory.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "synthetic-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service";
process.env.AUTH_SESSION_SECRET = "synthetic-owner-session-key-only";
const row = (n: number) => ({ session_id: id(n), code: `CN-${String(n).padStart(4, "0")}`, status: "open", paused_at: null,
    host_generation: n === 1 ? null : "typescript-node", policy_version: n === 1 ? null : policy, has_execution_history: n === 1,
    host_id: "private-host", token_hash: "private-token", repo_path: "private-repo" });

await test("inventory reader projects a bounded RPC page and preserves unknowns", async t => {
    const calls: unknown[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        assert.equal(url.href, "https://inventory.invalid/rest/v1/rpc/list_council_runtime_inventory");
        assert.equal(init?.method, "POST");
        const args = JSON.parse(String(init?.body)); calls.push(args);
        const start = args.p_after === null ? 1 : 51;
        return new Response(JSON.stringify(Array.from({ length: start === 1 ? 51 : 2 }, (_, index) => row(start + index))), { headers: { "content-type": "application/json" } });
    });
    const { readRuntimeInventory } = await import("../src/lib/council/runtime-inventory.ts");
    const first = await readRuntimeInventory();
    assert.equal(first.status, "available"); assert.equal(first.records.length, 50); assert.equal(first.nextCursor, id(50));
    assert.equal(first.records[0].hostGeneration, null); assert.equal(first.records[0].policyVersion, null); assert.equal(first.records[0].hasExecutionHistory, true);
    assert(!JSON.stringify(first).includes("private-"));
    const next = await readRuntimeInventory(first.nextCursor);
    assert.deepEqual(next.records.map(record => record.sessionId), [id(51), id(52)]); assert.equal(next.nextCursor, null);
    assert.deepEqual(calls, [{ p_after: null }, { p_after: id(50) }]);
});

await test("invalid cursors cannot reach the inventory database", async t => {
    let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected fetch"); });
    const { readRuntimeInventory } = await import("../src/lib/council/runtime-inventory.ts");
    for (const cursor of ["", "not-a-uuid", `${id(1)},id.gt.0`, `${id(1)}\n`]) await assert.rejects(readRuntimeInventory(cursor), /Invalid inventory cursor/);
    assert.equal(calls, 0);
});

await test("database errors and malformed pages remain unavailable without leaking raw details", async t => {
    const { readRuntimeInventory } = await import("../src/lib/council/runtime-inventory.ts");
    for (const payload of [{ message: "private-database-error" }, [row(2), row(1)], [{ ...row(1), policy_version: undefined }], Array.from({ length: 52 }, (_, i) => row(i + 1))]) {
        const mocked = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload), {
            status: Array.isArray(payload) ? 200 : 503, headers: { "content-type": "application/json" },
        }));
        const page = await readRuntimeInventory();
        assert.equal(page.status, "unavailable"); assert.deepEqual(page.records, []); assert.equal(page.nextCursor, null);
        assert(!JSON.stringify(page).includes("private-")); mocked.mock.restore();
    }
});

async function loadRoute(reader: (cursor: string | null) => Promise<unknown>) {
    const { parseRuntimeInventoryCursor } = await import("../src/lib/council/runtime-inventory.ts");
    const source = readFileSync(new URL("../src/app/api/council/runtime-inventory/route.ts", import.meta.url), "utf8");
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const loaded = { exports: {} as { GET: (request: NextRequest) => Promise<Response> } };
    runInNewContext(output, { exports: loaded.exports, module: loaded, console, require: (name: string) => {
        if (name === "@/lib/council/runtime-inventory") return { parseRuntimeInventoryCursor, readRuntimeInventory: reader };
        if (name === "@/lib/auth/config") return authConfig;
        if (name === "@/lib/auth/session") return { verifySessionValue };
        return require(name);
    } });
    return loaded.exports.GET;
}
const request = (query = "", cookie?: string, bearer?: string) => new NextRequest(`http://localhost/api/council/runtime-inventory${query}`, {
    headers: { ...(cookie ? { cookie: `${authConfig.AUTH_COOKIE}=${cookie}` } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
});

await test("route requires a signed owner cookie before any query, including direct MCP bearer requests", async () => {
    let calls = 0; const GET = await loadRoute(async () => { calls++; return { status: "available", records: [], nextCursor: null }; });
    for (const req of [request(), request("", "forged"), request("", undefined, "synthetic-seat-key"), request("?cursor=invalid")]) {
        const response = await GET(req); assert.equal(response.status, 401); assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
    assert.equal(calls, 0);
    const response = await GET(request("", await createSessionValue()));
    assert.equal(response.status, 200); assert.equal(calls, 1); assert.equal(response.headers.get("cache-control"), "private, no-store");
});

await test("owner route rejects ambiguous query parameters and returns private generic failures", async () => {
    const cookie = await createSessionValue(); let calls = 0;
    const GET = await loadRoute(async () => { calls++; return { status: "available", records: [], nextCursor: null }; });
    for (const query of ["?cursor=invalid", "?cursor=", `?cursor=${id(1)}&cursor=${id(2)}`, "?limit=10000"]) {
        assert.equal((await GET(request(query, cookie))).status, 400);
    }
    assert.equal(calls, 0);
    for (const reader of [async () => ({ status: "unavailable", records: [], nextCursor: null }), async () => { throw new Error("private-service-error"); }]) {
        const response = await (await loadRoute(reader))(request("", cookie));
        assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "private, no-store");
        assert(!(await response.text()).includes("private-service-error"));
    }
});

await test("existing proxy also session-gates the inventory endpoint", async () => {
    const source = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const loaded = { exports: {} as { proxy: (request: NextRequest) => Promise<Response> } };
    runInNewContext(output, { exports: loaded.exports, module: loaded, require: (name: string) => {
        if (name === "@/lib/auth/config") return authConfig;
        if (name === "@/lib/auth/session") return { verifySessionValue };
        return require(name);
    } });
    assert.equal((await loaded.exports.proxy(request())).status, 307);
    assert.equal((await loaded.exports.proxy(request("", undefined, "synthetic-mcp-key"))).status, 307);
    assert.equal((await loaded.exports.proxy(request("", await createSessionValue()))).headers.get("x-middleware-next"), "1");
});
