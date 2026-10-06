import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, mock, test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as protocol from "../src/lib/council/protocol.ts";
import * as templates from "../src/lib/council/templates.ts";
import * as hostContracts from "../src/lib/council/host-contracts.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://council-test.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "synthetic-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service";

type Row = Record<string, unknown>;
const NOW = Date.parse("2026-09-30T00:00:00Z");
const rows: Row[] = [];
const requests: string[] = [];
let beforeUpdate: (() => void) | undefined;
let failUpdate = false;
let actionOutcome: { ok: boolean; reason?: string } = { ok: true };

function splitFilters(value: string): string[] {
    let depth = 0, start = 0;
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
        if (value[i] === "(") depth++;
        if (value[i] === ")") depth--;
        if (value[i] === "," && depth === 0) { parts.push(value.slice(start, i)); start = i + 1; }
    }
    return [...parts, value.slice(start)];
}

function matches(row: Row, expression: string): boolean {
    for (const operator of ["and", "or"]) {
        if (expression.startsWith(`${operator}(`)) {
            const values = splitFilters(expression.slice(operator.length + 1, -1)).map(part => matches(row, part));
            return operator === "and" ? values.every(Boolean) : values.some(Boolean);
        }
    }
    const match = expression.match(/^(\w+)\.(eq|neq|is|in|lt|lte|gt)\.(.*)$/);
    assert(match, `Unexpected PostgREST filter ${expression}`);
    const [, column, op, value] = match;
    if (op === "is") return value === "null" && row[column] === null;
    if (op === "in") return value.slice(1, -1).split(",").includes(String(row[column]));
    if (op === "eq") return String(row[column]) === value;
    if (op === "neq") return String(row[column]) !== value;
    if (row[column] === null) return false;
    const actual = Date.parse(String(row[column])), expected = Date.parse(value);
    if (op === "lt") return actual < expected;
    if (op === "lte") return actual <= expected;
    return actual > expected;
}

mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://council-test.invalid");
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    if (url.pathname.endsWith("/rpc/touch_council_participant")) return json(true);
    if (["/rpc/pause_council", "/rpc/resume_council"].some(path => url.pathname.endsWith(path))) {
        assert.deepEqual(JSON.parse(String(init?.body)), { p_session_id: "session" });
        return json(actionOutcome);
    }
    const table = url.pathname.split("/").at(-1);
    assert(["council_sessions", "council_participants", "council_messages"].includes(table!), `Unexpected request ${url.pathname}`);
    if (init?.method === "PATCH") {
        beforeUpdate?.(); beforeUpdate = undefined;
        if (failUpdate) return new Response(JSON.stringify({ message: "synthetic unavailable" }), { status: 500 });
    }
    const source = table === "council_sessions" ? rows : table === "council_participants" ? [{
        id: "participant", session_id: "session", name: "seat", kind: "agent", expertise: "", status: "active",
        posts_total: 0, posts_this_round: 0, cursor_seq: 0, pending_ack_seq: 0, expired_grants: 0,
        wait_calls: 0, joined_seq: 0, last_seen_at: new Date(NOW).toISOString(), dispatch_mode: true,
    }] : [];
    const selected = source.filter(row => [...url.searchParams].every(([key, value]) =>
        ["select", "order", "limit"].includes(key) || matches(row, `${key}${key === "or" ? "" : "."}${value}`)));
    if (init?.method === "PATCH") {
        const changes = JSON.parse(String(init.body));
        for (const row of selected) Object.assign(row, changes);
    }
    return json(selected);
});
after(() => mock.restoreAll());
beforeEach(() => { rows.length = 0; requests.length = 0; beforeUpdate = undefined; failUpdate = false; actionOutcome = { ok: true }; });

const store = await import("../src/lib/council/store.ts");
const { pollCouncil, dispatchCouncil } = await import("../src/lib/council/wait.ts");
const { renderClosed } = await import("../src/lib/council/render.ts");

