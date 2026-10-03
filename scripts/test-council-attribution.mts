import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, beforeEach, mock, test } from "node:test";
import { runInNewContext } from "node:vm";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { withMcpAuth } from "mcp-handler";
import ts from "typescript";
import { z } from "zod";
import * as protocol from "../src/lib/council/protocol.ts";
import * as templates from "../src/lib/council/templates.ts";
import * as hostContracts from "../src/lib/council/host-contracts.ts";
import * as scopes from "../src/lib/agents/scopes.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://council-test.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "synthetic-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service";
delete process.env.MCP_COUNCIL_HOST_KEY;

const SESSION = "11111111-1111-4111-8111-111111111111";
const EXECUTION = "22222222-2222-4222-8222-222222222222";
const OTHER_EXECUTION = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";
const TOKEN = "zcs_" + "a".repeat(64);
const HASH = createHash("sha256").update(TOKEN).digest("hex");
const writeIdentity = { tokenHash: HASH, executionId: EXECUTION };
const auth = (executionId: string | null = EXECUTION, required = true): AuthInfo => ({
    token: TOKEN, clientId: `council-seat:${SESSION}:seat`, scopes: ["council:seat"],
    extra: { councilExecutionId: executionId, councilExecutionBindingRequired: required },
});
const owner: AuthInfo = { token: "synthetic-owner", clientId: "agent:owner", scopes: ["council:owner"] };
const network = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network access"); });
const { supabaseAdmin } = await import("../src/lib/supabase.ts");
const store = await import("../src/lib/council/store.ts");
const campaign = await import("../src/lib/council/campaign.ts");
const { verifyMcpToken } = await import("../src/lib/agents/mcp-auth.ts");
const identityModule = await import("../src/lib/council/write-identity.ts");
const { getCouncilWriteIdentity } = identityModule;
after(() => { assert.equal(network.mock.callCount(), 0); mock.restoreAll(); });

test("write identity is hashed from a verified seat bearer and server execution metadata", () => {
    assert.deepEqual(getCouncilWriteIdentity(auth()), writeIdentity);
    assert.deepEqual(getCouncilWriteIdentity(auth(null, false)), { tokenHash: HASH, executionId: null });
    assert.equal(getCouncilWriteIdentity(owner), undefined);
});

test("pending, malformed and non-seat identities fail closed", () => {
    const invalid: (AuthInfo | undefined)[] = [undefined,
        { ...auth(), scopes: ["knowledge:read"] },
        { ...auth(), clientId: "council-host", scopes: ["council:host"] },
        { ...auth(), token: "zcs_short" }, auth("not-a-uuid"), auth(null, true),
    ];
    for (const value of invalid) assert.throws(() => getCouncilWriteIdentity(value));
});

