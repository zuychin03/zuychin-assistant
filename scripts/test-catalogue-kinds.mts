import assert from "node:assert/strict";
import fs from "node:fs";
import {
    familyFromId, parseGeminiModels, parseOpenAiModelList, parseOpenRouterModels, selectAllDiscoverable, selectDiscoverable, typesDiscoveryEnabled,
    type ListedModel, type ProviderDiscovery,
} from "../src/lib/ai/catalogue/sources";
import { catalogueRowFromDb, catalogueRowToDb, missingColumn, traitsFromDb } from "../src/lib/ai/catalogue/rows";
import { catalogueSnapshot, rowKind, setCatalogueSnapshotForTests, type CatalogueRow } from "../src/lib/ai/catalogue/snapshot";

const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(`fixtures/model-lists/${name}.json`, "utf8"));
const kindOf = (models: ListedModel[], id: string) => models.find((model) => model.modelId === id)?.kind;
const ids = (models: readonly { modelId: string }[]) => models.map((model) => model.modelId);
let checks = 0;
function check(name: string, run: () => void) {
    run();
    checks++;
    console.log(`PASS ${name}`);
}

const openrouter: ProviderDiscovery = {
    source: "openrouter", include: "free", pricing: "listed",
    kinds: { embedding: { include: "free" }, speech: { include: "all" }, transcription: { include: "all" } },
};

check("OpenRouter: output modalities give the kind; expiry, voices and family come from the list", () => {
    const models = parseOpenRouterModels(fixture("openrouter-types"));
    assert.equal(kindOf(models, "nvidia/nemotron-3.5-lightning:free"), "chat");
    assert.equal(kindOf(models, "nvidia/nemotron-3.5-embed-1b:free"), "embedding");
    assert.equal(kindOf(models, "heygen/heygen-voice-1-turbo:free"), "speech");
    assert.equal(kindOf(models, "openai/whisper-large-v3-turbo"), "transcription");
    assert.equal(kindOf(models, "cohere/rerank-5-fast"), null);
    assert.equal(kindOf(models, "microsoft/mai-image-2.7-flash"), null);
    const heygen = models.find((model) => model.modelId === "heygen/heygen-voice-1-turbo:free")!;
    assert.equal(heygen.expiresAt, "2026-11-30T00:00:00.000Z");
    assert.equal(heygen.free, true);
    assert.equal(heygen.voices.length, 10);
    assert.equal(heygen.chat, false);
    const embed = models.find((model) => model.modelId === "nvidia/nemotron-3.5-embed-1b:free")!;
    assert.equal(embed.familyId, familyFromId("nvidia/nemotron-3.5-embed-1b"));
    assert.equal(models.find((model) => model.modelId === "nvidia/nemotron-3-embed-1b:free")!.expiresAt, null, "the listing never flagged the retired model");
});

check("OpenRouter: each kind follows its own include rule, chat keeps the provider's", () => {
    const models = parseOpenRouterModels(fixture("openrouter-types"));
    assert.deepEqual(ids(selectDiscoverable(models, openrouter)), ["nvidia/nemotron-3.5-lightning:free"]);
    assert.deepEqual(ids(selectDiscoverable(models, openrouter, new Set(), "embedding")), ["nvidia/nemotron-3.5-embed-1b:free", "nvidia/nemotron-3-embed-1b:free"]);
    assert.deepEqual(ids(selectDiscoverable(models, openrouter, new Set(), "speech")).sort(), ["fish-audio/s2.1-pro-free:free", "google/gemini-3.8-flash-tts", "heygen/heygen-voice-1-turbo:free"]);
    assert.deepEqual(ids(selectDiscoverable(models, openrouter, new Set(), "transcription")), ["openai/whisper-large-v3-turbo"]);
    assert.equal(selectAllDiscoverable(models, openrouter).length, 7);
    assert.deepEqual(ids(selectAllDiscoverable(models, openrouter, new Set(), false)), ["nvidia/nemotron-3.5-lightning:free"]);
});

check("A kind left out of the discovery config is never tracked", () => {
    const models = parseOpenRouterModels(fixture("openrouter-types"));
    const chatOnly: ProviderDiscovery = { source: "openrouter", include: "free", pricing: "listed" };
    for (const kind of ["embedding", "speech", "transcription"] as const) assert.deepEqual(selectDiscoverable(models, chatOnly, new Set(), kind), []);
});

check("Gemini: embedContent, -tts and transcribe give the kind; live models are ignored", () => {
    const models = parseGeminiModels(fixture("gemini-types"), true);
    assert.equal(kindOf(models, "gemini-3.8-flash"), "chat");
    assert.equal(kindOf(models, "gemini-embedding-2"), "embedding");
    assert.equal(kindOf(models, "gemini-embedding-001"), "embedding");
    assert.equal(kindOf(models, "gemini-3.8-flash-tts"), "speech");
    assert.equal(kindOf(models, "gemini-3.8-flash-lite-tts"), "speech");
    assert.equal(kindOf(models, "gemini-3.5-transcribe"), "transcription");
    assert.equal(kindOf(models, "gemini-3.5-transcribe-live"), null);
    assert.equal(kindOf(models, "gemini-3.8-live"), null);
    assert.equal(kindOf(models, "gemini-2.5-flash-native-audio-latest"), null);
    assert.equal(models.find((model) => model.modelId === "gemini-embedding-2")!.maxOutputTokens, null, "the listed output limit of 1 is not kept");
});

