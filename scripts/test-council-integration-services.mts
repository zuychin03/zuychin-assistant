import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, mock, test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as contracts from "../src/lib/council/host-contracts.ts";
import * as protocol from "../src/lib/council/protocol.ts";
import * as templates from "../src/lib/council/templates.ts";
import * as scopes from "../src/lib/agents/scopes.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://integration-test.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "synthetic-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-secret";
const network = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network access"); });
const { supabaseAdmin } = await import("../src/lib/supabase.ts");
const campaign = await import("../src/lib/council/campaign.ts");
after(() => { assert.equal(network.mock.callCount(), 0); mock.restoreAll(); });

const sessionId = "11111111-1111-4111-8111-111111111111";
const hostId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const sha = "a".repeat(40);
const digest = "b".repeat(64);
const caller = { scopes: ["council:host"] };
const begin = { sessionId, hostId, leaseEpoch: 2, attemptId, expectedIntegrator: null };
const receipt = { command: ["npm", "test"], exitCode: 0, durationMs: 7, outputDigest: digest,
    outputTail: "synthetic-service-secret API_KEY=fixture-secret", timedOut: false };
const evidence = { version: 1 as const, redactionVersion: 1 as const, receipts: [receipt], changedPaths: ["src/a.ts"],
    diffSummary: "1 file changed", protectedRefs: { before: { main: sha }, after: { main: sha } },
    conflictNotes: null, manualChecks: null };
const finish = { attemptId, hostId, leaseEpoch: 2, status: "verified" as const, branch: "council/test/integration",
    tipSha: sha, executionId: null, evidence };

test("only a dedicated host can begin or finish an integration attempt", async t => {
    const rpc = t.mock.method(supabaseAdmin, "rpc", async () => { assert.fail("Unauthorised RPC"); });
    for (const scopes of [undefined, [], ["council:seat"], ["council:owner"], ["knowledge:write"]]) {
        const denied = scopes ? { scopes } : undefined;
        await assert.rejects(campaign.beginIntegrationAttempt(begin, denied), /dedicated Council host/);
        await assert.rejects(campaign.finishIntegrationAttempt(finish, denied), /dedicated Council host/);
    }
    assert.equal(rpc.mock.callCount(), 0);
});

test("begin forwards caller UUID and nomination to one authoritative RPC", async t => {
    const rpc = t.mock.method(supabaseAdmin, "rpc", async (name: string, args: unknown) => {
        assert.equal(name, "begin_council_integration_attempt");
        assert.deepEqual(args, { p_session_id: sessionId, p_host_id: hostId, p_lease_epoch: 2,
            p_attempt_id: attemptId, p_expected_integrator: null });
        return { data: { ok: false, reason: "attempt_running" }, error: null };
    });
    assert.deepEqual(await campaign.beginIntegrationAttempt(begin, caller), { ok: false, reason: "attempt_running" });
    assert.equal(rpc.mock.callCount(), 1);
});

test("finish projects bounded redacted evidence and exact runtime identity", async t => {
    const rpc = t.mock.method(supabaseAdmin, "rpc", async (name: string, args: Record<string, unknown>) => {
        assert.equal(name, "finalize_council_integration_attempt");
        assert.equal(args.p_attempt_id, attemptId);
        assert.equal(args.p_execution_id, sessionId);
        assert.equal(args.p_tip_sha, sha);
        const stored = JSON.stringify(args.p_evidence);
        assert.ok(!stored.includes("synthetic-service-secret"));
        assert.ok(!stored.includes("fixture-secret"));
        return { data: { ok: true, attemptId, host_id: hostId, seat_token_hash: digest }, error: null };
    });
    assert.deepEqual(await campaign.finishIntegrationAttempt({ ...finish, executionId: sessionId }, caller), { ok: true, attemptId });
    assert.equal(rpc.mock.callCount(), 1);
});

test("invalid attempt inputs fail without RPC or secret-bearing validation details", async t => {
    const rpc = t.mock.method(supabaseAdmin, "rpc", async () => { assert.fail("Invalid RPC"); });
    await assert.rejects(campaign.beginIntegrationAttempt({ ...begin, attemptId: "private-invalid" }, caller), /^Error: Invalid integration attempt\.$/);
    await assert.rejects(campaign.finishIntegrationAttempt({ ...finish, evidence: { ...evidence, redactionVersion: 2 } } as never, caller), /^Error: Invalid integration result\.$/);
    assert.equal(rpc.mock.callCount(), 0);
});

test("RPC errors and null replies fail without legacy fallback or error payload echo", async t => {
    const rpc = t.mock.method(supabaseAdmin, "rpc", async (): Promise<{ data: null; error: { message: string } | null }> => ({ data: null, error: { message: "token=private-error" } }));
    await assert.rejects(campaign.finishIntegrationAttempt(finish, caller), /^Error: Could not record integration result\.$/);
    assert.equal(rpc.mock.callCount(), 1);
    rpc.mock.mockImplementation(async () => ({ data: null, error: null }));
    assert.deepEqual(await campaign.beginIntegrationAttempt(begin, caller), { ok: false, reason: "no_result" });
});

