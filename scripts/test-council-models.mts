import assert from "node:assert/strict";
import test from "node:test";
import { configureAcpSession } from "./council-models.mts";

const choices = (...values: string[]) => values.map((value) => ({ value, name: value }));
const model = (currentValue = "alpha", options: unknown = choices("alpha", "beta"), id = "model") => ({
    id, name: "Model", category: "model", type: "select", currentValue, options,
});
const reasoning = (currentValue = "medium", options: unknown = choices("medium", "high"), id = "reasoning_effort") => ({
    id, name: "Reasoning", category: "thought_level", type: "select", currentValue, options,
});
const stable = (...configOptions: unknown[]) => ({ configOptions });
const initialized = (version: unknown = "2.0.0") => ({ agentInfo: { name: "fixture-adapter", version } });
const legacy = (currentModelId: unknown = "claude-opus-4-6") => ({
    models: { currentModelId, availableModels: [{ modelId: "claude-opus-4-6", name: "Opus" }] },
});

function scenario(overrides: Partial<Parameters<typeof configureAcpSession>[0]> = {}, responses: unknown[] = []) {
    const calls: { configId: string; value: string }[] = [];
    return {
        calls,
        run: () => configureAcpSession({
            initialized: initialized(),
            sessionResponse: stable(model(), reasoning()),
            selection: {},
            allowedModels: ["alpha", "beta"],
            allowedReasoningEfforts: ["medium", "high"],
            setConfigOption: async (configId: string, value: string) => {
                calls.push({ configId, value });
                assert.ok(calls.length <= responses.length, "unexpected adapter configuration request");
                return responses[calls.length - 1];
            },
            ...overrides,
        }),
    };
}

await test("stable defaults are observed without setting configuration", async () => {
    const fixture = scenario();
    assert.deepEqual(await fixture.run(), {
        effectiveModel: "alpha", effectiveReasoningEffort: "medium", adapterVersion: "2.0.0",
        modelSource: "adapter_config", modelSelection: true,
    });
    assert.deepEqual(fixture.calls, []);
});

await test("legacy default evidence advertises legacy selection", async () => {
    const fixture = scenario({ sessionResponse: legacy() });
    assert.deepEqual(await fixture.run(), {
        effectiveModel: "claude-opus-4-6", effectiveReasoningEffort: null, adapterVersion: "2.0.0",
        modelSource: "adapter_legacy_models", modelSelection: true,
    });
    assert.deepEqual(fixture.calls, []);
});

await test("stable model evidence takes precedence over a conflicting legacy default", async () => {
    const fixture = scenario({ sessionResponse: { ...legacy(), ...stable(model("beta")) } });
    const result = await fixture.run();
    assert.equal(result.effectiveModel, "beta");
    assert.equal(result.modelSource, "adapter_config");
    assert.deepEqual(fixture.calls, []);
});

for (const sessionResponse of [undefined, null, {}, { configOptions: "invalid" }, { models: null }]) {
    await test(`missing or malformed default evidence stays unknown: ${JSON.stringify(sessionResponse)}`, async () => {
        const fixture = scenario({ sessionResponse });
        const result = await fixture.run();
        assert.equal(result.effectiveModel, null);
        assert.equal(result.effectiveReasoningEffort, null);
        assert.equal(result.modelSource, "unknown");
        assert.equal(result.modelSelection, false);
        assert.deepEqual(fixture.calls, []);
    });
}

await test("legacy selection requires an available setter", async () => {
    const fixture = scenario({
        sessionResponse: legacy(), selection: { modelId: "claude-opus-4-6" },
        allowedModels: ["claude-opus-4-6"],
    });
    await assert.rejects(fixture.run);
    assert.deepEqual(fixture.calls, []);
});

await test("a local model allowlist is checked before requesting an adapter change", async () => {
    const fixture = scenario({ selection: { modelId: "beta" }, allowedModels: ["alpha"] });
    await assert.rejects(fixture.run);
    assert.deepEqual(fixture.calls, []);
});

await test("an unadvertised model is rejected despite its local allowance", async () => {
    const fixture = scenario({ selection: { modelId: "gamma" }, allowedModels: ["gamma"] });
    await assert.rejects(fixture.run);
    assert.deepEqual(fixture.calls, []);
});

