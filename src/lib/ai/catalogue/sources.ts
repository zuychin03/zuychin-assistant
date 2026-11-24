import type { ProviderConfig } from "@/lib/ai/providers";

export type DiscoverySource = "openrouter" | "kilo" | "gemini" | "openai-list" | "opencode";

export type ModelKind = "chat" | "embedding" | "speech" | "transcription";
export type NonChatKind = Exclude<ModelKind, "chat">;
export const MODEL_KINDS: readonly ModelKind[] = ["chat", "embedding", "speech", "transcription"];
export const NON_CHAT_KINDS: readonly NonChatKind[] = ["embedding", "speech", "transcription"];

export interface ProviderDiscovery {
    source: DiscoverySource;
    /** "free" keeps only models the list marks as free; aggregator paid catalogues run to 400+ entries. */
    include: "free" | "all";
    /** "listed" reads the price from the list; the others apply to every model on the key. */
    pricing: "listed" | "all-free" | "all-paid";
    nameSuffix?: string;
    /** Ids the list carries that are not chat models and that the shared filters miss. */
    exclude?: RegExp;
    /** Non-chat kinds this provider tracks; a kind left out is never stored. */
    kinds?: Partial<Record<NonChatKind, { include: "free" | "all" }>>;
}

export interface ListedModel {
    modelId: string;
    label: string;
    description: string | null;
    developer: string | null;
    free: boolean;
    contextTokens: number | null;
    maxOutputTokens: number | null;
    inputs: string[];
    listedTools: boolean | null;
    listedStructured: boolean | null;
    listedThinking: boolean | null;
    mayTrain: boolean | null;
    /** Text-out chat model by the list's own description, before any probe. */
    chat: boolean;
    /** What the list says the model does; null for kinds the app never uses (image, video, rerank, live audio). */
    kind: ModelKind | null;
    /** Retirement date the list publishes (OpenRouter `expiration_date`), as an ISO timestamp. */
    expiresAt: string | null;
    /** Voice ids the list publishes for a speech model. */
    voices: string[];
    /** The model behind a route (OpenRouter `hugging_face_id`, else the id without vendor and `:free`), for same-space checks. */
    familyId: string;
}

export type ListingResult =
    | { ok: true; models: ListedModel[] }
    | { ok: false; status: number | null; error: string };

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";
const LISTING_TIMEOUT_MS = 20_000;
const MAX_DESCRIPTION = 400;