test("versioned item receipts are redacted again and carry per-receipt provenance", async t => {
    const rpc = t.mock.method(supabaseAdmin, "rpc", async (name: string, args: Record<string, unknown>) => {
        assert.equal(name, "record_council_verification");
        const rows = args.p_command_receipts as { redactionVersion?: number; outputTail: string }[];
        assert.equal(rows[0].redactionVersion, 1);
        assert.ok(!rows[0].outputTail.includes("fixture-secret"));
        assert.ok(!String(args.p_report).includes("synthetic-service-secret"));
        return { data: { ok: true }, error: null };
    });
    await campaign.recordExactVerification({ itemId: sessionId, hostId, leaseEpoch: 2, commitSha: sha,
        baseSha: sha, branchName: "council/test/a", profileId: "test", passed: true, outputDigest: digest,
        report: "synthetic-service-secret", receipts: [receipt], redactionVersion: 1 }, caller);
    assert.equal(rpc.mock.callCount(), 1);
});

test("legacy item receipts remain unversioned", async t => {
    t.mock.method(supabaseAdmin, "rpc", async (_name: string, args: Record<string, unknown>) => {
        const rows = args.p_command_receipts as Record<string, unknown>[];
        assert.ok(!("redactionVersion" in rows[0]));
        return { data: { ok: true }, error: null };
    });
    await campaign.recordExactVerification({ itemId: sessionId, hostId, leaseEpoch: 2, commitSha: sha,
        baseSha: sha, branchName: "council/test/a", profileId: "test", passed: true, outputDigest: digest,
        report: "test", receipts: [receipt] }, caller);
});

type Handler = (args: Record<string, unknown>, extra: { authInfo?: { scopes: string[] } }) => Promise<{ content: { text: string }[] }>;
test("registered transport exposes exact attempt schemas and denies owner/seat calls before resolving session", async () => {
    const handlers = new Map<string, Handler>();
    const schemas = new Map<string, Record<string, z.ZodType>>();
    const calls: { name: string; args: unknown; caller: unknown }[] = [];
    let resolved = 0;
    const dependencies: Record<string, unknown> = {
        zod: { z }, "mcp-handler": { createMcpHandler: (register: (server: unknown) => void) => {
            register({ registerTool: (name: string, meta: { inputSchema: Record<string, z.ZodType> }, handler: Handler) => {
                handlers.set(name, handler); schemas.set(name, meta.inputSchema);
            } }); return () => undefined;
        }, withMcpAuth: (handler: unknown) => handler },
        "@/lib/council/host-contracts": contracts, "@/lib/council/protocol": protocol,
        "@/lib/council/templates": templates, "@/lib/agents/scopes": scopes,
        "@/lib/council/store": { getSessionByCode: async () => { resolved++; return { id: sessionId }; } },
        "@/lib/council/campaign": Object.fromEntries(["beginIntegrationAttempt", "finishIntegrationAttempt", "recordExactVerification"].map(name => [name,
            async (args: unknown, caller: unknown) => { calls.push({ name, args, caller }); return { ok: true }; }])),
        "@/lib/agents/mcp-auth": { verifyMcpToken: () => undefined },
        "@/lib/vault/ingest": { VAULT_CATEGORIES: ["study"] },
    };
    runInNewContext(ts.transpileModule(readFileSync(new URL("../src/app/api/mcp/[transport]/route.ts", import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports: {}, process: { env: {} }, require: (id: string) => dependencies[id] ?? {} });
    for (const name of ["council_integration_begin", "council_integration_finish"]) {
        assert.ok(handlers.has(name));
        for (const scopes of [["council:seat"], ["council:owner"], []]) {
            await handlers.get(name)!({}, { authInfo: { scopes } });
        }
    }
    assert.equal(resolved, 0);
    assert.equal(calls.length, 0);
    const beginArgs = z.object(schemas.get("council_integration_begin")!).parse({ ...begin, sessionCode: "CN-TEST" });
    await handlers.get("council_integration_begin")!(beginArgs, { authInfo: caller });
    assert.equal(resolved, 1);
    assert.equal(calls[0].name, "beginIntegrationAttempt");
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)), begin);
    const finishArgs = z.object(schemas.get("council_integration_finish")!).parse(finish);
    await handlers.get("council_integration_finish")!(finishArgs, { authInfo: caller });
    assert.equal(calls[1].name, "finishIntegrationAttempt");
    assert.deepEqual(calls[1].args, finish);
    assert.ok(schemas.get("council_work_verify")!.redactionVersion.safeParse(1).success);
});
