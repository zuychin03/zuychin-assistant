import type { ProviderConfig } from "@/lib/ai/providers";
import { errorDetail, retiredAtFrom } from "@/lib/ai/embedding-request";
import { parseWav, rateFromContentType, toMono } from "@/lib/voice/audio";

// Text to speech over a provider API: Gemini's AUDIO modality, or POST /audio/speech (OpenRouter, Groq).
// Every engine yields 16-bit mono PCM with its own sample rate.

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

// Gemini's prebuilt voices (also OpenRouter's `supported_voices` for Gemini TTS, 24/11/2026).
export const GEMINI_VOICES = [
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina",
    "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix",
    "Sadachbia", "Sadaltager", "Sulafat",
] as const;
// Groq's English Orpheus voices from its docs (24/11/2026); its model list has no voice field. Each is confirmed when picked.
export const GROQ_ORPHEUS_VOICES = ["autumn", "diana", "hannah", "austin", "daniel", "troy"] as const;
export const DEFAULT_GEMINI_VOICE = "Kore";

/** Voices for a speech model: pinned lists where the provider's list has none, else what the list published. */
export function knownVoices(provider: Pick<ProviderConfig, "id" | "kind">, modelId: string, listed: readonly string[] = []): string[] {
    if (provider.kind === "gemini") return [...GEMINI_VOICES];
    if (provider.id === "groq" && /orpheus-v1-english/.test(modelId)) return [...GROQ_ORPHEUS_VOICES];
    return [...listed];
}

export function defaultVoice(provider: Pick<ProviderConfig, "id" | "kind">, modelId: string, listed: readonly string[] = []): string | undefined {
    if (provider.kind === "gemini") return DEFAULT_GEMINI_VOICE;
    return knownVoices(provider, modelId, listed)[0];
}

export interface ApiSpeechRoute {
    provider: Pick<ProviderConfig, "id" | "kind" | "baseUrl" | "extraHeaders">;
    modelId: string;
    apiKey: string;
    voice?: string;
    /** The format the probe found; skips the PCM-then-WAV retry. */
    format?: "pcm" | "wav";
}

export interface ApiSpeechChunk {
    pcm: Buffer;
    sampleRate: number;
    format: "pcm" | "wav";
}

export class SpeechRequestError extends Error {
    constructor(message: string, readonly status: number | null, readonly transient: boolean, readonly retiredAt: string | null = null, readonly unsupportedFormat = false) {
        super(message);
        this.name = "SpeechRequestError";
    }
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function failure(response: Response): Promise<SpeechRequestError> {
    const detail = errorDetail(await response.text().catch(() => ""), response.status);
    return new SpeechRequestError(detail, response.status, TRANSIENT_HTTP.has(response.status), response.status === 410 ? retiredAtFrom(detail) : null);
}

async function* geminiSpeech(route: ApiSpeechRoute, text: string, signal: AbortSignal, fetchImpl: typeof fetch): AsyncGenerator<ApiSpeechChunk> {
    const response = await fetchImpl(`${GEMINI_API}/models/${encodeURIComponent(route.modelId)}:streamGenerateContent?alt=sse`, {
        method: "POST", signal, cache: "no-store",
        headers: { "x-goog-api-key": route.apiKey, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text }] }],
            generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: route.voice ?? DEFAULT_GEMINI_VOICE } } } },
        }),
    });
    if (!response.ok || !response.body) throw await failure(response);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const parse = function* (line: string): Generator<ApiSpeechChunk> {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        let json: Record<string, unknown>;
        try { json = record(JSON.parse(trimmed.slice(5).trim())); } catch { return; }
        if (json.error !== undefined) {
            const error = record(json.error);
            const code = typeof error.code === "number" ? error.code : null;
            throw new SpeechRequestError(typeof error.message === "string" ? error.message : "Stream error.", code, code !== null && TRANSIENT_HTTP.has(code));
        }
        const parts = record(record((json.candidates as unknown[] | undefined)?.[0]).content).parts;
        for (const part of Array.isArray(parts) ? parts.map(record) : []) {
            const inline = record(part.inlineData);
            if (typeof inline.data !== "string" || !inline.data) continue;
            const mimeType = typeof inline.mimeType === "string" ? inline.mimeType : null;
            const bytes = Buffer.from(inline.data, "base64");
            // Streaming replies are raw L16; blocking ones (seen 24/11/2026) are WAV with a header.
            if (mimeType && /wav/i.test(mimeType)) {
                const wav = parseWav(bytes);
                if (!wav) throw new SpeechRequestError("The reply was not 16-bit PCM WAV.", 200, false, null, true);
                yield { pcm: toMono(wav.pcm, wav.channels), sampleRate: wav.sampleRate, format: "wav" };
            } else yield { pcm: bytes, sampleRate: rateFromContentType(mimeType) ?? 24000, format: "pcm" };
        }
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) yield* parse(line);
    }
    yield* parse(buffer);
}

