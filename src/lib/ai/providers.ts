import { getModelMeta } from "@/lib/ai/model-meta";
import { uniqueShortName, type ProviderDiscovery } from "@/lib/ai/catalogue/sources";
import { catalogueSnapshot, rowKind, type CatalogueOrigin, type CatalogueRow, type ExpiresSource } from "@/lib/ai/catalogue/snapshot";
import { statsKey, statsSnapshot } from "@/lib/ai/models/stats";
import { modelView, resolveSpeed, resolveTags } from "@/lib/ai/models/view";
import { removedModelKeys } from "@/lib/ai/models/profiles";
import { providerKeyOrEnv, storedProviderKey } from "@/lib/ai/provider-keys/snapshot";

export type ProviderKind = "gemini" | "openai-compatible";

/** Present when the stored catalogue has a row for this model. */
export interface ChatModelCatalogue {
    origin: "code" | CatalogueOrigin;
    approved: boolean;
    status: "new" | "missing" | "failing" | null;
    probeChatMs: number | null;
    /** Removed from the selectable list on the dashboard. */
    removed?: boolean;
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
    // Still resolves by id for stored vectors and overrides, but is never offered or picked by name.
    retired?: boolean;
    /** Sent to the API when `id` names a reduced-dimension partition (`<model id>@<dimension>`). */
    apiId?: string;
    /** Send input_type on OpenAI-shaped routes. NIM always gets it; Gemini gets a task type. */
    inputType?: boolean;
    /** An array of inputs returns one vector per input, in order (probed). */
    batch?: boolean;
    /** Knowledge partition id this route reproduces exactly (probed, then approved). */
    spaceOf?: string | null;
    catalogue?: TypedModelCatalogue;
}

/** Present when the stored catalogue has a row for an embedding, speech or transcription model. */
export interface TypedModelCatalogue {
    origin: "code" | CatalogueOrigin;
    approved: boolean;
    status: "new" | "missing" | "failing" | null;
    /** Per embedding call, first audio, or the transcript, from the last probe. */
    probeMs: number | null;
    expiresAt: string | null;
    expiresSource: ExpiresSource | null;
}

export interface SpeechModel {
    id: string;
    label: string;
    free: boolean;
    voices: string[];
    defaultVoice?: string;
    sampleRate?: number;
    /** "pcm" or "wav", from the probe. */
    audioFormat?: string;
    catalogue: TypedModelCatalogue;
}

export interface TranscriptionModel {
    id: string;
    label: string;
    free: boolean;
    /** Share of the probe clip's words heard in order. */
    accuracy?: number;
    catalogue: TypedModelCatalogue;
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
    /** Tokens per minute per model on the provider's free plan; ./request-budget keeps requests inside it. */
    requestTokenLimit?: number;
    discovery?: ProviderDiscovery;
    chatModels: ChatModel[];
    embeddingModels: EmbeddingModel[];
    /** Catalogue rows only (none in code); absent until merged. */
    speechModels?: SpeechModel[];
    transcriptionModels?: TranscriptionModel[];
}

