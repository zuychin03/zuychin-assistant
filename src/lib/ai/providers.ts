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
    metered?: boolean;
    /** Endpoint accepts response_format json_schema, verified by a live probe. */
    supportsStructuredOutput?: boolean;
    /** Published or probed endpoint ceiling; omitted where unverified. */
    maxOutputTokens?: number;
}

// Conservative request limit when the endpoint ceiling is unverified.
export const UNVERIFIED_MAX_OUTPUT_TOKENS = 8192;

// DeepSeek's published 384K ceiling sets the request-level bound.
export const MAX_OUTPUT_TOKENS_CEILING = 393216;

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
    unavailableReason?: string;
    extraHeaders?: Record<string, string>;
    /** Excludes paid providers from automatic worker recruitment. */
    metered?: boolean;
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
            { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", name: "gemini-3.8-flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, supportsStructuredOutput: true, maxOutputTokens: 65536 },
            { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", name: "gemini-3.5-flash-lite", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, supportsStructuredOutput: true, maxOutputTokens: 65536 },
        ],
        embeddingModels: [
            { id: "gemini-embedding-2", label: "Gemini Embedding 2 (768d)", name: "gemini-embedding-2", dimension: 768 },
        ],
    },
    {
        // Provider IDs keep the free-project key separate from paid selections.
        id: "gemini-free",
        label: "Google Gemini (free)",
        kind: "gemini",
        apiKeyEnv: "GEMINI_FREE_API_KEY",
        chatModels: [
            { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (free)", name: "gemini-3.8-flash-free", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, supportsStructuredOutput: true, maxOutputTokens: 65536 },
            { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (free)", name: "gemini-3.5-flash-lite-free", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, supportsStructuredOutput: true, maxOutputTokens: 65536 },
        ],
        embeddingModels: [],
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
            { id: "google/gemma-4-26b-a4b-it", label: "Gemma 4 26B A4B", name: "gemma-4-26b", metered: true, supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, supportsStructuredOutput: true, maxOutputTokens: 16384 },
            { id: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning (free)", name: "nemotron-3.5-lightning", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, maxOutputTokens: 65536 },
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
            { id: "moonshotai/kimi-k3", label: "Kimi K3 (free)", name: "kimi-k3", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
            { id: "z-ai/glm-5.3", label: "GLM-5.3 (free)", name: "glm-5.3", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { id: "deepseek-ai/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash (free)", name: "deepseek-v4.1-flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: false },
            { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra (free)", name: "nemotron-3-ultra", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, supportsStructuredOutput: true, maxOutputTokens: 131072 },
            { id: "google/gemma-4-31b-it", label: "Gemma 4 31B IT (free)", name: "gemma-4", supportsTools: true, supportsVision: true, supportsThinking: false, supportsSearch: true, supportsStructuredOutput: true, maxOutputTokens: 131072 },
            { id: "google/diffusiongemma-26b-a4b-it", label: "DiffusionGemma 26B (free)", name: "diffusiongemma", supportsTools: false, supportsVision: true, supportsThinking: false, supportsSearch: false, supportsStructuredOutput: true, maxOutputTokens: 131072 },
            { id: "z-ai/glm-5.3-flash", label: "GLM-5.3 Flash (free)", name: "glm-5.3-flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
            { id: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "Nemotron 3.5 Lightning (free)", name: "nemotron-3.5-lightning", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { id: "poolside/laguna-xs-2.1", label: "Laguna XS 2.1 (free)", name: "laguna-xs-2.1", supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: true, supportsStructuredOutput: true }
        ],
        embeddingModels: [
            { id: "nvidia/nemotron-3-embed-1b", label: "Nemotron 3 Embed 1B (free, 2048d)", name: "nemotron-3-embed-1b", dimension: 2048 },
        ],
    },
    {
        id: "deepseek",
        label: "DeepSeek",
        kind: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        metered: true,
        chatModels: [
            // DeepSeek accepts json_object, not strict json_schema output.
            { id: "deepseek-flash", label: "DeepSeek V4.1 Flash", name: "deepseek-v4.1-flash-api", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, maxOutputTokens: 393216 },
            { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", name: "deepseek-v4-pro-api", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, maxOutputTokens: 393216 },
        ],
        embeddingModels: [],
    },
    {
        id: "opencode-zen",
        label: "OpenCode Zen",
        kind: "openai-compatible",
        baseUrl: "https://opencode.ai/zen/v1",
        apiKeyEnv: "OPENCODE_ZEN_API_KEY",
        unavailableReason: "OpenCode's free tier can only be used within OpenCode (checked 23/09/2026).",
        chatModels: [
            { id: "mimo-v2.6-flash-free", label: "MiMo V2.6 Flash (free)", name: "mimo-v2.6-flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
            { id: "nemotron-3.5-lightning-free", label: "Nemotron 3.5 Lightning (free)", name: "nemotron-3.5-lightning", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
        ],
        embeddingModels: [],
    },
    {
        id: "tokenrouter",
        label: "TokenRouter",
        kind: "openai-compatible",
        baseUrl: "https://api.tokenrouter.com/v1",
        apiKeyEnv: "TOKENROUTER_API_KEY",
        unavailableReason: "No usable free endpoint for the configured key (checked 23/09/2026).",
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

/** Applies the endpoint ceiling after model resolution. */
export function cappedMaxTokens(requested: number, modelId: string): number {
    return Math.min(requested, modelMaxOutputTokens(modelId));
}

export const DEFAULT_CHAT = { providerId: "gemini", modelId: "gemini-3.5-flash-lite" };

const LEGACY_GEMINI_MODEL_IDS: Record<string, string> = {
    "gemini-3-flash-preview": "gemini-3.5-flash-lite",
    "gemini-3.5-flash": "gemini-3.8-flash",
    "gemini-3.6-flash": "gemini-3.8-flash",
    "gemini-3.7-flash": "gemini-3.8-flash",
};

const LEGACY_CHAT_MODELS: Record<string, Record<string, string>> = {
    gemini: LEGACY_GEMINI_MODEL_IDS,
    "gemini-free": {
        ...LEGACY_GEMINI_MODEL_IDS,
        "gemini-3.5-flash-free": "gemini-3.8-flash",
        "gemini-3.6-flash-free": "gemini-3.8-flash",
        "gemini-3.7-flash-free": "gemini-3.8-flash",
    },
    "nvidia-nim": {
        "minimaxai/minimax-m3": "moonshotai/kimi-k3",
        "minimax-m3": "moonshotai/kimi-k3",
        "deepseek-ai/deepseek-v4-pro": "z-ai/glm-5.3",
        "deepseek-v4-pro": "z-ai/glm-5.3",
        "deepseek-ai/deepseek-v4-flash": "deepseek-ai/deepseek-v4.1-flash",
        "deepseek-v4-flash": "deepseek-ai/deepseek-v4.1-flash",
        "stepfun-ai/step-3.7-flash": "z-ai/glm-5.3-flash",
        "step-3.7-flash": "z-ai/glm-5.3-flash",
        "z-ai/glm-5.2": "z-ai/glm-5.3",
        "glm-5.2": "z-ai/glm-5.3",
        "openai/gpt-oss-120b": "nvidia/nemotron-3-ultra-550b-a55b",
        "gpt-oss-120b": "nvidia/nemotron-3-ultra-550b-a55b",
    },
    deepseek: {
        "deepseek-v4-flash": "deepseek-flash",
        "deepseek-v4-flash-api": "deepseek-flash",
        "deepseek-v4.1-flash": "deepseek-flash",
    },
    "opencode-zen": {
        "mimo-v2.5-free": "mimo-v2.6-flash-free",
        "mimo-v2.5": "mimo-v2.6-flash-free",
        "deepseek-v4-flash-free": "nemotron-3.5-lightning-free",
        "deepseek-v4-flash": "nemotron-3.5-lightning-free",
        "laguna-s-2.1-free": "nemotron-3.5-lightning-free",
        "laguna-s-2.1": "nemotron-3.5-lightning-free",
        "ling-3.0-flash-free": "nemotron-3.5-lightning-free",
        "ling-3.0-flash": "nemotron-3.5-lightning-free",
    },
};

function canonicalChatModelId(providerId: string, modelId?: string): string | undefined {
    if (!modelId) return modelId;
    return LEGACY_CHAT_MODELS[providerId]?.[modelId] ?? modelId;
}
// Changing the embedding space requires scripts/reembed-knowledge.ts.
export const DEFAULT_EMBEDDING = { providerId: "nvidia-nim", modelId: "nvidia/nemotron-3-embed-1b" };

export function getProvider(id: string): ProviderConfig | undefined {
    return PROVIDERS.find((p) => p.id === id);
}

export function getProviderApiKey(p: ProviderConfig): string | undefined {
    return process.env[p.apiKeyEnv];
}

export function isProviderAvailable(p: ProviderConfig): boolean {
    return !p.unavailableReason && !!getProviderApiKey(p);
}

export interface ResolvedChat {
    provider: ProviderConfig;
    model: ChatModel;
}

export function resolveChat(providerId?: string, modelId?: string): ResolvedChat {
    const provider = getProvider(providerId ?? DEFAULT_CHAT.providerId);
    if (!provider) throw new Error(`Unknown chat provider: ${providerId}`);
    if (provider.unavailableReason) throw new Error(`${provider.label} is unavailable: ${provider.unavailableReason}`);
    if (providerId && !isProviderAvailable(provider)) throw new Error(`${provider.label} is unavailable: no API key is configured.`);
    if (!provider.chatModels.length) throw new Error(`${provider.label} has no chat models.`);
    const requestedModelId = modelId
        ?? (provider.id === DEFAULT_CHAT.providerId ? DEFAULT_CHAT.modelId : undefined);
    const canonicalModelId = canonicalChatModelId(provider.id, requestedModelId);
    const model = canonicalModelId
        ? provider.chatModels.find((m) => m.id === canonicalModelId || m.name === canonicalModelId)
        : provider.chatModels[0];
    if (!model) throw new Error(`Unknown model for ${provider.label}: ${requestedModelId}`);
    return { provider, model };
}

function resolveAvailable(providerId: string, modelId: string): ResolvedChat | null {
    const provider = getProvider(providerId);
    if (!provider || !isProviderAvailable(provider)) return null;
    const canonicalModelId = canonicalChatModelId(provider.id, modelId);
    const model = provider.chatModels.find((m) => m.id === canonicalModelId || m.name === canonicalModelId);
    return model ? { provider, model } : null;
}

export const MESSAGING_MODEL_CHAIN: { providerId: string; modelId: string }[] = [
    { providerId: "nvidia-nim", modelId: "z-ai/glm-5.3-flash" },
    { providerId: "nvidia-nim", modelId: "nvidia/nemotron-3-ultra-550b-a55b" },
    { providerId: "gemini", modelId: "gemini-3.8-flash" },
];

// Gemini is reserved for the worker's explicit final fallback.
const WORKER_PREFERRED: { providerId: string; modelId: string }[] = [
    { providerId: "nvidia-nim", modelId: "z-ai/glm-5.3-flash" },
    { providerId: "nvidia-nim", modelId: "deepseek-ai/deepseek-v4.1-flash" },
    { providerId: "nvidia-nim", modelId: "nvidia/nemotron-3.5-lightning-30b-a3b" },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3.5-lightning:free" },
];

// Tried first for no-tool subtasks; cannot call functions.
export const WORKER_NO_TOOLS_MODEL = { providerId: "nvidia-nim", modelId: "google/diffusiongemma-26b-a4b-it" };

// Paid fallback after free workers fail, sized to subtask complexity.
export const WORKER_GEMINI_FALLBACK = {
    simple: "gemini-3.5-flash-lite",
    complex: "gemini-3.8-flash",
} as const;

export function resolveWorkerChain(needsTools: boolean): ResolvedChat[] {
    const out: ResolvedChat[] = [];
    const seen = new Set<string>();
    const push = (r: ResolvedChat | null) => {
        if (!r || r.provider.metered || r.model.metered || (needsTools && !r.model.supportsTools)) return;
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
        if (provider.kind === "gemini" || provider.metered || !isProviderAvailable(provider)) continue;
        for (const model of provider.chatModels) {
            if (!model.metered && model.supportsTools && getModelMeta(model.id)?.strengths.includes("Fast")) {
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
    const aliases: ResolvedChat[] = [];
    for (const provider of PROVIDERS) {
        if (!isProviderAvailable(provider)) continue;
        const model = provider.chatModels.find(
            (m) => m.name.toLowerCase() === n || m.id.toLowerCase() === n,
        );
        if (model) return { provider, model };
        const canonicalName = canonicalChatModelId(provider.id, n);
        const aliased = provider.chatModels.find((m) => m.id === canonicalName);
        if (aliased) aliases.push({ provider, model: aliased });
    }
    return aliases.length === 1 ? aliases[0] : null;
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
    const wanted = modelId ?? (process.env.KNOWLEDGE_EMBEDDING_MODEL?.trim() || undefined);
    for (const provider of PROVIDERS) {
        const model = provider.embeddingModels.find((m) => m.id === wanted);
        if (model) return { provider, model };
    }
    if (wanted !== undefined) throw new Error(`Unknown embedding model: ${wanted}. Select a supported model and re-embed the knowledge store before switching.`);
    const g = getProvider(DEFAULT_EMBEDDING.providerId)!;
    const model = g.embeddingModels.find((m) => m.id === DEFAULT_EMBEDDING.modelId) ?? g.embeddingModels[0]!;
    return { provider: g, model };
}

export const MESSAGING_EMBEDDING_CHAIN: { providerId: string; modelId: string }[] = [
    { providerId: "nvidia-nim", modelId: "nvidia/nemotron-3-embed-1b" },
    { providerId: "gemini", modelId: "gemini-embedding-2" },
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
        unavailableReason: p.unavailableReason,
        chatModelAliases: LEGACY_CHAT_MODELS[p.id] ?? {},
        chatModels: p.chatModels.map((m) => ({
            id: m.id,
            label: m.label,
            supportsTools: m.supportsTools,
            supportsVision: m.supportsVision,
            supportsThinking: m.supportsThinking,
            supportsSearch: m.supportsSearch,
            supportsStructuredOutput: m.supportsStructuredOutput ?? false,
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
