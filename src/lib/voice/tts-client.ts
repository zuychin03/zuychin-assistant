// Client for tts-service, the on-box speaker (127.0.0.1 only, bearer token). Every failure before the first
// audio maps to one SpeechUnavailable error, so callers can fall back to Gemini.

export const LOCAL_VOICES = ["M2", "F2"] as const;
export type LocalVoice = (typeof LOCAL_VOICES)[number];
export const LOCAL_SPEECH_MODEL = "tiny-voca";
const FIRST_AUDIO_TIMEOUT_MS = 3_000;
const TOTAL_TIMEOUT_MS = 60_000;
const WARM_TIMEOUT_MS = 5_000;

export type SpeechFailure = "unconfigured" | "unavailable" | "busy" | "loading" | "unsupported" | "timeout" | "error";

export class SpeechUnavailable extends Error {
    constructor(readonly reason: SpeechFailure) {
        super(`Local speech unavailable: ${reason}`);
        this.name = "SpeechUnavailable";
    }
}

type TtsEnv = Record<string, string | undefined>;
type Options = { signal?: AbortSignal; env?: TtsEnv; fetchImpl?: typeof fetch; firstAudioMs?: number; totalMs?: number };

function config(env: TtsEnv = process.env) {
    const url = env.TTS_SERVICE_URL?.trim().replace(/\/+$/, "");
    const token = env.TTS_SERVICE_TOKEN?.trim();
    return url && token ? { url, token } : null;
}

export function ttsConfigured(env?: TtsEnv): boolean {
    return config(env) !== null;
}

export const isLocalVoice = (value: unknown): value is LocalVoice => (LOCAL_VOICES as readonly unknown[]).includes(value);

// The service sends its response headers when the first sentence is ready, so waiting for them is waiting for
// first audio. After that the body streams 16-bit mono PCM, one sentence at a time.
export async function* streamLocalSpeech(text: string, voice: LocalVoice, options: Options = {}): AsyncGenerator<{ pcm: Buffer; sampleRate: number }> {
    const settings = config(options.env);
    if (!settings) throw new SpeechUnavailable("unconfigured");
    const first = new AbortController();
    const firstTimer = setTimeout(() => first.abort(), options.firstAudioMs ?? FIRST_AUDIO_TIMEOUT_MS);
    const total = AbortSignal.timeout(options.totalMs ?? TOTAL_TIMEOUT_MS);
    const signal = AbortSignal.any([first.signal, total, ...(options.signal ? [options.signal] : [])]);

    let response: Response;
    try {
        response = await (options.fetchImpl ?? fetch)(`${settings.url}/speak`, {
            method: "POST",
            headers: { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ text, voice }),
            signal,
            cache: "no-store",
        });
    } catch {
        options.signal?.throwIfAborted();
        throw new SpeechUnavailable(first.signal.aborted || total.aborted ? "timeout" : "unavailable");
    } finally {
        clearTimeout(firstTimer);
    }

    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (response.status === 422) throw new SpeechUnavailable("unsupported");
        if (response.status === 503) throw new SpeechUnavailable(body.error === "busy" ? "busy" : body.error === "loading" ? "loading" : "unavailable");
        throw new SpeechUnavailable("error");
    }
    if (!response.body) throw new SpeechUnavailable("error");
    const sampleRate = Number(response.headers.get("X-Sample-Rate")) || 24000;

    const reader = response.body.getReader();
    let carry: Uint8Array | null = null;
    try {
        for (;;) {
            let read: ReadableStreamReadResult<Uint8Array>;
            try {
                read = await reader.read();
            } catch {
                options.signal?.throwIfAborted();
                throw new SpeechUnavailable(total.aborted ? "timeout" : "error");
            }
            if (read.done) return;
            let bytes = read.value;
            if (carry) {
                const joined = new Uint8Array(carry.length + bytes.length);
                joined.set(carry);
                joined.set(bytes, carry.length);
                bytes = joined;
                carry = null;
            }
            // 16-bit samples: never hand on half of one.
            if (bytes.length % 2) {
                carry = bytes.slice(bytes.length - 1);
                bytes = bytes.subarray(0, bytes.length - 1);
            }
            if (bytes.length) yield { pcm: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), sampleRate };
        }
    } finally {
        await reader.cancel().catch(() => { });
    }
}

export type TtsWarmState = "unconfigured" | "down" | "starting" | "loading" | "ready";

// Any request starts the service through its systemd socket, so this also loads the model ahead of the first reply.
export async function ttsWarm(options: Omit<Options, "signal"> & { timeoutMs?: number } = {}): Promise<TtsWarmState> {
    const settings = config(options.env);
    if (!settings) return "unconfigured";
    const timeout = AbortSignal.timeout(options.timeoutMs ?? WARM_TIMEOUT_MS);
    try {
        const response = await (options.fetchImpl ?? fetch)(`${settings.url}/health`, { signal: timeout, cache: "no-store" });
        if (!response.ok) return "down";
        const body = await response.json().catch(() => ({})) as { ok?: unknown; loaded?: unknown };
        return body.ok !== true ? "down" : body.loaded === true ? "ready" : "loading";
    } catch {
        return timeout.aborted ? "starting" : "down";
    }
}
