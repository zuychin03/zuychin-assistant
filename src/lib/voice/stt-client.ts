// Client for stt-service, the on-box transcriber (127.0.0.1 only, bearer token). Every failure maps to one
// "unavailable" shape so callers fall back to sending the audio itself.

export const STT_SAMPLE_RATE = 16000;
export const STT_MAX_SECONDS = 60;
export const STT_MAX_BYTES = STT_MAX_SECONDS * STT_SAMPLE_RATE * 2;
const TRANSCRIBE_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 2_000;

export type SttFailure = "unconfigured" | "unavailable" | "busy" | "timeout" | "too_large" | "empty" | "error";
export type SttResult =
    | { ok: true; text: string; audioSec: number; decodeMs: number; model: string }
    | { ok: false; reason: SttFailure };

type SttEnv = Record<string, string | undefined>;
type Options = { signal?: AbortSignal; env?: SttEnv; fetchImpl?: typeof fetch };

function config(env: SttEnv = process.env) {
    const url = env.STT_SERVICE_URL?.trim().replace(/\/+$/, "");
    const token = env.STT_SERVICE_TOKEN?.trim();
    return url && token ? { url, token } : null;
}

export function sttConfigured(env?: SttEnv): boolean {
    return config(env) !== null;
}

export async function transcribePcm(pcm: Uint8Array<ArrayBuffer>, options: Options = {}): Promise<SttResult> {
    const settings = config(options.env);
    if (!settings) return { ok: false, reason: "unconfigured" };
    if (pcm.byteLength > STT_MAX_BYTES) return { ok: false, reason: "too_large" };
    const timeout = AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS);
    let response: Response;
    try {
        response = await (options.fetchImpl ?? fetch)(`${settings.url}/transcribe`, {
            method: "POST",
            headers: { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/octet-stream", "X-Sample-Rate": String(STT_SAMPLE_RATE) },
            body: pcm,
            signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
            cache: "no-store",
        });
    } catch {
        // Node's fetch throws, rather than returning, when the service answers 401 to a request with a body.
        options.signal?.throwIfAborted();
        return { ok: false, reason: timeout.aborted ? "timeout" : "unavailable" };
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
        if (response.status === 413) return { ok: false, reason: "too_large" };
        if (response.status === 503) return { ok: false, reason: body.error === "busy" ? "busy" : body.error === "timeout" ? "timeout" : "unavailable" };
        return { ok: false, reason: "error" };
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return { ok: false, reason: "empty" };
    return {
        ok: true, text,
        audioSec: typeof body.audioSec === "number" ? body.audioSec : pcm.byteLength / (STT_SAMPLE_RATE * 2),
        decodeMs: typeof body.decodeMs === "number" ? body.decodeMs : 0,
        model: typeof body.model === "string" ? body.model : "unknown",
    };
}

export async function sttAvailable(options: Omit<Options, "signal"> = {}): Promise<boolean> {
    const settings = config(options.env);
    if (!settings) return false;
    try {
        const response = await (options.fetchImpl ?? fetch)(`${settings.url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), cache: "no-store" });
        if (!response.ok) return false;
        const body = await response.json() as { ok?: unknown; loaded?: unknown };
        return body.ok === true && body.loaded === true;
    } catch {
        return false;
    }
}
