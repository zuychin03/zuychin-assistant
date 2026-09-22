import assert from "node:assert/strict";
import { MODEL_META } from "../src/lib/ai/model-meta";
import {
    PROVIDERS,
    DEFAULT_CHAT,
    DEFAULT_EMBEDDING,
    WORKER_GEMINI_FALLBACK,
    availableChatModels,
    availableEmbeddingModels,
    getProvider,
    isProviderAvailable,
    listProvidersPublic,
    modelMaxOutputTokens,
    resolveChat,
    resolveChatByName,
    resolveChatModelByName,
    resolveEmbedding,
    resolveEmbeddingByName,
    resolveEmbeddingKey,
    resolveMessagingDefault,
    resolveMessagingEmbedding,
    resolveModelKey,
    resolveWorkerChain,
} from "../src/lib/ai/providers";

const envKeys = [...PROVIDERS.map((p) => p.apiKeyEnv), "KNOWLEDGE_EMBEDDING_MODEL"];
const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
let checks = 0;
function check(name: string, run: () => void) {
    run();
    checks++;
    console.log(`PASS ${name}`);
}

try {
    for (const provider of PROVIDERS) process.env[provider.apiKeyEnv] = "registry-test-key";
    delete process.env.KNOWLEDGE_EMBEDDING_MODEL;

    check("saved NIM IDs and names migrate within their provider", () => {
        const aliases = [
            ["minimaxai/minimax-m3", "moonshotai/kimi-k3"],
            ["minimax-m3", "moonshotai/kimi-k3"],
            ["deepseek-ai/deepseek-v4-pro", "z-ai/glm-5.3"],
            ["deepseek-v4-pro", "z-ai/glm-5.3"],
            ["deepseek-ai/deepseek-v4-flash", "deepseek-ai/deepseek-v4.1-flash"],
            ["step-3.7-flash", "z-ai/glm-5.3-flash"],
            ["z-ai/glm-5.2", "z-ai/glm-5.3"],
            ["openai/gpt-oss-120b", "nvidia/nemotron-3-ultra-550b-a55b"],
        ];
        for (const [oldId, newId] of aliases) {
            assert.equal(resolveChat("nvidia-nim", oldId).model.id, newId);
            assert.equal(resolveModelKey(`nvidia-nim::${oldId}`)?.model.id, newId);
            assert.equal(resolveChatByName("NVIDIA NIM", oldId)?.model.id, newId);
        }
    });

    check("Gemini aliases retain the selected account", () => {
        for (const provider of ["gemini", "gemini-free"]) {
            const resolved = resolveChat(provider, "gemini-3.7-flash");
            assert.equal(resolved.provider.id, provider);
            assert.equal(resolved.model.id, "gemini-3.8-flash");
        }
        assert.equal(resolveChatByName("gemini-free", "gemini-3.7-flash-free")?.provider.id, "gemini-free");
        assert.equal(resolveChat("gemini", "gemini-3-flash-preview").model.id, "gemini-3.5-flash-lite");
    });

    check("aliases do not cross provider or billing boundaries", () => {
        assert.equal(resolveChat("deepseek", "deepseek-v4-pro").model.id, "deepseek-v4-pro");
        assert.equal(resolveChat("deepseek", "deepseek-v4-flash-api").model.id, "deepseek-flash");
        assert.equal(resolveChatByName("openrouter", "minimax-m3"), null);
        assert.equal(resolveModelKey("deepseek::deepseek-ai/deepseek-v4-flash"), null);
        assert.throws(() => resolveChat("openrouter", "minimax-m3"), /Unknown model/);
        assert.equal(resolveChatModelByName("deepseek-v4-flash"), null);
        assert.equal(resolveChatModelByName("gemini-3.7-flash"), null);
        assert.equal(resolveChatModelByName("deepseek-ai/deepseek-v4-flash")?.provider.id, "nvidia-nim");
    });

    check("disabled providers remain unavailable with configured keys", () => {
        for (const id of ["opencode-zen", "tokenrouter"]) {
            const provider = getProvider(id)!;
            assert.equal(isProviderAvailable(provider), false);
            assert.throws(() => resolveChat(id), /unavailable:/);
            assert.equal(resolveChatByName(id, provider.chatModels[0].id), null);
            assert.equal(resolveModelKey(`${id}::${provider.chatModels[0].id}`), null);
            assert.ok(!availableChatModels().some((p) => p.providerId === id));
            const publicProvider = listProvidersPublic().find((p) => p.id === id)!;
            assert.equal(publicProvider.available, false);
            assert.ok(publicProvider.unavailableReason);
        }
    });

    check("explicit unknown providers and missing keys cannot silently fall back", () => {
        assert.throws(() => resolveChat("unknown-provider"), /Unknown chat provider/);
        delete process.env.DEEPSEEK_API_KEY;
        assert.throws(() => resolveChat("deepseek", "deepseek-v4-pro"), /no API key/);
        assert.equal(resolveModelKey("deepseek::deepseek-v4-pro"), null);
        process.env.DEEPSEEK_API_KEY = "registry-test-key";
    });

    check("workers use available free tool endpoints in priority order", () => {
        const workers = resolveWorkerChain(true);
        assert.equal(workers[0].model.id, "z-ai/glm-5.3-flash");
        assert.equal(workers[1].model.id, "deepseek-ai/deepseek-v4.1-flash");
        assert.equal(workers[1].model.supportsSearch, false);
        const keys = workers.map((w) => `${w.provider.id}::${w.model.id}`);
        assert.equal(new Set(keys).size, keys.length);
        for (const worker of workers) {
            assert.ok(isProviderAvailable(worker.provider));
            assert.equal(worker.provider.kind, "openai-compatible");
            assert.ok(!worker.provider.metered && !worker.model.metered);
            assert.ok(worker.model.supportsTools);
        }
        assert.equal(resolveWorkerChain(false)[0].model.id, "google/diffusiongemma-26b-a4b-it");
        const preferred = getProvider("nvidia-nim")!.chatModels.find((m) => m.id === "z-ai/glm-5.3-flash")!;
        preferred.supportsTools = false;
        try {
            assert.ok(!resolveWorkerChain(true).some((w) => w.model === preferred));
        } finally {
            preferred.supportsTools = true;
        }
    });

    check("a Fast tag cannot recruit a paid OpenRouter model", () => {
        const meta = MODEL_META["google/gemma-4-26b-a4b-it"];
        const strengths = meta.strengths;
        meta.strengths = [...strengths, "Fast"];
        try {
            assert.ok(!resolveWorkerChain(true).some((w) => w.model.id === "google/gemma-4-26b-a4b-it"));
        } finally {
            meta.strengths = strengths;
        }
    });

    check("default chains use current endpoints and respect missing keys", () => {
        assert.equal(resolveChat().model.id, DEFAULT_CHAT.modelId);
        assert.equal(resolveMessagingDefault().provider.id, "nvidia-nim");
        assert.equal(resolveMessagingEmbedding().model.id, DEFAULT_EMBEDDING.modelId);
        delete process.env.NVIDIA_NIM_API_KEY;
        assert.equal(resolveMessagingDefault().model.id, "gemini-3.8-flash");
        assert.equal(resolveMessagingEmbedding().model.id, "gemini-embedding-2");
        assert.ok(resolveWorkerChain(true).every((w) => w.provider.id === "openrouter"));
        process.env.NVIDIA_NIM_API_KEY = "registry-test-key";
        assert.equal(WORKER_GEMINI_FALLBACK.complex, "gemini-3.8-flash");
    });

    check("embedding selection never aliases an obsolete vector space", () => {
        assert.equal(resolveEmbedding().model.id, "nvidia/nemotron-3-embed-1b");
        assert.equal(resolveEmbedding().model.dimension, 2048);
        assert.equal(resolveEmbedding("gemini-embedding-2").model.dimension, 768);
        for (const id of ["nvidia/llama-nemotron-embed-1b-v2", "nvidia/llama-embed-nemotron-8b", "gemini-embedding-2-preview", "unknown", ""]) {
            assert.throws(() => resolveEmbedding(id), /Unknown embedding model/);
            assert.equal(resolveEmbeddingKey(`nvidia-nim::${id}`), null);
        }
        process.env.KNOWLEDGE_EMBEDDING_MODEL = "nvidia/llama-nemotron-embed-1b-v2";
        assert.throws(() => resolveEmbedding(), /re-embed/);
        delete process.env.KNOWLEDGE_EMBEDDING_MODEL;
        assert.equal(resolveEmbeddingByName("nvidia-nim", "llama-nemotron-embed-1b-v2"), null);
        assert.equal(resolveEmbeddingKey("gemini::nvidia/nemotron-3-embed-1b"), null);
        assert.equal(availableEmbeddingModels().flatMap((p) => p.models).length, 2);
    });

    check("blank optional embedding configuration defaults without relaxing explicit IDs", () => {
        for (const configured of ["", "  ", "\t\n"]) {
            process.env.KNOWLEDGE_EMBEDDING_MODEL = configured;
            assert.equal(resolveEmbedding().model.id, DEFAULT_EMBEDDING.modelId);
            assert.throws(() => resolveEmbedding(configured), /Unknown embedding model/);
        }
        process.env.KNOWLEDGE_EMBEDDING_MODEL = "  gemini-embedding-2  ";
        assert.equal(resolveEmbedding().model.id, "gemini-embedding-2");
        assert.throws(() => resolveEmbedding("  gemini-embedding-2  "), /Unknown embedding model/);
        delete process.env.KNOWLEDGE_EMBEDDING_MODEL;
    });

    check("new NIM endpoints use conservative unverified output and schema limits", () => {
        for (const id of ["moonshotai/kimi-k3", "z-ai/glm-5.3", "z-ai/glm-5.3-flash", "deepseek-ai/deepseek-v4.1-flash", "nvidia/nemotron-3.5-lightning-30b-a3b"]) {
            assert.equal(modelMaxOutputTokens(id), 8192);
            assert.ok(!resolveChat("nvidia-nim", id).model.supportsStructuredOutput);
        }
    });

    check("public aliases support saved selection migration without exposing keys", () => {
        const providers = listProvidersPublic();
        assert.equal(providers.find((p) => p.id === "nvidia-nim")!.chatModelAliases["deepseek-v4-pro"], "z-ai/glm-5.3");
        assert.equal(providers.find((p) => p.id === "deepseek")!.chatModelAliases["deepseek-v4-pro"], undefined);
        assert.ok(!JSON.stringify(providers).includes("registry-test-key"));
    });

    check("all registered models have metadata and unique provider-local IDs", () => {
        for (const provider of PROVIDERS) {
            const models = [...provider.chatModels, ...provider.embeddingModels];
            assert.equal(new Set(models.map((m) => m.id)).size, models.length);
            for (const model of models) assert.ok(MODEL_META[model.id], `Missing metadata: ${model.id}`);
        }
    });
} finally {
    for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

console.log(`${checks} provider registry checks passed.`);
