import { getModelMeta } from "@/lib/ai/model-meta";

export type ProviderKind = "gemini" | "openai-compatible";

export interface ChatModel {
    id: string;
    label: string;
    name: string;
    supportsTools: boolean;
    supportsVision: boolean;
    supportsThinking: boolean;
    supportsSearch: boolean;
    /**
     * Verified output-token ceiling, measured 2026-07-31 against each platform:
     * Gemini via models.get outputTokenLimit, OpenRouter via
     * top_provider.max_completion_tokens, and NVIDIA NIM / OpenCode Zen by
     * probing chat/completions (their /models endpoints omit limits).
     * Omitted where the platform publishes nothing and no key was available.
     */
    maxOutputTokens?: number;
}

// Used for the slider bound when a model's ceiling was never verified. Matches
// the value the NIM path already backfills, so it is not a regression.
export const UNVERIFIED_MAX_OUTPUT_TOKENS = 8192;

// The widest verified ceiling across every provider; the request-level guard.
export const MAX_OUTPUT_TOKENS_CEILING = 131072;

export interface EmbeddingModel {
    id: string;
    label: string;
    name: string;
    dimension: number;
}

export interface ProviderConfig {
    id: string;
    label: string;
    kind: ProviderKind;
    baseUrl?: string;
    apiKeyEnv: string;
    extraHeaders?: Record<string, string>;
    chatModels: ChatModel[];
    embeddingModels: EmbeddingModel[];
}