const formatRefused = (error: SpeechRequestError) => error.status === 400 && /(response_format|format)/i.test(error.message);

async function openAiRequest(route: ApiSpeechRoute, text: string, format: "pcm" | "wav", signal: AbortSignal, fetchImpl: typeof fetch): Promise<Response> {
    const response = await fetchImpl(`${route.provider.baseUrl}/audio/speech`, {
        method: "POST", signal, cache: "no-store",
        headers: { Authorization: `Bearer ${route.apiKey}`, "Content-Type": "application/json", ...(route.provider.extraHeaders ?? {}) },
        body: JSON.stringify({ model: route.modelId, input: text, response_format: format, ...(route.voice ? { voice: route.voice } : {}) }),
    });
    if (!response.ok || !response.body) throw await failure(response);
    return response;
}

async function* openAiSpeech(route: ApiSpeechRoute, text: string, signal: AbortSignal, fetchImpl: typeof fetch): AsyncGenerator<ApiSpeechChunk> {
    let format: "pcm" | "wav" = route.format ?? "pcm";
    let response: Response;
    try {
        response = await openAiRequest(route, text, format, signal, fetchImpl);
    } catch (error) {
        if (route.format || !(error instanceof SpeechRequestError) || !formatRefused(error)) throw error;
        format = "wav";
        try { response = await openAiRequest(route, text, format, signal, fetchImpl); }
        catch (retry) {
            if (retry instanceof SpeechRequestError && formatRefused(retry)) throw new SpeechRequestError("Audio format not supported: this app plays PCM or WAV only.", 400, false, null, true);
            throw retry;
        }
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (/(mpeg|mp3|ogg|opus|aac|flac)/.test(contentType)) {
        await response.body?.cancel().catch(() => {});
        throw new SpeechRequestError(`Audio format not supported (${contentType}).`, 200, false, null, true);
    }
    const body = response.body!;
    if (format === "pcm" && !/wav/.test(contentType)) {
        const sampleRate = rateFromContentType(contentType) ?? 24000;
        const reader = body.getReader();
        let carry: Buffer | null = null;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            let bytes: Buffer = carry ? Buffer.concat([carry, Buffer.from(value)]) : Buffer.from(value);
            carry = bytes.length % 2 ? bytes.subarray(bytes.length - 1) : null;
            if (carry) bytes = bytes.subarray(0, bytes.length - 1);
            if (bytes.length) yield { pcm: bytes, sampleRate, format: "pcm" };
        }
        return;
    }
    const wav = parseWav(Buffer.from(await response.arrayBuffer()));
    if (!wav) throw new SpeechRequestError("The reply was not 16-bit PCM WAV.", 200, false, null, true);
    yield { pcm: toMono(wav.pcm, wav.channels), sampleRate: wav.sampleRate, format: "wav" };
}

/** Streams speech for one text. Errors are SpeechRequestError, except an abort of the caller's own signal. */
export async function* apiSpeechStream(
    route: ApiSpeechRoute, text: string,
    options: { signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): AsyncGenerator<ApiSpeechChunk> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 55_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const fetchImpl = options.fetchImpl ?? fetch;
    try {
        if (route.provider.kind === "gemini") yield* geminiSpeech(route, text, signal, fetchImpl);
        else yield* openAiSpeech(route, text, signal, fetchImpl);
    } catch (error) {
        if (error instanceof SpeechRequestError) throw error;
        if (options.signal?.aborted) throw error;
        const name = error instanceof Error ? error.name : "";
        const timedOut = name === "TimeoutError" || (name === "AbortError" && timeout.aborted);
        throw new SpeechRequestError(timedOut ? "Timed out." : "Request failed before a response.", null, true);
    }
}
