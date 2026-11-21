import assert from "node:assert/strict";
import { after, mock, test, type TestContext } from "node:test";
import type { CouncilCaller } from "../src/lib/council/host-contracts.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://council-test.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "council-test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "council-test-service-key";

const network = mock.method(globalThis, "fetch", async () => {
    throw new Error("Council service tests must not access the network.");
});
const { supabaseAdmin } = await import("../src/lib/supabase.ts");
const hostServices = await import("../src/lib/council/host-service.ts");
const { issueHostSeatKey, hashSeatToken } = await import("../src/lib/council/seat-keys.ts");
const { createCouncilSession } = await import("../src/lib/council/store.ts");

after(() => {
    assert.equal(network.mock.callCount(), 0, "a service attempted a network request");
    mock.restoreAll();
});

const HOST: CouncilCaller = { scopes: ["council:host"] };
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const HOST_ID = "22222222-2222-4222-8222-222222222222";
const EXECUTION_ID = "55555555-5555-4555-8555-555555555555";
const COMMIT_SHA = "abcdef01".repeat(5);
const BASE_SHA = "ABCDEF01".repeat(5);
const DIGEST = "a".repeat(64);
const fence = { sessionId: SESSION_ID, hostId: HOST_ID, leaseEpoch: 1 };
const BRANCH = "council/cn-test/agent-a";
const capabilities = {
    kind: "acp" as const, source: "configured" as const,
    streaming: true, cancellation: true, sessionResume: false,
    modelSelection: true, structuredActions: true, toolCalls: true,
    permissionCallbacks: true, filesystemMediated: true, terminalMediated: true,
    observedAt: "2026-09-20T00:00:00.000Z",
};
const execution = {
    ...fence, agentName: "agent-a", hostGeneration: "typescript-node", capabilities,
    identityAssurance: "host_bound" as const, provider: "codex", adapterVersion: "1.0.0",
    requestedModel: "test-model", effectiveModel: "test-model", requestedReasoningEffort: "high",
    effectiveReasoningEffort: "high", modelSource: "configured", branch: BRANCH,
    worktree: "C:/council-test/agent-a", baseSha: BASE_SHA,
};
function serviceCase<P extends object>(
    name: string,
    invoke: (params: P, caller: CouncilCaller | undefined) => Promise<unknown>,
    params: P,
    rpcName: string,
    rpcArgs: Record<string, unknown>,
    rpcData: unknown = { ok: true },
) {
    return {
        name, params, rpcName, rpcArgs, rpcData,
        call: (caller: CouncilCaller | undefined, overrides: Record<string, unknown> = {}) => invoke({ ...params, ...overrides }, caller),
    };
}

const services = [
    serviceCase("claimHostLease", hostServices.claimHostLease, { sessionId: SESSION_ID, hostId: HOST_ID }, "claim_council_host_lease", {
        p_session_id: SESSION_ID, p_host_id: HOST_ID, p_duration_seconds: 45,
    }),
    serviceCase("renewHostLease", hostServices.renewHostLease, fence, "renew_council_host_lease", {
        p_session_id: SESSION_ID, p_host_id: HOST_ID, p_lease_epoch: 1, p_duration_seconds: 45,
    }),
    serviceCase("releaseHostLease", hostServices.releaseHostLease, fence, "release_council_host_lease", {
        p_session_id: SESSION_ID, p_host_id: HOST_ID, p_lease_epoch: 1,
    }, true),
    serviceCase("startAgentExecution", hostServices.startAgentExecution, execution, "start_council_agent_execution", {
        p_session_id: SESSION_ID, p_agent_name: "agent-a", p_host_id: HOST_ID, p_lease_epoch: 1,
        p_host_generation: "typescript-node", p_connector_kind: "acp", p_connector_capabilities: capabilities,
        p_capability_source: "configured", p_identity_assurance: "host_bound", p_provider: "codex", p_adapter_version: "1.0.0",
        p_requested_model: "test-model", p_effective_model: "test-model", p_requested_reasoning_effort: "high",
        p_effective_reasoning_effort: "high", p_model_source: "configured", p_branch_name: BRANCH,
        p_worktree_path: "C:/council-test/agent-a", p_base_sha: BASE_SHA,
    }),
    serviceCase("stopAgentExecution", hostServices.stopAgentExecution, {
        executionId: EXECUTION_ID, hostId: HOST_ID, leaseEpoch: 1, stopReason: "completed",
    }, "stop_council_agent_execution", {
        p_execution_id: EXECUTION_ID, p_host_id: HOST_ID, p_lease_epoch: 1, p_stop_reason: "completed",
    }, true),
    serviceCase("issueHostSeatKey", issueHostSeatKey, { ...fence, seatName: "agent-a" }, "issue_council_host_seat_key", {}),
];

const deniedCallers: [string, CouncilCaller | undefined][] = [
    ["absent", undefined],
    ["empty", { scopes: [] }],
    ["read", { scopes: ["knowledge:read"] }],
    ["notes", { scopes: ["knowledge:read", "notes:write"] }],
    ["full", { scopes: ["knowledge:read", "notes:write", "vault:write"] }],
    ["legacy owner", { scopes: ["knowledge:read", "knowledge:write", "notes:write", "vault:write", "council:owner"] }],
    ["council owner", { scopes: ["council:owner"] }],
    ["seat", { scopes: ["council:seat"] }],
    ["malformed scopes", { scopes: "council:host" } as unknown as CouncilCaller],
];

