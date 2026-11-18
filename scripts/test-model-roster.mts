import assert from "node:assert/strict";
import { PROVIDERS, isProviderAvailable, listProvidersPublic, providers } from "../src/lib/ai/providers";
import { setCatalogueSnapshotForTests, type CatalogueRow } from "../src/lib/ai/catalogue/snapshot";
import { buildRoster, findEntry, formatModelDetail, formatRoster, formatRosterSummary, listForRun, rankForPurpose, scoreEntry, type RosterPolicy } from "../src/lib/ai/models/roster";
import { feedbackScore, modelSpeed, setStatsSnapshotForTests, speedTier, type ModelFeedback, type SpeedStats } from "../src/lib/ai/models/stats";
import { gateTags, tagsFromMeta } from "../src/lib/ai/models/tags";
import { getModelMeta } from "../src/lib/ai/model-meta";
import type { ProfileRecord } from "../src/lib/ai/models/profiles";
import { formatModelStatus } from "../src/lib/ai/models/status";

for (const provider of PROVIDERS) process.env[provider.apiKeyEnv] = "roster-test-key";
let checks = 0;
function check(name: string, run: () => void) {
    setCatalogueSnapshotForTests([]);
    setStatsSnapshotForTests([]);
    run();
    checks++;
    console.log(`PASS ${name}`);
}

const FREE: RosterPolicy = { freeOnly: false, paidOrchestrator: false, unattended: false };
const PAID: RosterPolicy = { freeOnly: false, paidOrchestrator: true, unattended: false };
const NIM_ULTRA = "nvidia-nim::nvidia/nemotron-3-ultra-550b-a55b";
const NIM_LIGHTNING = "nvidia-nim::nvidia/nemotron-3.5-lightning-30b-a3b";
const OR_LIGHTNING = "openrouter::nvidia/nemotron-3.5-lightning:free";

function stats(providerId: string, modelId: string, overrides: Partial<SpeedStats> = {}): SpeedStats {
    return { providerId, modelId, timedCalls: 10, medianFirstAnswerMs: 2000, p90FirstAnswerMs: 4000, medianDurationMs: 6000, medianTokensPerSecond: 60, succeeded: 10, failed: 0, lastSuccessAt: "2026-11-18T00:00:00.000Z", ...overrides };
}
function row(overrides: Partial<CatalogueRow> & Pick<CatalogueRow, "providerId" | "modelId">): CatalogueRow {
    return {
        origin: "discovered", label: overrides.modelId, shortName: overrides.modelId.slice(overrides.modelId.lastIndexOf("/") + 1),
        description: "Listed description.", developer: "Acme", free: true, metered: false, mayTrain: null, contextTokens: 128_000, maxOutputTokens: null, inputs: ["text", "image"],
        listedTools: true, listedStructured: null, listedThinking: null, probeStatus: "passed", probeAttempts: 0, probedAt: "2026-11-18T00:00:00.000Z", probeChatMs: 30_000,
        supportsTools: true, supportsSearch: true, supportsVision: false, supportsThinking: false, supportsStructured: null,
        firstSeenAt: "2026-11-18T00:00:00.000Z", lastSeenAt: "2026-11-18T00:00:00.000Z", missedChecks: 0, missingSince: null, notifiedMissingAt: null, approvedAt: null,
        ...overrides,
    };
}
function profile(providerId: string, modelId: string, overrides: Partial<ProfileRecord> = {}): ProfileRecord {
    return { providerId, modelId, tags: [], tagsSource: "seed", profile: null, approvedAt: null, draft: null, draftStatus: "none", draftError: null, draftedAt: null, lookupAttempts: 0, vaultPath: null, vaultSyncedAt: null, vaultError: null, removedAt: null, ...overrides };
}
function roster(policy: RosterPolicy, speed: SpeedStats[] = [], feedback: Map<string, ModelFeedback> = new Map(), rows: CatalogueRow[] = [], profiles: ProfileRecord[] = []) {
    setCatalogueSnapshotForTests(rows, "ok", profiles);
    return buildRoster({ providers: providers(), rows, profiles, speed: new Map(speed.map((entry) => [`${entry.providerId}::${entry.modelId}`, entry])), feedback, available: isProviderAvailable }, policy);
}
const entry = (list: ReturnType<typeof roster>, key: string) => list.find((item) => item.key === key)!;

