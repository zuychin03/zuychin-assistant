import assert from "node:assert/strict";
import { assessDataRoute } from "../src/lib/ai/data-policy";
import { freeChatCandidates, resolveFreeChat } from "../src/lib/ai/model-policy";
import {
    PROVIDERS,
    availableChatModels,
    getProvider,
    listProvidersPublic,
    providers,
    resolveChat,
    resolveChatModelByName,
    resolveMessagingDefault,
    resolveModelKey,
    resolveWorkerChain,
} from "../src/lib/ai/providers";
import { catalogueRowFromDb } from "../src/lib/ai/catalogue/rows";
import { setCatalogueSnapshotForTests, type CatalogueRow } from "../src/lib/ai/catalogue/snapshot";

const envKeys = PROVIDERS.map((provider) => provider.apiKeyEnv);
const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
let checks = 0;
function check(name: string, run: () => void) {
    setCatalogueSnapshotForTests([]);
    for (const provider of PROVIDERS) process.env[provider.apiKeyEnv] = "merge-test-key";
    run();
    checks++;
    console.log(`PASS ${name}`);
}

function row(overrides: Partial<CatalogueRow> & Pick<CatalogueRow, "providerId" | "modelId">): CatalogueRow {
    return {
        origin: "discovered", label: overrides.modelId, shortName: overrides.modelId.slice(overrides.modelId.lastIndexOf("/") + 1),
        description: null, developer: null, free: true, metered: false, mayTrain: null,
        contextTokens: null, maxOutputTokens: null, inputs: ["Text"],
        listedTools: true, listedStructured: null, listedThinking: null,
        probeStatus: "passed", probeAttempts: 1, probedAt: "2026-11-18T00:00:00.000Z", probeChatMs: 2000,
        supportsTools: true, supportsSearch: true, supportsVision: false, supportsThinking: false, supportsStructured: null,
        firstSeenAt: "2026-11-18T00:00:00.000Z", lastSeenAt: "2026-11-18T00:00:00.000Z", missedChecks: 0, missingSince: null, notifiedMissingAt: null,
        approvedAt: null,
        ...overrides,
    };
}
const NEW_ID = "acme/new-model";
const chatIds = (providerId: string) => getProvider(providerId)!.chatModels.map((model) => model.id);
const chainKeys = (needsTools: boolean) => resolveWorkerChain(needsTools).map((entry) => `${entry.provider.id}::${entry.model.id}`);

