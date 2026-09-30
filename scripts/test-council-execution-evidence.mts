import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExecutionEvidence, parseFrozenExecutionItems, resolveExecutionEvidence, executionSourceLabel } from "../src/lib/council/execution-evidence.ts";

const evidence = {
    executionId: "00000000-0000-4000-8000-000000000001", agentName: "reviewer",
    connectorKind: "acp", identityAssurance: "host_verified", provider: "fixture",
    adapterVersion: "1.2.3", requestedModel: "requested", effectiveModel: "observed",
    requestedReasoningEffort: "high", effectiveReasoningEffort: "medium", modelSource: "adapter_config",
};

test("evidence parser explicitly strips private and lifecycle metadata", () => {
    assert.deepEqual(parseExecutionEvidence({ ...evidence, hostId: "private", tokenHash: "secret", env: { API_KEY: "secret" }, worktree: "private", stopReason: "private", endedAt: "mutable" }), evidence);
});

test("unknown effective fields remain unknown even when a requested model exists", () => {
    const parsed = parseExecutionEvidence({ ...evidence, effectiveModel: null, effectiveReasoningEffort: null });
    assert.equal(parsed?.effectiveModel, null);
    assert.equal(parsed?.effectiveReasoningEffort, null);
    assert.equal(parsed?.requestedModel, "requested");
});

test("historical unbound messages never acquire the current or latest execution", () => {
    assert.deepEqual(resolveExecutionEvidence(null, [evidence]), { status: "not_recorded", evidence: null });
    assert.deepEqual(resolveExecutionEvidence(undefined, [evidence]), { status: "not_recorded", evidence: null });
});

test("missing referenced evidence is unavailable, not unbound and not the latest run", () => {
    assert.deepEqual(resolveExecutionEvidence("00000000-0000-4000-8000-000000000002", [evidence]), { status: "unavailable", evidence: null });
    assert.deepEqual(resolveExecutionEvidence(evidence.executionId, [evidence]), { status: "recorded", evidence });
});

test("malformed snapshots cannot introduce a fabricated model or binding", () => {
    assert.equal(parseExecutionEvidence({ ...evidence, executionId: "" }), null);
    assert.equal(parseExecutionEvidence({ ...evidence, agentName: null }), null);
    assert.equal(parseExecutionEvidence({ ...evidence, effectiveModel: { name: "fabricated" } }), null);
});

test("frozen accepted evidence never uses another run or a newly submitted execution", () => {
    const item = { itemId: "task", sequence: 1, agentName: "reviewer", commitSha: "accepted-sha", acceptedExecutionId: evidence.executionId };
    const parsed = parseFrozenExecutionItems({ items: [{ ...item, executionEvidence: evidence, submittedExecutionId: "new-run", env: "private" }] });
    assert.deepEqual(parsed, [{ ...item, executionEvidence: evidence }]);
    assert.equal(parseFrozenExecutionItems({ items: [{ ...item, executionEvidence: { ...evidence, executionId: "00000000-0000-4000-8000-000000000002" } }] })[0].executionEvidence, null);
    assert.equal(parseFrozenExecutionItems({ items: [{ ...item, executionEvidence: { ...evidence, agentName: "other-seat" } }] })[0].executionEvidence, null);
    assert.equal(parseFrozenExecutionItems({ items: [{ ...item, acceptedExecutionId: null, executionEvidence: evidence }] })[0].executionEvidence, null);
});

test("legacy acknowledgement and declared configuration are not labelled independent readback", () => {
    assert.equal(executionSourceLabel("adapter_legacy_set_model"), "Selection acknowledged");
    assert.equal(executionSourceLabel("configured_cli"), "Configured, unverified");
    assert.equal(executionSourceLabel("adapter_config"), "Adapter readback");
});
