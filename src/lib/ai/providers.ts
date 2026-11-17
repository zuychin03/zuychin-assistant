import { getModelMeta } from "@/lib/ai/model-meta";
import { uniqueShortName, type ProviderDiscovery } from "@/lib/ai/catalogue/sources";
import { catalogueSnapshot, type CatalogueOrigin, type CatalogueRow } from "@/lib/ai/catalogue/snapshot";

export type ProviderKind = "gemini" | "openai-compatible";

/** Present when the stored catalogue has a row for this model. */
export interface ChatModelCatalogue {
    origin: "code" | CatalogueOrigin;
    approved: boolean;
    status: "new" | "missing" | "failing" | null;
    probeChatMs: number | null;
}

export interface ChatModel {
    id: string;
    label: string;
    name: string;
    free?: boolean;
    supportsTools: boolean;
    supportsVision: boolean;
    supportsThinking: boolean;
    supportsSearch: boolean;
    apiFormat?: "responses";
    metered?: boolean;
    /** Endpoint accepts response_format json_schema, verified by a live probe. */
    supportsStructuredOutput?: boolean;
    /** Published or probed endpoint ceiling; omitted where unverified. */
    maxOutputTokens?: number;
    catalogue?: ChatModelCatalogue;
}

// Conservative request limit when the endpoint ceiling is unverified.
export const UNVERIFIED_MAX_OUTPUT_TOKENS = 8192;

// DeepSeek's published 384K ceiling sets the request-level bound.
export const MAX_OUTPUT_TOKENS_CEILING = 393216;

export interface EmbeddingModel {
    id: string;
    label: string;
    name: string;
    free?: boolean;
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
    discovery?: ProviderDiscovery;
    chatModels: ChatModel[];
    embeddingModels: EmbeddingModel[];
}