test("actual MCP auth resolves the same bearer afresh on every request", async t => {
    let executionId: string | null = null;
    const rpc = t.mock.method(supabaseAdmin, "rpc", async (name: string, args: unknown) => {
        assert.equal(name, "resolve_council_seat_key");
        assert.deepEqual(args, { p_token_hash: HASH });
        return { data: { session_id: SESSION, seat_name: "seat", code: "CN-TEST", issuer: "host",
            execution_id: executionId, execution_binding_required: true }, error: null };
    });
    const handler = withMcpAuth(async (request: Request) =>
        Response.json((request as Request & { auth: AuthInfo }).auth.extra), verifyMcpToken, { required: true });
    const request = () => new Request("https://app.invalid/api/mcp/mcp", { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.deepEqual(await (await handler(request())).json(), { councilExecutionId: null, councilExecutionBindingRequired: true });
    executionId = EXECUTION;
    assert.deepEqual(await (await handler(request())).json(), { councilExecutionId: EXECUTION, councilExecutionBindingRequired: true });
    assert.equal(rpc.mock.callCount(), 2);
});

const message = { sessionId: SESSION, speaker: "seat", intent: "propose", body: "Synthetic proposal", clientKey: "test-1" };
const submission = { itemId: ITEM, agentName: "seat", commitHash: "a".repeat(40), verification: "Synthetic result" };

test("seat messages and submissions pass verified identity to the atomic RPCs", async t => {
    const rpc = t.mock.method(supabaseAdmin, "rpc", async (name: string, args: Record<string, unknown>) => {
        assert.equal(args.p_seat_token_hash, HASH);
        assert.equal(args.p_expected_execution_id, EXECUTION);
        assert(["append_council_message_attributed", "complete_council_work_item_attributed"].includes(name));
        return { data: { ok: true, executionId: EXECUTION, round: 1 }, error: null };
    });
    assert.equal((await store.appendMessage({ ...message, identity: writeIdentity })).ok, true);
    assert.equal(await campaign.completeWorkItem({ ...submission, identity: writeIdentity }), true);
    assert.equal(rpc.mock.callCount(), 2);
});

test("legacy owner and moderator writes retain the unbound RPC path", async t => {
    const rpc = t.mock.method(supabaseAdmin, "rpc", async (name: string, args: Record<string, unknown>) => {
        assert(!("p_seat_token_hash" in args));
        if (name === "append_council_message") return { data: { ok: true, round: 1 }, error: null };
        assert.equal(name, "complete_council_work_item");
        return { data: true, error: null };
    });
    assert.equal((await store.appendMessage({ ...message, role: "moderator" })).ok, true);
    assert.equal(await campaign.completeWorkItem(submission), true);
    assert.equal(rpc.mock.callCount(), 2);
});

test("legacy seat identity stays null without substituting a newer execution", async t => {
    t.mock.method(supabaseAdmin, "rpc", async (name: string, args: Record<string, unknown>) => {
        assert.equal(name, "append_council_message_attributed");
        assert.equal(args.p_expected_execution_id, null);
        return { data: { ok: true, round: 1, executionId: null }, error: null };
    });
    await store.appendMessage({ ...message, identity: { tokenHash: HASH, executionId: null } });
});

test("attributed failures never retry through the legacy RPC", async t => {
    const rpc = t.mock.method(supabaseAdmin, "rpc", async () => ({ data: null, error: { message: "synthetic unavailable" } }));
    t.mock.method(console, "error", () => undefined);
    await assert.rejects(store.appendMessage({ ...message, identity: writeIdentity }), /nothing was said/);
    await assert.rejects(campaign.completeWorkItem({ ...submission, identity: writeIdentity }), /synthetic unavailable/);
    assert.equal(rpc.mock.callCount(), 2);
});

test("invalid write identity is rejected before any database call", async t => {
    const rpc = t.mock.method(supabaseAdmin, "rpc", async () => { assert.fail("Invalid identity reached database"); });
    t.mock.method(console, "error", () => undefined);
    for (const identity of [{ tokenHash: "bad", executionId: EXECUTION }, { tokenHash: HASH, executionId: "bad" }]) {
        await assert.rejects(store.appendMessage({ ...message, identity }));
        await assert.rejects(campaign.completeWorkItem({ ...submission, identity }));
    }
    assert.equal(rpc.mock.callCount(), 0);
});

test("message and work-item mappers preserve explicit bindings and historical nulls", async t => {
    const messageRows = [EXECUTION, null].map((id, i) => ({ seq: i + 1, execution_id: id, body: "Synthetic message" }));
    const itemRows = [{ submitted_execution_id: EXECUTION, accepted_execution_id: OTHER_EXECUTION }, {}];
    t.mock.method(supabaseAdmin, "from", (table: string) => {
        const rows = table === "council_messages" ? messageRows : itemRows;
        const builder = { select: (columns: string) => {
            assert(columns.includes(table === "council_messages" ? "execution_id" : "submitted_execution_id"));
            return builder;
        }, eq: () => builder, gt: () => builder, order: () => builder, limit: () => builder,
        then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve) };
        return builder;
    });
    assert.deepEqual((await store.readTranscript({ sessionId: SESSION })).map(m => m.executionId), [EXECUTION, null]);
    assert.deepEqual((await campaign.listCampaignWorkItems("campaign")).map(i => [i.submittedExecutionId, i.acceptedExecutionId]),
        [[EXECUTION, OTHER_EXECUTION], [null, null]]);
});

type ToolResult = { isError?: boolean; content: { text: string }[] };
type ToolHandler = (args: Record<string, unknown>, extra: { authInfo: AuthInfo }) => Promise<ToolResult>;
let protocolVersion = 3;
const calls: { kind: string; args: Record<string, unknown> }[] = [];
beforeEach(t => {
    calls.length = 0; protocolVersion = 3;
    assert("mock" in t);
    t.mock.method(supabaseAdmin, "from", (table: string) => {
        assert.equal(table, "council_participants");
        const query = { select: () => query, eq: () => query, order: async () => ({ data: [{ name: "seat", kind: "agent" }], error: null }) };
        return query;
    });
});

function registeredTools() {
    const handlers = new Map<string, ToolHandler>();
    const schemas = new Map<string, Record<string, z.ZodType>>();
    const participant = { name: "seat", kind: "agent", dispatchMode: true, cursorSeq: 0 };
    const dependencies: Record<string, unknown> = {
        zod: { z }, "mcp-handler": {
            createMcpHandler: (register: (server: { registerTool: (name: string, meta: { inputSchema: Record<string, z.ZodType> }, handler: ToolHandler) => void }) => void) => {
                register({ registerTool: (name, meta, handler) => { handlers.set(name, handler); schemas.set(name, meta.inputSchema); } });
                return () => undefined;
            }, withMcpAuth: (handler: unknown) => handler,
        },
        "@/lib/council/protocol": protocol, "@/lib/council/templates": templates,
        "@/lib/council/host-contracts": hostContracts, "@/lib/agents/scopes": scopes,
        "@/lib/council/write-identity": identityModule,
        "@/lib/council/store": {
            CouncilSpeakProtocolError: store.CouncilSpeakProtocolError,
            getSessionByCode: async () => ({ id: SESSION, code: "CN-TEST", round: 1, lastSeq: 0, protocolVersion }),
            listParticipants: async () => [participant], getParticipant: async () => participant,
            appendMessage: async (args: Record<string, unknown>) => { calls.push({ kind: "message", args }); return { ok: true, round: 1 }; },
        },
        "@/lib/council/campaign": { completeWorkItem: async (args: Record<string, unknown>) => { calls.push({ kind: "submission", args }); return true; } },
        "@/lib/council/seat-keys": { issueHostSeatKey: async (args: Record<string, unknown>) => { calls.push({ kind: "issue", args }); return { ok: true }; } },
        "@/lib/council/render": { renderDispatchSpeakResult: () => "Recorded", renderPassed: () => "Passed" },
        "@/lib/agents/mcp-auth": { verifyMcpToken },
        "@/lib/vault/ingest": { VAULT_CATEGORIES: ["study"] },
    };
    const source = readFileSync(new URL("../src/app/api/mcp/[transport]/route.ts", import.meta.url), "utf8");
    runInNewContext(ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports: {}, process: { env: { COUNCIL_V2_ASSERTED_IDENTITY: "true" } },
        require: (id: string) => dependencies[id] ?? new Proxy({}, { get: (_target, key) => { throw new Error(`Unexpected boundary ${id}.${String(key)}`); } }) });
    return { handlers, schemas };
}
const tools = registeredTools();
const toolArgs = {
    sessionCode: "CN-TEST", intent: "propose", message: "Synthetic proposal", clientKey: "test-1",
    reason: "Nothing further", ...submission, executionId: OTHER_EXECUTION, identity: { tokenHash: "b".repeat(64), executionId: OTHER_EXECUTION },
};