try {
    check("an empty catalogue changes nothing", () => {
        assert.equal(providers().length, PROVIDERS.length);
        providers().forEach((provider, index) => assert.equal(provider, PROVIDERS[index]));
        for (const provider of listProvidersPublic()) {
            for (const model of provider.chatModels) {
                assert.equal(model.origin, "code");
                assert.equal(model.approved, true);
                assert.equal(model.status, null);
            }
        }
    });

    check("database rows map to catalogue rows and bad rows are dropped", () => {
        const raw = {
            provider_id: "nvidia-nim", model_id: "z-ai/glm-5.3-flash", origin: "seed", label: "GLM-5.3 Flash (free)", short_name: "glm-5.3-flash",
            description: null, developer: "Z.ai", free: true, metered: false, may_train: null, context_tokens: null, max_output_tokens: 65536,
            inputs: ["Text", "Image"], listed_tools: null, listed_structured: null, listed_thinking: null,
            probe_status: "untested", probe_attempts: 0, probed_at: null, probe_chat_ms: null,
            supports_tools: true, supports_search: true, supports_vision: true, supports_thinking: true, supports_structured: null,
            first_seen_at: "2026-11-18T00:00:00+00:00", last_seen_at: null, missed_checks: 0, missing_since: null, approved_at: "2026-11-18T00:00:00+00:00",
        };
        const mapped = catalogueRowFromDb(raw)!;
        assert.equal(mapped.shortName, "glm-5.3-flash");
        assert.equal(mapped.maxOutputTokens, 65536);
        assert.equal(mapped.probeAttempts, 0);
        assert.deepEqual(mapped.inputs, ["Text", "Image"]);
        assert.equal(catalogueRowFromDb({ ...raw, model_id: "bad id" }), null);
        assert.equal(catalogueRowFromDb({ ...raw, origin: "other" }), null);
        assert.equal(catalogueRowFromDb({ ...raw, free: null }), null);
    });

    check("seed rows for code models keep code values and only fill gaps", () => {
        setCatalogueSnapshotForTests(PROVIDERS.flatMap((provider) => provider.chatModels.map((model) => row({
            providerId: provider.id, modelId: model.id, origin: "seed", shortName: model.name, approvedAt: "2026-11-18T00:00:00.000Z",
            maxOutputTokens: 4096, supportsTools: false, probeStatus: "untested",
        }))));
        for (const provider of PROVIDERS) {
            const merged = getProvider(provider.id)!;
            assert.deepEqual(merged.chatModels.map((model) => model.id), provider.chatModels.map((model) => model.id));
            merged.chatModels.forEach((model, index) => {
                const code = provider.chatModels[index];
                assert.equal(model.catalogue?.origin, "code");
                assert.equal(model.supportsTools, code.supportsTools);
                assert.equal(model.maxOutputTokens, code.maxOutputTokens ?? 4096);
            });
        }
    });

    check("a passed, unapproved model is in the picker but not in automatic routes", () => {
        setCatalogueSnapshotForTests([row({ providerId: "nvidia-nim", modelId: NEW_ID, shortName: "new-model" })]);
        assert.ok(chatIds("nvidia-nim").includes(NEW_ID));
        const published = listProvidersPublic().find((provider) => provider.id === "nvidia-nim")!.chatModels.find((model) => model.id === NEW_ID)!;
        assert.equal(published.status, "new");
        assert.equal(published.approved, false);
        assert.equal(published.origin, "discovered");
        assert.equal(resolveModelKey(`nvidia-nim::${NEW_ID}`)?.model.id, NEW_ID);
        assert.equal(resolveChatModelByName("new-model")?.model.id, NEW_ID);
        assert.ok(!freeChatCandidates().some((entry) => entry.model.id === NEW_ID));
        assert.ok(!chainKeys(true).includes(`nvidia-nim::${NEW_ID}`));
        const picked = resolveModelKey(`nvidia-nim::${NEW_ID}`)!;
        assert.equal(resolveFreeChat(picked), picked);
        const route = assessDataRoute({ providerId: "nvidia-nim", modelId: NEW_ID, purpose: "chat", classes: ["personal"], freeOnly: true });
        assert.equal(route.tier, "free");
        assert.equal(route.allowed, true);
    });

    check("approval adds a model to automatic routes; Fast needs a quick probe", () => {
        setCatalogueSnapshotForTests([row({ providerId: "nvidia-nim", modelId: NEW_ID, approvedAt: "2026-11-18T00:00:00.000Z", probeChatMs: 2000 })]);
        assert.ok(freeChatCandidates().some((entry) => entry.model.id === NEW_ID));
        assert.ok(chainKeys(true).includes(`nvidia-nim::${NEW_ID}`));
        assert.equal(getProvider("nvidia-nim")!.chatModels.find((model) => model.id === NEW_ID)!.catalogue?.status, null);
        setCatalogueSnapshotForTests([row({ providerId: "nvidia-nim", modelId: NEW_ID, approvedAt: "2026-11-18T00:00:00.000Z", probeChatMs: 30_000 })]);
        assert.ok(freeChatCandidates().some((entry) => entry.model.id === NEW_ID));
        assert.ok(!chainKeys(true).includes(`nvidia-nim::${NEW_ID}`));
    });

    check("untested, failed and untested paid rows stay out unless approved", () => {
        setCatalogueSnapshotForTests([
            row({ providerId: "nvidia-nim", modelId: "acme/untested", probeStatus: "untested", probedAt: null }),
            row({ providerId: "nvidia-nim", modelId: "acme/failed", probeStatus: "failed" }),
            row({ providerId: "nvidia-nim", modelId: "acme/failing", probeStatus: "failed", approvedAt: "2026-11-18T00:00:00.000Z" }),
            row({ providerId: "gemini", modelId: "gemini-4-argon", free: false, metered: true, probeStatus: "untested", probedAt: null }),
        ]);
        const nim = chatIds("nvidia-nim");
        assert.ok(!nim.includes("acme/untested"));
        assert.ok(!nim.includes("acme/failed"));
        assert.ok(nim.includes("acme/failing"));
        assert.equal(getProvider("nvidia-nim")!.chatModels.find((model) => model.id === "acme/failing")!.catalogue?.status, "failing");
        assert.ok(!chatIds("gemini").includes("gemini-4-argon"));
        const unknown = assessDataRoute({ providerId: "nvidia-nim", modelId: "acme/untested", purpose: "chat", classes: ["personal"] });
        assert.equal(unknown.tier, "unknown");
        assert.equal(unknown.allowed, false);
    });

    check("a missing model stays selectable and is marked", () => {
        setCatalogueSnapshotForTests([
            row({ providerId: "nvidia-nim", modelId: "poolside/laguna-xs-2.1", origin: "seed", approvedAt: "2026-11-18T00:00:00.000Z", missingSince: "2026-11-18T00:00:00.000Z", missedChecks: 2 }),
            row({ providerId: "kilo", modelId: "acme/gone", approvedAt: "2026-11-18T00:00:00.000Z", missingSince: "2026-11-18T00:00:00.000Z", missedChecks: 2 }),
        ]);
        assert.equal(getProvider("nvidia-nim")!.chatModels.find((model) => model.id === "poolside/laguna-xs-2.1")!.catalogue?.status, "missing");
        assert.equal(resolveModelKey("nvidia-nim::poolside/laguna-xs-2.1")?.model.id, "poolside/laguna-xs-2.1");
        assert.equal(resolveModelKey("kilo::acme/gone")?.model.catalogue?.status, "missing");
    });

    check("retired alias ids never become models of their own", () => {
        setCatalogueSnapshotForTests([
            row({ providerId: "nvidia-nim", modelId: "z-ai/glm-5.2", approvedAt: "2026-11-18T00:00:00.000Z" }),
            row({ providerId: "nvidia-nim", modelId: "moonshotai/kimi-k3", origin: "seed", approvedAt: "2026-11-18T00:00:00.000Z" }),
        ]);
        assert.ok(!chatIds("nvidia-nim").includes("z-ai/glm-5.2"));
        assert.ok(!chatIds("nvidia-nim").includes("moonshotai/kimi-k3"));
        assert.equal(resolveChat("nvidia-nim", "z-ai/glm-5.2").model.id, "nvidia/nemotron-3-ultra-550b-a55b");
        assert.equal(resolveModelKey("nvidia-nim::moonshotai/kimi-k3")?.model.id, "nvidia/nemotron-3-ultra-550b-a55b");
    });

    check("short names stay unique within a provider", () => {
        setCatalogueSnapshotForTests([row({ providerId: "nvidia-nim", modelId: "google/gemma-4-new", shortName: "gemma-4" })]);
        const added = getProvider("nvidia-nim")!.chatModels.find((model) => model.id === "google/gemma-4-new")!;
        assert.equal(added.name, "gemma-4-2");
        assert.equal(resolveChatModelByName("gemma-4-2")?.model.id, "google/gemma-4-new");
    });

    check("messaging falls back to an approved free model before the paid default", () => {
        for (const key of envKeys) delete process.env[key];
        process.env.OPENROUTER_API_KEY = "merge-test-key";
        assert.equal(resolveMessagingDefault().provider.id, "gemini");
        setCatalogueSnapshotForTests([row({ providerId: "openrouter", modelId: "acme/free-tools:free", approvedAt: "2026-11-18T00:00:00.000Z" })]);
        const fallback = resolveMessagingDefault();
        assert.equal(fallback.provider.id, "openrouter");
        assert.equal(fallback.model.id, "acme/free-tools:free");
        setCatalogueSnapshotForTests([row({ providerId: "openrouter", modelId: "acme/free-tools:free" })]);
        assert.equal(resolveMessagingDefault().provider.id, "gemini");
    });

    check("/model lists picker models only and marks new and missing ones", () => {
        setCatalogueSnapshotForTests([
            row({ providerId: "openrouter", modelId: "acme/passed:free" }),
            row({ providerId: "openrouter", modelId: "acme/untested:free", probeStatus: "untested", probedAt: null }),
            row({ providerId: "openrouter", modelId: "acme/failed:free", probeStatus: "failed" }),
            row({ providerId: "openrouter", modelId: "acme/gone:free", approvedAt: "2026-11-18T00:00:00.000Z", missingSince: "2026-11-18T00:00:00.000Z", missedChecks: 2 }),
            row({ providerId: "openrouter", modelId: "acme/approved:free", approvedAt: "2026-11-18T00:00:00.000Z" }),
        ]);
        const listed = new Map(availableChatModels().find((entry) => entry.providerId === "openrouter")!.models.map((model) => [model.label, model]));
        assert.equal(listed.get("acme/passed:free")?.status, "new");
        assert.equal(listed.get("acme/gone:free")?.status, "missing");
        assert.ok(listed.has("acme/approved:free"));
        assert.equal(listed.get("acme/approved:free")?.status, undefined);
        assert.ok(!listed.has("acme/untested:free"));
        assert.ok(!listed.has("acme/failed:free"));
        const code = PROVIDERS.find((provider) => provider.id === "openrouter")!.chatModels[0];
        assert.equal(listed.get(code.label)?.status, undefined);
    });
} finally {
    setCatalogueSnapshotForTests([]);
    for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

console.log(`${checks} catalogue merge checks passed`);