function fixture(pausedAt: string | null, overrides: Row = {}) {
    const row: Row = {
        id: "session", code: "CN-TEST", topic: "Retained discussion", brief: "", closer_name: "seat",
        council_type: "debate", status: "open", round: 1, max_rounds: 6, max_messages: 60,
        last_seq: 0, last_message_at: "2026-09-01T00:00:00Z", quorum_at: null,
        floor_holder: "seat", floor_granted_at: new Date(NOW).toISOString(), floor_epoch: 1, silent_grants: 0,
        verdict: null, open_questions: [], archive_status: "pending", vault_path: null,
        expires_at: "2026-10-30T00:00:00Z", closed_at: null, created_at: "2026-09-01T00:00:00Z",
        repo_path: null, base_branch: null, protocol_version: 3, base_sha: null,
        paused_at: pausedAt, paused_total_seconds: 0, verdict_proposed_at: null, standby_expires_at: null,
        continue_count: 0, ...overrides,
    };
    rows.push(row);
    return row;
}

test("sweep expires exactly seven paused days, preserving other lifecycle cases", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const exact = fixture("2026-09-23T00:00:00Z", { id: "exact" });
    const before = fixture("2026-09-23T00:00:00.001Z", { id: "before", expires_at: "2026-09-23T01:00:00Z" });
    const old = fixture("2026-08-01T00:00:00Z", { id: "old", status: "concluding" });
    const running = fixture(null, { id: "running", expires_at: "2026-09-29T00:00:00Z" });
    const future = fixture(null, { id: "future" });
    const normalExact = fixture(null, { id: "normal-exact", expires_at: "2026-09-30T00:00:00Z" });
    const closed = fixture("2026-08-01T00:00:00Z", { id: "closed", status: "closed" });
    const originals = rows.map(row => ({ ...row }));
    assert.deepEqual((await store.expireOverdueSessions()).map(s => s.id).sort(), ["exact", "old", "running"]);
    for (const row of [exact, old, running]) assert.equal(row.status, "expired");
    for (const row of [before, future, normalExact, closed]) assert.deepEqual(row, originals.find(r => r.id === row.id));
    for (const row of [exact, old]) assert.deepEqual(row, { ...originals.find(r => r.id === row.id), status: "expired" });
    assert.deepEqual(await store.listSessionsNeedingVerdict(600_000), [await store.getSessionById("running")]);
});

test("single-session expiry does not mutate another Council or a resumed pause", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const target = fixture("2026-09-23T00:00:00Z");
    const other = fixture("2026-09-01T00:00:00Z", { id: "other" });
    beforeUpdate = () => { target.paused_at = null; target.expires_at = "2026-10-30T00:00:00Z"; };
    await store.expireSessionIfDue("session");
    assert.equal(target.status, "open");
    assert.equal(other.status, "open");
    target.paused_at = "2026-09-23T00:00:00Z";
    await store.expireSessionIfDue("session");
    assert.equal(target.status, "expired");
    assert.equal(other.status, "open");
});

for (const status of ["open", "expired"]) {
    test(`poll releases a seven-day pause with initial status ${status}`, async t => {
        t.mock.timers.enable({ apis: ["Date"], now: NOW });
        const row = fixture("2026-09-23T00:00:00Z", { status });
        const session = await store.getSessionById("session");
        assert(session);
        const result = await pollCouncil({ session, agentName: "seat", waitMs: 0 });
        assert.equal(result.kind, "closed");
        assert.equal(row.status, "expired");
        if (result.kind !== "closed") assert.fail("Expected terminal pause expiry");
        const text = renderClosed(result.session);
        assert.match(text, /expired[\s\S]*seven|seven[\s\S]*expired/i);
        assert.match(text, /transcript[\s\S]*retain/i);
        assert.doesNotMatch(text, /write the verdict|call council_work_next/i);
    });
    test(`dispatch returns no deliveries for a seven-day pause with initial status ${status}`, async t => {
        t.mock.timers.enable({ apis: ["Date"], now: NOW });
        fixture("2026-09-23T00:00:00Z", { status });
        const session = await store.getSessionById("session");
        assert(session);
        const result = await dispatchCouncil({ session, agentNames: ["seat"], durable: true });
        assert.equal(result.kind, "ok");
        if (result.kind !== "ok") assert.fail("Expected expired status without delivery");
        assert.equal(result.session.status, "expired");
        assert.equal(result.floorHolder, null);
        assert.deepEqual(result.view.agents, {});
        assert(!requests.some(r => r.includes("/rpc/elect_council_floor")));
    });
}

