import type { ProviderConfig } from "@/lib/ai/providers";
import type { MediaKind } from "@/lib/ai/catalogue/sources";
import { retiredAtFrom } from "@/lib/ai/embedding-request";

// REST adapters for the V8 media kinds. Request shapes checked against the live APIs on 24/11/2026.

export interface MediaRoute {
    provider: Pick<ProviderConfig, "id" | "kind" | "baseUrl" | "extraHeaders">;
    modelId: string;
    apiKey: string;
}

export type MediaFailure = { ok: false; status: number | null; ms: number; error: string; transient: boolean; timedOut: boolean; retiredAt: string | null };
export type MediaResult<T> = { ok: true; value: T; status: number; ms: number } | MediaFailure;

export interface MediaCallOptions {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs: number;
    /** Wait between NVCF status polls; NVCF itself holds each poll open for a while. */
    pollMs?: number;
}

const NIM_AI = "https://ai.api.nvidia.com/v1";
const NVCF_STATUS = "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status";
const GEMINI_V1BETA = "https://generativelanguage.googleapis.com/v1beta";
const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const DEFAULT_POLL_MS = 500;
const GEMINI_PROVIDERS = new Set(["gemini", "gemini-free"]);

/** Whether this app has a request shape for the kind on this provider. Rows without one are listed but never tested. */
export function mediaRouteSupported(kind: MediaKind, provider: Pick<ProviderConfig, "id" | "kind">): boolean {
    switch (kind) {
        case "rerank": case "parse": case "image": return provider.id === "nvidia-nim";
        case "decision": case "live": return GEMINI_PROVIDERS.has(provider.id);
        case "translate": return provider.kind === "openai-compatible";
    }
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorText(json: unknown, text: string, status: number): string {
    const body = record(json);
    const nested = record(body.error);
    const detail = body.detail;
    const message = typeof nested.message === "string" ? nested.message
        : typeof detail === "string" ? detail
            : Array.isArray(detail) ? JSON.stringify(detail)
                : typeof body.message === "string" ? body.message
                    : typeof body.title === "string" ? body.title : text.trim();
    return (message || `HTTP ${status}`).slice(0, 300);
}

const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/** One POST, following NVCF's 202 polling, inside one deadline. */
export async function mediaPost(url: string, body: string | FormData, headers: Record<string, string>, options: MediaCallOptions): Promise<{ ok: true; status: number; json: unknown; ms: number } | MediaFailure> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const deadline = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    try {
        const contentType: Record<string, string> = typeof body === "string" ? { "Content-Type": "application/json" } : {};
        let response = await fetchImpl(url, { method: "POST", headers: { Accept: "application/json", ...contentType, ...headers }, body, signal, cache: "no-store" });
        for (let request = response.headers.get("nvcf-reqid"); response.status === 202 && request; request = response.headers.get("nvcf-reqid")) {
            await delay(options.pollMs ?? DEFAULT_POLL_MS, signal);
            response = await fetchImpl(`${NVCF_STATUS}/${encodeURIComponent(request)}`, { headers: { Accept: "application/json", ...headers }, signal, cache: "no-store" });
        }
        const text = await response.text();
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { /* a plain-text error body */ }
        if (response.ok && response.status !== 202) return { ok: true, status: response.status, json, ms: ms() };
        const error = response.status === 202 ? "The provider never finished the request." : errorText(json, text, response.status);
        return {
            ok: false, status: response.status, ms: ms(), error, transient: response.status === 202 || TRANSIENT_HTTP.has(response.status), timedOut: false,
            retiredAt: response.status === 410 ? retiredAtFrom(error) : null,
        };
    } catch (error) {
        const timedOut = deadline.aborted;
        if (options.signal?.aborted && !timedOut) throw error;
        return { ok: false, status: null, ms: ms(), error: timedOut ? `No answer within ${Math.round(options.timeoutMs / 1000)} s.` : "The request failed.", transient: true, timedOut, retiredAt: null };
    }
}

const unsupported = (kind: MediaKind, route: MediaRoute): MediaFailure =>
    ({ ok: false, status: null, ms: 0, error: `This app has no ${kind} request for ${route.provider.id}.`, transient: false, timedOut: false, retiredAt: null });