// Pins and audited quirks only. Every other chat model comes from the catalogue (catalogue/snapshot.ts),
// so without a loaded snapshot the picker shows these alone.
export const PROVIDERS: ProviderConfig[] = [
    {
        id: "gemini",
        label: "Google Gemini",
        kind: "gemini",
        apiKeyEnv: "GEMINI_API_KEY",
        discovery: { source: "gemini", include: "all", pricing: "all-paid", kinds: { speech: { include: "all" }, transcription: { include: "all" } } },
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
        discovery: { source: "gemini", include: "all", pricing: "all-free", nameSuffix: "-free", kinds: { embedding: { include: "all" }, speech: { include: "all" }, transcription: { include: "all" } } },
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
        discovery: { source: "openrouter", include: "free", pricing: "listed", kinds: { embedding: { include: "free" }, speech: { include: "all" }, transcription: { include: "all" } } },
        chatModels: [
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
            // Forced tool calls (explicit Search) timed out on this route on 23/09/2026; this overrides the probe.
            { free: true, id: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning (free)", name: "nemotron-3.5-lightning", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: false, maxOutputTokens: 65536 },
        ],
        embeddingModels: [],
    },
    {
        id: "nvidia-nim",
        label: "NVIDIA NIM",
        kind: "openai-compatible",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyEnv: "NVIDIA_NIM_API_KEY",
        discovery: { source: "openai-list", include: "all", pricing: "all-free", kinds: { embedding: { include: "all" } } },
        chatModels: [
            { free: true, id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra (free)", name: "nemotron-3-ultra", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, supportsStructuredOutput: true, maxOutputTokens: 131072 },
            { free: true, id: "z-ai/glm-5.3-flash", label: "GLM-5.3 Flash (free)", name: "glm-5.3-flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true },
            { free: true, id: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "Nemotron 3.5 Lightning (free)", name: "nemotron-3.5-lightning", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true },
        ],
        embeddingModels: [
            { free: true, id: "nvidia/nemotron-3.5-embed-1b", label: "Nemotron 3.5 Embed 1B (free, 2048d)", name: "nemotron-3.5-embed-1b", dimension: 2048 },
            // Retired by NVIDIA 23/11/2026 09:00 UTC (HTTP 410). Kept registered so a store or override still on it
            // resolves instead of throwing until the re-embed moves it; it cannot embed anything new.
            { free: true, id: "nvidia/nemotron-3-embed-1b", label: "Nemotron 3 Embed 1B (retired 23/11/2026)", name: "nemotron-3-embed-1b", dimension: 2048, retired: true },
        ],
    },
    {
        // No built-in models: the three free ones are catalogue seeds (v7-provider-keys.sql), so automatic
        // routes wait for Approve. The free tier allows 8K tokens per minute (checked 19/11/2026).
        id: "groq",
        label: "Groq",
        kind: "openai-compatible",
        baseUrl: "https://api.groq.com/openai/v1",
        apiKeyEnv: "GROQ_API_KEY",
        requestTokenLimit: 8000,
        discovery: { source: "openai-list", include: "all", pricing: "all-free", kinds: { speech: { include: "all" }, transcription: { include: "all" } } },
        chatModels: [],
        embeddingModels: [],
    },
    {
        // $0 is an early-user "experience price" with no end date, and no data-use policy is published
        // (checked 21/11/2026). No built-in models: discovery adds them once a key is saved.
        id: "agnes",
        label: "Agnes AI",
        kind: "openai-compatible",
        baseUrl: "https://apihub.agnes-ai.com/v1",
        apiKeyEnv: "AGNES_API_KEY",
        discovery: { source: "openai-list", include: "all", pricing: "all-free", exclude: /(image|video)/ },
        chatModels: [],
        embeddingModels: [],
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
        // Paid only: free models answer 403 outside OpenCode (checked 19/11/2026). Models come from discovery
        // once a key is saved, and each needs Test before use. Id kept so call history keeps its provider.
        id: "opencode-zen",
        label: "OpenCode Console",
        kind: "openai-compatible",
        baseUrl: "https://opencode.ai/inference/openai/v1",
        apiKeyEnv: "OPENCODE_API_KEY",
        metered: true,
        discovery: { source: "opencode", include: "all", pricing: "listed" },
        chatModels: [],
        embeddingModels: [],
    },
    {
        id: "tokenrouter",
        label: "TokenRouter",
        kind: "openai-compatible",
        baseUrl: "https://api.tokenrouter.com/v1",
        apiKeyEnv: "TOKENROUTER_API_KEY",
        unavailableReason: "No usable free endpoint for the configured key (checked 23/09/2026).",
        chatModels: [],
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
};

// Saved ids with no replacement: OpenCode's free models, which answer 403 outside OpenCode (19/11/2026).
const RETIRED_CHAT_MODELS: Record<string, readonly string[]> = {
    // 2.0 is deprecated and 2.5 goes offline on 30/11/2026 (Agnes docs, 21/11/2026).
    agnes: ["agnes-2.0-flash", "agnes-2.5-flash"],
    "opencode-zen": [
        "mimo-v2.6-flash-free", "nemotron-3-ultra-free", "nemotron-3.5-lightning-free", "muse-spark-1.3-contributor-free",
        "mimo-v2.5-free", "deepseek-v4-flash-free", "laguna-s-2.1-free", "ling-3.0-flash-free",
    ],
};

/** A saved choice of a retired model falls back to the default instead of erroring. */
export function isRetiredChatModel(providerId?: string, modelId?: string): boolean {
    return !!providerId && !!modelId && (RETIRED_CHAT_MODELS[providerId]?.includes(modelId) ?? false);
}

/** Saved ids that resolve to a replacement or are retired; discovery must not list them as models of their own. */
export function retiredChatModelIds(providerId: string): Set<string> {
    return new Set([...Object.keys(LEGACY_CHAT_MODELS[providerId] ?? {}), ...(RETIRED_CHAT_MODELS[providerId] ?? [])]);
}

function canonicalChatModelId(providerId: string, modelId?: string): string | undefined {
    if (!modelId) return modelId;
    return LEGACY_CHAT_MODELS[providerId]?.[modelId] ?? modelId;
}
// Changing the embedding space re-embeds the store: the switch job on /admin#models, or scripts/reembed-knowledge.ts.
export const DEFAULT_EMBEDDING = { providerId: "nvidia-nim", modelId: "nvidia/nemotron-3.5-embed-1b" };

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

function typedCatalogue(row: CatalogueRow, origin: TypedModelCatalogue["origin"], approved: boolean): TypedModelCatalogue {
    return {
        origin, approved,
        status: row.missingSince ? "missing" : row.probeStatus === "failed" ? "failing" : approved ? null : "new",
        probeMs: row.probeChatMs, expiresAt: row.expiresAt ?? null, expiresSource: row.expiresSource ?? null,
    };
}

/** A 410 from the provider; code and catalogue then agree the model can embed nothing new. */
function rowGone(row: CatalogueRow): boolean {
    return row.expiresSource === "gone";
}

function joins(row: CatalogueRow): boolean {
    return row.approvedAt !== null || row.probeStatus === "passed";
}

function mergeTyped(provider: ProviderConfig, own: readonly CatalogueRow[]): Pick<ProviderConfig, "embeddingModels" | "speechModels" | "transcriptionModels"> {
    const byId = new Map(own.filter((row) => rowKind(row) === "embedding").map((row) => [row.modelId, row]));
    const embeddingModels: EmbeddingModel[] = provider.embeddingModels.map((model) => {
        const row = byId.get(model.id);
        if (!row) return model;
        const traits = row.traits ?? {};
        return {
            ...model,
            ...(rowGone(row) ? { retired: true } : {}),
            ...(model.inputType === undefined && traits.acceptsInputType !== undefined ? { inputType: traits.acceptsInputType } : {}),
            ...(traits.batch !== undefined ? { batch: traits.batch } : {}),
            spaceOf: row.spaceOf ?? null,
            catalogue: typedCatalogue(row, "code", true),
        };
    });
    const taken = new Set(embeddingModels.map((model) => model.name));
    const codeIds = new Set(embeddingModels.map((model) => model.id));
    for (const row of [...byId.values()].sort((a, b) => a.label.localeCompare(b.label))) {
        if (codeIds.has(row.modelId) || !joins(row) || !row.dimension) continue;
        const name = uniqueShortName(row.shortName, taken);
        taken.add(name);
        const traits = row.traits ?? {};
        embeddingModels.push({
            id: row.modelId, label: row.label, name, free: row.free, dimension: row.dimension,
            ...(rowGone(row) ? { retired: true } : {}),
            inputType: traits.acceptsInputType ?? false, batch: traits.batch ?? false, spaceOf: row.spaceOf ?? null,
            catalogue: typedCatalogue(row, row.origin, row.approvedAt !== null),
        });
    }
    const typed = (kind: "speech" | "transcription") => own.filter((row) => rowKind(row) === kind && joins(row) && !rowGone(row)).sort((a, b) => a.label.localeCompare(b.label));
    const speechModels: SpeechModel[] = typed("speech").map((row) => ({
        id: row.modelId, label: row.label, free: row.free, voices: row.traits?.voices ?? [],
        ...(row.traits?.defaultVoice ? { defaultVoice: row.traits.defaultVoice } : {}),
        ...(row.traits?.sampleRate ? { sampleRate: row.traits.sampleRate } : {}),
        ...(row.traits?.audioFormat ? { audioFormat: row.traits.audioFormat } : {}),
        catalogue: typedCatalogue(row, row.origin, row.approvedAt !== null),
    }));
    const transcriptionModels: TranscriptionModel[] = typed("transcription").map((row) => ({
        id: row.modelId, label: row.label, free: row.free,
        ...(row.traits?.accuracy !== undefined ? { accuracy: row.traits.accuracy } : {}),
        catalogue: typedCatalogue(row, row.origin, row.approvedAt !== null),
    }));
    return { embeddingModels, speechModels, transcriptionModels };
}

/** Code entries win field by field; rows add discovered models and status. Untested or failed rows stay out unless approved. */
export function mergeCatalogue(config: readonly ProviderConfig[], allRows: readonly CatalogueRow[], removed: ReadonlySet<string> = new Set()): ProviderConfig[] {
    if (!allRows.length) return [...config];
    const rows = allRows.filter((row) => rowKind(row) === "chat");
    return config.map((base) => {
        const typedRows = allRows.filter((row) => row.providerId === base.id && rowKind(row) !== "chat");
        const provider = typedRows.length ? { ...base, ...mergeTyped(base, typedRows) } : base;
        const own = rows.filter((row) => row.providerId === provider.id);
        if (!own.length) return provider;
        const byId = new Map(own.map((row) => [row.modelId, row]));
        const retired = retiredChatModelIds(provider.id);
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
                    ...(removed.has(`${provider.id}::${model.id}`) ? { removed: true } : {}),
                },
            };
        });
        const taken = new Set(chatModels.map((model) => model.name));
        const codeIds = new Set(chatModels.map((model) => model.id));
        const added = own
            .filter((row) => !codeIds.has(row.modelId) && !retired.has(row.modelId)
                && (row.approvedAt !== null || row.probeStatus === "passed"))
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((row) => {
                const name = uniqueShortName(row.shortName, taken);
                taken.add(name);
                const model = chatModelFromRow(row, name);
                return removed.has(`${provider.id}::${row.modelId}`) ? { ...model, catalogue: { ...model.catalogue!, removed: true } } : model;
            });
        return { ...provider, chatModels: [...chatModels, ...added] };
    });
}