check("speed tiers follow the first-answer thresholds and fall back to the latest test", () => {
    assert.equal(speedTier(5000), "fast"); assert.equal(speedTier(5001), "medium"); assert.equal(speedTier(20_000), "medium"); assert.equal(speedTier(20_001), "slow"); assert.equal(speedTier(null), "unknown");
    assert.deepEqual(modelSpeed(stats("p", "m", { timedCalls: 2 }), 12_000).source, "test");
    assert.equal(modelSpeed(stats("p", "m", { timedCalls: 2 }), 12_000).tier, "medium");
    assert.equal(modelSpeed(undefined, null).tier, "unknown");
    assert.equal(modelSpeed(stats("p", "m"), null).source, "calls");
    assert.equal(modelSpeed(stats("p", "m", { succeeded: 3, failed: 1 }), null).reliable, null, "under five calls says nothing about reliability");
    assert.equal(modelSpeed(stats("p", "m", { succeeded: 3, failed: 2 }), null).reliable, false);
    assert.equal(modelSpeed(stats("p", "m", { succeeded: 8, failed: 2 }), null).reliable, true);
});

check("feedback moves the score by at most two points and only after three ratings", () => {
    assert.equal(feedbackScore({ useful: 2, notUseful: 0 }), 0);
    assert.equal(feedbackScore({ useful: 3, notUseful: 0 }), 2);
    assert.equal(feedbackScore({ useful: 0, notUseful: 4 }), -2);
    assert.equal(feedbackScore({ useful: 2, notUseful: 2 }), 0);
});

check("tags fall back to the hand-written strengths and are gated by capabilities", () => {
    assert.deepEqual(tagsFromMeta(getModelMeta("nvidia/nemotron-3-ultra-550b-a55b"), { supportsTools: true, supportsVision: false }), ["coding", "reasoning", "long-context", "agentic"]);
    assert.deepEqual(tagsFromMeta(getModelMeta("google/gemma-4-31b-it"), { supportsTools: true, supportsVision: true }), ["coding", "vision", "multilingual", "agentic"]);
    assert.deepEqual(gateTags(["vision", "research", "general", "coding"], { supportsTools: false, supportsVision: false }), ["coding"]);
});

check("purpose picks are free, approved and never Gemini; paid models are hints only under a paid orchestrator", () => {
    const free = roster(FREE), paid = roster(PAID);
    assert.equal(entry(free, NIM_LIGHTNING).autoEligible, true);
    assert.equal(entry(free, "gemini-free::gemini-3.8-flash").autoEligible, false);
    assert.equal(entry(free, "gemini-free::gemini-3.8-flash").hintEligible, true, "free Gemini may be named");
    assert.equal(entry(free, "deepseek::deepseek-v4-pro").hintEligible, false);
    assert.match(entry(free, "deepseek::deepseek-v4-pro").reason!, /orchestrator is on a free model/);
    assert.equal(entry(paid, "deepseek::deepseek-v4-pro").hintEligible, true);
    assert.equal(entry(paid, "deepseek::deepseek-v4-pro").autoEligible, false);
    assert.equal(entry(paid, "openrouter::google/gemma-4-26b-a4b-it").autoEligible, false, "metered OpenRouter models stay out of purpose picks");
    assert.equal(entry(free, "opencode-zen::mimo-v2.6-flash-free").hintEligible, false, "unavailable providers are never usable");
});

check("Free only and scheduled runs narrow what may be named", () => {
    const freeOnly = roster({ freeOnly: true, paidOrchestrator: false, unattended: false });
    assert.equal(entry(freeOnly, "gemini::gemini-3.8-flash").hintEligible, false);
    assert.match(entry(freeOnly, "gemini::gemini-3.8-flash").reason!, /Free only/);
    const scheduled = roster({ freeOnly: false, paidOrchestrator: true, unattended: true });
    assert.deepEqual(scheduled.filter((item) => item.hintEligible).map((item) => item.providerId).sort(), ["gemini", "gemini"]);
    assert.equal(scheduled.filter((item) => item.autoEligible).length, 0);
    assert.equal(formatRosterSummary(scheduled, { freeOnly: false, paidOrchestrator: true, unattended: true }), null);
});

