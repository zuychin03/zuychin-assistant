import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, mock, test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as protocol from "../src/lib/council/protocol.ts";
import * as templates from "../src/lib/council/templates.ts";
import * as scopes from "../src/lib/agents/scopes.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://speak-parity.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "synthetic";
process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service";
const network = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network"); });
const { supabaseAdmin } = await import("../src/lib/supabase.ts");
const store = await import("../src/lib/council/store.ts");
const identity = await import("../src/lib/council/write-identity.ts");
const hostContracts = await import("../src/lib/council/host-contracts.ts");
after(() => { assert.equal(network.mock.callCount(), 0); mock.restoreAll(); });
const sessionId = "11111111-1111-4111-8111-111111111111";
const roster = [{ name: "seat", kind: "agent", dispatch_mode: true, cursor_seq: 0 }, { name: "peer", kind: "agent" }, { name: "zuychin", kind: "moderator" }];
const message = { sessionId, speaker: "seat", intent: "propose", body: "Synthetic message", clientKey: "synthetic-client" };
const rpcCalls: Record<string, unknown>[] = [];
mock.method(supabaseAdmin, "from", (table: string) => {
    assert.equal(table, "council_participants");
    const builder = { select: () => builder, eq: () => builder, order: async () => ({ data: roster, error: null }) };
    return builder;
});
mock.method(supabaseAdmin, "rpc", async (name: string, args: Record<string, unknown>) => {
    assert.equal(name, "append_council_message"); rpcCalls.push(args);
    return { data: { ok: true, seq: 1, round: 1 }, error: null };
});
type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }>;
const handlers = new Map<string, ToolHandler>();
const dependencies: Record<string, unknown> = {
    zod: { z }, "mcp-handler": { createMcpHandler: (register: (server: unknown) => void) => { register({ registerTool: (name: string, _meta: unknown, handler: ToolHandler) => handlers.set(name, handler) }); return () => undefined; }, withMcpAuth: (handler: unknown) => handler },
    "@/lib/council/store": { ...store, getSessionByCode: async () => ({ id: sessionId, code: "CN-TEST", protocolVersion: 2 }), listParticipants: async () => roster.map(row => ({ ...row, dispatchMode: row.dispatch_mode, cursorSeq: row.cursor_seq })) },
    "@/lib/council/protocol": protocol, "@/lib/council/templates": templates, "@/lib/agents/scopes": scopes,
    "@/lib/council/host-contracts": hostContracts, "@/lib/council/write-identity": identity,
    "@/lib/council/render": { renderDispatchSpeakResult: () => "Recorded" },
    "@/lib/vault/ingest": { VAULT_CATEGORIES: ["study"] },
};
function load(path: string): Record<string, unknown> {
    const exports = {};
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
        exports, process: { env: { COUNCIL_V2_ASSERTED_IDENTITY: "true" } }, require: (id: string) => dependencies[id] ?? new Proxy({}, { get: () => () => undefined }),
    });
    return exports;
}
dependencies["@/lib/council/operations"] = load("../src/lib/council/operations.ts");
load("../src/app/api/mcp/[transport]/route.ts");
const speak = (params: Record<string, unknown>) => handlers.get("council_speak")!({ sessionCode: "CN-TEST", agentName: "seat", message: message.body, clientKey: message.clientKey, ...params }, { authInfo: { clientId: "agent:owner", scopes: ["council:owner"] } });
const invalid = [
    { intent: "propose", addressedTo: "unknown" },
    { intent: "challenge", addressedTo: "unknown" },
    { intent: "ask" }, { intent: "challenge", replyToSeq: 1 },
    { intent: "answer" }, { intent: "concede" }, { intent: "challenge", addressedTo: "peer" },
    { intent: "propose", addressedTo: " peer " }, { intent: "propose", addressedTo: "Peer" },
];
for (const [index, params] of invalid.entries()) test(`direct service and MCP preserve rejection ordering for invalid speak${index + 1}`, async () => {
    rpcCalls.length = 0;
    let direct = "";
    const target = params.addressedTo ?? "all";
    const expected = index < 2 || index > 6
        ? `addressedTo "${target}" is not on the roster. Valid values: seat, peer, zuychin, all.\n\nNEXT → repeat your council_speak call with a valid addressedTo.`
        : index < 4
            ? `intent "${params.intent}" must name one participant in addressedTo. Valid values: seat, peer, zuychin.\n\nNEXT → repeat your council_speak call with addressedTo set.`
            : `intent "${params.intent}" must set replyToSeq to the seq you are responding to; that is what clears the obligation.\n\nNEXT → repeat your council_speak call with replyToSeq set.`;
    await assert.rejects(store.appendMessage({ ...message, ...params }), (error: Error) => { direct = error.message; return direct === `PROTOCOL_ERROR - nothing was recorded.\n${expected}`; });
    assert.equal(rpcCalls.length, 0);
    const routed = await speak(params);
    assert.equal(routed.content[0].text, direct);
    assert.equal(rpcCalls.length, 0);
});
test("existing accepted intent/target combinations keep exact append payloads", async () => {
    for (const params of [{ intent: "propose" }, { intent: "ask", addressedTo: "peer" }, { intent: "answer", replyToSeq: 1 }, { intent: "challenge", addressedTo: "seat", replyToSeq: 999 }, { intent: "refine", addressedTo: "zuychin" }]) {
        rpcCalls.length = 0;
        await store.appendMessage({ ...message, ...params });
        const direct = rpcCalls[0];
        const response = await speak(params);
        assert.equal(response.content[0].text, "Recorded");
        assert.deepEqual(rpcCalls[1], direct);
    }
});
test("moderator/system notices and agent pass retain their existing append path", async () => {
    rpcCalls.length = 0;
    for (const role of ["moderator", "system"] as const) await store.appendMessage({ ...message, role, intent: "ask" });
    await store.appendMessage({ ...message, intent: "pass" });
    assert.equal(rpcCalls.length, 3);
});

test("untyped direct callers cannot bypass required replies with null", async () => {
    rpcCalls.length = 0;
    for (const intent of ["answer", "concede", "challenge"]) {
        await assert.rejects(store.appendMessage({ ...message, intent, addressedTo: "peer", replyToSeq: null as unknown as number }),
            (error: Error) => error.message.includes(`intent "${intent}" must set replyToSeq`));
    }
    assert.equal(rpcCalls.length, 0);
});

test("a null reply retains invalid-target and required-target rejection precedence", async () => {
    rpcCalls.length = 0;
    for (const [addressedTo, code] of [["unknown", "invalid_target"], ["all", "target_required"]]) {
        await assert.rejects(store.appendMessage({ ...message, intent: "challenge", addressedTo, replyToSeq: null as unknown as number }),
            (error: unknown) => error instanceof store.CouncilSpeakProtocolError && error.code === code);
    }
    assert.equal(rpcCalls.length, 0);
});