function stubRpc(t: TestContext, data: unknown = { ok: true }) {
    return t.mock.method(supabaseAdmin, "rpc", async (name: string, args?: Record<string, unknown>) => {
        assert.ok(name);
        assert.ok(args);
        return { data, error: null };
    });
}

for (const service of services) {
    test(`${service.name} requires a dedicated host before any RPC`, async (t) => {
        const rpc = stubRpc(t);
        for (const [label, caller] of deniedCallers) {
            await assert.rejects(() => service.call(caller), {
                message: "This tool requires the dedicated Council host credential.",
            }, `${service.name} accepted ${label}`);
            assert.equal(rpc.mock.callCount(), 0, `${service.name} reached RPC for ${label}`);
        }
    });

    test(`${service.name} validates fence identifiers before any RPC`, async (t) => {
        const rpc = stubRpc(t);
        const params = service.params;
        for (const field of ["sessionId", "hostId", "executionId"]) {
            if (!(field in params)) continue;
            for (const invalid of ["", "not-a-uuid"]) {
                await assert.rejects(() => service.call(HOST, { [field]: invalid }), { name: "ZodError" });
            }
        }
        if ("leaseEpoch" in params) {
            for (const invalid of [0, -1, 1.5, "1", Number.NaN, Number.POSITIVE_INFINITY]) {
                await assert.rejects(() => service.call(HOST, { leaseEpoch: invalid }), { name: "ZodError" });
            }
        }
        assert.equal(rpc.mock.callCount(), 0);
    });

    if (service.name !== "issueHostSeatKey") {
        test(`${service.name} forwards valid host input to its fenced RPC`, async (t) => {
            const rpc = stubRpc(t, service.rpcData);
            await service.call(HOST);
            assert.equal(rpc.mock.callCount(), 1);
            assert.deepEqual(rpc.mock.calls[0].arguments, [service.rpcName, service.rpcArgs]);
        });
    }
}

test("host seat issuance persists only the token hash with the validated fence and TTL", async (t) => {
    const rpc = stubRpc(t);
    for (const ttlHours of [undefined, 0.5]) {
        const before = Date.now();
        const result = await issueHostSeatKey({ ...fence, seatName: "agent-a", ttlHours }, HOST);
        const after = Date.now();
        assert.equal(result.ok, true);
        assert.match(result.token, /^zcs_[0-9a-f]{64}$/);
        const expires = Date.parse(result.expiresAt);
        const ttlMs = (ttlHours ?? 24) * 3600_000;
        assert.ok(expires >= before + ttlMs && expires <= after + ttlMs);
        assert.deepEqual(rpc.mock.calls.at(-1)?.arguments, ["issue_council_host_seat_key", {
            p_session_id: SESSION_ID, p_seat_name: "agent-a", p_token_hash: hashSeatToken(result.token),
            p_expires_at: result.expiresAt, p_host_id: HOST_ID, p_lease_epoch: 1,
        }]);
    }
    assert.equal(rpc.mock.callCount(), 2);
});

test("bound host issuance selects the bound RPC and retains its binding acknowledgement", async (t) => {
    const rpc = stubRpc(t, { ok: true, executionBindingRequired: true });
    const result = await issueHostSeatKey({ ...fence, seatName: "agent-a", bindExecution: true }, HOST);
    assert.equal(result.ok, true);
    assert.equal(result.executionBindingRequired, true);
    assert.deepEqual(rpc.mock.calls[0].arguments, ["issue_council_bound_host_seat_key", {
        p_session_id: SESSION_ID, p_seat_name: "agent-a", p_token_hash: hashSeatToken(result.token),
        p_expires_at: result.expiresAt, p_host_id: HOST_ID, p_lease_epoch: 1,
    }]);
});

test("bound execution registration forwards only the token hash to its dedicated RPC", async (t) => {
    const rpc = stubRpc(t, { ok: true, executionId: EXECUTION_ID, seatBound: true });
    const result = await hostServices.startAgentExecution({ ...execution, seatTokenHash: DIGEST }, HOST);
    assert.equal(result.seatBound, true);
    assert.equal(result.executionId, EXECUTION_ID);
    assert.equal(rpc.mock.calls[0].arguments[0], "start_council_bound_agent_execution");
    assert.equal(rpc.mock.calls[0].arguments[1]?.p_seat_token_hash, DIGEST);
});

test("binding selectors reject malformed values before RPC", async (t) => {
    const rpc = stubRpc(t);
    for (const value of ["", "g".repeat(64), "a".repeat(63), "a".repeat(65), `${DIGEST}\n`]) {
        await assert.rejects(() => hostServices.startAgentExecution({ ...execution, seatTokenHash: value }, HOST), { name: "ZodError" });
    }
    await assert.rejects(() => issueHostSeatKey({ ...fence, seatName: "agent-a", bindExecution: "true" as unknown as boolean }, HOST), { name: "ZodError" });
    assert.equal(rpc.mock.callCount(), 0);
});

