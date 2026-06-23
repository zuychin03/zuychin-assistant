// List of providers and their chat/embedding models. The user can pick which one
// to use per request. Gemini uses its own native client (grounding, thinking,
// vision); the rest are OpenAI-compatible and share one client.
//
// Note: embeddings are kept per-model. Each model reads/writes its own slice of
// the vector store because vectors from different models aren't comparable and can
// be different sizes.

export type ProviderKind = "gemini" | "openai-compatible";

export interface ChatModel {
    id: string;
    label: string;
    supportsTools: boolean;
    supportsVision: boolean;
    // does /think actually change anything on this model
    supportsThinking: boolean;
    // does /search (web grounding) work on this model
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
            { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra (free)", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: false },
        ],
        embeddingModels: [
            { id: "nvidia/llama-nemotron-embed-vl-1b-v2:free", label: "Nemotron Embed VL 1B v2 (free, 2048d)", dimension: 2048 },
        ],
    },
    {
        id: "nvidia-nim",
        label: "NVIDIA NIM",
        kind: "openai-compatible",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyEnv: "NVIDIA_NIM_API_KEY",
        chatModels: [
            { id: "minimaxai/minimax-m3", label: "MiniMax M3 (free)", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: false },
            { id: "deepseek-ai/deepseek-v4-pro", label: "DeepSeek V4 Pro (free)", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: false },
            { id: "deepseek-ai/deepseek-v4-flash", label: "DeepSeek V4 Flash (free)", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: false },
            { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra (free)", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: false },
        ],
        embeddingModels: [],
    },
    {
        id: "opencode-zen",
        label: "OpenCode Zen",
        kind: "openai-compatible",
        baseUrl: "https://opencode.ai/zen/v1",
        apiKeyEnv: "OPENCODE_ZEN_API_KEY",
        chatModels: [
            { id: "mimo-v2.5-free", label: "MiMo V2.5 (free)", supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: false },
            { id: "deepseek-v4-flash-free", label: "DeepSeek V4 Flash (free)", supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: false },
            { id: "nemotron-3-ultra-free", label: "Nemotron 3 Ultra (free)", supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: false },
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
        })),
        embeddingModels: p.embeddingModels.map((m) => ({ id: m.id, label: m.label })),
    }));
}