function registeredDispatch() {
    type Handler = (args: Record<string, unknown>, extra: { authInfo: { scopes: string[] } }) => Promise<{ content: { text: string }[] }>;
    const handlers = new Map<string, Handler>();
    const dependencies: Record<string, unknown> = {
        zod: { z },
        "mcp-handler": {
            createMcpHandler: (register: (server: { registerTool: (name: string, metadata: unknown, handler: Handler) => void }) => void) => {
                register({ registerTool: (name, _metadata, handler) => { handlers.set(name, handler); } });
                return () => undefined;
            },
            withMcpAuth: (handler: unknown) => handler,
        },
        "@/lib/council/protocol": protocol,
        "@/lib/council/templates": templates,
        "@/lib/council/host-contracts": hostContracts,
        "@/lib/council/store": store,
        "@/lib/council/wait": { dispatchCouncil },
        "@/lib/agents/mcp-auth": { verifyMcpToken: () => { throw new Error("No authentication calls in this fixture"); } },
        "@/lib/vault/ingest": { VAULT_CATEGORIES: ["study"] },
    };
    const load = (path: string) => {
        const exports = {};
        const source = readFileSync(new URL(path, import.meta.url), "utf8");
        runInNewContext(ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText, {
            exports, process: { env: {} },
            require: (id: string) => dependencies[id] ?? new Proxy({}, {
                get: (_target, key) => { throw new Error(`Unexpected boundary ${id}.${String(key)}`); },
            }),
        });
        return exports;
    };
    dependencies["@/lib/council/operations"] = load("../src/lib/council/operations.ts");
    load("../src/app/api/mcp/[transport]/route.ts");
    const handler = handlers.get("council_dispatch"); assert(handler);
    return handler;
}

test("registered MCP dispatch distinguishes paused expiry from normal expiry without prompts", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const handler = registeredDispatch();
    for (const pausedAt of ["2026-09-23T00:00:00Z", null]) {
        rows.length = 0;
        fixture(pausedAt, { status: "expired", floor_holder: null });
        const result = await handler({ sessionCode: "CN-TEST", agentNames: ["host-probe"], hostId: "host", leaseEpoch: 1 }, {
            authInfo: { scopes: ["council:host"] },
        });
        const payload = JSON.parse(result.content[0].text);
        assert.equal(payload.error, undefined);
        assert.equal(payload.status, "expired");
        assert.equal(payload.pausedAt, pausedAt);
        assert.deepEqual(payload.agents, {});
    }
});

test("status-only dispatch reads a silent open Council without electing, touching or acknowledging", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const row = fixture(null, { floor_holder: null, quorum_at: "2026-09-29T00:00:00Z" });
    const before = { ...row };
    const result = await registeredDispatch()({
        sessionCode: "CN-TEST", agentNames: ["host-probe"], hostId: "host", leaseEpoch: 1, statusOnly: true,
    }, { authInfo: { scopes: ["council:host"] } });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.error, undefined);
    assert.equal(payload.statusOnly, true);
    assert.equal(payload.status, "open");
    assert.equal(payload.pausedAt, null);
    assert.equal(payload.participants[0].name, "seat");
    assert.equal(payload.participants[0].dispatchMode, true);
    assert.deepEqual(payload.agents, {});
    assert.deepEqual(row, before);
    assert.deepEqual(requests, ["GET /rest/v1/council_sessions", "GET /rest/v1/council_participants"]);
});

test("status-only dispatch rejects acknowledgements without mutations", async () => {
    fixture(null);
    const result = await registeredDispatch()({
        sessionCode: "CN-TEST", agentNames: ["host-probe"], hostId: "host", leaseEpoch: 1,
        statusOnly: true, ackDeliveryIds: ["delivery"],
    }, { authInfo: { scopes: ["council:host"] } });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.error, "status_only_cannot_acknowledge");
    assert(!requests.some(request => !request.startsWith("GET ")));
});