test("execution registration rejects an invalid base SHA before RPC", async (t) => {
    const rpc = stubRpc(t);
    for (const invalid of ["", "a".repeat(39), "a".repeat(41), "g".repeat(40), ` ${COMMIT_SHA}`, `${COMMIT_SHA}\n`]) {
        await assert.rejects(() => hostServices.startAgentExecution({ ...execution, baseSha: invalid }, HOST), { name: "ZodError" });
    }
    assert.equal(rpc.mock.callCount(), 0);
});

test("lease durations, seat TTLs and execution evidence fail closed", async (t) => {
    const rpc = stubRpc(t);
    const invalid: [string, Record<string, unknown>][] = [
        ["claimHostLease", { durationSeconds: 0 }], ["claimHostLease", { durationSeconds: 1.5 }],
        ["renewHostLease", { durationSeconds: -1 }], ["renewHostLease", { durationSeconds: Number.POSITIVE_INFINITY }],
        ["issueHostSeatKey", { seatName: "" }], ["issueHostSeatKey", { ttlHours: 0 }],
        ["issueHostSeatKey", { ttlHours: Number.POSITIVE_INFINITY }],
        ["startAgentExecution", { capabilities: { ...capabilities, source: "unknown" } }],
        ["startAgentExecution", { capabilities: { ...capabilities, observedAt: "yesterday" } }],
        ["startAgentExecution", { capabilities: { ...capabilities, streaming: "true" } }],
        ["startAgentExecution", { identityAssurance: "trusted" }], ["startAgentExecution", { provider: "" }],
        ["stopAgentExecution", { stopReason: "" }], ["stopAgentExecution", { stopReason: "x".repeat(501) }],
    ];
    for (const [name, overrides] of invalid) {
        const service = services.find((entry) => entry.name === name)!;
        await assert.rejects(() => service.call(HOST, overrides), { name: "ZodError" }, `${name} accepted ${Object.keys(overrides)}`);
    }
    assert.equal(rpc.mock.callCount(), 0);
});

test("lease duration overrides are forwarded after validation", async (t) => {
    const rpc = stubRpc(t);
    await hostServices.claimHostLease({ sessionId: SESSION_ID, hostId: HOST_ID, durationSeconds: 1 }, HOST);
    await hostServices.renewHostLease({ ...fence, durationSeconds: 120 }, HOST);
    assert.deepEqual(rpc.mock.calls.map((call) => call.arguments[1]?.p_duration_seconds), [1, 120]);
});

const council = {
    topic: "Offline allocation test", brief: "Review the requested change.", closerName: "agent-a",
    participants: [{ name: "agent-a", expertise: "implementation" }],
};

function stubCouncilCreation(t: TestContext, collisions = 0) {
    const inserts: Record<string, unknown>[] = [];
    const roster: Record<string, unknown>[] = [];
    const from = t.mock.method(supabaseAdmin, "from", (table: string) => {
        if (table === "council_sessions") {
            return {
                insert: (values: Record<string, unknown>) => {
                    inserts.push(values);
                    return {
                        select: () => ({
                            single: async () => inserts.length <= collisions
                                ? { data: null, error: { code: "23505", message: "Code collision" } }
                                : { data: { id: SESSION_ID, ...values }, error: null },
                        }),
                    };
                },
                select: () => ({
                    eq: (column: string, value: string) => {
                        assert.equal(column, "id");
                        assert.equal(value, SESSION_ID);
                        return { maybeSingle: async () => ({ data: { id: SESSION_ID, ...inserts.at(-1) }, error: null }) };
                    },
                }),
            };
        }
        if (table === "council_participants") {
            return {
                insert: async (values: Record<string, unknown>[]) => {
                    roster.push(...values);
                    return { error: null };
                },
            };
        }
        assert.fail(`Unexpected council table: ${table}`);
    });
    const rpc = stubRpc(t);
    return { inserts, roster, from, rpc };
}

test("creation inserts the session, the roster with the moderator, and the brief once", async (t) => {
    const database = stubCouncilCreation(t);
    const result = await createCouncilSession(council);
    assert.equal(database.inserts.length, 1);
    assert.match(String(database.inserts[0].code), /^CN-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
    assert.equal(result.code, database.inserts[0].code);
    assert.equal(result.id, SESSION_ID);
    assert.deepEqual(database.roster.map((p) => p.name), ["agent-a", "zuychin"]);
    assert.equal(database.rpc.mock.callCount(), 1);
    assert.equal(database.rpc.mock.calls[0].arguments[0], "append_council_message");
});

test("creation retries code collisions and creates the roster once", async (t) => {
    const database = stubCouncilCreation(t, 2);
    const result = await createCouncilSession(council);
    assert.equal(database.inserts.length, 3);
    for (const insert of database.inserts) {
        assert.match(String(insert.code), /^CN-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
    }
    assert.equal(result.code, database.inserts[2].code);
    assert.equal(database.roster.length, 2);
    assert.equal(database.rpc.mock.callCount(), 1);
});