export const PROVIDERS: ProviderConfig[] = [
    {
        id: "gemini",
        label: "Google Gemini",
        kind: "gemini",
        apiKeyEnv: "GEMINI_API_KEY",
        discovery: { source: "gemini", include: "all", pricing: "all-paid" },
        chatModels: [
            { free: false, id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", name: "gemini-3.8-flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, supportsStructuredOutput: true, maxOutputTokens: 65536 },
            { free: false, id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", name: "gemini-3.5-flash-lite", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, supportsStructuredOutput: true, maxOutputTokens: 65536 },
        ],
        embeddingModels: [
            { free: false, id: "gemini-embedding-2", label: "Gemini Embedding 2 (768d)", name: "gemini-embedding-2", dimension: 768 },
        ],
    },
    {
        // Provider IDs keep the free-project key separate from paid selections.
        id: "gemini-free",
        label: "Google Gemini (free)",
        kind: "gemini",
        apiKeyEnv: "GEMINI_FREE_API_KEY",
        discovery: { source: "gemini", include: "all", pricing: "all-free", nameSuffix: "-free" },
        chatModels: [
            { free: true, id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (free)", name: "gemini-3.8-flash-free", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, supportsStructuredOutput: true, maxOutputTokens: 65536 },
            { free: true, id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (free)", name: "gemini-3.5-flash-lite-free", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, supportsStructuredOutput: true, maxOutputTokens: 65536 },
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
        discovery: { source: "openrouter", include: "free", pricing: "listed" },
        chatModels: [
            { free: true, id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra (free)", name: "nemotron-3-ultra", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, maxOutputTokens: 65536 },
            { free: true, id: "poolside/laguna-s-2.1:free", label: "Laguna S 2.1 (free)", name: "laguna-s-2.1", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, maxOutputTokens: 32768 },
            { free: true, id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B IT (free)", name: "gemma-4", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, maxOutputTokens: 32768 },
            { free: false, id: "google/gemma-4-26b-a4b-it", label: "Gemma 4 26B A4B", name: "gemma-4-26b", metered: true, supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, supportsStructuredOutput: true, maxOutputTokens: 16384 },
            { free: true, id: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning (free)", name: "nemotron-3.5-lightning", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, maxOutputTokens: 65536 },
        ],
        embeddingModels: [],
    },
    {
        id: "kilo",
        label: "Kilo",
        kind: "openai-compatible",
        baseUrl: "https://api.kilo.ai/api/gateway",
        apiKeyEnv: "KILO_API_KEY",
        discovery: { source: "kilo", include: "free", pricing: "listed" },
        chatModels: [
            { free: true, id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra (free)", name: "nemotron-3-ultra", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, maxOutputTokens: 65536 },
            { free: true, id: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning (free)", name: "nemotron-3.5-lightning", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: false, maxOutputTokens: 65536 },
            { free: true, id: "inclusionai/ling-3.0-flash-vl:free", label: "Ling 3.0 Flash VL (free)", name: "ling-3.0-flash-vl", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, maxOutputTokens: 32768 },
            { free: true, id: "stepfun/step-3.7-flash:free", label: "Step 3.7 Flash (free)", name: "step-3.7-flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, maxOutputTokens: 262144 },
            { free: true, id: "poolside/laguna-s-2.1:free", label: "Laguna S 2.1 (free)", name: "laguna-s-2.1", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, maxOutputTokens: 32768 },
        ],
        embeddingModels: [],
    },
    {
        id: "nvidia-nim",
        label: "NVIDIA NIM",
        kind: "openai-compatible",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyEnv: "NVIDIA_NIM_API_KEY",
        discovery: { source: "openai-list", include: "all", pricing: "all-free" },
        chatModels: [
            { free: true, id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra (free)", name: "nemotron-3-ultra", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, supportsStructuredOutput: true, maxOutputTokens: 131072 },
            { free: true, id: "google/gemma-4-31b-it", label: "Gemma 4 31B IT (free)", name: "gemma-4", supportsTools: true, supportsVision: true, supportsThinking: false, supportsSearch: true, supportsStructuredOutput: true, maxOutputTokens: 131072 },
            { free: true, id: "z-ai/glm-5.3-flash", label: "GLM-5.3 Flash (free)", name: "glm-5.3-flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
            { free: true, id: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "Nemotron 3.5 Lightning (free)", name: "nemotron-3.5-lightning", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { free: true, id: "poolside/laguna-xs-2.1", label: "Laguna XS 2.1 (free)", name: "laguna-xs-2.1", supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: true, supportsStructuredOutput: true }
        ],
        embeddingModels: [
            { free: true, id: "nvidia/nemotron-3-embed-1b", label: "Nemotron 3 Embed 1B (free, 2048d)", name: "nemotron-3-embed-1b", dimension: 2048 },
        ],
    },
    {
        id: "deepseek",
        label: "DeepSeek",
        kind: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        metered: true,
        discovery: { source: "openai-list", include: "all", pricing: "all-paid" },
        chatModels: [
            // DeepSeek accepts json_object, not strict json_schema output.
            { free: false, id: "deepseek-flash", label: "DeepSeek V4.1 Flash", name: "deepseek-v4.1-flash-api", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, maxOutputTokens: 393216 },
            { free: false, id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", name: "deepseek-v4-pro-api", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, maxOutputTokens: 393216 },
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
            { free: true, id: "mimo-v2.6-flash-free", label: "MiMo V2.6 Flash (free)", name: "mimo-v2.6-flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
            { free: true, id: "nemotron-3-ultra-free", label: "Nemotron 3 Ultra (free)", name: "nemotron-3-ultra", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { free: true, id: "nemotron-3.5-lightning-free", label: "Nemotron 3.5 Lightning (free)", name: "nemotron-3.5-lightning", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
            { free: true, id: "muse-spark-1.3-contributor-free", label: "Muse Spark 1.3 Contributor (free)", name: "muse-spark-1.3-contributor", apiFormat: "responses", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, maxOutputTokens: 131072 },
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
            { free: true, id: "moonshotai/kimi-k3-free", label: "Kimi K3 (free)", name: "kimi-k3", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
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
    for (const provider of providers()) {
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
        "minimaxai/minimax-m3": "nvidia/nemotron-3-ultra-550b-a55b",
        "minimax-m3": "nvidia/nemotron-3-ultra-550b-a55b",
        "deepseek-ai/deepseek-v4-pro": "nvidia/nemotron-3-ultra-550b-a55b",
        "deepseek-v4-pro": "nvidia/nemotron-3-ultra-550b-a55b",
        "deepseek-ai/deepseek-v4-flash": "nvidia/nemotron-3.5-lightning-30b-a3b",
        "deepseek-v4-flash": "nvidia/nemotron-3.5-lightning-30b-a3b",
        "stepfun-ai/step-3.7-flash": "z-ai/glm-5.3-flash",
        "step-3.7-flash": "z-ai/glm-5.3-flash",
        "z-ai/glm-5.2": "nvidia/nemotron-3-ultra-550b-a55b",
        "glm-5.2": "nvidia/nemotron-3-ultra-550b-a55b",
        "openai/gpt-oss-120b": "nvidia/nemotron-3-ultra-550b-a55b",
        "gpt-oss-120b": "nvidia/nemotron-3-ultra-550b-a55b",
        // NIM returned 410 end of life for these on 18/11/2026.
        "moonshotai/kimi-k3": "nvidia/nemotron-3-ultra-550b-a55b",
        "kimi-k3": "nvidia/nemotron-3-ultra-550b-a55b",
        "z-ai/glm-5.3": "nvidia/nemotron-3-ultra-550b-a55b",
        "glm-5.3": "nvidia/nemotron-3-ultra-550b-a55b",
        "deepseek-ai/deepseek-v4.1-flash": "nvidia/nemotron-3.5-lightning-30b-a3b",
        "deepseek-v4.1-flash": "nvidia/nemotron-3.5-lightning-30b-a3b",
        "google/diffusiongemma-26b-a4b-it": "google/gemma-4-31b-it",
        "diffusiongemma": "google/gemma-4-31b-it",
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

/** Saved ids that resolve to a replacement; discovery must not list them as models of their own. */
export function retiredChatModelIds(providerId: string): Set<string> {
    return new Set(Object.keys(LEGACY_CHAT_MODELS[providerId] ?? {}));
}

function canonicalChatModelId(providerId: string, modelId?: string): string | undefined {
    if (!modelId) return modelId;
    return LEGACY_CHAT_MODELS[providerId]?.[modelId] ?? modelId;
}
// Changing the embedding space requires scripts/reembed-knowledge.ts.
export const DEFAULT_EMBEDDING = { providerId: "nvidia-nim", modelId: "nvidia/nemotron-3-embed-1b" };

// An approved discovered model counts as Fast for worker recruitment when its chat probe finished within this.
export const FAST_PROBE_MS = 10_000;

function chatModelFromRow(row: CatalogueRow, name: string): ChatModel {
    const approved = row.approvedAt !== null;
    return {
        id: row.modelId,
        label: row.label,
        name,
        free: row.free,
        metered: row.metered,
        supportsTools: row.supportsTools ?? false,
        supportsVision: row.supportsVision ?? false,
        supportsThinking: row.supportsThinking ?? row.listedThinking ?? false,
        supportsSearch: row.supportsSearch ?? false,
        ...(row.supportsStructured ? { supportsStructuredOutput: true } : {}),
        ...(row.maxOutputTokens ? { maxOutputTokens: Math.min(row.maxOutputTokens, MAX_OUTPUT_TOKENS_CEILING) } : {}),
        catalogue: {
            origin: row.origin,
            approved,
            status: row.missingSince ? "missing" : row.probeStatus === "failed" ? "failing" : approved ? null : "new",
            probeChatMs: row.probeChatMs,
        },
    };
}

/** Code entries win field by field; rows add discovered models and status. Untested or failed rows stay out unless approved. */
export function mergeCatalogue(config: readonly ProviderConfig[], rows: readonly CatalogueRow[]): ProviderConfig[] {
    if (!rows.length) return [...config];
    return config.map((provider) => {
        const own = rows.filter((row) => row.providerId === provider.id);
        if (!own.length) return provider;
        const byId = new Map(own.map((row) => [row.modelId, row]));
        const retired = LEGACY_CHAT_MODELS[provider.id] ?? {};
        const chatModels: ChatModel[] = provider.chatModels.map((model) => {
            const row = byId.get(model.id);
            if (!row) return model;
            return {
                ...model,
                ...(model.maxOutputTokens === undefined && row.maxOutputTokens ? { maxOutputTokens: Math.min(row.maxOutputTokens, MAX_OUTPUT_TOKENS_CEILING) } : {}),
                catalogue: {
                    origin: "code",
                    approved: true,
                    status: row.missingSince ? "missing" : row.probeStatus === "failed" ? "failing" : null,
                    probeChatMs: row.probeChatMs,
                },
            };
        });
        const taken = new Set(chatModels.map((model) => model.name));
        const codeIds = new Set(chatModels.map((model) => model.id));
        const added = own
            .filter((row) => !codeIds.has(row.modelId) && !Object.hasOwn(retired, row.modelId)
                && (row.approvedAt !== null || row.probeStatus === "passed"))
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((row) => {
                const name = uniqueShortName(row.shortName, taken);
                taken.add(name);
                return chatModelFromRow(row, name);
            });
        return { ...provider, chatModels: [...chatModels, ...added] };
    });
}

let mergedProviders: { version: number; list: ProviderConfig[] } | null = null;

/** Code providers merged with the stored catalogue. Synchronous: reads the in-memory snapshot. */
export function providers(): ProviderConfig[] {
    const snapshot = catalogueSnapshot();
    if (mergedProviders?.version !== snapshot.version) {
        mergedProviders = { version: snapshot.version, list: mergeCatalogue(PROVIDERS, snapshot.rows) };
    }
    return mergedProviders.list;
}

/** Worker recruitment, Free only fallback and messaging fallback use code models and approved catalogue models only. */
export function automaticRouteEligible(model: ChatModel): boolean {
    return !model.catalogue || model.catalogue.origin === "code" || model.catalogue.approved;
}

function workerFast(model: ChatModel): boolean {
    if (getModelMeta(model.id)?.strengths.includes("Fast")) return true;
    const probeMs = model.catalogue && model.catalogue.origin !== "code" ? model.catalogue.probeChatMs : null;
    return probeMs !== null && probeMs <= FAST_PROBE_MS;
}

export function getProvider(id: string): ProviderConfig | undefined {
    return providers().find((p) => p.id === id);
}

export function getProviderApiKey(p: ProviderConfig): string | undefined {
    return process.env[p.apiKeyEnv];
}

export function isProviderAvailable(p: ProviderConfig): boolean {
    return !p.unavailableReason && !!getProviderApiKey(p);
}

function chatModelUnavailableReason(model: ChatModel): string | undefined {
    return model.apiFormat === "responses"
        ? "Requires the Responses API, which this app does not yet support."
        : undefined;
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
        : provider.chatModels.find((m) => !chatModelUnavailableReason(m));
    if (!model) throw new Error(`Unknown model for ${provider.label}: ${requestedModelId}`);
    const unavailableReason = chatModelUnavailableReason(model);
    if (unavailableReason) throw new Error(`${model.label} is unavailable: ${unavailableReason}`);
    return { provider, model };
}

function resolveAvailable(providerId: string, modelId: string): ResolvedChat | null {
    const provider = getProvider(providerId);
    if (!provider || !isProviderAvailable(provider)) return null;
    const canonicalModelId = canonicalChatModelId(provider.id, modelId);
    const model = provider.chatModels.find((m) => m.id === canonicalModelId || m.name === canonicalModelId);
    return model && !chatModelUnavailableReason(model) ? { provider, model } : null;
}

// On 18/11/2026 NIM took about 110 s to start a GLM-5.3 Flash reply, past the 60 s request timeout.
export const MESSAGING_MODEL_CHAIN: { providerId: string; modelId: string }[] = [
    { providerId: "nvidia-nim", modelId: "nvidia/nemotron-3-ultra-550b-a55b" },
    { providerId: "nvidia-nim", modelId: "z-ai/glm-5.3-flash" },
    { providerId: "gemini", modelId: "gemini-3.8-flash" },
];

// Gemini is reserved for the worker's explicit final fallback.
const WORKER_PREFERRED: { providerId: string; modelId: string }[] = [
    { providerId: "nvidia-nim", modelId: "nvidia/nemotron-3.5-lightning-30b-a3b" },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3.5-lightning:free" },
    { providerId: "nvidia-nim", modelId: "z-ai/glm-5.3-flash" },
];

// Paid Gemini for workers, sized to subtask complexity: the fallback after free
// workers fail, and the only model on a paid-only run.
export const WORKER_GEMINI_FALLBACK = {
    simple: "gemini-3.5-flash-lite",
    complex: "gemini-3.8-flash",
} as const;

export function resolveWorkerChain(needsTools: boolean): ResolvedChat[] {
    const out: ResolvedChat[] = [];
    const seen = new Set<string>();
    const push = (r: ResolvedChat | null) => {
        if (!r || chatModelUnavailableReason(r.model) || r.provider.metered || r.model.metered || (needsTools && !r.model.supportsTools)) return;
        const key = `${r.provider.id}::${r.model.id}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(r);
        }
    };

    for (const c of WORKER_PREFERRED) push(resolveAvailable(c.providerId, c.modelId));
    for (const provider of providers()) {
        if (provider.kind === "gemini" || provider.metered || !isProviderAvailable(provider)) continue;
        for (const model of provider.chatModels) {
            if (!model.metered && model.supportsTools && automaticRouteEligible(model) && workerFast(model)) {
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
    for (const provider of providers()) {
        if (provider.metered || !isProviderAvailable(provider)) continue;
        const model = provider.chatModels.find((m) => m.catalogue && m.catalogue.origin !== "code" && m.catalogue.approved
            && m.free === true && m.supportsTools && !chatModelUnavailableReason(m));
        if (model) return { provider, model };
    }
    return resolveChat();
}

// Google keeps paid-tier prompts out of training; free routes may train on them.
// Matched by provider id, not kind: "gemini-free" is Gemini on the free tier.
const PAID_CHAT = { providerId: "gemini", modelId: "gemini-3.5-flash-lite" };

/** A stored choice already on the paid key, else the paid default. Throws rather than fall back to a free route. */
export function resolvePaidChat(storedKey?: string | null): ResolvedChat {
    const stored = resolveModelKey(storedKey);
    return stored?.provider.id === PAID_CHAT.providerId ? stored : resolveChat(PAID_CHAT.providerId, PAID_CHAT.modelId);
}

export function resolveModelKey(key?: string | null): ResolvedChat | null {
    if (!key || !key.includes("::")) return null;
    const idx = key.indexOf("::");
    return resolveAvailable(key.slice(0, idx), key.slice(idx + 2));
}

function findAvailableProvider(arg: string): ProviderConfig | undefined {
    const a = arg.trim().toLowerCase();
    const provider = providers().find((p) => p.id.toLowerCase() === a || p.label.toLowerCase() === a);
    return provider && isProviderAvailable(provider) ? provider : undefined;
}

export function resolveChatByName(providerArg: string, modelArg: string): ResolvedChat | null {
    const provider = findAvailableProvider(providerArg);
    if (!provider) return null;
    const m = canonicalChatModelId(provider.id, modelArg.trim().toLowerCase()) ?? "";
    const model = provider.chatModels.find(
        (mod) => mod.name.toLowerCase() === m || mod.id.toLowerCase() === m
    );
    return model && !chatModelUnavailableReason(model) ? { provider, model } : null;
}

export function resolveChatModelByName(name: string): ResolvedChat | null {
    const n = name.trim().toLowerCase();
    const aliases: ResolvedChat[] = [];
    for (const provider of providers()) {
        if (!isProviderAvailable(provider)) continue;
        const model = provider.chatModels.find(
            (m) => m.name.toLowerCase() === n || m.id.toLowerCase() === n,
        );
        if (model && !chatModelUnavailableReason(model)) return { provider, model };
        const canonicalName = canonicalChatModelId(provider.id, n);
        const aliased = provider.chatModels.find((m) => m.id === canonicalName);
        if (aliased && !chatModelUnavailableReason(aliased)) aliases.push({ provider, model: aliased });
    }
    return aliases.length === 1 ? aliases[0] : null;
}

/** Picker models for `/model`: untested and failed discovered models never reach `providers()`. */
export function availableChatModels(freeOnly = false): { provider: string; providerId: string; models: { name: string; label: string; status?: "new" | "missing" }[] }[] {
    return providers()
        .filter((p) => isProviderAvailable(p) && p.chatModels.length > 0)
        .map((p) => ({
            provider: p.label,
            providerId: p.id,
            models: p.chatModels.filter((m) => !chatModelUnavailableReason(m) && (!freeOnly || m.free === true)).map((m) => {
                const status = m.catalogue?.status;
                return { name: m.name, label: m.label, ...(status === "new" || status === "missing" ? { status } : {}) };
            }),
        })).filter((p) => p.models.length > 0);
}

export interface ResolvedEmbedding {
    provider: ProviderConfig;
    model: EmbeddingModel;
}

export function resolveEmbedding(modelId?: string): ResolvedEmbedding {
    const wanted = modelId ?? (process.env.KNOWLEDGE_EMBEDDING_MODEL?.trim() || undefined);
    for (const provider of providers()) {
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

export function availableEmbeddingModels(freeOnly = false): { provider: string; providerId: string; models: { name: string; label: string }[] }[] {
    return providers()
        .filter((p) => isProviderAvailable(p) && p.embeddingModels.length > 0)
        .map((p) => ({
            provider: p.label,
            providerId: p.id,
            models: p.embeddingModels.filter((m) => !freeOnly || m.free === true).map((m) => ({ name: m.name, label: m.label })),
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
    return providers().map((p) => ({
        id: p.id,
        label: p.label,
        available: isProviderAvailable(p),
        unavailableReason: p.unavailableReason,
        chatModelAliases: LEGACY_CHAT_MODELS[p.id] ?? {},
        chatModels: p.chatModels.filter((m) => !chatModelUnavailableReason(m)).map((m) => ({
            id: m.id,
            label: m.label,
            free: m.free === true,
            supportsTools: m.supportsTools,
            supportsVision: m.supportsVision,
            supportsThinking: m.supportsThinking,
            supportsSearch: m.supportsSearch,
            supportsStructuredOutput: m.supportsStructuredOutput ?? false,
            maxOutputTokens: m.maxOutputTokens ?? UNVERIFIED_MAX_OUTPUT_TOKENS,
            meta: getModelMeta(m.id),
            origin: m.catalogue?.origin ?? "code",
            approved: automaticRouteEligible(m),
            status: m.catalogue?.status ?? null,
        })),
        unavailableChatModels: p.chatModels.filter((m) => chatModelUnavailableReason(m)).map((m) => ({
            id: m.id,
            label: m.label,
            free: m.free === true,
            reason: chatModelUnavailableReason(m)!,
        })),
        embeddingModels: p.embeddingModels.map((m) => ({
            id: m.id,
            label: m.label,
            free: m.free === true,
            dimension: m.dimension,
            meta: getModelMeta(m.id),
        })),
    }));
}