for (const [action, reason, pausedAt] of [
    ["resume", "pause_expired", "2026-09-23T00:00:00Z"],
    ["resume", "not_running", "2026-09-29T00:00:00Z"],
    ["pause", "not_running", null],
    ["pause", "unavailable", "2026-09-29T00:00:00Z"],
] as const) {
    test(`owner channel reports rejected ${action}/${reason} instead of a model-authored success`, async () => {
        fixture(pausedAt);
        actionOutcome = { ok: false, reason };
        const saved: Row[] = [];
        const dependencies: Record<string, unknown> = {
            "@/lib/gemini": { MODEL: "synthetic", ai: { models: {
                generateContent: async () => ({ text: JSON.stringify({ action, reply: "Done, I successfully changed the council." }) }),
            } } },
            "./protocol": protocol,
            "./store": { ...store, appendOwnerMessage: async (row: Row) => { saved.push(row); }, readOwnerThread: async () => [] },
        };
        const exports: { ownerTurn?: (params: { session: NonNullable<Awaited<ReturnType<typeof store.getSessionById>>>; text: string }) => Promise<{ reply: string; action: string; paused: boolean }> } = {};
        const source = readFileSync(new URL("../src/lib/council/owner-channel.ts", import.meta.url), "utf8");
        runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
            exports, require: (id: string) => { assert(Object.hasOwn(dependencies, id)); return dependencies[id]; },
        });
        const session = await store.getSessionById("session"); assert(session && exports.ownerTurn);
        const result = await exports.ownerTurn({ session, text: action });
        assert.notEqual(result.reply, "Done, I successfully changed the council.");
        assert.equal(result.action, "none");
        if (reason === "pause_expired") assert.match(result.reply, /expired[\s\S]*seven[\s\S]*transcript/i);
        else assert.match(result.reply, /could not|no longer running/i);
        assert.equal(result.paused, pausedAt !== null);
        assert.equal(saved.at(-1)?.body, result.reply);
    });
}

test("just before seven days, agents remain paused despite the normal TTL", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    fixture("2026-09-23T00:00:00.001Z", { floor_holder: null, expires_at: "2026-09-23T01:00:00Z" });
    const session = await store.getSessionById("session"); assert(session);
    assert.equal((await pollCouncil({ session, agentName: "seat", waitMs: 0 })).kind, "paused");
    assert.equal((await dispatchCouncil({ session, agentNames: ["seat"], durable: true })).kind, "paused");
    assert.equal(rows[0].status, "open");
});

for (const mode of ["poll", "dispatch"]) {
    test(`${mode} uses the resumed row when resume wins the expiry race`, async t => {
        t.mock.timers.enable({ apis: ["Date"], now: NOW });
        const row = fixture("2026-09-23T00:00:00Z", { floor_holder: null });
        const session = await store.getSessionById("session"); assert(session);
        beforeUpdate = () => { row.paused_at = null; row.expires_at = "2026-10-30T00:00:00Z"; };
        const result = mode === "poll"
            ? await pollCouncil({ session, agentName: "seat", waitMs: 0 })
            : await dispatchCouncil({ session, agentNames: ["seat"], durable: true });
        assert.equal(result.kind, mode === "poll" ? "waiting" : "ok");
        assert("session" in result);
        assert.equal(result.session.status, "open");
        assert.equal(result.session.pausedAt, null);
    });
    test(`${mode} does not claim expiry when the write fails`, async t => {
        t.mock.timers.enable({ apis: ["Date"], now: NOW });
        const warnings: unknown[][] = [];
        t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
        const row = fixture("2026-09-23T00:00:00Z");
        const session = await store.getSessionById("session"); assert(session);
        failUpdate = true;
        const result = mode === "poll"
            ? await pollCouncil({ session, agentName: "seat", waitMs: 0 })
            : await dispatchCouncil({ session, agentNames: ["seat"], durable: true });
        assert.equal(result.kind, "degraded");
        assert.equal(row.status, "open");
        assert.equal(warnings.length, 1);
    });
}