let mergedProviders: { version: number; list: ProviderConfig[] } | null = null;

/** Code providers merged with the stored catalogue. Synchronous: reads the in-memory snapshot. */
export function providers(): ProviderConfig[] {
    const snapshot = catalogueSnapshot();
    if (mergedProviders?.version !== snapshot.version) {
        mergedProviders = { version: snapshot.version, list: mergeCatalogue(PROVIDERS, [...snapshot.rows, ...snapshot.typedRows], removedModelKeys(snapshot.profiles)) };
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

/** A key saved on the dashboard wins over the env var. */
export function getProviderApiKey(p: ProviderConfig): string | undefined {
    return providerKeyOrEnv(p.id, p.apiKeyEnv);
}

export function providerKeySource(p: ProviderConfig): "dashboard" | "environment" | null {
    if (storedProviderKey(p.id)) return "dashboard";
    return process.env[p.apiKeyEnv] ? "environment" : null;
}

export function isProviderAvailable(p: ProviderConfig): boolean {
    return !p.unavailableReason && !!getProviderApiKey(p);
}

/** False for models this app cannot call yet (Responses API only). */
export function chatModelUsable(model: ChatModel): boolean {
    return !chatModelUnavailableReason(model);
}

export const REMOVED_MODEL_REASON = "Removed from the model list on the dashboard.";

/** Why a model cannot be removed from the selectable list, or null when it can. */
export function removalBlockedReason(providerId: string, modelId: string): string | null {
    // Kept selectable so resolveChat() and resolvePaidChat() always resolve.
    const pinned = [DEFAULT_CHAT, PAID_CHAT].some((ref) => ref.providerId === providerId && ref.modelId === modelId);
    return pinned ? "The app's default chat model cannot be removed." : null;
}

/** Every selection path, automatic or by name, skips a model with a reason. */
export function chatModelUnavailableReason(model: ChatModel): string | undefined {
    if (model.apiFormat === "responses") return "Requires the Responses API, which this app does not yet support.";
    return model.catalogue?.removed ? REMOVED_MODEL_REASON : undefined;
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
export const WORKER_PREFERRED: readonly { providerId: string; modelId: string }[] = [
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
export const PAID_CHAT = { providerId: "gemini", modelId: "gemini-3.5-flash-lite" };

/** A stored choice already on the paid key, else the paid default. Throws rather than fall back to a free route. */
export function resolvePaidChat(storedKey?: string | null): ResolvedChat {
    const stored = resolveModelKey(storedKey);
    return stored?.provider.id === PAID_CHAT.providerId ? stored : resolveChat(PAID_CHAT.providerId, PAID_CHAT.modelId);
}

export function resolveModelKey(key?: string | null): ResolvedChat | null {
    if (!key || !key.includes("::")) return null;
    const idx = key.indexOf("::");
    const providerId = key.slice(0, idx);
    const modelId = key.slice(idx + 2);
    if (isRetiredChatModel(providerId, modelId)) {
        console.warn(`[Chat] Saved model ${key} is retired; using the default.`);
        return null;
    }
    return resolveAvailable(providerId, modelId);
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
export function availableChatModels(freeOnly = false): { provider: string; providerId: string; models: { id: string; name: string; label: string; status?: "new" | "missing" }[] }[] {
    return providers()
        .filter((p) => isProviderAvailable(p) && p.chatModels.length > 0)
        .map((p) => ({
            provider: p.label,
            providerId: p.id,
            models: p.chatModels.filter((m) => !chatModelUnavailableReason(m) && (!freeOnly || m.free === true)).map((m) => {
                const status = m.catalogue?.status;
                return { id: m.id, name: m.name, label: m.label, ...(status === "new" || status === "missing" ? { status } : {}) };
            }),
        })).filter((p) => p.models.length > 0);
}

export interface ResolvedEmbedding {
    provider: ProviderConfig;
    model: EmbeddingModel;
}

const PARTITION_DIMENSION = /^(.+)@(\d{1,5})$/;

/** `<model id>@<dimension>` names a reduced-dimension partition; a bare id is the model at its native dimension. */
export function parsePartitionId(partitionId: string): { modelId: string; dimension: number | null } {
    const match = PARTITION_DIMENSION.exec(partitionId);
    return match ? { modelId: match[1], dimension: Number(match[2]) } : { modelId: partitionId, dimension: null };
}

export function partitionIdFor(modelId: string, dimension: number | null | undefined, nativeDimension: number): string {
    return dimension && dimension !== nativeDimension ? `${modelId}@${dimension}` : modelId;
}

/** Resolves a knowledge partition id to a route; `providerId` is preferred when it serves that model. */
export function resolveEmbedding(partitionId?: string, providerId?: string): ResolvedEmbedding {
    const wanted = partitionId ?? (process.env.KNOWLEDGE_EMBEDDING_MODEL?.trim() || undefined);
    if (wanted === undefined) {
        const g = getProvider(DEFAULT_EMBEDDING.providerId)!;
        const model = g.embeddingModels.find((m) => m.id === DEFAULT_EMBEDDING.modelId) ?? g.embeddingModels[0]!;
        return { provider: g, model };
    }
    const { modelId, dimension } = parsePartitionId(wanted);
    const list = providers();
    const ordered = providerId ? [...list.filter((p) => p.id === providerId), ...list.filter((p) => p.id !== providerId)] : list;
    for (const provider of ordered) {
        const model = provider.embeddingModels.find((m) => m.id === modelId);
        if (!model) continue;
        if (!dimension) return { provider, model };
        // An explicit size names its own partition, even at the model's native size (two providers can share an id).
        return { provider, model: { ...model, id: wanted, apiId: model.id, name: `${model.name}@${dimension}`, label: `${model.label}, ${dimension}d`, dimension } };
    }
    throw new Error(`Unknown embedding model: ${wanted}. Switch the knowledge model on the dashboard, which re-embeds the store.`);
}

export function resolveEmbeddingByName(providerArg: string, modelArg: string): ResolvedEmbedding | null {
    const provider = findAvailableProvider(providerArg);
    if (!provider) return null;
    const m = modelArg.trim().toLowerCase();
    const model = provider.embeddingModels.find(
        (mod) => !mod.retired && (mod.name.toLowerCase() === m || mod.id.toLowerCase() === m)
    );
    return model ? { provider, model } : null;
}

export function availableEmbeddingModels(freeOnly = false): { provider: string; providerId: string; models: { name: string; label: string }[] }[] {
    return providers()
        .filter((p) => isProviderAvailable(p) && p.embeddingModels.some((m) => !m.retired))
        .map((p) => ({
            provider: p.label,
            providerId: p.id,
            models: p.embeddingModels.filter((m) => !m.retired && (!freeOnly || m.free === true)).map((m) => ({ name: m.name, label: m.label })),
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

export function listProvidersPublic() {
    const catalogue = catalogueSnapshot(), stats = statsSnapshot();
    const rows = new Map(catalogue.rows.map((row) => [statsKey(row.providerId, row.modelId), row]));
    const profiles = new Map(catalogue.profiles.map((profile) => [statsKey(profile.providerId, profile.modelId), profile]));
    return providers().map((p) => ({
        id: p.id,
        label: p.label,
        available: isProviderAvailable(p),
        unavailableReason: p.unavailableReason,
        chatModelAliases: LEGACY_CHAT_MODELS[p.id] ?? {},
        chatModels: p.chatModels.filter((m) => !chatModelUnavailableReason(m)).map((m) => {
            const key = statsKey(p.id, m.id), profile = profiles.get(key), row = rows.get(key), speed = resolveSpeed(p.id, m, stats.speed);
            return {
                id: m.id,
                label: m.label,
                free: m.free === true,
                supportsTools: m.supportsTools,
                supportsVision: m.supportsVision,
                supportsThinking: m.supportsThinking,
                supportsSearch: m.supportsSearch,
                supportsStructuredOutput: m.supportsStructuredOutput ?? false,
                maxOutputTokens: m.maxOutputTokens ?? UNVERIFIED_MAX_OUTPUT_TOKENS,
                meta: modelView(m, profile, row, speed),
                origin: m.catalogue?.origin ?? "code",
                approved: automaticRouteEligible(m),
                status: m.catalogue?.status ?? null,
                tags: resolveTags(m, profile, row).tags,
                speed,
            };
        }),
        unavailableChatModels: p.chatModels.filter((m) => !m.catalogue?.removed && chatModelUnavailableReason(m)).map((m) => ({
            id: m.id,
            label: m.label,
            free: m.free === true,
            reason: chatModelUnavailableReason(m)!,
        })),
        embeddingModels: p.embeddingModels.filter((m) => !m.retired).map((m) => ({
            id: m.id,
            label: m.label,
            free: m.free === true,
            dimension: m.dimension,
            meta: getModelMeta(m.id),
            origin: m.catalogue?.origin ?? "code",
            status: m.catalogue?.status ?? null,
            spaceOf: m.spaceOf ?? null,
        })),
        speechModels: (p.speechModels ?? []).map((m) => ({ id: m.id, label: m.label, free: m.free, voices: m.voices, approved: m.catalogue.approved, status: m.catalogue.status })),
        transcriptionModels: (p.transcriptionModels ?? []).map((m) => ({ id: m.id, label: m.label, free: m.free, approved: m.catalogue.approved, status: m.catalogue.status })),
    }));
}
