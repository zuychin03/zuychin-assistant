import { getProvider, getProviderApiKey, isProviderAvailable } from "@/lib/ai/providers";
import { beginModelObservation } from "@/lib/ai/model-observations";
import type { TranscriptionChoice, TranscriptionOrder } from "@/lib/ai/voice-choices";
import { transcribeWithApi, type ApiSttRoute } from "@/lib/voice/api-stt";
import { pcmToWav } from "@/lib/voice/audio";
import { STT_SAMPLE_RATE, transcribePcm, type SttFailure } from "@/lib/voice/stt-client";

// Speech in, in the owner's order: the on-box service and an API model. Raw audio to the chat model stays the
// caller's last step in every order. Logs keep sizes, timings, engine and model, never the transcript.

const API_TIMEOUT_MS = 15_000;

export type TranscribeStep = "local" | "api";

export type OrderedTranscript =
    | { ok: true; text: string; audioSec: number; engine: TranscribeStep; model: string }
    | { ok: false; reason: SttFailure };

export function transcriptionSteps(order: TranscriptionOrder, localReady: boolean, apiReady: boolean): TranscribeStep[] {
    const steps: Record<TranscriptionOrder, TranscribeStep[]> = { local: ["local"], "local-first": ["local", "api"], "api-first": ["api", "local"], api: ["api"] };
    return steps[order].filter((step) => step === "local" ? localReady : apiReady);
}

/** The chosen API model while it stays approved, passing and keyed. Free only uses it only when it is free. */
export function apiTranscriptionRoute(choice: TranscriptionChoice, freeOnly: boolean): ApiSttRoute | null {
    if (choice.order === "local" || !choice.providerId || !choice.modelId) return null;
    const provider = getProvider(choice.providerId);
    const apiKey = provider && isProviderAvailable(provider) ? getProviderApiKey(provider) : undefined;
    const model = provider?.transcriptionModels?.find((entry) => entry.id === choice.modelId);
    if (!provider || !apiKey || !model || !model.catalogue.approved || model.catalogue.status) return null;
    if (freeOnly && !model.free) return null;
    return { provider, modelId: model.id, apiKey };
}

function apiFailure(status: number | null, transient: boolean): SttFailure {
    if (status === null) return "timeout";
    if (status === 429) return "busy";
    return transient ? "unavailable" : "error";
}

async function viaApi(pcm: Uint8Array<ArrayBuffer>, route: ApiSttRoute, transcribe: typeof transcribeWithApi, signal?: AbortSignal): Promise<OrderedTranscript> {
    const observation = beginModelObservation({ providerId: route.provider.id, modelId: route.modelId, purpose: "transcription" });
    try {
        const result = await transcribe(route, pcmToWav(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), STT_SAMPLE_RATE), { signal, timeoutMs: API_TIMEOUT_MS });
        if (!result.ok) {
            observation.finish({ error: result.status === null ? { name: "TimeoutError" } : { status: result.status } });
            return { ok: false, reason: apiFailure(result.status, result.transient) };
        }
        observation.firstAnswer();
        observation.finish();
        if (!result.text.trim()) return { ok: false, reason: "empty" };
        return { ok: true, text: result.text.trim(), audioSec: pcm.byteLength / (STT_SAMPLE_RATE * 2), engine: "api", model: route.modelId };
    } catch (error) {
        observation.finish({ error, ...(signal?.aborted ? { status: "aborted" as const } : {}) });
        throw error;
    }
}

/** Tries each step in order and returns the first transcript. An empty result from a step is final: there was no speech. */
export async function transcribeInOrder(pcm: Uint8Array<ArrayBuffer>, options: {
    steps: readonly TranscribeStep[];
    apiRoute: ApiSttRoute | null;
    signal?: AbortSignal;
    local?: typeof transcribePcm;
    api?: typeof transcribeWithApi;
}): Promise<OrderedTranscript> {
    let last: OrderedTranscript = { ok: false, reason: "unconfigured" };
    for (const step of options.steps) {
        options.signal?.throwIfAborted();
        if (step === "local") {
            const result = await (options.local ?? transcribePcm)(pcm, { signal: options.signal });
            last = result.ok ? { ok: true, text: result.text, audioSec: result.audioSec, engine: "local", model: result.model } : { ok: false, reason: result.reason };
        } else if (options.apiRoute) {
            last = await viaApi(pcm, options.apiRoute, options.api ?? transcribeWithApi, options.signal);
        }
        if (last.ok || last.reason === "empty" || last.reason === "too_large") return last;
    }
    return last;
}
