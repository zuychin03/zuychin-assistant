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
const { recordExactVerification, freezeIntegrationManifest, recordV3Integration } = await import("../src/lib/council/campaign.ts");
const { issueHostSeatKey, hashSeatToken } = await import("../src/lib/council/seat-keys.ts");
const { createCouncilSession } = await import("../src/lib/council/store.ts");

after(() => {
    assert.equal(network.mock.callCount(), 0, "a service attempted a network request");
    mock.restoreAll();
});

const HOST: CouncilCaller = { scopes: ["council:host"] };
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const HOST_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_ID = "33333333-3333-4333-8333-333333333333";
const DELIVERY_ID = "44444444-4444-4444-8444-444444444444";
const EXECUTION_ID = "55555555-5555-4555-8555-555555555555";
const COMMIT_SHA = "abcdef01".repeat(5);
const BASE_SHA = "ABCDEF01".repeat(5);
const DIGEST = "a".repeat(64);
const fence = { sessionId: SESSION_ID, hostId: HOST_ID, leaseEpoch: 1 };
const deliveryFence = { deliveryId: DELIVERY_ID, hostId: HOST_ID, leaseEpoch: 1 };
const receipt = {
    command: ["npm", "run", "build"], exitCode: 0, durationMs: 12.5,
    outputDigest: DIGEST, outputTail: "Build passed.\n", timedOut: false,
};
const verification = {
    itemId: ITEM_ID, hostId: HOST_ID, leaseEpoch: 1, commitSha: COMMIT_SHA, baseSha: BASE_SHA,
    branchName: "council/cn-test/agent-a", profileId: "standard", receipts: [receipt],
    outputDigest: DIGEST, passed: true, report: "Exact commit checks passed.",
};
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
    effectiveReasoningEffort: "high", modelSource: "configured", branch: verification.branchName,
    worktree: "C:/council-test/agent-a", baseSha: BASE_SHA,
};
const integration = {
    ...fence, reporter: "host", status: "verified" as const,
    branch: "council/cn-test/integration", tipSha: COMMIT_SHA, report: "Integration checks passed.",
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
    serviceCase("prepareDelivery", hostServices.prepareDelivery, {
        ...fence, agentName: "agent-a", fromSeq: 0, throughSeq: 7, promptHash: DIGEST, promptBody: "Read the latest turn.\n",
    }, "prepare_council_delivery", {
        p_session_id: SESSION_ID, p_agent_name: "agent-a", p_host_id: HOST_ID, p_lease_epoch: 1,
        p_from_seq: 0, p_through_seq: 7, p_prompt_hash: DIGEST, p_prompt_body: "Read the latest turn.\n",
    }),
    serviceCase("failDelivery", hostServices.failDelivery, { ...deliveryFence, error: "Agent failed." }, "fail_council_delivery", {
        p_delivery_id: DELIVERY_ID, p_host_id: HOST_ID, p_lease_epoch: 1, p_error: "Agent failed.",
    }, true),
    serviceCase("markDeliveryInFlight", hostServices.markDeliveryInFlight, deliveryFence, "mark_council_delivery_in_flight", {
        p_delivery_id: DELIVERY_ID, p_host_id: HOST_ID, p_lease_epoch: 1,
    }, true),
    serviceCase("acknowledgeDelivery", hostServices.acknowledgeDelivery, deliveryFence, "ack_council_delivery", {
        p_delivery_id: DELIVERY_ID, p_host_id: HOST_ID, p_lease_epoch: 1,
    }),
    serviceCase("startAgentExecution", hostServices.startAgentExecution, execution, "start_council_agent_execution", {
        p_session_id: SESSION_ID, p_agent_name: "agent-a", p_host_id: HOST_ID, p_lease_epoch: 1,
        p_host_generation: "typescript-node", p_connector_kind: "acp", p_connector_capabilities: capabilities,
        p_capability_source: "configured", p_identity_assurance: "host_bound", p_provider: "codex", p_adapter_version: "1.0.0",
        p_requested_model: "test-model", p_effective_model: "test-model", p_requested_reasoning_effort: "high",
        p_effective_reasoning_effort: "high", p_model_source: "configured", p_branch_name: verification.branchName,
        p_worktree_path: "C:/council-test/agent-a", p_base_sha: BASE_SHA,
    }),
    serviceCase("stopAgentExecution", hostServices.stopAgentExecution, {
        executionId: EXECUTION_ID, hostId: HOST_ID, leaseEpoch: 1, stopReason: "completed",
    }, "stop_council_agent_execution", {
        p_execution_id: EXECUTION_ID, p_host_id: HOST_ID, p_lease_epoch: 1, p_stop_reason: "completed",
    }, true),
    serviceCase("recordExactVerification", recordExactVerification, verification, "record_council_verification", {
        p_item_id: ITEM_ID, p_host_id: HOST_ID, p_lease_epoch: 1, p_commit_sha: COMMIT_SHA, p_base_sha: BASE_SHA,
        p_branch_name: verification.branchName, p_profile_id: "standard", p_command_receipts: [receipt],
        p_output_digest: DIGEST, p_passed: true, p_report: verification.report,
    }),
    serviceCase("freezeIntegrationManifest", freezeIntegrationManifest, fence, "freeze_council_integration_manifest", {
        p_session_id: SESSION_ID, p_host_id: HOST_ID, p_lease_epoch: 1,
    }),
    serviceCase("recordV3Integration", recordV3Integration, integration, "record_council_integration_v3", {
        p_session_id: SESSION_ID, p_reporter: "host", p_host_id: HOST_ID, p_lease_epoch: 1,
        p_status: "verified", p_branch: integration.branch, p_tip_sha: COMMIT_SHA, p_report: integration.report,
    }),
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
        for (const field of ["sessionId", "hostId", "itemId", "deliveryId", "executionId"]) {
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

test("exact verification and execution reject invalid commit and base SHAs before RPC", async (t) => {
    const rpc = stubRpc(t);
    for (const invalid of ["", "a".repeat(39), "a".repeat(41), "g".repeat(40), ` ${COMMIT_SHA}`, `${COMMIT_SHA}\n`]) {
        for (const field of ["commitSha", "baseSha"]) {
            await assert.rejects(() => recordExactVerification({ ...verification, [field]: invalid }, HOST), { name: "ZodError" });
        }
        await assert.rejects(() => hostServices.startAgentExecution({ ...execution, baseSha: invalid }, HOST), { name: "ZodError" });
        await assert.rejects(() => recordV3Integration({ ...integration, tipSha: invalid }, HOST), { name: "ZodError" });
    }
    assert.equal(rpc.mock.callCount(), 0);
});

test("verification preserves 20 receipts and rejects a 21st before RPC", async (t) => {
    const rpc = stubRpc(t);
    const receipts = Array.from({ length: 20 }, (_, index) => ({ ...receipt, command: ["check", String(index)] }));
    await recordExactVerification({ ...verification, receipts }, HOST);
    assert.equal(rpc.mock.callCount(), 1);
    assert.deepEqual(rpc.mock.calls[0].arguments[1]?.p_command_receipts, receipts);
    await assert.rejects(() => recordExactVerification({ ...verification, receipts: [...receipts, receipt] }, HOST), { name: "ZodError" });
    assert.equal(rpc.mock.callCount(), 1);
});

test("malformed verification receipts fail before RPC", async (t) => {
    const rpc = stubRpc(t);
    const invalidReceipts: unknown[] = [
        null, {}, { ...receipt, command: "npm run build" }, { ...receipt, command: [123] },
        { ...receipt, exitCode: 0.5 }, { ...receipt, exitCode: "0" }, { ...receipt, durationMs: -1 },
        { ...receipt, durationMs: Number.POSITIVE_INFINITY }, { ...receipt, outputDigest: null },
        { ...receipt, outputTail: 123 }, { ...receipt, timedOut: "false" },
    ];
    const service = services.find((entry) => entry.name === "recordExactVerification")!;
    for (const invalid of invalidReceipts) {
        await assert.rejects(() => service.call(HOST, { receipts: [invalid] }), { name: "ZodError" });
    }
    assert.equal(rpc.mock.callCount(), 0);
});

test("verification forwards parsed receipts without unvalidated extra fields", async (t) => {
    const rpc = stubRpc(t);
    const timedOut = { ...receipt, exitCode: null, timedOut: true };
    await recordExactVerification({
        ...verification, passed: false, receipts: [{ ...timedOut, extra: "discard me" } as typeof timedOut],
    }, HOST);
    assert.deepEqual(rpc.mock.calls[0].arguments[1]?.p_command_receipts, [timedOut]);
    assert.equal(rpc.mock.calls[0].arguments[1]?.p_passed, false);
});

for (const name of ["recordExactVerification", "recordV3Integration"]) {
    test(`${name} accepts report boundaries and rejects empty or excessive reports`, async (t) => {
        const rpc = stubRpc(t);
        const service = services.find((entry) => entry.name === name)!;
        for (const report of ["x", "x".repeat(16000)]) {
            await service.call(HOST, { report });
            assert.equal(rpc.mock.calls.at(-1)?.arguments[1]?.p_report, report);
        }
        assert.equal(rpc.mock.callCount(), 2);
        for (const report of ["", "x".repeat(16001)]) {
            await assert.rejects(() => service.call(HOST, { report }), { name: "ZodError" });
        }
        assert.equal(rpc.mock.callCount(), 2);
    });
}

test("integration allows only reportable status values", async (t) => {
    const rpc = stubRpc(t);
    const service = services.find((entry) => entry.name === "recordV3Integration")!;
    for (const status of ["running", "verified", "conflict", "failed"]) {
        await service.call(HOST, { status, branch: undefined, tipSha: undefined });
        const args = rpc.mock.calls.at(-1)?.arguments[1];
        assert.equal(args?.p_status, status);
        assert.equal(args?.p_branch, null);
        assert.equal(args?.p_tip_sha, null);
    }
    for (const status of ["pending", "unknown", "", null]) {
        await assert.rejects(() => service.call(HOST, { status }), { name: "ZodError" });
    }
    assert.equal(rpc.mock.callCount(), 4);
});

test("lease durations, seat TTLs, delivery fields and execution evidence fail closed", async (t) => {
    const rpc = stubRpc(t);
    const invalid: [string, Record<string, unknown>][] = [
        ["claimHostLease", { durationSeconds: 0 }], ["claimHostLease", { durationSeconds: 1.5 }],
        ["renewHostLease", { durationSeconds: -1 }], ["renewHostLease", { durationSeconds: Number.POSITIVE_INFINITY }],
        ["issueHostSeatKey", { seatName: "" }], ["issueHostSeatKey", { ttlHours: 0 }],
        ["issueHostSeatKey", { ttlHours: Number.POSITIVE_INFINITY }],
        ["prepareDelivery", { fromSeq: -1 }], ["prepareDelivery", { throughSeq: 1.5 }],
        ["prepareDelivery", { agentName: "" }], ["prepareDelivery", { promptHash: "" }],
        ["failDelivery", { error: "x".repeat(2001) }],
        ["startAgentExecution", { capabilities: { ...capabilities, source: "unknown" } }],
        ["startAgentExecution", { capabilities: { ...capabilities, observedAt: "yesterday" } }],
        ["startAgentExecution", { capabilities: { ...capabilities, streaming: "true" } }],
        ["startAgentExecution", { identityAssurance: "trusted" }], ["startAgentExecution", { provider: "" }],
        ["stopAgentExecution", { stopReason: "" }], ["stopAgentExecution", { stopReason: "x".repeat(501) }],
        ["recordExactVerification", { branchName: "" }], ["recordExactVerification", { branchName: "x".repeat(301) }],
        ["recordExactVerification", { profileId: "x".repeat(101) }], ["recordExactVerification", { outputDigest: "" }],
        ["recordV3Integration", { branch: "x".repeat(201) }], ["recordV3Integration", { reporter: "" }],
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
const REQUESTED_CODE = "CN-ABCD";

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

test("requested council codes require the host before database access", async (t) => {
    const database = stubCouncilCreation(t);
    for (const [label, caller] of deniedCallers) {
        await assert.rejects(() => createCouncilSession({ ...council, requestedCode: REQUESTED_CODE }, caller), {
            message: "This tool requires the dedicated Council host credential.",
        }, `requestedCode accepted ${label}`);
    }
    assert.equal(database.from.mock.callCount(), 0);
    assert.equal(database.rpc.mock.callCount(), 0);
});

test("malformed requested council codes fail before database access", async (t) => {
    const database = stubCouncilCreation(t);
    for (const requestedCode of ["", "cn-abcd", "CN-ABC", "CN-ABCDE", "CN-0ABC", "CN-ABCI", " CN-ABCD", "CN-ABCD\n"]) {
        await assert.rejects(() => createCouncilSession({ ...council, requestedCode }, HOST), {
            message: "Invalid requested council code.",
        });
    }
    assert.equal(database.from.mock.callCount(), 0);
    assert.equal(database.rpc.mock.callCount(), 0);
});

test("successful creation preserves the exact preflighted code through insert and refresh", async (t) => {
    const database = stubCouncilCreation(t);
    const result = await createCouncilSession({ ...council, requestedCode: REQUESTED_CODE }, HOST);
    assert.equal(database.inserts.length, 1);
    assert.equal(database.inserts[0].code, REQUESTED_CODE);
    assert.equal(result.code, REQUESTED_CODE);
    assert.equal(result.id, SESSION_ID);
    assert.equal(database.roster.length, 2);
    assert.equal(database.roster[0].name, "agent-a");
    assert.equal(database.rpc.mock.callCount(), 1);
    assert.equal(database.rpc.mock.calls[0].arguments[0], "append_council_message");
});

test("a requested code collision stops after one insert without roster or brief writes", async (t) => {
    const database = stubCouncilCreation(t, 1);
    await assert.rejects(() => createCouncilSession({ ...council, requestedCode: REQUESTED_CODE }, HOST), {
        message: "Requested council code is already in use. Nothing was created.",
    });
    assert.equal(database.inserts.length, 1);
    assert.equal(database.inserts[0].code, REQUESTED_CODE);
    assert.equal(database.from.mock.callCount(), 1);
    assert.equal(database.roster.length, 0);
    assert.equal(database.rpc.mock.callCount(), 0);
});

test("legacy creation without a requested code retries collisions and creates the roster once", async (t) => {
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
