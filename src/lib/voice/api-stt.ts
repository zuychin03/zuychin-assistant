import type { ProviderConfig } from "@/lib/ai/providers";
import { errorDetail, retiredAtFrom } from "@/lib/ai/embedding-request";

// Speech to text over a provider API. Gemini takes the WAV inline; OpenRouter takes JSON with base64
// `input_audio`; other OpenAI-shaped providers (Groq) take multipart form data, as OpenAI does.

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const TRANSCRIBE_PROMPT = "Transcribe this audio exactly. Reply with the transcript only, with no notes.";

export interface ApiSttRoute {
    provider: Pick<ProviderConfig, "id" | "kind" | "baseUrl" | "extraHeaders">;
    modelId: string;
    apiKey: string;
}

export type ApiSttResult =
    | { ok: true; text: string; ms: number }
    | { ok: false; status: number | null; error: string; transient: boolean; retiredAt: string | null; ms: number };

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A container the providers name by extension; `gemini` is the type Gemini lists for it (none for WebM). */
export interface AudioFormat { ext: string; mime: string; gemini: string | null }

const FORMATS: Record<string, AudioFormat> = {
    wav: { ext: "wav", mime: "audio/wav", gemini: "audio/wav" },
    ogg: { ext: "ogg", mime: "audio/ogg", gemini: "audio/ogg" },
    mp3: { ext: "mp3", mime: "audio/mpeg", gemini: "audio/mp3" },
    m4a: { ext: "m4a", mime: "audio/mp4", gemini: "audio/aac" },
    flac: { ext: "flac", mime: "audio/flac", gemini: "audio/flac" },
    webm: { ext: "webm", mime: "audio/webm", gemini: null },
};
const EXTENSIONS: Record<string, keyof typeof FORMATS> = { wav: "wav", ogg: "ogg", oga: "ogg", opus: "ogg", mp3: "mp3", m4a: "m4a", mp4: "m4a", aac: "m4a", flac: "flac", webm: "webm" };
const MIMES: Record<string, keyof typeof FORMATS> = {
    "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/ogg": "ogg", "audio/opus": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3",
    "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/aac": "m4a", "audio/x-aac": "m4a", "audio/flac": "flac", "audio/webm": "webm",
};
export const WAV_FORMAT = FORMATS.wav;

/** The extension decides first, since Telegram and Discord report some types loosely. */
export function audioFormat(name: string, mimeType: string): AudioFormat | null {
    const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    const key = (ext && EXTENSIONS[ext]) || MIMES[mimeType.toLowerCase().split(";")[0].trim()];
    return key ? FORMATS[key] : null;
}

// Gemini caps a request at 20 MB and base64 adds a third; Groq's free tier takes 25 MB files.
const INLINE_MAX_BYTES = 14 * 1024 * 1024;
const UPLOAD_MAX_BYTES = 24 * 1024 * 1024;

/** The largest audio file a route takes in one request. */
export function apiAudioLimit(route: ApiSttRoute): number {
    return route.provider.kind === "gemini" || route.provider.id === "openrouter" ? INLINE_MAX_BYTES : UPLOAD_MAX_BYTES;
}

function request(route: ApiSttRoute, audio: Buffer, format: AudioFormat, language: string): { url: string; init: RequestInit } {
    if (route.provider.kind === "gemini") {
        // Dedicated transcribe models need no instruction; others are told to transcribe.
        const parts: Record<string, unknown>[] = [{ inlineData: { mimeType: format.gemini ?? format.mime, data: audio.toString("base64") } }];
        if (!/transcribe/.test(route.modelId)) parts.push({ text: TRANSCRIBE_PROMPT });
        return {
            url: `${GEMINI_API}/models/${encodeURIComponent(route.modelId)}:generateContent`,
            init: { headers: { "x-goog-api-key": route.apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts }] }) },
        };
    }
    const url = `${route.provider.baseUrl}/audio/transcriptions`;
    const auth = { Authorization: `Bearer ${route.apiKey}`, ...(route.provider.extraHeaders ?? {}) };
    if (route.provider.id === "openrouter") {
        return { url, init: { headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ model: route.modelId, language, input_audio: { data: audio.toString("base64"), format: format.ext } }) } };
    }
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: format.mime }), `audio.${format.ext}`);
    form.append("model", route.modelId);
    form.append("language", language);
    form.append("response_format", "json");
    return { url, init: { headers: auth, body: form } };
}

function transcript(route: ApiSttRoute, json: Record<string, unknown>): string | null {
    if (route.provider.kind === "gemini") {
        const parts = record(record((json.candidates as unknown[] | undefined)?.[0]).content).parts;
        const text = (Array.isArray(parts) ? parts.map(record) : []).map((part) => typeof part.text === "string" && part.thought !== true ? part.text : "").join("");
        return text.trim() || null;
    }
    return typeof json.text === "string" ? json.text.trim() : null;
}

type ApiSttOptions = { signal?: AbortSignal; timeoutMs?: number; language?: string; fetchImpl?: typeof fetch };

export function transcribeWithApi(route: ApiSttRoute, wav: Buffer, options: ApiSttOptions = {}): Promise<ApiSttResult> {
    return transcribeAudioWithApi(route, wav, WAV_FORMAT, options);
}

/** Any container in FORMATS, sent as it is; callers check apiAudioLimit first. */
export async function transcribeAudioWithApi(route: ApiSttRoute, audio: Buffer, format: AudioFormat, options: ApiSttOptions = {}): Promise<ApiSttResult> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const { url, init } = request(route, audio, format, options.language ?? "en");
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
        const response = await (options.fetchImpl ?? fetch)(url, { ...init, method: "POST", signal, cache: "no-store" });
        const body = await response.text();
        if (!response.ok) {
            const error = errorDetail(body, response.status);
            return { ok: false, status: response.status, error, transient: TRANSIENT_HTTP.has(response.status), retiredAt: response.status === 410 ? retiredAtFrom(error) : null, ms: elapsed() };
        }
        let json: Record<string, unknown> = {};
        try { json = record(JSON.parse(body)); } catch { /* checked below */ }
        const text = transcript(route, json);
        if (text === null) return { ok: false, status: response.status, error: "The reply had no transcript.", transient: false, retiredAt: null, ms: elapsed() };
        return { ok: true, text, ms: elapsed() };
    } catch (error) {
        if (options.signal?.aborted) throw error;
        const name = error instanceof Error ? error.name : "";
        const timedOut = name === "TimeoutError" || (name === "AbortError" && timeout.aborted);
        return { ok: false, status: null, error: timedOut ? "Timed out." : "Request failed before a response.", transient: true, retiredAt: null, ms: elapsed() };
    }
}

function words(text: string): string[] {
    return text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
}

/** Share of the expected words heard in order (longest common subsequence over the expected length). */
export function wordAccuracy(expected: string, heard: string): number {
    const want = words(expected), got = words(heard);
    if (!want.length) return 0;
    const row = new Array<number>(got.length + 1).fill(0);
    for (const word of want) {
        let diagonal = 0;
        for (let index = 1; index <= got.length; index++) {
            const above = row[index];
            row[index] = word === got[index - 1] ? diagonal + 1 : Math.max(row[index], row[index - 1]);
            diagonal = above;
        }
    }
    return row[got.length] / want.length;
}
