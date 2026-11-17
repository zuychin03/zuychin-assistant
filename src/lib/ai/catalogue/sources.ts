import type { ProviderConfig } from "@/lib/ai/providers";

export type DiscoverySource = "openrouter" | "kilo" | "gemini" | "openai-list";

export interface ProviderDiscovery {
    source: DiscoverySource;
    /** "free" keeps only models the list marks as free; aggregator paid catalogues run to 400+ entries. */
    include: "free" | "all";
    /** "listed" reads the price from the list; the others apply to every model on the key. */
    pricing: "listed" | "all-free" | "all-paid";
    nameSuffix?: string;
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
}

export type ListingResult =
    | { ok: true; models: ListedModel[] }
    | { ok: false; status: number | null; error: string };

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";
const LISTING_TIMEOUT_MS = 20_000;
const MAX_DESCRIPTION = 400;

const ROUTER_IDS = /^(openrouter|kilo-auto)\//;
const GEMINI_NON_CHAT = /(tts|image|imagen|veo|lyria|embedding|aqa|live|native-audio|robotics|computer-use|nano-banana|transcribe|deep-research|antigravity|customtools|-latest$)/;
const OPENAI_LIST_NON_CHAT = /(embed|rerank|guard|safety|reward|parse|retriever|nvclip|detector)/;

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
        chat: !ROUTER_IDS.test(id) && outputs.length === 1 && outputs[0] === "text" && (inputs.length === 0 || inputs.includes("text")),
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
        return [{
            modelId: id,
            label: cleanLabel(text(entry.displayName) ?? labelFromId(id), free),
            description: description(entry.description),
            developer: "Google",
            free,
            contextTokens: count(entry.inputTokenLimit),
            maxOutputTokens: count(entry.outputTokenLimit),
            inputs: [],
            listedTools: null,
            listedStructured: null,
            listedThinking: typeof entry.thinking === "boolean" ? entry.thinking : null,
            mayTrain: null,
            chat: methods.includes("generateContent") && !GEMINI_NON_CHAT.test(id),
        }];
    });
}

/** OpenAI-style `{ data: [{ id }] }`: NVIDIA NIM gives ids only; DeepSeek adds limits and modalities. */
export function parseOpenAiModelList(raw: unknown, free: boolean): ListedModel[] {
    return (Array.isArray(record(raw).data) ? record(raw).data as unknown[] : []).flatMap((value) => {
        const entry = record(value);
        const id = text(entry.id);
        if (!id) return [];
        const outputs = strings(entry.output_modalities);
        return [{
            modelId: id,
            label: cleanLabel(text(entry.name) ?? labelFromId(id), free),
            description: description(entry.description),
            developer: text(entry.owned_by) ?? vendorFromId(id),
            free,
            contextTokens: count(entry.context_window) ?? count(entry.context_length),
            maxOutputTokens: count(entry.max_output_tokens),
            inputs: inputNames(entry.input_modalities),
            listedTools: null,
            listedStructured: null,
            listedThinking: entry.effort !== undefined ? true : null,
            mayTrain: null,
            chat: !OPENAI_LIST_NON_CHAT.test(id) && (outputs.length === 0 || outputs.includes("text")),
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
    }
}

/** Chat models this provider should track. `retiredIds` are legacy aliases, which must keep resolving to their replacement. */
export function selectDiscoverable(models: readonly ListedModel[], discovery: ProviderDiscovery, retiredIds: ReadonlySet<string> = new Set()): ListedModel[] {
    const seen = new Set<string>();
    return models.filter((model) => {
        if (!model.chat || retiredIds.has(model.modelId) || seen.has(model.modelId)) return false;
        if (discovery.include === "free" && !model.free) return false;
        seen.add(model.modelId);
        return true;
    });
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
        const { status, body } = await getJson(`${provider.baseUrl}/models`, { Authorization: `Bearer ${apiKey}`, ...provider.extraHeaders }, fetchImpl, options.signal);
        if (status !== 200) return listingError(status, body, `HTTP ${status}`);
        if (!Array.isArray(record(body).data)) return listingError(status, body, "The model list has no data array.");
        return { ok: true, models: parseListing(discovery, body) };
    } catch (error) {
        const name = error instanceof Error ? error.name : "";
        return { ok: false, status: null, error: name === "TimeoutError" || name === "AbortError" ? "Listing timed out." : "Listing request failed." };
    }
}