await test("grouped stable choices use their advertised configuration ID", async () => {
    const grouped = [{ group: "family", name: "Family", options: choices("alpha", "beta") }];
    const fixture = scenario({
        sessionResponse: stable(model("alpha", grouped, "runtime-model")), selection: { modelId: "beta" },
    }, [stable(model("beta", grouped, "runtime-model"))]);
    const result = await fixture.run();
    assert.equal(result.effectiveModel, "beta");
    assert.equal(result.modelSource, "adapter_config");
    assert.deepEqual(fixture.calls, [{ configId: "runtime-model", value: "beta" }]);
});

for (const response of [{}, null, { configOptions: "invalid" }, stable(), stable(model("alpha")), stable({ ...model(), currentValue: 42 })]) {
    await test(`model override requires returned effective configuration: ${JSON.stringify(response)}`, async () => {
        const fixture = scenario({ selection: { modelId: "beta" } }, [response]);
        await assert.rejects(fixture.run);
        assert.deepEqual(fixture.calls, [{ configId: "model", value: "beta" }]);
    });
}

await test("adapter rejection propagates without manufacturing effective evidence", async () => {
    const failure = new Error("fixture adapter rejected the change");
    const fixture = scenario({
        selection: { modelId: "beta" },
        setConfigOption: async () => { throw failure; },
    });
    await assert.rejects(fixture.run, (error) => error === failure);
});

await test("reasoning allowlist denial prevents adapter configuration", async () => {
    const fixture = scenario({ selection: { reasoningEffort: "high" }, allowedReasoningEfforts: ["medium"] });
    await assert.rejects(fixture.run);
    assert.deepEqual(fixture.calls, []);
});

await test("reasoning selection requires an advertised option", async () => {
    const fixture = scenario({ sessionResponse: stable(model()), selection: { reasoningEffort: "high" } });
    await assert.rejects(fixture.run);
    assert.deepEqual(fixture.calls, []);
});

await test("reasoning selection uses grouped choices and its advertised ID", async () => {
    const grouped = [{ group: "levels", name: "Levels", options: choices("medium", "high") }];
    const fixture = scenario({
        sessionResponse: stable(model(), reasoning("medium", grouped, "effort-v2")),
        selection: { reasoningEffort: "high" },
    }, [stable(model(), reasoning("high", grouped, "effort-v2"))]);
    const result = await fixture.run();
    assert.equal(result.effectiveModel, "alpha");
    assert.equal(result.effectiveReasoningEffort, "high");
    assert.deepEqual(fixture.calls, [{ configId: "effort-v2", value: "high" }]);
});

for (const response of [{}, stable(model()), stable(model(), reasoning("medium")), stable(model(), { ...reasoning(), currentValue: false })]) {
    await test(`reasoning override requires returned effective configuration: ${JSON.stringify(response)}`, async () => {
        const fixture = scenario({ selection: { reasoningEffort: "high" } }, [response]);
        await assert.rejects(fixture.run);
        assert.deepEqual(fixture.calls, [{ configId: "reasoning_effort", value: "high" }]);
    });
}

await test("model changes refresh reasoning choices and their configuration ID", async () => {
    const fixture = scenario({
        sessionResponse: stable(model(), reasoning("medium", choices("medium"), "old-effort")),
        selection: { modelId: "beta", reasoningEffort: "high" },
    }, [
        stable(model("beta"), reasoning("medium", choices("medium", "high"), "new-effort")),
        stable(model("beta"), reasoning("high", choices("medium", "high"), "new-effort")),
    ]);
    const result = await fixture.run();
    assert.equal(result.effectiveModel, "beta");
    assert.equal(result.effectiveReasoningEffort, "high");
    assert.deepEqual(fixture.calls, [{ configId: "model", value: "beta" }, { configId: "new-effort", value: "high" }]);
});

await test("a reasoning choice removed by model selection is not sent from stale options", async () => {
    const fixture = scenario({ selection: { modelId: "beta", reasoningEffort: "high" } }, [
        stable(model("beta"), reasoning("medium", choices("medium"))),
    ]);
    await assert.rejects(fixture.run);
    assert.deepEqual(fixture.calls, [{ configId: "model", value: "beta" }]);
});

await test("the final reasoning response cannot change the explicitly selected model", async () => {
    const fixture = scenario({ selection: { modelId: "beta", reasoningEffort: "high" } }, [
        stable(model("beta"), reasoning()),
        stable(model("alpha"), reasoning("high")),
    ]);
    await assert.rejects(fixture.run);
    assert.deepEqual(fixture.calls, [{ configId: "model", value: "beta" }, { configId: "reasoning_effort", value: "high" }]);
});

