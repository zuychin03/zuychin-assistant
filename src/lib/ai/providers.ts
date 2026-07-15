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
}

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
            { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", name: "gemini-3.5-flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
            { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", name: "gemini-3-flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
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
            { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra (free)", name: "nemotron-3-ultra", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { id: "poolside/laguna-m.1:free", label: "Laguna M.1 (free)", name: "laguna-m.1", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B IT (free)", name: "gemma-4", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
            { id: "google/gemma-4-26b-a4b-it", label: "Gemma 4 26B A4B", name: "gemma-4-26b", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
            { id: "openai/gpt-oss-120b:free", label: "GPT-OSS 120B (free)", name: "gpt-oss-120b", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { id: "qwen/qwen3-next-80b-a3b-instruct:free", label: "Qwen3 Next 80B (free)", name: "qwen3-next", supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: true },
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
            { id: "minimaxai/minimax-m3", label: "MiniMax M3 (free)", name: "minimax-m3", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
            { id: "deepseek-ai/deepseek-v4-pro", label: "DeepSeek V4 Pro (free)", name: "deepseek-v4-pro", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { id: "deepseek-ai/deepseek-v4-flash", label: "DeepSeek V4 Flash (free)", name: "deepseek-v4-flash", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra (free)", name: "nemotron-3-ultra", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { id: "google/gemma-4-31b-it", label: "Gemma 4 31B IT (free)", name: "gemma-4", supportsTools: true, supportsVision: true, supportsThinking: false, supportsSearch: true },
            { id: "google/diffusiongemma-26b-a4b-it", label: "DiffusionGemma 26B (free)", name: "diffusiongemma", supportsTools: false, supportsVision: true, supportsThinking: false, supportsSearch: false },
            { id: "stepfun-ai/step-3.7-flash", label: "Step 3.7 Flash (free)", name: "step-3.7-flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
            { id: "z-ai/glm-5.2", label: "GLM-5.2 (free)", name: "glm-5.2", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { id: "minimaxai/minimax-m2.7", label: "MiniMax M2.7 (free)", name: "minimax-m2.7", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { id: "qwen/qwen3.5-397b-a17b", label: "Qwen3.5 397B (free)", name: "qwen3.5", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
            { id: "qwen/qwen3-next-80b-a3b-instruct", label: "Qwen3 Next 80B (free)", name: "qwen3-next", supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: true }
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
            { id: "mimo-v2.5-free", label: "MiMo V2.5 (free)", name: "mimo-v2.5", supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: true },
            { id: "deepseek-v4-flash-free", label: "DeepSeek V4 Flash (free)", name: "deepseek-v4-flash", supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: true },
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
            out.maxTokens = Math.min(32000, Math.max(1, Math.round(r.maxTokens)));
        }
    }
    return out;
}

export const DEFAULT_CHAT = { providerId: "gemini", modelId: "gemini-3-flash-preview" };
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
    const model = provider.chatModels.find((m) => m.id === modelId) ?? provider.chatModels[0]!;
    return { provider, model };
}

function resolveAvailable(providerId: string, modelId: string): ResolvedChat | null {
    const provider = getProvider(providerId);
    if (!provider || !isProviderAvailable(provider)) return null;
    const model = provider.chatModels.find((m) => m.id === modelId);
    return model ? { provider, model } : null;
}

export const MESSAGING_MODEL_CHAIN: { providerId: string; modelId: string }[] = [
    { providerId: "nvidia-nim", modelId: "deepseek-ai/deepseek-v4-flash" },
    { providerId: "nvidia-nim", modelId: "google/gemma-4-31b-it" },
    { providerId: "gemini", modelId: "gemini-3.5-flash" },
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
    const m = modelArg.trim().toLowerCase();
    const model = provider.chatModels.find(
        (mod) => mod.name.toLowerCase() === m || mod.id.toLowerCase() === m
    );
    return model ? { provider, model } : null;
}

export function resolveChatModelByName(name: string): ResolvedChat | null {
    const n = name.trim().toLowerCase();
    for (const provider of PROVIDERS) {
        if (!isProviderAvailable(provider)) continue;
        const model = provider.chatModels.find((m) => m.name.toLowerCase() === n || m.id.toLowerCase() === n);
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
