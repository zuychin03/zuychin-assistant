// List of providers and their chat/embedding models. The user can pick which one
// to use per request. Gemini uses its own native client (grounding, thinking,
// vision); the rest are OpenAI-compatible and share one client.
//
// Note: embeddings are kept per-model. Each model reads/writes its own slice of
// the vector store because vectors from different models aren't comparable and can
// be different sizes.

import { getModelMeta } from "@/lib/ai/model-meta";

export type ProviderKind = "gemini" | "openai-compatible";

export interface ChatModel {
    id: string;
    label: string;
    supportsTools: boolean;
    supportsVision: boolean;
    // does /think actually change anything on this model
    supportsThinking: boolean;
    // can this model do web search - Gemini grounds natively, the OpenAI-compatible
    // models call the search_web tool (so they need tool support)
    supportsSearch: boolean;
}

export interface EmbeddingModel {
    id: string;
    label: string;
    dimension: number;
}

export interface ProviderConfig {
    id: string;
    label: string;
    kind: ProviderKind;
    // base URL for OpenAI-compatible providers (no trailing slash)
    baseUrl?: string;
    // name of the env var that holds the API key
    apiKeyEnv: string;
    // extra request headers (e.g. OpenRouter ranking headers)
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
            { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
            { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
        ],
        embeddingModels: [
            { id: "gemini-embedding-2-preview", label: "Gemini Embedding 2 (768d)", dimension: 768 },
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
            { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra (free)", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { id: "poolside/laguna-m.1:free", label: "Laguna M.1 (free)", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B IT (free)", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
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
            { id: "minimaxai/minimax-m3", label: "MiniMax M3 (free)", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
            { id: "deepseek-ai/deepseek-v4-pro", label: "DeepSeek V4 Pro (free)", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { id: "deepseek-ai/deepseek-v4-flash", label: "DeepSeek V4 Flash (free)", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra (free)", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { id: "google/gemma-4-31b-it", label: "Gemma 4 31B IT (free)", supportsTools: true, supportsVision: true, supportsThinking: false, supportsSearch: true },
        ],
        embeddingModels: [
            { id: "nvidia/llama-nemotron-embed-1b-v2", label: "Llama Nemotron Embed 1B v2 (free, 2048d)", dimension: 2048 },
            { id: "nvidia/llama-embed-nemotron-8b", label: "Llama Embed Nemotron 8B (free, 4096d)", dimension: 4096 },
        ],
    },
    {
        id: "opencode-zen",
        label: "OpenCode Zen",
        kind: "openai-compatible",
        baseUrl: "https://opencode.ai/zen/v1",
        apiKeyEnv: "OPENCODE_ZEN_API_KEY",
        chatModels: [
            { id: "mimo-v2.5-free", label: "MiMo V2.5 (free)", supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: true },
            { id: "deepseek-v4-flash-free", label: "DeepSeek V4 Flash (free)", supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: true },
        ],
        embeddingModels: [],
    },
];

// generation settings the user can tweak in the UI
export interface GenParams {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
}

// clamp the values coming from a request so nothing crazy gets through
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
            out.maxTokens = Math.min(32000, Math.max(1, Math.round(r.maxTokens)));
        }
    }
    return out;
}

export const DEFAULT_CHAT = { providerId: "gemini", modelId: "gemini-3-flash-preview" };
export const DEFAULT_EMBEDDING = { providerId: "gemini", modelId: "gemini-embedding-2-preview" };

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

// pick a chat provider+model, falling back to the default Gemini Flash
export function resolveChat(providerId?: string, modelId?: string): ResolvedChat {
    let provider = (providerId && getProvider(providerId)) || getProvider(DEFAULT_CHAT.providerId)!;
    // fall back to Gemini if the requested provider has no models
    if (!provider.chatModels.length) provider = getProvider(DEFAULT_CHAT.providerId)!;
    const model = provider.chatModels.find((m) => m.id === modelId) ?? provider.chatModels[0]!;
    return { provider, model };
}

// Resolve a specific provider+model only if the provider has a key set and the
// model exists. Returns null otherwise (so callers can fall back).
function resolveAvailable(providerId: string, modelId: string): ResolvedChat | null {
    const provider = getProvider(providerId);
    if (!provider || !isProviderAvailable(provider)) return null;
    const model = provider.chatModels.find((m) => m.id === modelId);
    return model ? { provider, model } : null;
}

// Free models the external messaging channels (Discord/Telegram) default to, in
// order of preference. The first one whose provider key is set wins. Gemini is the
// final fallback since it's always configured.
export const MESSAGING_MODEL_CHAIN: { providerId: string; modelId: string }[] = [
    { providerId: "nvidia-nim", modelId: "deepseek-ai/deepseek-v4-flash" },
    { providerId: "nvidia-nim", modelId: "google/gemma-4-31b-it" },
    { providerId: "gemini", modelId: "gemini-3.5-flash" },
];

// First available model in the messaging chain (defaults to Gemini Flash).
export function resolveMessagingDefault(): ResolvedChat {
    for (const c of MESSAGING_MODEL_CHAIN) {
        const resolved = resolveAvailable(c.providerId, c.modelId);
        if (resolved) return resolved;
    }
    return resolveChat();
}

// Resolve a stored "providerId::modelId" key, but only if it's still available.
export function resolveModelKey(key?: string | null): ResolvedChat | null {
    if (!key || !key.includes("::")) return null;
    const idx = key.indexOf("::");
    return resolveAvailable(key.slice(0, idx), key.slice(idx + 2));
}

// Friendly names accepted by the /model command, each mapped to ordered candidates
// so we use the first one whose provider key is set.
export const MODEL_ALIASES: Record<string, { providerId: string; modelId: string }[]> = {
    deepseek: [
        { providerId: "nvidia-nim", modelId: "deepseek-ai/deepseek-v4-flash" },
        { providerId: "opencode-zen", modelId: "deepseek-v4-flash-free" },
    ],
    "deepseek-flash": [
        { providerId: "nvidia-nim", modelId: "deepseek-ai/deepseek-v4-flash" },
        { providerId: "opencode-zen", modelId: "deepseek-v4-flash-free" },
    ],
    gemma: [{ providerId: "nvidia-nim", modelId: "google/gemma-4-31b-it" }],
    gemma4: [{ providerId: "nvidia-nim", modelId: "google/gemma-4-31b-it" }],
    gemini: [{ providerId: "gemini", modelId: "gemini-3.5-flash" }],
    flash: [{ providerId: "gemini", modelId: "gemini-3.5-flash" }],
};

// Resolve a /model alias to the first available candidate, or null if none.
export function resolveAlias(alias: string): ResolvedChat | null {
    const candidates = MODEL_ALIASES[alias.trim().toLowerCase()];
    if (!candidates) return null;
    for (const c of candidates) {
        const resolved = resolveAvailable(c.providerId, c.modelId);
        if (resolved) return resolved;
    }
    return null;
}

// Available models for the /model command, grouped by the model they resolve to so
// synonyms (e.g. "gemini" / "flash") show on one line with the real model name.
export function availableModelChoices(): { aliases: string[]; label: string; provider: string }[] {
    const groups = new Map<string, { aliases: string[]; label: string; provider: string }>();
    for (const alias of Object.keys(MODEL_ALIASES)) {
        const resolved = resolveAlias(alias);
        if (!resolved) continue;
        const key = `${resolved.provider.id}::${resolved.model.id}`;
        const existing = groups.get(key);
        if (existing) {
            existing.aliases.push(alias);
        } else {
            groups.set(key, { aliases: [alias], label: resolved.model.label, provider: resolved.provider.label });
        }
    }
    return [...groups.values()];
}

export interface ResolvedEmbedding {
    provider: ProviderConfig;
    model: EmbeddingModel;
}

// find an embedding provider+model by id, falling back to Gemini 768d
export function resolveEmbedding(modelId?: string): ResolvedEmbedding {
    for (const provider of PROVIDERS) {
        const model = provider.embeddingModels.find((m) => m.id === modelId);
        if (model) return { provider, model };
    }
    const g = getProvider(DEFAULT_EMBEDDING.providerId)!;
    return { provider: g, model: g.embeddingModels[0]! };
}

// Embedding model the external channels (Discord/Telegram) default to, in order
// of preference. First one whose provider key is set wins; Gemini is the fallback.
export const MESSAGING_EMBEDDING_CHAIN: { providerId: string; modelId: string }[] = [
    { providerId: "nvidia-nim", modelId: "nvidia/llama-nemotron-embed-1b-v2" },
    { providerId: "gemini", modelId: "gemini-embedding-2-preview" },
];

// First available embedding model in the messaging chain (defaults to Gemini).
export function resolveMessagingEmbedding(): ResolvedEmbedding {
    for (const c of MESSAGING_EMBEDDING_CHAIN) {
        const provider = getProvider(c.providerId);
        if (!provider || !isProviderAvailable(provider)) continue;
        const model = provider.embeddingModels.find((m) => m.id === c.modelId);
        if (model) return { provider, model };
    }
    return resolveEmbedding();
}

// provider list safe to send to the browser (no keys, just availability flags)
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
