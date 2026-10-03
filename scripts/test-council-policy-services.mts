import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://council-test.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "synthetic-policy-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-policy-service";
const network = mock.method(globalThis, "fetch", async () => { throw new Error("No network in policy tests"); });
const { supabaseAdmin } = await import("../src/lib/supabase.ts");
const service = await import("../src/lib/council/host-service.ts");
const { NODE_POLICY_VERSION } = await import("../src/lib/council/policy-versions.ts");
after(() => { assert.equal(network.mock.callCount(), 0); mock.restoreAll(); });

const caller = { scopes: ["council:host"] };
const sessionId = "11111111-1111-4111-8111-111111111111", hostId = "22222222-2222-4222-8222-222222222222";
const lease = { ok: true, hostId, leaseEpoch: 3, leaseExpiresAt: "2026-09-30T06:00:00Z" };
const boundary = { ok: true, hostGeneration: null, policyVersion: null, hasExecutionHistory: false };
const claim = { sessionId, hostId, policyVersion: NODE_POLICY_VERSION };
const execution = {
    ...claim, leaseEpoch: 3, seatTokenHash: "a".repeat(64), agentName: "seat", hostGeneration: "typescript-node",
    capabilities: { kind: "acp" as const, source: "configured" as const, streaming: true, cancellation: true,
        sessionResume: false, modelSelection: true, structuredActions: true, toolCalls: true,
        permissionCallbacks: true, filesystemMediated: true, terminalMediated: true, observedAt: "2026-09-30T04:00:00Z" },
    identityAssurance: "verified_seat" as const, provider: "fixture",
};

test("version-aware claim reads its exact fenced execution boundary", async t => {
    const calls: { name: string; args: unknown }[] = [];
    const rpc = mock.method(supabaseAdmin, "rpc", async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args }); return { data: name === "claim_council_host_lease" ? lease : boundary, error: null };
    });
    t.after(() => rpc.mock.restore());
    assert.deepEqual(await service.claimHostLease(claim, caller), { ...lease, ...boundary });
    assert.deepEqual(calls.map(call => call.name), ["claim_council_host_lease", "get_council_execution_boundary"]);
    assert.deepEqual(calls[1].args, { p_session_id: sessionId, p_host_id: hostId, p_lease_epoch: 3 });
});
test("legacy claim preserves its original RPC contract", async t => {
    const rpc = mock.method(supabaseAdmin, "rpc", async () => ({ data: lease, error: null }));
    t.after(() => rpc.mock.restore());
    assert.deepEqual(await service.claimHostLease({ sessionId, hostId }, caller), lease);
    assert.equal(rpc.mock.callCount(), 1);
});
test("failed or malformed boundary releases the captured lease and returns a safe refusal", async () => {
    for (const response of [{ data: null, error: { message: "private fixture detail" } }, { data: { ok: true, hostGeneration: null, policyVersion: null }, error: null }, { data: { ok: false, reason: "stale_host" }, error: null }]) {
        const calls: { name: string; args: unknown }[] = [];
        const rpc = mock.method(supabaseAdmin, "rpc", async (name: string, args: Record<string, unknown>) => {
            calls.push({ name, args });
            return name === "claim_council_host_lease" ? { data: lease, error: null }
                : name === "release_council_host_lease" ? { data: true, error: null } : response;
        });
        try {
            const result = await service.claimHostLease(claim, caller);
            assert.equal(result.ok, false);
            assert.equal(result.reason, "execution_policy_unavailable");
            assert.equal(JSON.stringify(result).includes("private fixture detail"), false);
            assert.deepEqual(calls.at(-1), { name: "release_council_host_lease", args: { p_session_id: sessionId, p_host_id: hostId, p_lease_epoch: 3 } });
        } finally { rpc.mock.restore(); }
    }
    assert.ok(true);
});
test("claim refusal does not read or release another host's boundary", async t => {
    const rpc = mock.method(supabaseAdmin, "rpc", async () => ({ data: { ok: false, reason: "host_busy" }, error: null }));
    t.after(() => rpc.mock.restore());
    assert.deepEqual(await service.claimHostLease(claim, caller), { ok: false, reason: "host_busy" });
    assert.equal(rpc.mock.callCount(), 1);
});
test("version-aware registration calls the unambiguous versioned bound RPC", async t => {
    let name = "", args: Record<string, unknown> = {};
    const accepted = { ok: true, executionId: sessionId, seatBound: true, hostGeneration: "typescript-node", policyVersion: NODE_POLICY_VERSION };
    const rpc = mock.method(supabaseAdmin, "rpc", async (rpcName: string, rpcArgs: Record<string, unknown>) => { name = rpcName; args = rpcArgs; return { data: accepted, error: null }; });
    t.after(() => rpc.mock.restore());
    assert.deepEqual(await service.startAgentExecution(execution, caller), accepted);
    assert.equal(name, "start_council_versioned_bound_execution");
    assert.equal(args.p_policy_version, NODE_POLICY_VERSION);
    assert.equal(args.p_seat_token_hash, execution.seatTokenHash);
});
test("unknown policy, unbound policy and wrong generation stop before RPC", async t => {
    const rpc = mock.method(supabaseAdmin, "rpc", async () => { throw new Error("unexpected RPC"); });
    t.after(() => rpc.mock.restore());
    await assert.rejects(service.claimHostLease({ ...claim, policyVersion: "future" }, caller));
    await assert.rejects(service.startAgentExecution({ ...execution, policyVersion: "future" }, caller));
    await assert.rejects(service.startAgentExecution({ ...execution, seatTokenHash: undefined }, caller));
    await assert.rejects(service.startAgentExecution({ ...execution, hostGeneration: "rust" }, caller));
    assert.equal(rpc.mock.callCount(), 0);
});
test("seat and missing callers cannot claim or register policy-aware runtimes", async t => {
    const rpc = mock.method(supabaseAdmin, "rpc", async () => { throw new Error("unexpected RPC"); });
    t.after(() => rpc.mock.restore());
    for (const denied of [undefined, { scopes: ["council:seat"] }]) {
        await assert.rejects(service.claimHostLease(claim, denied));
        await assert.rejects(service.startAgentExecution(execution, denied));
    }
    assert.equal(rpc.mock.callCount(), 0);
});