check("NIM and Groq: ids give the kind", () => {
    const nim = parseOpenAiModelList(fixture("nvidia-nim-types"), true);
    assert.equal(kindOf(nim, "nvidia/nemotron-3-ultra-550b-a55b"), "chat");
    assert.equal(kindOf(nim, "nvidia/nemotron-3.5-embed-1b"), "embedding");
    assert.equal(kindOf(nim, "nvidia/embed-qa-4"), "embedding");
    assert.equal(kindOf(nim, "nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1"), "embedding");
    assert.equal(kindOf(nim, "nvidia/nvclip"), null);
    const groq = parseOpenAiModelList(fixture("groq"), true);
    assert.equal(kindOf(groq, "whisper-large-v3-turbo"), "transcription");
    assert.equal(kindOf(groq, "canopylabs/orpheus-v1-english"), "speech");
});

check("Chat selection is unchanged by the typed parse", () => {
    for (const [name, parse, discovery] of [
        ["nvidia-nim", (raw: unknown) => parseOpenAiModelList(raw, true), { source: "openai-list", include: "all", pricing: "all-free" }],
        ["groq", (raw: unknown) => parseOpenAiModelList(raw, true), { source: "openai-list", include: "all", pricing: "all-free" }],
        ["gemini", (raw: unknown) => parseGeminiModels(raw, false), { source: "gemini", include: "all", pricing: "all-paid" }],
        ["openrouter", parseOpenRouterModels, { source: "openrouter", include: "free", pricing: "listed" }],
    ] as const) {
        const models = parse(fixture(name));
        assert.deepEqual(ids(selectDiscoverable(models, discovery as ProviderDiscovery)), ids(models.filter((model) => model.chat && (discovery.include === "all" || model.free))), name);
    }
});

check("MODEL_TYPES_DISCOVERY=off turns the typed kinds off", () => {
    assert.equal(typesDiscoveryEnabled(undefined), true);
    assert.equal(typesDiscoveryEnabled(" OFF "), false);
});

const base = {
    provider_id: "nvidia-nim", model_id: "nvidia/nemotron-3.5-embed-1b", origin: "seed", label: "Nemotron 3.5 Embed 1B", short_name: "nemotron-3.5-embed-1b",
    free: true, metered: false, first_seen_at: "2026-11-24T00:00:00.000Z", inputs: ["Text"],
};

check("Rows: typed columns are read and sanitised; rows from before the migration are chat", () => {
    const typed = catalogueRowFromDb({
        ...base, kind: "embedding", dimension: 2048, expires_at: "2026-12-31T00:00:00Z", expires_source: "listing", notified_expiry_days: 30,
        space_of: "nvidia/nemotron-3.5-embed-1b", traits: { asymmetric: true, batch: "yes", voices: ["a", 3], accuracy: 0.9, evil: "x" },
    })!;
    assert.equal(typed.kind, "embedding");
    assert.equal(typed.dimension, 2048);
    assert.equal(typed.expiresSource, "listing");
    assert.equal(typed.notifiedExpiryDays, 30);
    assert.deepEqual(typed.traits, { voices: ["a"], accuracy: 0.9, asymmetric: true });
    const legacy = catalogueRowFromDb(base)!;
    assert.equal(legacy.kind, undefined);
    assert.equal(rowKind(legacy), "chat");
    assert.equal(catalogueRowFromDb({ ...base, kind: "rerank" })!.kind, "chat");
    assert.deepEqual(traitsFromDb("not an object"), {});
});

check("Rows: writes carry the typed columns only when the database has them", () => {
    const row = catalogueRowFromDb({ ...base, kind: "embedding", dimension: 2048, traits: {} })!;
    const typed = catalogueRowToDb(row, "2026-11-24T00:00:00.000Z");
    assert.equal(typed.kind, "embedding");
    assert.equal(typed.dimension, 2048);
    assert.deepEqual(typed.traits, {});
    const legacy = catalogueRowToDb(row, "2026-11-24T00:00:00.000Z", undefined, false);
    assert.equal("kind" in legacy, false);
    assert.equal("traits" in legacy, false);
    assert.equal(missingColumn({ code: "42703" }), true);
    assert.equal(missingColumn({ code: "PGRST204" }), true);
    assert.equal(missingColumn({ code: "42P01" }), false);
});

check("The snapshot keeps chat rows in rows and every other kind in typedRows", () => {
    const chat = catalogueRowFromDb({ ...base, model_id: "nvidia/nemotron-3-ultra-550b-a55b", short_name: "nemotron-3-ultra" })!;
    const embedding = catalogueRowFromDb({ ...base, kind: "embedding" })!;
    const speech = catalogueRowFromDb({ ...base, provider_id: "groq", model_id: "canopylabs/orpheus-v1-english", short_name: "orpheus", kind: "speech" })!;
    setCatalogueSnapshotForTests([chat, embedding, speech] as CatalogueRow[]);
    const snapshot = catalogueSnapshot();
    assert.deepEqual(ids(snapshot.rows), ["nvidia/nemotron-3-ultra-550b-a55b"]);
    assert.deepEqual(ids(snapshot.typedRows), ["nvidia/nemotron-3.5-embed-1b", "canopylabs/orpheus-v1-english"]);
});

console.log(`${checks} catalogue kind checks passed`);