const ROUTER_IDS = /^(openrouter|kilo-auto)\//;
const GEMINI_NON_CHAT = /(tts|image|imagen|veo|lyria|embedding|aqa|live|native-audio|robotics|computer-use|nano-banana|transcribe|deep-research|antigravity|customtools|-latest$)/;
const OPENAI_LIST_NON_CHAT = /(embed|rerank|guard|safety|reward|parse|retriever|nvclip|detector|whisper|orpheus|tts|playai)/;
const OPENAI_LIST_EMBEDDING = /embed/;
const OPENAI_LIST_NOT_EMBEDDING = /(rerank|clip)/;
const OPENAI_LIST_SPEECH = /(tts|orpheus|playai)/;
const OPENAI_LIST_TRANSCRIPTION = /(whisper|transcri|parakeet|canary|(^|[-/])asr([-/]|$))/;
const GEMINI_SPEECH = /-tts(-|$)/;
const GEMINI_TRANSCRIPTION = /transcribe/;
const GEMINI_LIVE = /(live|native-audio)/;

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
function count(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
function inputNames(value: unknown): string[] {
    return strings(value).map((entry) => entry.toLowerCase() === "pdf" ? "PDF" : entry.charAt(0).toUpperCase() + entry.slice(1).toLowerCase());
}
function description(value: unknown): string | null {
    const raw = text(value);
    return raw && raw.length > MAX_DESCRIPTION ? `${raw.slice(0, MAX_DESCRIPTION - 3).trimEnd()}...` : raw;
}
function vendorFromId(id: string): string | null {
    const slash = id.indexOf("/");
    return slash > 0 ? id.slice(0, slash) : null;
}

/** "nvidia/nemotron-3.5-embed-1b:free" and "nvidia/nemotron-3.5-embed-1b" -> "nemotron-3.5-embed-1b". */
export function familyFromId(id: string): string {
    return id.slice(id.lastIndexOf("/") + 1).replace(/:free$/, "").replace(/-free$/, "").toLowerCase();
}

/** A listed date ("2026-11-30" or a full timestamp) as an ISO timestamp, or null. */
function listedDate(value: unknown): string | null {
    const raw = text(value);
    if (!raw) return null;
    const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function openAiListKind(id: string, chat: boolean): ModelKind | null {
    if (chat) return "chat";
    if (OPENAI_LIST_EMBEDDING.test(id) && !OPENAI_LIST_NOT_EMBEDDING.test(id)) return "embedding";
    if (OPENAI_LIST_TRANSCRIPTION.test(id)) return "transcription";
    if (OPENAI_LIST_SPEECH.test(id)) return "speech";
    return null;
}

/** Strips "Vendor: " and a trailing "(free)", then re-adds "(free)" when it applies. */
export function cleanLabel(raw: string, free: boolean): string {
    const base = raw.replace(/^[^:]{1,40}:\s+/, "").replace(/\s*\(free\)\s*$/i, "").trim() || raw.trim();
    return free ? `${base} (free)` : base;
}

/** "z-ai/glm-5.3-flash" -> "Glm 5.3 Flash", for lists that carry no display name. */
export function labelFromId(id: string): string {
    const tail = id.slice(id.lastIndexOf("/") + 1).replace(/:free$/, "").replace(/-free$/, "");
    return tail.split("-").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

/** Short name for /model and name lookups; callers make it unique within a provider. */
export function shortNameFor(id: string, suffix = ""): string {
    const tail = id.slice(id.lastIndexOf("/") + 1).replace(/:free$/, "").replace(/-free$/, "").toLowerCase();
    return `${tail}${suffix}`;
}

export function uniqueShortName(base: string, taken: ReadonlySet<string>): string {
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function aggregatorModel(entry: Record<string, unknown>, free: boolean, mayTrain: boolean | null): ListedModel | null {
    const id = text(entry.id);
    if (!id) return null;
    const architecture = record(entry.architecture);
    const outputs = strings(architecture.output_modalities);
    const inputs = strings(architecture.input_modalities);
    const params = strings(entry.supported_parameters);
    const top = record(entry.top_provider);
    const name = text(entry.name);
    const chat = !ROUTER_IDS.test(id) && outputs.length === 1 && outputs[0] === "text" && (inputs.length === 0 || inputs.includes("text"));
    const only = outputs.length === 1 ? outputs[0] : null;
    const kind: ModelKind | null = chat ? "chat" : only === "embeddings" ? "embedding" : only === "speech" ? "speech" : only === "transcription" ? "transcription" : null;
    return {
        modelId: id,
        label: cleanLabel(name ?? labelFromId(id), free),
        description: description(entry.description),
        developer: name?.includes(": ") ? name.slice(0, name.indexOf(": ")) : vendorFromId(id),
        free,
        contextTokens: count(entry.context_length) ?? count(top.context_length),
        maxOutputTokens: count(top.max_completion_tokens),
        inputs: inputNames(inputs),
        listedTools: params.includes("tools"),
        listedStructured: params.includes("structured_outputs"),
        listedThinking: params.includes("reasoning"),
        mayTrain,
        chat,
        kind,
        expiresAt: listedDate(entry.expiration_date),
        voices: strings(entry.supported_voices),
        familyId: (text(entry.hugging_face_id) ? familyFromId(text(entry.hugging_face_id)!) : familyFromId(id)),
    };
}

export function parseOpenRouterModels(raw: unknown): ListedModel[] {
    return (Array.isArray(record(raw).data) ? record(raw).data as unknown[] : []).flatMap((value) => {
        const entry = record(value);
        const pricing = record(entry.pricing);
        const model = aggregatorModel(entry, pricing.prompt === "0" && pricing.completion === "0", null);
        return model ? [model] : [];
    });
}

export function parseKiloModels(raw: unknown): ListedModel[] {
    return (Array.isArray(record(raw).data) ? record(raw).data as unknown[] : []).flatMap((value) => {
        const entry = record(value);
        const model = aggregatorModel(entry, entry.isFree === true, typeof entry.mayTrainOnYourPrompts === "boolean" ? entry.mayTrainOnYourPrompts : null);
        return model ? [model] : [];
    });
}

export function parseGeminiModels(raw: unknown, free: boolean): ListedModel[] {
    return (Array.isArray(record(raw).models) ? record(raw).models as unknown[] : []).flatMap((value) => {
        const entry = record(value);
        const id = text(entry.name)?.replace(/^models\//, "");
        if (!id) return [];
        const methods = strings(entry.supportedGenerationMethods);
        const chat = methods.includes("generateContent") && !GEMINI_NON_CHAT.test(id);
        const generates = methods.includes("generateContent") && !GEMINI_LIVE.test(id);
        const kind: ModelKind | null = chat ? "chat"
            : methods.includes("embedContent") ? "embedding"
                : generates && GEMINI_SPEECH.test(id) ? "speech"
                    : generates && GEMINI_TRANSCRIPTION.test(id) ? "transcription" : null;
        return [{
            modelId: id,
            label: cleanLabel(text(entry.displayName) ?? labelFromId(id), free),
            description: description(entry.description),
            developer: "Google",
            free,
            contextTokens: count(entry.inputTokenLimit),
            // Embedding models list an output limit of 1.
            maxOutputTokens: kind === "embedding" ? null : count(entry.outputTokenLimit),
            inputs: [],
            listedTools: null,
            listedStructured: null,
            listedThinking: typeof entry.thinking === "boolean" ? entry.thinking : null,
            // Google may train on free-tier requests and keeps paid-tier ones out of training.
            mayTrain: free,
            chat,
            kind,
            expiresAt: null,
            voices: [],
            familyId: familyFromId(id),
        }];
    });
}

/** OpenAI-style `{ data: [{ id }] }`: NVIDIA NIM gives ids only; DeepSeek adds limits and modalities; Groq adds `active` and `max_completion_tokens`. */
export function parseOpenAiModelList(raw: unknown, free: boolean): ListedModel[] {
    return (Array.isArray(record(raw).data) ? record(raw).data as unknown[] : []).flatMap((value) => {
        const entry = record(value);
        const id = text(entry.id);
        if (!id) return [];
        const outputs = strings(entry.output_modalities);
        const chat = entry.active !== false && !OPENAI_LIST_NON_CHAT.test(id) && (outputs.length === 0 || outputs.includes("text"));
        return [{
            modelId: id,
            label: cleanLabel(text(entry.name) ?? labelFromId(id), free),
            description: description(entry.description),
            developer: text(entry.owned_by) ?? vendorFromId(id),
            free,
            contextTokens: count(entry.context_window) ?? count(entry.context_length),
            maxOutputTokens: count(entry.max_output_tokens) ?? count(entry.max_completion_tokens),
            inputs: inputNames(entry.input_modalities),
            listedTools: null,
            listedStructured: null,
            listedThinking: entry.effort !== undefined ? true : null,
            mayTrain: null,
            chat,
            kind: entry.active === false ? null : openAiListKind(id, chat),
            expiresAt: null,
            voices: [],
            familyId: familyFromId(id),
        }];
    });
}

function opencodeInputs(value: unknown): string[] {
    const names = strings(value).map((entry) => {
        const kind = entry.toLowerCase();
        if (kind === "application/pdf") return "PDF";
        const family = kind.split("/")[0];
        return ["text", "image", "audio", "video"].includes(family) ? family.charAt(0).toUpperCase() + family.slice(1) : null;
    });
    return [...new Set(names.filter((name): name is string => name !== null))];
}

/** OpenCode Console list (19/11/2026 shape). Free models answer 403 outside OpenCode and other transports are not wired, so only paid Chat Completions models count as chat. */
export function parseOpenCodeModels(raw: unknown): ListedModel[] {
    return (Array.isArray(record(raw).data) ? record(raw).data as unknown[] : []).flatMap((value) => {
        const entry = record(value);
        const id = text(entry.id);
        if (!id) return [];
        const cost = record(record(entry.cost).text);
        const inputPrice = record(cost.input).price;
        const outputPrice = record(cost.output).price;
        const free = inputPrice === 0 && outputPrice === 0;
        const capabilities = record(entry.capabilities);
        const limit = record(entry.limit);
        const modalities = record(entry.modalities);
        const outputs = strings(modalities.output);
        const tools = record(capabilities.tools).supported;
        const reasoning = record(capabilities.reasoning).supported;
        const chat = !free && entry.type === "chat" && "chat-completions" in record(entry.api)
            && typeof inputPrice === "number" && typeof outputPrice === "number"
            && outputs.length === 1 && outputs[0] === "text";
        return [{
            modelId: id,
            label: cleanLabel(text(entry.name) ?? labelFromId(id), free),
            description: description(entry.description),
            developer: vendorFromId(text(entry.canonical_id) ?? ""),
            free,
            contextTokens: count(limit.context),
            maxOutputTokens: count(limit.output),
            inputs: opencodeInputs(modalities.input),
            listedTools: typeof tools === "boolean" ? tools : null,
            listedStructured: typeof capabilities.structured_output === "boolean" ? capabilities.structured_output : null,
            listedThinking: typeof reasoning === "boolean" ? reasoning : null,
            mayTrain: null,
            chat,
            kind: chat ? "chat" : null,
            expiresAt: null,
            voices: [],
            familyId: familyFromId(id),
        }];
    });
}

export function parseListing(discovery: ProviderDiscovery, raw: unknown): ListedModel[] {
    const keyFree = discovery.pricing === "all-free";
    switch (discovery.source) {
        case "openrouter": return parseOpenRouterModels(raw);
        case "kilo": return parseKiloModels(raw);
        case "gemini": return parseGeminiModels(raw, keyFree);
        case "openai-list": return parseOpenAiModelList(raw, keyFree);
        case "opencode": return parseOpenCodeModels(raw);
    }
}

/** Models of one kind this provider should track (chat by default). `retiredIds` are legacy chat aliases, which must keep resolving to their replacement. */
export function selectDiscoverable(models: readonly ListedModel[], discovery: ProviderDiscovery, retiredIds: ReadonlySet<string> = new Set(), kind: ModelKind = "chat"): ListedModel[] {
    const include = kind === "chat" ? discovery.include : discovery.kinds?.[kind]?.include;
    if (!include) return [];
    const seen = new Set<string>();
    return models.filter((model) => {
        if (model.kind !== kind || seen.has(model.modelId)) return false;
        if (kind === "chat" && (!model.chat || retiredIds.has(model.modelId) || discovery.exclude?.test(model.modelId))) return false;
        if (include === "free" && !model.free) return false;
        seen.add(model.modelId);
        return true;
    });
}

/** Every model this provider tracks, all configured kinds together. */
export function selectAllDiscoverable(models: readonly ListedModel[], discovery: ProviderDiscovery, retiredIds: ReadonlySet<string> = new Set(), typesEnabled = true): ListedModel[] {
    const kinds: readonly ModelKind[] = typesEnabled ? MODEL_KINDS : ["chat"];
    return kinds.flatMap((kind) => selectDiscoverable(models, discovery, retiredIds, kind));
}

export function typesDiscoveryEnabled(raw = process.env.MODEL_TYPES_DISCOVERY): boolean {
    return raw?.trim().toLowerCase() !== "off";
}

async function getJson(url: string, headers: Record<string, string>, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    const timeout = AbortSignal.timeout(LISTING_TIMEOUT_MS);
    const response = await fetchImpl(url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, cache: "no-store" });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
}

function listingError(status: number | null, body: unknown, fallback: string): ListingResult {
    const error = record(record(body).error);
    const message = text(error.message) ?? text(record(body).message) ?? fallback;
    return { ok: false, status, error: message.slice(0, 200) };
}

export async function listProviderModels(
    provider: Pick<ProviderConfig, "id" | "kind" | "baseUrl" | "extraHeaders">,
    discovery: ProviderDiscovery,
    apiKey: string,
    options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ListingResult> {
    const fetchImpl = options.fetchImpl ?? fetch;
    try {
        if (discovery.source === "gemini") {
            const entries: unknown[] = [];
            let pageToken: string | null = null;
            for (let page = 0; page < 10; page++) {
                const url = `${GEMINI_API}?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
                const { status, body } = await getJson(url, { "x-goog-api-key": apiKey }, fetchImpl, options.signal);
                if (status !== 200) return listingError(status, body, `HTTP ${status}`);
                const data = record(body);
                if (!Array.isArray(data.models)) return listingError(status, body, "The model list has no models array.");
                entries.push(...data.models);
                pageToken = text(data.nextPageToken);
                if (!pageToken) break;
            }
            return { ok: true, models: parseListing(discovery, { models: entries }) };
        }
        if (!provider.baseUrl) return { ok: false, status: null, error: "Provider has no base URL." };
        // Without the filter OpenRouter lists text-output models only.
        const query = discovery.source === "openrouter" ? "?output_modalities=all" : "";
        const { status, body } = await getJson(`${provider.baseUrl}/models${query}`, { Authorization: `Bearer ${apiKey}`, ...provider.extraHeaders }, fetchImpl, options.signal);
        if (status !== 200) return listingError(status, body, `HTTP ${status}`);
        if (!Array.isArray(record(body).data)) return listingError(status, body, "The model list has no data array.");
        return { ok: true, models: parseListing(discovery, body) };
    } catch (error) {
        const name = error instanceof Error ? error.name : "";
        return { ok: false, status: null, error: name === "TimeoutError" || name === "AbortError" ? "Listing timed out." : "Listing request failed." };
    }
}
