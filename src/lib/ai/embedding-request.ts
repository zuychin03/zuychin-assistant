import type { ProviderConfig } from "@/lib/ai/providers";

// Raw embedding requests for any route, one text or a batch. The live path (embeddings.ts) and the probes both use it.

export type EmbedInputType = "query" | "passage";

export interface EmbeddingRoute {
    provider: Pick<ProviderConfig, "id" | "kind" | "baseUrl" | "extraHeaders">;
    modelId: string;
    apiKey: string;
    /** Send `input_type` (OpenAI-shaped routes). Gemini always gets a task type. */
    inputType: boolean;
    /** Reduced vector length; omitted means the model's own. */
    dimension?: number;
}

export type EmbeddingResponse =
    | { ok: true; vectors: number[][]; ms: number; usage: unknown }
    | { ok: false; status: number | null; error: string; ms: number; timedOut: boolean };

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
const DETAIL_MAX = 300;

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function vector(value: unknown): number[] | null {
    return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry)) ? value as number[] : null;
}

// NIM's 404 names the caller's account id; details are stored and shown, so it is dropped.
function scrub(detail: string): string {
    return detail.replace(/for account '[^']*'/gi, "for this account").replace(/Function '[0-9a-f-]{36}'/gi, "The model function").slice(0, DETAIL_MAX);
}

export function errorDetail(body: string, status: number): string {
    try {
        const json = record(JSON.parse(body));
        const error = record(json.error);
        const message = error.message ?? json.message ?? json.detail ?? json.error;
        if (typeof message === "string" && message.trim()) return scrub(message.trim());
    } catch { /* not JSON */ }
    return scrub(body.trim()) || `HTTP ${status}`;
}

/** "reached its end of life on 2026-11-23T09:00:00Z" (NIM and OpenRouter 410 replies) as an ISO timestamp. */
export function retiredAtFrom(detail: string | null): string | null {
    const match = detail ? /end of life on (\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?)/i.exec(detail) : null;
    const ms = match ? Date.parse(match[1].includes("T") ? match[1] : `${match[1]}T00:00:00Z`) : NaN;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function geminiTask(inputType: EmbedInputType): string {
    return inputType === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
}

function geminiRequest(route: EmbeddingRoute, texts: readonly string[], inputType: EmbedInputType): { url: string; body: unknown } {
    const one = (text: string) => ({
        content: { parts: [{ text }] }, taskType: geminiTask(inputType),
        ...(route.dimension ? { outputDimensionality: route.dimension } : {}),
    });
    const model = encodeURIComponent(route.modelId);
    return texts.length === 1
        ? { url: `${GEMINI_API}/models/${model}:embedContent`, body: one(texts[0]) }
        : { url: `${GEMINI_API}/models/${model}:batchEmbedContents`, body: { requests: texts.map((text) => ({ model: `models/${route.modelId}`, ...one(text) })) } };
}

function geminiVectors(json: Record<string, unknown>, count: number): number[][] | null {
    const raw = count === 1 ? [record(json.embedding).values] : (Array.isArray(json.embeddings) ? json.embeddings.map((entry) => record(entry).values) : []);
    const vectors = raw.map(vector);
    return vectors.length === count && vectors.every((entry) => entry !== null) ? vectors as number[][] : null;
}

function openAiVectors(json: Record<string, unknown>, count: number): number[][] | null {
    const data = Array.isArray(json.data) ? json.data.map(record) : [];
    // Providers may return items out of order; `index` puts them back.
    const sorted = data.every((entry) => typeof entry.index === "number") ? [...data].sort((a, b) => (a.index as number) - (b.index as number)) : data;
    const vectors = sorted.map((entry) => vector(entry.embedding));
    return vectors.length === count && vectors.every((entry) => entry !== null) ? vectors as number[][] : null;
}

export async function requestEmbeddings(
    route: EmbeddingRoute,
    texts: readonly string[],
    inputType: EmbedInputType,
    options: { signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<EmbeddingResponse> {
    if (!texts.length) throw new Error("No texts to embed.");
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const gemini = route.provider.kind === "gemini";
    const request = gemini ? geminiRequest(route, texts, inputType) : {
        url: `${route.provider.baseUrl}/embeddings`,
        body: {
            model: route.modelId, input: texts.length === 1 ? texts[0] : texts, encoding_format: "float",
            ...(route.inputType ? { input_type: inputType } : {}),
            ...(route.dimension ? { dimensions: route.dimension } : {}),
        },
    };
    const headers: Record<string, string> = gemini
        ? { "x-goog-api-key": route.apiKey, "Content-Type": "application/json" }
        : { Authorization: `Bearer ${route.apiKey}`, "Content-Type": "application/json", ...(route.provider.extraHeaders ?? {}) };
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
        const response = await (options.fetchImpl ?? fetch)(request.url, { method: "POST", headers, body: JSON.stringify(request.body), signal, cache: "no-store" });
        const text = await response.text();
        if (!response.ok) return { ok: false, status: response.status, error: errorDetail(text, response.status), ms: elapsed(), timedOut: false };
        let json: Record<string, unknown> = {};
        try { json = record(JSON.parse(text)); } catch { /* checked below */ }
        const vectors = gemini ? geminiVectors(json, texts.length) : openAiVectors(json, texts.length);
        if (!vectors) return { ok: false, status: response.status, error: "The reply had no usable vectors.", ms: elapsed(), timedOut: false };
        return { ok: true, vectors, ms: elapsed(), usage: json.usage };
    } catch (error) {
        const name = error instanceof Error ? error.name : "";
        const timedOut = name === "TimeoutError" || (name === "AbortError" && timeout.aborted);
        if (!timedOut && options.signal?.aborted) throw error;
        return { ok: false, status: null, error: timedOut ? "Timed out." : "Request failed before a response.", ms: elapsed(), timedOut };
    }
}

export function cosine(a: readonly number[], b: readonly number[]): number {
    if (a.length !== b.length || !a.length) return 0;
    let dot = 0, left = 0, right = 0;
    for (let index = 0; index < a.length; index++) {
        dot += a[index] * b[index];
        left += a[index] * a[index];
        right += b[index] * b[index];
    }
    return left && right ? dot / Math.sqrt(left * right) : 0;
}