const shapeFailure = (status: number, ms: number, error: string): MediaFailure =>
    ({ ok: false, status, ms, error, transient: false, timedOut: false, retiredAt: null });
const nimAuth = (route: MediaRoute) => ({ Authorization: `Bearer ${route.apiKey}` });

export interface RankedPassage { index: number; logit: number }

/** NIM reranking: passage indexes in model order, best first. */
export async function requestRerank(route: MediaRoute, query: string, passages: readonly string[], options: MediaCallOptions): Promise<MediaResult<RankedPassage[]>> {
    if (!mediaRouteSupported("rerank", route.provider)) return unsupported("rerank", route);
    const response = await mediaPost(`${NIM_AI}/retrieval/${route.modelId}/reranking`,
        JSON.stringify({ model: route.modelId, query: { text: query }, passages: passages.map((text) => ({ text })) }), nimAuth(route), options);
    if (!response.ok) return response;
    const raw = record(response.json).rankings;
    const seen = new Set<number>();
    const rankings = (Array.isArray(raw) ? raw : []).flatMap((entry) => {
        const { index, logit } = record(entry);
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= passages.length || seen.has(index) || typeof logit !== "number" || !Number.isFinite(logit)) return [];
        seen.add(index);
        return [{ index, logit }];
    });
    if (rankings.length !== passages.length) return shapeFailure(response.status, response.ms, `Ranked ${rankings.length} of ${passages.length} passages.`);
    return { ok: true, status: response.status, ms: response.ms, value: rankings.sort((a, b) => b.logit - a.logit) };
}

