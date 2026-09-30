import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostSnapshot } from "../src/app/council/host-client.ts";

const snapshot: HostSnapshot = { version: "fixture", code: null, topic: null, status: "idle", round: 0, maxRounds: 6, floorHolder: null, repo: "fixture", runDir: null, agents: [], permissions: [], capabilities: { protocolVersion: 3, modelSelection: true }, instances: [
    { name: "seat", provider: "fixture", mode: "acp", expertise: "Review", warn: null, defaultModel: "default-model", allowedModels: ["default-model", "chosen-model"], defaultReasoningEffort: "medium", allowedReasoningEfforts: ["medium", "high"] },
    { name: "locked", provider: "fixture", mode: "acp", expertise: "Review", warn: null, defaultModel: "locked-model", allowedModels: [], defaultReasoningEffort: null, allowedReasoningEfforts: [] },
    { name: "shell", provider: "fixture", mode: "shell", expertise: "Review", warn: null, defaultModel: "shell-model", allowedModels: ["shell-model"], defaultReasoningEffort: null, allowedReasoningEfforts: ["high"] },
] };

test("chat selection payload carries only explicit advertised choices for proposed seats", async () => {
    const { prepareProposalSelections } = await import("../src/app/home/council-proposal-selection.ts");
    const choices = { seat: { modelId: "chosen-model", reasoningEffort: "high", args: ["private"] }, intruder: { modelId: "chosen-model" } };
    assert.deepEqual(prepareProposalSelections(snapshot, ["seat"], choices), { selections: { seat: { modelId: "chosen-model", reasoningEffort: "high" } } });
    assert.deepEqual(prepareProposalSelections(snapshot, ["seat"], {}), { selections: {} });
});

test("chat selection rejects forged or stale choices rather than silently using defaults", async () => {
    const { prepareProposalSelections } = await import("../src/app/home/council-proposal-selection.ts");
    for (const selection of [{ modelId: "retired" }, { reasoningEffort: "unsupported" }]) {
        assert("error" in prepareProposalSelections(snapshot, ["seat"], { seat: selection }));
    }
    assert("error" in prepareProposalSelections(snapshot, ["unknown"], { unknown: { modelId: "chosen-model" } }));
});

test("old hosts, locked seats and shell seats expose defaults without accepting overrides", async () => {
    const { prepareProposalSelections, proposalSeatChoices } = await import("../src/app/home/council-proposal-selection.ts");
    for (const name of ["locked", "shell"]) {
        assert.equal(proposalSeatChoices(snapshot, name).models.length, 0);
        assert("error" in prepareProposalSelections(snapshot, [name], { [name]: { modelId: "chosen-model" } }));
        assert.deepEqual(prepareProposalSelections(snapshot, [name], {}), { selections: {} });
    }
    const old = { ...snapshot, capabilities: undefined };
    assert.equal(proposalSeatChoices(old, "seat").models.length, 0);
    assert.deepEqual(prepareProposalSelections(old, ["seat"], {}), { selections: {} });
    assert("error" in prepareProposalSelections(old, ["seat"], { seat: { modelId: "chosen-model" } }));
});
