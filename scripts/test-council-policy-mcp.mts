import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, mock, test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import * as hostContracts from "../src/lib/council/host-contracts.ts";
import * as policyVersions from "../src/lib/council/policy-versions.ts";
import * as protocol from "../src/lib/council/protocol.ts";
import * as scopes from "../src/lib/agents/scopes.ts";
import * as templates from "../src/lib/council/templates.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://policy-mcp.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "synthetic-policy-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-policy-service";
const network = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network access"); });
const { supabaseAdmin } = await import("../src/lib/supabase.ts");
const service = await import("../src/lib/council/host-service.ts");
const { NODE_POLICY_VERSION } = policyVersions;
const sessionId = "11111111-1111-4111-8111-111111111111";
const hostId = "22222222-2222-4222-8222-222222222222";
const executionId = "33333333-3333-4333-8333-333333333333";
const lease = { ok: true, hostId, leaseEpoch: 4, leaseExpiresAt: "2026-09-30T06:00:00Z" };
const host = { scopes: ["council:host"] };
const claim = { sessionCode: "CN-TEST", hostId, policyVersion: NODE_POLICY_VERSION };
const start = {
    ...claim, leaseEpoch: 4, agentName: "seat", seatTokenHash: "a".repeat(64), hostGeneration: "typescript-node",
    capabilities: { kind: "acp", source: "probed", streaming: true, cancellation: true, sessionResume: false,
        modelSelection: true, structuredActions: true, toolCalls: true, permissionCallbacks: true,
        filesystemMediated: true, terminalMediated: true, observedAt: "2026-09-30T05:00:00Z" },
    identityAssurance: "verified_seat", provider: "fixture-provider", effectiveModel: "fixture-model",
};
let boundary = { ok: true, hostGeneration: null as string | null, policyVersion: null as string | null, hasExecutionHistory: false };
let sessionReads = 0, sessionExists = true;
const calls: { name: string; args: Record<string, unknown> }[] = [];
mock.method(supabaseAdmin, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "claim_council_host_lease") return { data: lease, error: null };
    if (name === "get_council_execution_boundary") return { data: boundary, error: null };
    assert(["start_council_versioned_bound_execution", "start_council_bound_agent_execution"].includes(name));
    return { data: { ok: true, executionId, seatBound: true, ...(args.p_policy_version ? {
        hostGeneration: args.p_host_generation, policyVersion: args.p_policy_version,
    } : {}) }, error: null };
});
after(() => { assert.equal(network.mock.callCount(), 0); mock.restoreAll(); });
beforeEach(() => {
    calls.length = 0; sessionReads = 0; sessionExists = true;
    boundary = { ok: true, hostGeneration: null, policyVersion: null, hasExecutionHistory: false };
});

type ToolResult = { isError?: boolean; content: { text: string }[] };
type ToolHandler = (args: Record<string, unknown>, extra: { authInfo?: { scopes: string[] } }) => Promise<ToolResult>;
const tools = new Map<string, { schema: Record<string, z.ZodType>; handler: ToolHandler }>();
const dependencies: Record<string, unknown> = {
    zod: { z }, "mcp-handler": {
        createMcpHandler: (register: (server: unknown) => void) => {
            register({ registerTool: (name: string, meta: { inputSchema: Record<string, z.ZodType> }, handler: ToolHandler) => tools.set(name, { schema: meta.inputSchema, handler }) });
            return () => undefined;
        }, withMcpAuth: (handler: unknown) => handler,
    },
    "@/lib/council/host-contracts": hostContracts, "@/lib/council/policy-versions": policyVersions,
    "@/lib/council/protocol": protocol, "@/lib/agents/scopes": scopes, "@/lib/council/templates": templates,
    "@/lib/council/service": { councilHostService: { claimLease: service.claimHostLease, startExecution: service.startAgentExecution } },
    "@/lib/council/store": { getSessionByCode: async (code: string) => {
        sessionReads++; assert.equal(code, "CN-TEST");
        return sessionExists ? { id: sessionId, code, topic: "Synthetic", status: "open", protocolVersion: 3, baseSha: "b".repeat(40) } : null;
    } },
    "@/lib/vault/ingest": { VAULT_CATEGORIES: ["study"] },
};
const source = readFileSync(new URL("../src/app/api/mcp/[transport]/route.ts", import.meta.url), "utf8");
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: {}, process: { env: {} }, require: (name: string) => dependencies[name] ?? new Proxy({}, { get: () => () => undefined }),
});
async function invoke(name: string, args: Record<string, unknown>, authInfo: { scopes: string[] } | undefined = host): Promise<ToolResult> {
    const tool = tools.get(name)!;
    return tool.handler(z.object(tool.schema).parse(args), { authInfo });
}
const read = (result: ToolResult) => JSON.parse(result.content[0].text) as Record<string, unknown>;