await test("the final response cannot omit an explicitly selected model", async () => {
    const fixture = scenario({ selection: { modelId: "beta", reasoningEffort: "high" } }, [
        stable(model("beta"), reasoning()),
        stable(reasoning("high")),
    ]);
    await assert.rejects(fixture.run);
    assert.deepEqual(fixture.calls, [{ configId: "model", value: "beta" }, { configId: "reasoning_effort", value: "high" }]);
});

await test("a reasoning-only update records its returned default model rather than the old one", async () => {
    const fixture = scenario({ selection: { reasoningEffort: "high" } }, [stable(model("beta"), reasoning("high"))]);
    const result = await fixture.run();
    assert.equal(result.effectiveModel, "beta");
    assert.equal(result.effectiveReasoningEffort, "high");
});

for (const value of [undefined, null, {}, { agentInfo: null }, { agentInfo: "invalid" }, initialized(42), initialized(""), initialized("   ")]) {
    await test(`missing or malformed implementation metadata remains unknown: ${JSON.stringify(value)}`, async () => {
        const fixture = scenario({ initialized: value });
        const result = await fixture.run();
        assert.equal(result.adapterVersion, null);
        assert.equal(result.effectiveModel, "alpha");
        assert.deepEqual(fixture.calls, []);
    });
}

await test("version evidence comes from initialization and does not require semver", async () => {
    const fixture = scenario({
        initialized: { ...initialized("release-custom+build42"), version: "wrong", adapterVersion: "wrong" },
        sessionResponse: { ...stable(model()), agentInfo: { name: "wrong", version: "wrong" } },
    });
    assert.equal((await fixture.run()).adapterVersion, "release-custom+build42");
});

await test("separate executions keep independent reported versions and do not mutate evidence", async () => {
    const firstMetadata = initialized("0.16.2");
    const secondMetadata = initialized("2.0.0");
    const firstSession = legacy();
    const secondSession = stable(model());
    const before = JSON.stringify([firstMetadata, secondMetadata, firstSession, secondSession]);
    const [first, second] = await Promise.all([
        scenario({ initialized: firstMetadata, sessionResponse: firstSession }).run(),
        scenario({ initialized: secondMetadata, sessionResponse: secondSession }).run(),
    ]);
    assert.equal(first.adapterVersion, "0.16.2");
    assert.equal(second.adapterVersion, "2.0.0");
    assert.equal(first.effectiveModel, "claude-opus-4-6");
    assert.equal(second.effectiveModel, "alpha");
    assert.equal(JSON.stringify([firstMetadata, secondMetadata, firstSession, secondSession]), before);
});


for (const acknowledgement of [{}, { _meta: { fixture: true } }]) {
    await test("legacy selection records acknowledged configuration " + JSON.stringify(acknowledgement), async () => {
        const calls: string[] = [];
        const sessionResponse = { models: { currentModelId: "default", availableModels: [{ modelId: "sonnet" }] } };
        const before = JSON.stringify(sessionResponse);
        const fixture = scenario({ sessionResponse, selection: { modelId: "sonnet" }, allowedModels: ["sonnet"],
            setLegacyModel: async (id: string) => { calls.push(id); return acknowledgement; } });
        assert.deepEqual(await fixture.run(), {
            effectiveModel: "sonnet", effectiveReasoningEffort: null, adapterVersion: "2.0.0",
            modelSource: "adapter_legacy_set_model", modelSelection: true,
        });
        assert.deepEqual(calls, ["sonnet"]);
        assert.deepEqual(fixture.calls, []);
        assert.equal(JSON.stringify(sessionResponse), before);
    });
}

for (const acknowledgement of [undefined, null, [], "ok", 1, true]) {
    await test("legacy selection rejects malformed acknowledgement " + JSON.stringify(acknowledgement), async () => {
        let called = false;
        const fixture = scenario({ sessionResponse: legacy(), selection: { modelId: "claude-opus-4-6" },
            allowedModels: ["claude-opus-4-6"], setLegacyModel: async () => { called = true; return acknowledgement; } });
        await assert.rejects(fixture.run, /acknowledg/);
        assert.equal(called, true);
        assert.deepEqual(fixture.calls, []);
    });
}

await test("legacy choices without a default can be selected", async () => {
    const fixture = scenario({ sessionResponse: { models: { availableModels: [{ modelId: "sonnet" }] } },
        selection: { modelId: "sonnet" }, allowedModels: ["sonnet"], setLegacyModel: async () => ({}) });
    assert.equal((await fixture.run()).effectiveModel, "sonnet");
});