for (const name of ["council_speak", "council_pass", "council_work_complete"]) {
    test(`${name} uses authenticated identity and ignores forged model inputs`, async () => {
        const schema = tools.schemas.get(name)!;
        assert(!("executionId" in schema)); assert(!("identity" in schema)); assert(!("tokenHash" in schema));
        await tools.handlers.get(name)!(toolArgs, { authInfo: auth() });
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].args.identity, writeIdentity);
    });
    test(`${name} rejects pending keys, wrong seats and read-only callers`, async () => {
        for (const identity of [auth(null, true), { ...auth(), clientId: `council-seat:${SESSION}:other` }, { ...auth(), scopes: ["knowledge:read"] }]) {
            await tools.handlers.get(name)!(toolArgs, { authInfo: identity });
            assert.equal(calls.length, 0);
        }
    });
    test(`${name} preserves explicitly enabled legacy owner access`, async () => {
        protocolVersion = 2;
        await tools.handlers.get(name)!(toolArgs, { authInfo: owner });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].args.identity, undefined);
    });
}

test("host issuance advertises and forwards optional execution binding", async () => {
    const schema = tools.schemas.get("council_host_issue_seat")!;
    assert.equal(schema.bindExecution.safeParse(true).success, true);
    await tools.handlers.get("council_host_issue_seat")!({ sessionCode: "CN-TEST", agentName: "seat", hostId: ITEM, leaseEpoch: 1, bindExecution: true },
        { authInfo: { token: "synthetic-host", clientId: "council-host", scopes: ["council:host"] } });
    assert.equal(calls[0].args.bindExecution, true);
});

for (const name of ["council_join", "council_conclude", "council_work_next", "council_work_heartbeat", "council_work_review", "council_work_block"]) {
    test(`${name} refuses a pending execution binding at the seat gate`, async () => {
        const result = await tools.handlers.get(name)!({ ...toolArgs, verdict: "Synthetic verdict", accepted: true, note: "Synthetic review" }, { authInfo: auth(null, true) });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /execution binding/);
        assert.equal(calls.length, 0);
    });
}