check("ranking prefers the tag, then speed, demotes unreliable models and keeps the preferred order on ties", () => {
    const tied = rankForPurpose(roster(FREE), "research", { tools: true, vision: false });
    assert.equal(tied[0].key, NIM_LIGHTNING, "with no data, WORKER_PREFERRED order breaks the tie");
    assert.ok(tied.length <= 6);
    const timed = roster(FREE, [stats("nvidia-nim", "nvidia/nemotron-3-ultra-550b-a55b", { medianFirstAnswerMs: 1500 }), stats("nvidia-nim", "nvidia/nemotron-3.5-lightning-30b-a3b", { medianFirstAnswerMs: 45_000 })]);
    const research = rankForPurpose(timed, "research", { tools: true, vision: false }, 50);
    assert.equal(research[0].key, NIM_ULTRA);
    assert.ok(research.findIndex((item) => item.key === NIM_LIGHTNING) > research.findIndex((item) => item.key === OR_LIGHTNING), "a slow route drops below the same model elsewhere");
    const unreliable = roster(FREE, [stats("nvidia-nim", "nvidia/nemotron-3.5-lightning-30b-a3b", { succeeded: 4, failed: 6 })]);
    assert.equal(scoreEntry(entry(unreliable, NIM_LIGHTNING), "coding"), 3 + 2 - 3);
    assert.equal(scoreEntry(entry(unreliable, NIM_LIGHTNING), "research"), 2 - 3, "derived tags never include research; only profile rows add it");
    const tagged = roster(FREE, [stats("nvidia-nim", "nvidia/nemotron-3-ultra-550b-a55b", { medianFirstAnswerMs: 1500 })], new Map(), [],
        [profile("openrouter", "nvidia/nemotron-3.5-lightning:free", { tags: ["research", "agentic"] })]);
    assert.equal(rankForPurpose(tagged, "research", { tools: true, vision: false })[0].key, OR_LIGHTNING, "a tag match outranks a faster untagged model");
    const vision = rankForPurpose(roster(FREE), "vision", { tools: true, vision: true });
    assert.ok(vision.length > 0 && vision.every((item) => item.caps.vision && item.tags.includes("vision")));
});

check("worker feedback for the purpose moves a model up", () => {
    const feedback = new Map<string, ModelFeedback>([[OR_LIGHTNING, { coding: { useful: 5, notUseful: 0 }, all: { useful: 5, notUseful: 0 } }]]);
    const coding = rankForPurpose(roster(FREE, [], feedback), "coding", { tools: true, vision: false });
    assert.equal(coding[0].key, OR_LIGHTNING);
});