export const PROVIDERS: ProviderConfig[] = [
    {
        id: "gemini",
        label: "Google Gemini",
        kind: "gemini",
        apiKeyEnv: "GEMINI_API_KEY",
        chatModels: [
            { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", name: "gemini-3.6-flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, maxOutputTokens: 65536 },
            { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", name: "gemini-3.5-flash-lite", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, maxOutputTokens: 65536 },
        ],
        embeddingModels: [
            { id: "gemini-embedding-2-preview", label: "Gemini Embedding 2 (768d)", name: "gemini-embedding-2", dimension: 768 },
        ],
    },
    {
        id: "openrouter",
        label: "OpenRouter",
        kind: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
        extraHeaders: {
            "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://zuychin.app",
            "X-Title": process.env.OPENROUTER_APP_NAME || "Zuychin Assistant",
        },
        chatModels: [
            { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra (free)", name: "nemotron-3-ultra", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, maxOutputTokens: 65536 },
            { id: "poolside/laguna-s-2.1:free", label: "Laguna S 2.1 (free)", name: "laguna-s-2.1", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, maxOutputTokens: 32768 },
            { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B IT (free)", name: "gemma-4", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, maxOutputTokens: 32768 },
            { id: "google/gemma-4-26b-a4b-it", label: "Gemma 4 26B A4B", name: "gemma-4-26b", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, maxOutputTokens: 16384 },
        ],
        embeddingModels: [],
    },
    {
        id: "nvidia-nim",
        label: "NVIDIA NIM",
        kind: "openai-compatible",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyEnv: "NVIDIA_NIM_API_KEY",
        chatModels: [
            { id: "minimaxai/minimax-m3", label: "MiniMax M3 (free)", name: "minimax-m3", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, maxOutputTokens: 131072 },
            { id: "deepseek-ai/deepseek-v4-pro", label: "DeepSeek V4 Pro (free)", name: "deepseek-v4-pro", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, maxOutputTokens: 131072 },
            { id: "deepseek-ai/deepseek-v4-flash", label: "DeepSeek V4 Flash (free)", name: "deepseek-v4-flash", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, maxOutputTokens: 65536 },
            { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra (free)", name: "nemotron-3-ultra", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, maxOutputTokens: 131072 },
            { id: "google/gemma-4-31b-it", label: "Gemma 4 31B IT (free)", name: "gemma-4", supportsTools: true, supportsVision: true, supportsThinking: false, supportsSearch: true, maxOutputTokens: 131072 },
            { id: "google/diffusiongemma-26b-a4b-it", label: "DiffusionGemma 26B (free)", name: "diffusiongemma", supportsTools: false, supportsVision: true, supportsThinking: false, supportsSearch: false, maxOutputTokens: 131072 },
            { id: "stepfun-ai/step-3.7-flash", label: "Step 3.7 Flash (free)", name: "step-3.7-flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, maxOutputTokens: 131072 },
            { id: "z-ai/glm-5.2", label: "GLM-5.2 (free)", name: "glm-5.2", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, maxOutputTokens: 65536 }
        ],
        embeddingModels: [
            { id: "nvidia/llama-nemotron-embed-1b-v2", label: "Llama Nemotron Embed 1B v2 (free, 2048d)", name: "nemotron-embed-1b", dimension: 2048 },
            { id: "nvidia/llama-embed-nemotron-8b", label: "Llama Embed Nemotron 8B (free, 4096d)", name: "llama-embed-8b", dimension: 4096 },
        ],
    },
    {
        id: "opencode-zen",
        label: "OpenCode Zen",
        kind: "openai-compatible",
        baseUrl: "https://opencode.ai/zen/v1",
        apiKeyEnv: "OPENCODE_ZEN_API_KEY",
        chatModels: [
            { id: "mimo-v2.5-free", label: "MiMo V2.5 (free)", name: "mimo-v2.5", supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: true, maxOutputTokens: 131072 },
            { id: "deepseek-v4-flash-free", label: "DeepSeek V4 Flash (free)", name: "deepseek-v4-flash", supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: true, maxOutputTokens: 131072 },
            { id: "laguna-s-2.1-free", label: "Laguna S 2.1 (free)", name: "laguna-s-2.1", supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: true, maxOutputTokens: 131072 },
            { id: "ling-3.0-flash-free", label: "Ling 3.0 Flash (free)", name: "ling-3.0-flash", supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: true, maxOutputTokens: 131072 },
        ],
        embeddingModels: [],
    },
    {
        id: "tokenrouter",
        label: "TokenRouter",
        kind: "openai-compatible",
        baseUrl: "https://api.tokenrouter.com/v1",
        apiKeyEnv: "TOKENROUTER_API_KEY",
        chatModels: [
            { id: "moonshotai/kimi-k3-free", label: "Kimi K3 (free)", name: "kimi-k3", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
        ],
        embeddingModels: [],
    },
];

export interface GenParams {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
}

export function sanitizeGenParams(raw: unknown): GenParams {
    const out: GenParams = {};
    if (raw && typeof raw === "object") {
        const r = raw as Record<string, unknown>;
        if (typeof r.temperature === "number" && isFinite(r.temperature)) {
            out.temperature = Math.min(2, Math.max(0, r.temperature));
        }
        if (typeof r.topP === "number" && isFinite(r.topP)) {
            out.topP = Math.min(1, Math.max(0, r.topP));
        }
        if (typeof r.maxTokens === "number" && isFinite(r.maxTokens)) {
            out.maxTokens = Math.min(MAX_OUTPUT_TOKENS_CEILING, Math.max(1, Math.round(r.maxTokens)));
        }
    }
    return out;
}

/** Verified output ceiling for a chat model id, or the conservative fallback. */
export function modelMaxOutputTokens(modelId: string): number {
    for (const provider of PROVIDERS) {
        const model = provider.chatModels.find((m) => m.id === modelId);
        if (model) return model.maxOutputTokens ?? UNVERIFIED_MAX_OUTPUT_TOKENS;
    }
    return UNVERIFIED_MAX_OUTPUT_TOKENS;
}

/**
 * Never send a model more than it accepts. sanitizeGenParams cannot do this
 * because it runs before the model is resolved, and going over the ceiling makes
 * the provider reject the whole request rather than quietly clamping.
 */
export function cappedMaxTokens(requested: number, modelId: string): number {
    return Math.min(requested, modelMaxOutputTokens(modelId));
}

export const DEFAULT_CHAT = { providerId: "gemini", modelId: "gemini-3.5-flash-lite" };

const LEGACY_GEMINI_MODEL_IDS: Record<string, string> = {
    "gemini-3-flash-preview": "gemini-3.5-flash-lite",
    "gemini-3.5-flash": "gemini-3.6-flash",
};

function canonicalChatModelId(providerId: string, modelId?: string): string | undefined {
    if (providerId !== "gemini" || !modelId) return modelId;
    return LEGACY_GEMINI_MODEL_IDS[modelId] ?? modelId;
}
// Owns the knowledge store's single embedding partition. Swapping it (here or
// via the KNOWLEDGE_EMBEDDING_MODEL env override) requires re-embedding the
// store: npx tsx --env-file=<env> scripts/reembed-knowledge.ts
export const DEFAULT_EMBEDDING = { providerId: "nvidia-nim", modelId: "nvidia/llama-nemotron-embed-1b-v2" };

export function getProvider(id: string): ProviderConfig | undefined {
    return PROVIDERS.find((p) => p.id === id);
}

export function getProviderApiKey(p: ProviderConfig): string | undefined {
    return process.env[p.apiKeyEnv];
}

export function isProviderAvailable(p: ProviderConfig): boolean {
    return !!getProviderApiKey(p);
}

export interface ResolvedChat {
    provider: ProviderConfig;
    model: ChatModel;
}

export function resolveChat(providerId?: string, modelId?: string): ResolvedChat {
    let provider = (providerId && getProvider(providerId)) || getProvider(DEFAULT_CHAT.providerId)!;
    if (!provider.chatModels.length) provider = getProvider(DEFAULT_CHAT.providerId)!;
    const requestedModelId = modelId
        ?? (provider.id === DEFAULT_CHAT.providerId ? DEFAULT_CHAT.modelId : undefined);
    const canonicalModelId = canonicalChatModelId(provider.id, requestedModelId);
    const model = provider.chatModels.find((m) => m.id === canonicalModelId) ?? provider.chatModels[0]!;
    return { provider, model };
}

function resolveAvailable(providerId: string, modelId: string): ResolvedChat | null {
    const provider = getProvider(providerId);
    if (!provider || !isProviderAvailable(provider)) return null;
    const canonicalModelId = canonicalChatModelId(provider.id, modelId);
    const model = provider.chatModels.find((m) => m.id === canonicalModelId);
    return model ? { provider, model } : null;
}

export const MESSAGING_MODEL_CHAIN: { providerId: string; modelId: string }[] = [
    { providerId: "nvidia-nim", modelId: "deepseek-ai/deepseek-v4-flash" },
    { providerId: "nvidia-nim", modelId: "google/gemma-4-31b-it" },
    { providerId: "gemini", modelId: "gemini-3.6-flash" },
];

// Sub-agent pool: preferred models first, then any free "Fast"-tagged model
// that supports tools. Gemini is excluded; runWorker uses it only as the
// last-resort fallback.
const WORKER_PREFERRED: { providerId: string; modelId: string }[] = [
    { providerId: "opencode-zen", modelId: "deepseek-v4-flash-free" },
    { providerId: "nvidia-nim", modelId: "stepfun-ai/step-3.7-flash" },
];

// Tried first for no-tool subtasks; cannot call functions.
export const WORKER_NO_TOOLS_MODEL = { providerId: "nvidia-nim", modelId: "google/diffusiongemma-26b-a4b-it" };

// Paid Gemini fallback when every free candidate errored or returned nothing,
// sized to the subtask's declared complexity.
export const WORKER_GEMINI_FALLBACK = {
    simple: "gemini-3.5-flash-lite",
    complex: "gemini-3.6-flash",
} as const;

export function resolveWorkerChain(needsTools: boolean): ResolvedChat[] {
    const out: ResolvedChat[] = [];
    const seen = new Set<string>();
    const push = (r: ResolvedChat | null) => {
        if (!r) return;
        const key = `${r.provider.id}::${r.model.id}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(r);
        }
    };

    if (!needsTools) {
        push(resolveAvailable(WORKER_NO_TOOLS_MODEL.providerId, WORKER_NO_TOOLS_MODEL.modelId));
    }
    for (const c of WORKER_PREFERRED) push(resolveAvailable(c.providerId, c.modelId));
    for (const provider of PROVIDERS) {
        if (provider.kind === "gemini" || !isProviderAvailable(provider)) continue;
        for (const model of provider.chatModels) {
            if (model.supportsTools && getModelMeta(model.id)?.strengths.includes("Fast")) {
                push({ provider, model });
            }
        }
    }
    return out;
}

export function resolveMessagingDefault(): ResolvedChat {
    for (const c of MESSAGING_MODEL_CHAIN) {
        const resolved = resolveAvailable(c.providerId, c.modelId);
        if (resolved) return resolved;
    }
    return resolveChat();
}

export function resolveModelKey(key?: string | null): ResolvedChat | null {
    if (!key || !key.includes("::")) return null;
    const idx = key.indexOf("::");
    return resolveAvailable(key.slice(0, idx), key.slice(idx + 2));
}

function findAvailableProvider(arg: string): ProviderConfig | undefined {
    const a = arg.trim().toLowerCase();
    const provider = PROVIDERS.find((p) => p.id.toLowerCase() === a || p.label.toLowerCase() === a);
    return provider && isProviderAvailable(provider) ? provider : undefined;
}

export function resolveChatByName(providerArg: string, modelArg: string): ResolvedChat | null {
    const provider = findAvailableProvider(providerArg);
    if (!provider) return null;
    const m = canonicalChatModelId(provider.id, modelArg.trim().toLowerCase()) ?? "";
    const model = provider.chatModels.find(
        (mod) => mod.name.toLowerCase() === m || mod.id.toLowerCase() === m
    );
    return model ? { provider, model } : null;
}

export function resolveChatModelByName(name: string): ResolvedChat | null {
    const n = name.trim().toLowerCase();
    for (const provider of PROVIDERS) {
        if (!isProviderAvailable(provider)) continue;
        const canonicalName = canonicalChatModelId(provider.id, n);
        const model = provider.chatModels.find(
            (m) => m.name.toLowerCase() === canonicalName || m.id.toLowerCase() === canonicalName,
        );
        if (model) return { provider, model };
    }
    return null;
}

export function availableChatModels(): { provider: string; providerId: string; models: { name: string; label: string }[] }[] {
    return PROVIDERS
        .filter((p) => isProviderAvailable(p) && p.chatModels.length > 0)
        .map((p) => ({
            provider: p.label,
            providerId: p.id,
            models: p.chatModels.map((m) => ({ name: m.name, label: m.label })),
        }));
}

export interface ResolvedEmbedding {
    provider: ProviderConfig;
    model: EmbeddingModel;
}

export function resolveEmbedding(modelId?: string): ResolvedEmbedding {
    const wanted = modelId ?? process.env.KNOWLEDGE_EMBEDDING_MODEL;
    for (const provider of PROVIDERS) {
        const model = provider.embeddingModels.find((m) => m.id === wanted);
        if (model) return { provider, model };
    }
    const g = getProvider(DEFAULT_EMBEDDING.providerId)!;
    const model = g.embeddingModels.find((m) => m.id === DEFAULT_EMBEDDING.modelId) ?? g.embeddingModels[0]!;
    return { provider: g, model };
}

export const MESSAGING_EMBEDDING_CHAIN: { providerId: string; modelId: string }[] = [
    { providerId: "nvidia-nim", modelId: "nvidia/llama-nemotron-embed-1b-v2" },
    { providerId: "gemini", modelId: "gemini-embedding-2-preview" },
];

export function resolveEmbeddingByName(providerArg: string, modelArg: string): ResolvedEmbedding | null {
    const provider = findAvailableProvider(providerArg);
    if (!provider) return null;
    const m = modelArg.trim().toLowerCase();
    const model = provider.embeddingModels.find(
        (mod) => mod.name.toLowerCase() === m || mod.id.toLowerCase() === m
    );
    return model ? { provider, model } : null;
}

export function availableEmbeddingModels(): { provider: string; providerId: string; models: { name: string; label: string }[] }[] {
    return PROVIDERS
        .filter((p) => isProviderAvailable(p) && p.embeddingModels.length > 0)
        .map((p) => ({
            provider: p.label,
            providerId: p.id,
            models: p.embeddingModels.map((m) => ({ name: m.name, label: m.label })),
        }));
}

export function resolveEmbeddingKey(key?: string | null): ResolvedEmbedding | null {
    if (!key || !key.includes("::")) return null;
    const idx = key.indexOf("::");
    const provider = getProvider(key.slice(0, idx));
    if (!provider || !isProviderAvailable(provider)) return null;
    const model = provider.embeddingModels.find((m) => m.id === key.slice(idx + 2));
    return model ? { provider, model } : null;
}

export function resolveMessagingEmbedding(): ResolvedEmbedding {
    for (const c of MESSAGING_EMBEDDING_CHAIN) {
        const provider = getProvider(c.providerId);
        if (!provider || !isProviderAvailable(provider)) continue;
        const model = provider.embeddingModels.find((m) => m.id === c.modelId);
        if (model) return { provider, model };
    }
    return resolveEmbedding();
}

export function listProvidersPublic() {
    return PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        available: isProviderAvailable(p),
        chatModels: p.chatModels.map((m) => ({
            id: m.id,
            label: m.label,
            supportsTools: m.supportsTools,
            supportsVision: m.supportsVision,
            supportsThinking: m.supportsThinking,
            supportsSearch: m.supportsSearch,
            maxOutputTokens: m.maxOutputTokens ?? UNVERIFIED_MAX_OUTPUT_TOKENS,
            meta: getModelMeta(m.id),
        })),
        embeddingModels: p.embeddingModels.map((m) => ({
            id: m.id,
            label: m.label,
            dimension: m.dimension,
            meta: getModelMeta(m.id),
        })),
    }));
}
