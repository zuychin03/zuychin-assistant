// Offline checks for the agent's model tools: hint rules under each policy, purpose picks, ratings, the consult budget and timeouts.
import assert from "node:assert/strict";
import { PROVIDERS, isProviderAvailable, providers, type ResolvedChat } from "../src/lib/ai/providers";
import { setCatalogueSnapshotForTests } from "../src/lib/ai/catalogue/snapshot";
import { buildRoster, type RosterEntry, type RosterPolicy } from "../src/lib/ai/models/roster";
import { createModelToolkit, MODEL_TOOLS, parsePurpose, type ModelToolDeps } from "../src/lib/ai/agent/model-tools";
import { AGENT_TOOLS } from "../src/lib/ai/agent/tools";
import { AGENT_CONFIG } from "../src/lib/ai/agent/config";
import { getSkill } from "../src/lib/ai/skills/registry";
import type { FeedbackInput } from "../src/lib/ai/models/store";
import type { SpeedStats } from "../src/lib/ai/models/stats";
import type { ProfileRecord } from "../src/lib/ai/models/profiles";
import { CODE_SEED_ROWS } from "./fixtures/catalogue-seeds.mts";

for (const provider of PROVIDERS) process.env[provider.apiKeyEnv] = "agent-tools-test-key";
const LAGUNA_ROW = CODE_SEED_ROWS.find((row) => row.providerId === "nvidia-nim" && row.modelId === "poolside/laguna-xs-2.1")!;
setCatalogueSnapshotForTests([LAGUNA_ROW]);

const FREE: RosterPolicy = { freeOnly: false, paidOrchestrator: false, unattended: false };
const PAID: RosterPolicy = { freeOnly: false, paidOrchestrator: true, unattended: false };
const FREE_ONLY: RosterPolicy = { freeOnly: true, paidOrchestrator: false, unattended: false };
const UNATTENDED: RosterPolicy = { freeOnly: false, paidOrchestrator: false, unattended: true };
const LAGUNA = "nvidia-nim::poolside/laguna-xs-2.1";
const GLM = "nvidia-nim::z-ai/glm-5.3-flash";
const PAID_FLASH = "gemini::gemini-3.8-flash";

function speed(key: string, ms: number): SpeedStats {
    const [providerId, modelId] = key.split("::");
    return { providerId, modelId, timedCalls: 10, medianFirstAnswerMs: ms, p90FirstAnswerMs: ms * 2, medianDurationMs: ms * 3, medianTokensPerSecond: 50, succeeded: 10, failed: 0, lastSuccessAt: "2026-11-19T00:00:00.000Z" };
}
function profile(key: string, tags: ProfileRecord["tags"]): ProfileRecord {
    const [providerId, modelId] = key.split("::");
    return { providerId, modelId, tags, tagsSource: "owner", profile: null, approvedAt: null, draft: null, draftStatus: "none", draftError: null, draftedAt: null, lookupAttempts: 0, vaultPath: null, vaultSyncedAt: null, vaultError: null, removedAt: null };
}
const roster = (policy: RosterPolicy) => buildRoster({
    providers: providers(), rows: [LAGUNA_ROW], profiles: [profile(LAGUNA, ["coding", "agentic"]), profile(GLM, ["research", "agentic"])],
    speed: new Map([speed(LAGUNA, 1500), speed(GLM, 30_000)].map((entry) => [`${entry.providerId}::${entry.modelId}`, entry])),
    feedback: new Map(), available: isProviderAvailable,
}, policy);
const resolve = (entry: RosterEntry): ResolvedChat | null => {
    const provider = providers().find((candidate) => candidate.id === entry.providerId);
    const model = provider?.chatModels.find((candidate) => candidate.id === entry.modelId);
    return provider && model ? { provider, model } : null;
};
const keyOf = (resolved: ResolvedChat) => `${resolved.provider.id}::${resolved.model.id}`;

function toolkit(policy: RosterPolicy, overrides: Partial<ModelToolDeps> = {}) {
    const saved: FeedbackInput[][] = [];
    const consulted: string[] = [];
    let clock = 0;
    const deps: ModelToolDeps = {
        roster: () => roster(policy), resolve,
        consult: async (resolved) => { consulted.push(keyOf(resolved)); clock += 1200; return `answer from ${resolved.model.id}`; },
        saveFeedback: async (rows) => { saved.push([...rows]); return true; },
        now: () => clock,
        ...overrides,
    };
    return { kit: createModelToolkit(policy, deps, { runId: "run-7" }), saved, consulted };
}