check("missing, failing and unapproved catalogue models are kept out of purpose picks", () => {
    const rows = [
        row({ providerId: "kilo", modelId: "inclusionai/ling-3.0-flash-vl:free", origin: "seed", missingSince: "2026-11-18T00:00:00.000Z", approvedAt: "2026-11-18T00:00:00.000Z" }),
        row({ providerId: "nvidia-nim", modelId: "z-ai/glm-5.3-flash", origin: "seed", probeStatus: "failed", approvedAt: "2026-11-18T00:00:00.000Z" }),
        row({ providerId: "openrouter", modelId: "cohere/north-mini-code:free" }),
    ];
    const list = roster(FREE, [], new Map(), rows);
    const ling = entry(list, "kilo::inclusionai/ling-3.0-flash-vl:free");
    assert.equal(ling.hintEligible, false); assert.match(ling.reason!, /Missing/);
    assert.match(ling.measured.join(" "), /Missing from the provider's model list since 18\/11\/2026/);
    const glm = entry(list, "nvidia-nim::z-ai/glm-5.3-flash");
    assert.equal(glm.autoEligible, false); assert.equal(glm.hintEligible, true);
    const fresh = entry(list, "openrouter::cohere/north-mini-code:free");
    assert.equal(fresh.hintEligible, false); assert.match(fresh.reason!, /Not approved/);
    assert.equal(fresh.speed.source, "test"); assert.equal(fresh.speed.tier, "slow");
    assert.equal(fresh.view?.origin, "listing"); assert.equal(fresh.view?.description, "Listed description.");
    assert.match(fresh.measured.join(" "), /image test/);
    const approved = roster(FREE, [], new Map(), [row({ providerId: "openrouter", modelId: "cohere/north-mini-code:free", approvedAt: "2026-11-19T00:00:00.000Z" })]);
    assert.equal(entry(approved, "openrouter::cohere/north-mini-code:free").autoEligible, true);
});

check("a removed model is out of purpose picks, hints, list_models and the model_status problem lists", () => {
    const [providerId, modelId] = NIM_ULTRA.split("::");
    const list = roster(PAID, [stats(providerId, modelId, { medianFirstAnswerMs: 40_000 })], new Map(), [row({ providerId, modelId, origin: "seed" })],
        [profile(providerId, modelId, { removedAt: "2026-11-19T00:00:00.000Z" })]);
    const ultra = entry(list, NIM_ULTRA);
    assert.deepEqual([ultra.removed, ultra.hintEligible, ultra.autoEligible], [true, false, false]);
    assert.match(ultra.reason!, /Removed from the model list/);
    assert.ok(!formatRoster(list, PAID, null, { tools: false, vision: false }).includes(NIM_ULTRA));
    assert.ok(!formatModelStatus({ roster: list, runs: [], profiles: [], show: "all", purpose: null }).includes(NIM_ULTRA), "a removed slow model is not reported");
});

check("profile tags replace the derived ones, still gated, and an approved profile drives the view", () => {
    const profiles = [profile("nvidia-nim", "nvidia/nemotron-3-ultra-550b-a55b", { tags: ["vision", "writing"], tagsSource: "owner",
        profile: { description: "Approved text.", developer: "NVIDIA", params: null, strengths: ["Long reports"], weaknesses: ["Slow to start"], sources: [{ title: "Card", url: "https://example.com/card" }] },
        approvedAt: "2026-11-19T00:00:00.000Z" })];
    const ultra = entry(roster(FREE, [], new Map(), [], profiles), NIM_ULTRA);
    assert.deepEqual(ultra.tags, ["writing"]); assert.equal(ultra.tagsSource, "owner");
    assert.equal(ultra.view?.origin, "profile"); assert.deepEqual(ultra.view?.weaknesses, ["Slow to start"]);
    const draftOnly = entry(roster(FREE, [], new Map(), [], [profile("nvidia-nim", "nvidia/nemotron-3-ultra-550b-a55b", { tags: ["coding"], draftStatus: "ready" })]), NIM_ULTRA);
    assert.equal(draftOnly.view?.origin, "meta", "a draft never reaches the view before approval");
});

check("names resolve to a usable route, and keys are exact", () => {
    const list = roster(FREE);
    assert.equal(findEntry(list, NIM_ULTRA)?.key, NIM_ULTRA);
    const named = findEntry(list, "nemotron-3-ultra");
    assert.ok(named?.autoEligible && named.name === "nemotron-3-ultra");
    assert.equal(findEntry(list, "nvidia/nemotron-3-ultra-550b-a55b")?.key, NIM_ULTRA);
    assert.equal(findEntry(list, "no-such-model"), null);
});

check("the roster text names keys, the policy and the fallback, and lists hint-only models last", () => {
    const text = formatRoster(roster(PAID), PAID, "research", { tools: true, vision: false });
    assert.match(text, /^Models for research/);
    assert.match(text, /orchestrator is on a paid model/);
    assert.match(text, /nvidia-nim::nvidia\/nemotron-3\.5-lightning-30b-a3b/);
    assert.match(text, /Fallback: paid Gemini/);
    const ordered = listForRun(roster(PAID), "research", { tools: true, vision: false });
    const firstHintOnly = ordered.findIndex((item) => !item.autoEligible);
    assert.ok(firstHintOnly > 0 && ordered.slice(firstHintOnly).every((item) => !item.autoEligible));
    assert.doesNotMatch(formatRoster(roster({ freeOnly: true, paidOrchestrator: false, unattended: false }), { freeOnly: true, paidOrchestrator: false, unattended: false }, null, { tools: false, vision: false }), /Fallback: paid Gemini/);
    const summary = formatRosterSummary(roster(FREE), FREE)!;
    assert.match(summary, /^MODELS/); assert.match(summary, /- coding: /);
    assert.ok(summary.split("\n").length <= 9);
    assert.match(formatModelDetail(entry(roster(FREE), "deepseek::deepseek-v4-pro"), FREE), /Not usable on this run/);
});

check("the public provider list carries tags and speed for every chat model", () => {
    setStatsSnapshotForTests([stats("nvidia-nim", "nvidia/nemotron-3-ultra-550b-a55b", { medianFirstAnswerMs: 900 })]);
    const nim = listProvidersPublic().find((provider) => provider.id === "nvidia-nim")!;
    const ultra = nim.chatModels.find((model) => model.id === "nvidia/nemotron-3-ultra-550b-a55b")!;
    assert.deepEqual(ultra.tags, ["coding", "reasoning", "long-context", "agentic"]);
    assert.equal(ultra.speed.tier, "fast");
    assert.ok(nim.chatModels.every((model) => Array.isArray(model.tags) && model.speed));
});

console.log(`\nModel roster: ${checks} checks passed (speed tiers, feedback, tags, eligibility under each policy, removal, ranking, names, text formats, provider list). No live services were used.`);