export interface PageImage { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" }

/** NIM page parsing: the raw tagged text, for parse-markdown.ts to convert. */
export async function requestParse(route: MediaRoute, page: PageImage, maxOutputTokens: number, options: MediaCallOptions): Promise<MediaResult<string>> {
    if (!mediaRouteSupported("parse", route.provider)) return unsupported("parse", route);
    const form = new FormData();
    form.append("document", new Blob([new Uint8Array(page.bytes)], { type: page.mimeType }), page.mimeType === "image/png" ? "page.png" : "page.jpg");
    form.append("options", new Blob([JSON.stringify({ decoding: { max_output_tokens: maxOutputTokens } })], { type: "application/json" }));
    const response = await mediaPost(`${NIM_AI}/retrieval/${route.modelId}/parse`, form, nimAuth(route), options);
    if (!response.ok) return response;
    const content = record(response.json).content;
    if (typeof content !== "string") return shapeFailure(response.status, response.ms, "The reply had no content.");
    return { ok: true, status: response.status, ms: response.ms, value: content };
}

export interface GeneratedImage { bytes: Uint8Array; mimeType: "image/jpeg" | "image/png" | "image/webp" }

export function imageMime(bytes: Uint8Array): GeneratedImage["mimeType"] | null {
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes.length > 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
    return null;
}

/** NIM image generation. FLUX.2 klein refuses unknown fields such as `seed` with a 422. */
export async function requestImage(route: MediaRoute, input: { prompt: string; width: number; height: number }, options: MediaCallOptions): Promise<MediaResult<GeneratedImage>> {
    if (!mediaRouteSupported("image", route.provider)) return unsupported("image", route);
    const response = await mediaPost(`${NIM_AI}/genai/${route.modelId}`, JSON.stringify({ prompt: input.prompt, width: input.width, height: input.height }), nimAuth(route), options);
    if (!response.ok) return response;
    const artifact = record((record(response.json).artifacts as unknown[] | undefined)?.[0]);
    const finish = typeof artifact.finishReason === "string" ? artifact.finishReason : null;
    if (typeof artifact.base64 !== "string" || !artifact.base64) return shapeFailure(response.status, response.ms, finish ? `No image (${finish}).` : "The reply had no image.");
    const bytes = new Uint8Array(Buffer.from(artifact.base64, "base64"));
    const mimeType = imageMime(bytes);
    if (!mimeType) return shapeFailure(response.status, response.ms, "The image bytes are not a JPEG, PNG or WebP.");
    if (finish && !/^(success|stop|complete)/i.test(finish)) return shapeFailure(response.status, response.ms, `The image finished with ${finish}.`);
    return { ok: true, status: response.status, ms: response.ms, value: { bytes, mimeType } };
}

export type DecisionQuestion =
    | { type: "noul"; instructions: string }
    | { type: "choice"; instructions: string; criteria: Record<string, string> }
    | { type: "score"; instructions: string; criteria: string[] };

export type DecisionAnswer =
    | { type: "noul"; value: number; confidence: number | null }
    | { type: "choice"; value: string; probabilities: Record<string, number>; confidence: number | null }
    | { type: "score"; value: number; confidence: number | null };

function decisionAnswer(question: DecisionQuestion, raw: unknown): DecisionAnswer | null {
    const answer = record(raw);
    const confidence = typeof answer.confidence === "number" && Number.isFinite(answer.confidence) ? answer.confidence : null;
    if (question.type === "noul") return typeof answer.noul === "number" && answer.noul >= 0 && answer.noul <= 1 ? { type: "noul", value: answer.noul, confidence } : null;
    if (question.type === "score") {
        const top = question.criteria.length - 1;
        return typeof answer.score === "number" && answer.score >= 0 && answer.score <= top ? { type: "score", value: answer.score, confidence } : null;
    }
    if (typeof answer.choice !== "string" || !(answer.choice in question.criteria)) return null;
    const probabilities = Object.fromEntries(Object.entries(record(answer.probabilities)).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
    return { type: "choice", value: answer.choice, probabilities, confidence };
}

/** Gemini Decisions (`POST /v1beta/decisions`); the installed SDK has no client for it. Every question must be answered. */
export async function requestDecision<Q extends Record<string, DecisionQuestion>>(route: MediaRoute, input: string, questions: Q, options: MediaCallOptions): Promise<MediaResult<{ [K in keyof Q]: DecisionAnswer }>> {
    if (!mediaRouteSupported("decision", route.provider)) return unsupported("decision", route);
    const response = await mediaPost(`${GEMINI_V1BETA}/decisions`, JSON.stringify({ model: route.modelId, input, questions }), { "x-goog-api-key": route.apiKey }, options);
    if (!response.ok) return response;
    const answers = record(record(response.json).answers);
    const out: Record<string, DecisionAnswer> = {};
    for (const [key, question] of Object.entries(questions)) {
        const answer = decisionAnswer(question, answers[key]);
        if (!answer) return shapeFailure(response.status, response.ms, `No usable answer for "${key}".`);
        out[key] = answer;
    }
    return { ok: true, status: response.status, ms: response.ms, value: out as { [K in keyof Q]: DecisionAnswer } };
}

export const DEFAULT_TRANSLATE_TEMPLATE = "Translate the following text from {source} to {target}:\n{text}";

export function renderTranslatePrompt(template: string, input: { text: string; source: string; target: string }): string {
    const body = template.includes("{text}") ? template : `${template}\n{text}`;
    return body.replace(/\{(source|target|text)\}/g, (_, key: "source" | "target" | "text") => input[key]);
}

/** A translation model on an OpenAI-style chat endpoint, prompted with its model card's template as a single user turn. */
export async function requestTranslate(route: MediaRoute, input: { text: string; source: string; target: string; template?: string; maxTokens: number }, options: MediaCallOptions): Promise<MediaResult<string>> {
    if (!mediaRouteSupported("translate", route.provider) || !route.provider.baseUrl) return unsupported("translate", route);
    const content = renderTranslatePrompt(input.template ?? DEFAULT_TRANSLATE_TEMPLATE, input);
    const response = await mediaPost(`${route.provider.baseUrl}/chat/completions`,
        JSON.stringify({ model: route.modelId, max_tokens: input.maxTokens, temperature: 0, messages: [{ role: "user", content }] }),
        { Authorization: `Bearer ${route.apiKey}`, ...route.provider.extraHeaders }, options);
    if (!response.ok) return response;
    const message = record(record((record(response.json).choices as unknown[] | undefined)?.[0]).message);
    const text = typeof message.content === "string" ? message.content.trim() : "";
    if (!text) return shapeFailure(response.status, response.ms, "The reply was empty.");
    return { ok: true, status: response.status, ms: response.ms, value: text };
}