let checks = 0;
async function check(name: string, run: () => void | Promise<void>) {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

await check("the tools are declared for the lead, with purpose on run_subagents and the skill registered", () => {
    assert.deepEqual(MODEL_TOOLS.map((tool) => tool.name), ["list_models", "ask_model", "compare_models", "rate_workers"]);
    const subagents = AGENT_TOOLS.find((tool) => tool.name === "run_subagents")!;
    const task = (subagents.parameters.tasks as { items: { properties: Record<string, { enum?: string[]; description: string }> } }).items.properties;
    assert.ok(task.purpose.enum?.includes("research"));
    assert.ok(!task.needs_tools.description.includes("even faster"), "the stale speed claim is gone");
    assert.ok(getSkill("choose-models")?.instructions.includes("rate_workers"));
    assert.equal(parsePurpose("coding"), "coding");
    assert.equal(parsePurpose("hacking"), "invalid");
    assert.equal(parsePurpose(undefined), null);
});

await check("a free orchestrator ignores a paid hint and says why; a paid orchestrator uses it", () => {
    const free = toolkit(FREE).kit.pickWorker({ hint: PAID_FLASH, purpose: null, needsTools: true });
    assert.equal(free.candidates.length, 0);
    assert.equal(free.defaultChain, true);
    assert.match(free.note ?? "", /Paid, and this run's orchestrator is on a free model/);
    const paid = toolkit(PAID).kit.pickWorker({ hint: PAID_FLASH, purpose: null, needsTools: true });
    assert.deepEqual(paid.candidates.map(keyOf), [PAID_FLASH]);
    assert.equal(paid.note, null);
    const named = toolkit(FREE).kit.pickWorker({ hint: "laguna-xs-2.1", purpose: null, needsTools: true });
    assert.equal(keyOf(named.candidates[0]), LAGUNA, "a short name resolves to the usable route");
});

await check("Free only refuses paid hints and unattended runs leave workers on paid Gemini", () => {
    const freeOnly = toolkit(FREE_ONLY).kit.pickWorker({ hint: PAID_FLASH, purpose: null, needsTools: true });
    assert.equal(freeOnly.candidates.length, 0);
    assert.match(freeOnly.note ?? "", /Free only is on/);
    const unattended = toolkit(UNATTENDED).kit.pickWorker({ hint: LAGUNA, purpose: "coding", needsTools: true });
    assert.deepEqual(unattended, { candidates: [], defaultChain: false, note: "Scheduled run: the model hint was ignored and paid Gemini ran." });
});

await check("a purpose ranks tagged, fast free models first and replaces the default chain", () => {
    const coding = toolkit(FREE).kit.pickWorker({ purpose: "coding", needsTools: true });
    assert.equal(keyOf(coding.candidates[0]), LAGUNA);
    assert.equal(coding.defaultChain, false);
    assert.ok(coding.candidates.length <= 6);
    assert.ok(coding.candidates.every((resolved) => resolved.model.free === true && resolved.provider.kind !== "gemini"));
    const research = toolkit(FREE).kit.pickWorker({ purpose: "research", needsTools: true });
    assert.notEqual(keyOf(research.candidates[0]), GLM, "a slow model loses to fast untagged ones");
    const hinted = toolkit(FREE).kit.pickWorker({ hint: GLM, purpose: "coding", needsTools: true });
    assert.equal(keyOf(hinted.candidates[0]), GLM, "a usable hint goes first, then the purpose picks");
    assert.equal(keyOf(hinted.candidates[1]), LAGUNA);
});

await check("list_models explains the policy, rejects unknown purposes and shows one model's detail", () => {
    const { kit } = toolkit(FREE);
    const list = kit.listModels({ purpose: "coding", needs_tools: true });
    assert.match(list, /orchestrator is on a free model/);
    assert.ok(list.indexOf(LAGUNA) > 0 && !list.includes(PAID_FLASH));
    assert.match(kit.listModels({ purpose: "hacking" }), /Unknown purpose "hacking"/);
    assert.match(kit.listModels({ model: LAGUNA }), /Tags: coding, agentic \(owner\)/);
    assert.match(kit.listModels({ model: "nope" }), /No model matches "nope"/);
});

await check("ratings are stored once, with each worker's model and purpose", async () => {
    const { kit, saved } = toolkit(FREE);
    const w1 = kit.registerWorker({ providerId: "nvidia-nim", modelId: "poolside/laguna-xs-2.1", purpose: "coding" });
    const w2 = kit.registerWorker({ providerId: "openrouter", modelId: "nvidia/nemotron-3.5-lightning:free", purpose: null });
    assert.deepEqual([w1, w2], ["w1", "w2"]);
    assert.equal(kit.workerKey("w2"), "openrouter::nvidia/nemotron-3.5-lightning:free");
    const reply = await kit.rateWorkers({ ratings: [{ worker: "W1", useful: true, reason: "Clean code" }, { worker: "w2", useful: false }, { worker: "w9", useful: true }] });
    assert.match(reply, /Saved 2 ratings\. Skipped: w9\./);
    assert.deepEqual(saved[0], [
        { providerId: "nvidia-nim", modelId: "poolside/laguna-xs-2.1", purpose: "coding", source: "lead", useful: true, reason: "Clean code", agentRunId: "run-7" },
        { providerId: "openrouter", modelId: "nvidia/nemotron-3.5-lightning:free", purpose: null, source: "lead", useful: false, reason: null, agentRunId: "run-7" },
    ]);
    assert.match(await kit.rateWorkers({ ratings: [{ worker: "w1", useful: true }] }), /already rated/);
    await kit.autoFeedback([{ providerId: "nvidia-nim", modelId: "z-ai/glm-5.3-flash", purpose: "research", reason: "Stopped at the worker deadline" }]);
    assert.deepEqual(saved[1], [{ providerId: "nvidia-nim", modelId: "z-ai/glm-5.3-flash", purpose: "research", reason: "Stopped at the worker deadline", source: "auto", useful: false, agentRunId: "run-7" }]);
});

await check("ask_model follows the hint rule and the consult budget holds across both tools", async () => {
    const { kit, consulted } = toolkit(FREE);
    assert.match(await kit.askModel({ model: PAID_FLASH, prompt: "Hi" }), /not usable on this run: Paid/);
    assert.equal(consulted.length, 0, "a refused model costs nothing");
    for (let index = 0; index < 4; index += 1) assert.match(await kit.askModel({ model: LAGUNA, prompt: "Hi" }), /^Answer from nvidia-nim::poolside\/laguna-xs-2\.1 in 1\.2 s/);
    assert.match(await kit.compareModels({ prompt: "Hi", models: [LAGUNA, GLM, "openrouter::nvidia/nemotron-3.5-lightning:free"] }), /Only 2 of the 6 consult calls/);
    assert.match(await kit.compareModels({ prompt: "Hi", models: [LAGUNA, GLM] }), /0 consult calls left/);
    assert.match(await kit.askModel({ model: LAGUNA, prompt: "Hi" }), /consult budget of 6 calls/);
    assert.equal(consulted.length, 6);
});

await check("compare_models reports a model that runs out of time and keeps the other answer", async () => {
    const saved = AGENT_CONFIG.consultTimeoutMs;
    AGENT_CONFIG.consultTimeoutMs = 50;
    // AbortSignal.timeout does not hold the event loop open on its own.
    const keepAlive = setInterval(() => {}, 1000);
    try {
        const { kit } = toolkit(PAID, {
            consult: (resolved, _prompt, _max, signal) => resolved.model.id === "z-ai/glm-5.3-flash"
                ? new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
                : Promise.resolve(`answer from ${resolved.model.id}`),
            now: Date.now,
        });
        const reply = await kit.compareModels({ prompt: "Hi", models: [LAGUNA, GLM, PAID_FLASH] });
        assert.match(reply, /### nvidia-nim::poolside\/laguna-xs-2\.1\nanswer from poolside\/laguna-xs-2\.1/);
        assert.match(reply, /### nvidia-nim::z-ai\/glm-5\.3-flash\n\(failed: no answer within 0\.05 s\)/);
        assert.match(reply, /\| gemini::gemini-3\.8-flash \| [\d.]+ s \| answered \|/, "a paid orchestrator may compare against paid Gemini");
        assert.match(reply, /3 consult calls left/);
    } finally {
        clearInterval(keepAlive);
        AGENT_CONFIG.consultTimeoutMs = saved;
    }
});

console.log(`${checks} agent model tool checks passed`);