for (const name of ["council_host_claim", "council_execution_start"]) {
    test(`${name} advertises the exact optional current policy literal`, () => {
        const schema = tools.get(name)!.schema.policyVersion;
        assert(schema, "The registered schema must advertise policyVersion");
        const advertised = zodToJsonSchema(z.object(tools.get(name)!.schema)) as { properties: Record<string, { const?: unknown }> };
        assert.equal(advertised.properties.policyVersion.const, NODE_POLICY_VERSION);
        assert.equal(schema.safeParse(undefined).success, true);
        assert.equal(schema.safeParse("council-reference-v1").success, false);
    });
    test(`${name} rejects a future policy before session reads or RPC`, async () => {
        await assert.rejects(invoke(name, { ...(name === "council_host_claim" ? claim : start), policyVersion: "future-policy" }));
        assert.equal(sessionReads, 0); assert.equal(calls.length, 0);
    });
    test(`${name} denies non-host callers before all I/O`, async () => {
        for (const authInfo of [null, { scopes: ["council:seat"] }, { scopes: ["council:owner"] }, { scopes: ["knowledge:read"] }]) {
            const tool = tools.get(name)!;
            const result = await tool.handler(z.object(tool.schema).parse(name === "council_host_claim" ? claim : start), { authInfo: authInfo ?? undefined });
            assert.equal(result.isError, true);
        }
        assert.equal(sessionReads, 0); assert.equal(calls.length, 0);
    });
}

test("policy-aware claim forwards the resolved session and returns the exact fenced boundary", async () => {
    boundary = { ok: true, hostGeneration: "historical-node", policyVersion: "historical-policy", hasExecutionHistory: true };
    const result = read(await invoke("council_host_claim", claim));
    assert.deepEqual(calls, [
        { name: "claim_council_host_lease", args: { p_session_id: sessionId, p_host_id: hostId, p_duration_seconds: 45 } },
        { name: "get_council_execution_boundary", args: { p_session_id: sessionId, p_host_id: hostId, p_lease_epoch: 4 } },
    ]);
    assert.equal(result.hostGeneration, "historical-node"); assert.equal(result.policyVersion, "historical-policy");
    assert.equal(result.hasExecutionHistory, true);
    assert.equal((result.session as Record<string, unknown>).id, sessionId);
});

test("historical unknown policy metadata stays null through the registered claim response", async () => {
    boundary.hasExecutionHistory = true;
    const result = read(await invoke("council_host_claim", claim));
    assert.equal(result.hostGeneration, null); assert.equal(result.policyVersion, null);
    assert.equal(result.hasExecutionHistory, true);
});

test("policy omission keeps the legacy claim response and avoids a boundary query", async () => {
    const result = read(await invoke("council_host_claim", { sessionCode: claim.sessionCode, hostId }));
    assert.deepEqual(calls.map(call => call.name), ["claim_council_host_lease"]);
    assert.equal(result.policyVersion, undefined); assert.equal(result.hasExecutionHistory, undefined);
});

test("registered start preserves policy, seat binding and the exact host fence", async () => {
    const result = read(await invoke("council_execution_start", start));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "start_council_versioned_bound_execution");
    assert.equal(calls[0].args.p_session_id, sessionId); assert.equal(calls[0].args.p_host_id, hostId);
    assert.equal(calls[0].args.p_lease_epoch, 4); assert.equal(calls[0].args.p_policy_version, NODE_POLICY_VERSION);
    assert.equal(calls[0].args.p_host_generation, "typescript-node"); assert.equal(calls[0].args.p_seat_token_hash, start.seatTokenHash);
    assert.equal(calls[0].args.p_effective_model, start.effectiveModel);
    assert.deepEqual(result, { ok: true, executionId, seatBound: true, hostGeneration: "typescript-node", policyVersion: NODE_POLICY_VERSION });
});

test("policy omission retains the existing bound execution RPC without fabricating policy evidence", async () => {
    const result = read(await invoke("council_execution_start", { ...start, policyVersion: undefined }));
    assert.equal(calls[0].name, "start_council_bound_agent_execution");
    assert.equal("p_policy_version" in calls[0].args, false);
    assert.equal(result.policyVersion, undefined); assert.equal(result.hostGeneration, undefined);
});

test("unknown sessions stop claim and start before RPC", async () => {
    sessionExists = false;
    for (const [name, args] of [["council_host_claim", claim], ["council_execution_start", start]] as const) {
        assert.deepEqual(read(await invoke(name, args)), { ok: false, reason: "unknown_session" });
    }
    assert.equal(calls.length, 0);
});