for (const [label, allowedModels, modelId] of [
    ["local allowlist", ["sonnet"], "claude-opus-4-6"],
    ["live choices", ["sonnet"], "sonnet"],
] as const) {
    await test("legacy selection validates " + label + " before any setter", async () => {
        let called = false;
        const fixture = scenario({ sessionResponse: legacy(), selection: { modelId }, allowedModels: [...allowedModels],
            setLegacyModel: async () => { called = true; return {}; } });
        await assert.rejects(fixture.run);
        assert.equal(called, false);
        assert.deepEqual(fixture.calls, []);
    });
}

for (const message of ["legacy RPC rejected", "legacy RPC timed out"]) {
    await test(message + " prevents fallback or fabricated evidence", async () => {
        const failure = new Error(message);
        const fixture = scenario({ sessionResponse: legacy(), selection: { modelId: "claude-opus-4-6" },
            allowedModels: ["claude-opus-4-6"], setLegacyModel: async () => { throw failure; } });
        await assert.rejects(fixture.run, (error) => error === failure);
        assert.deepEqual(fixture.calls, []);
    });
}

await test("stable selection takes precedence over a usable legacy setter", async () => {
    let called = false;
    const fixture = scenario({ sessionResponse: { ...legacy(), ...stable(model()) }, selection: { modelId: "beta" },
        setLegacyModel: async () => { called = true; return {}; } }, [stable(model("beta"))]);
    assert.equal((await fixture.run()).modelSource, "adapter_config");
    assert.equal(called, false);
});

await test("failed stable readback cannot fall back to the legacy setter", async () => {
    let called = false;
    const fixture = scenario({ sessionResponse: { ...legacy(), ...stable(model()) }, selection: { modelId: "beta" },
        setLegacyModel: async () => { called = true; return {}; } }, [{}]);
    await assert.rejects(fixture.run, /did not confirm/);
    assert.equal(called, false);
});

await test("legacy model plus reasoning fails before setters without complete readback", async () => {
    let called = false;
    const fixture = scenario({ sessionResponse: { ...legacy(), ...stable(reasoning()) },
        selection: { modelId: "claude-opus-4-6", reasoningEffort: "high" }, allowedModels: ["claude-opus-4-6"],
        setLegacyModel: async () => { called = true; return {}; } });
    await assert.rejects(fixture.run, /legacy.*reasoning/);
    assert.equal(called, false);
    assert.deepEqual(fixture.calls, []);
});

await test("reasoning-only update with legacy models records returned evidence", async () => {
    const fixture = scenario({ sessionResponse: { ...legacy(), ...stable(reasoning()) }, selection: { reasoningEffort: "high" } }, [
        { models: { currentModelId: "sonnet", availableModels: [{ modelId: "sonnet" }] }, ...stable(reasoning("high")) },
    ]);
    const evidence = await fixture.run();
    assert.equal(evidence.effectiveModel, "sonnet");
    assert.equal(evidence.effectiveReasoningEffort, "high");
    assert.equal(evidence.modelSource, "adapter_legacy_models");
});

for (const currentModelId of [42, ""]) {
    await test("legacy choices stay selectable with unknown default " + JSON.stringify(currentModelId), async () => {
        const evidence = await scenario({ sessionResponse: legacy(currentModelId) }).run();
        assert.equal(evidence.effectiveModel, null);
        assert.equal(evidence.modelSource, "unknown");
        assert.equal(evidence.modelSelection, true);
    });
}

await test("legacy selection discards stale reasoning evidence after a model change", async () => {
    const fixture = scenario({ sessionResponse: { ...legacy(), ...stable(reasoning()) },
        selection: { modelId: "claude-opus-4-6" }, allowedModels: ["claude-opus-4-6"], setLegacyModel: async () => ({}) });
    assert.equal((await fixture.run()).effectiveReasoningEffort, null);
});

await test("empty and malformed legacy choices remain non-selectable", async () => {
    for (const availableModels of [undefined, null, [], "invalid", [{ modelId: "" }, { modelId: 42 }, null]]) {
        const evidence = await scenario({ sessionResponse: { models: { currentModelId: "default", availableModels } } }).run();
        assert.equal(evidence.effectiveModel, "default");
        assert.equal(evidence.modelSelection, false);
    }
});
