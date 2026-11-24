import { beginModelObservation, configureModelDataPolicy, withModelObservationCollector, type ModelCallObservation } from "@/lib/ai/model-observations";
import { persistModelObservations } from "@/lib/ai/model-health";
import type { TranscriptionChoice, TranscriptionOrder } from "@/lib/ai/voice-choices";
import { apiAudioLimit, audioFormat, transcribeAudioWithApi, type ApiSttRoute, type transcribeWithApi } from "@/lib/voice/api-stt";
import { STT_SAMPLE_RATE, type transcribePcm, type SttFailure } from "@/lib/voice/stt-client";
import { apiFailure, apiTranscriptionRoute, transcribeInOrder, type OrderedTranscript, type TranscribeStep } from "@/lib/voice/transcribe-order";
import { VOICE_NOTE_PIECE_SECONDS } from "@/lib/voice/voice-note";

// V8 F5 and F6: Capture recordings arrive as 3-minute PCM pieces; Telegram and Discord audio over 5 minutes goes
// to the API model as the compressed file. Logs and records keep sizes and timings, never the words.

/** A piece's request must finish inside Cloudflare's 100 s cut, so the API step gets 40 s and the box the rest. */
export const PIECE_API_TIMEOUT_MS = 40_000;
const PIECE_BUDGET_MS = 90_000;
// stt-client gives each 30 s slice up to 15 s; the box takes about 5 to 7 s for one.
const LOCAL_SLICE_MS = 15_000;
/** Telegram long audio runs in after(), and the Discord bot calls the app directly, so neither meets the 100 s cut. */
export const LONG_AUDIO_TIMEOUT_MS = 240_000;

/** On-box Moonshine is too slow to lead on long audio, so an API model goes first unless the owner keeps audio on the box. */
export function recordingSteps(order: TranscriptionOrder, localReady: boolean, apiReady: boolean): TranscribeStep[] {
    const steps: TranscribeStep[] = order === "local" ? ["local"] : order === "api" ? ["api"] : ["api", "local"];
    return steps.filter((step) => step === "local" ? localReady : apiReady);
}

type PieceOptions = {
    steps: readonly TranscribeStep[]; apiRoute: ApiSttRoute | null; signal?: AbortSignal;
    local?: typeof transcribePcm; api?: typeof transcribeWithApi; now?: () => number;
};

async function onBox(pcm: Uint8Array<ArrayBuffer>, options: PieceOptions, elapsed: () => number): Promise<OrderedTranscript> {
    const sliceBytes = VOICE_NOTE_PIECE_SECONDS * STT_SAMPLE_RATE * 2;
    const texts: string[] = [];
    let audioSec = 0, model = "";
    for (let offset = 0; offset < pcm.byteLength; offset += sliceBytes) {
        if (elapsed() + LOCAL_SLICE_MS > PIECE_BUDGET_MS) return { ok: false, reason: "timeout" };
        const slice = new Uint8Array(pcm.buffer.slice(pcm.byteOffset + offset, pcm.byteOffset + Math.min(offset + sliceBytes, pcm.byteLength)));
        const result = await transcribeInOrder(slice, { steps: ["local"], apiRoute: null, signal: options.signal, local: options.local });
        if (!result.ok) {
            if (result.reason === "empty") continue;
            return result;
        }
        texts.push(result.text);
        audioSec += result.audioSec;
        model = result.model;
    }
    const text = texts.join(" ").trim();
    return text ? { ok: true, text, audioSec, engine: "local", model } : { ok: false, reason: "empty" };
}

/** One Capture piece in order. Empty means silence and is final, as in transcribeInOrder. */
export async function transcribeRecordingPiece(pcm: Uint8Array<ArrayBuffer>, options: PieceOptions): Promise<OrderedTranscript> {
    const now = options.now ?? (() => performance.now());
    const started = now();
    let last: OrderedTranscript = { ok: false, reason: "unconfigured" };
    for (const step of options.steps) {
        options.signal?.throwIfAborted();
        last = step === "api"
            ? await transcribeInOrder(pcm, { steps: ["api"], apiRoute: options.apiRoute, signal: options.signal, api: options.api, apiTimeoutMs: PIECE_API_TIMEOUT_MS })
            : await onBox(pcm, options, () => now() - started);
        if (last.ok || last.reason === "empty") return last;
    }
    return last;
}

export type LongAudioFailure = SttFailure | "no_model" | "unsupported";
export type LongAudioResult = { ok: true; text: string; model: string } | { ok: false; reason: LongAudioFailure };
export type AudioFile = { bytes: Uint8Array; name: string; mimeType: string };

/** A whole compressed file to the owner's API model. "local" order, or no usable model, means no_model. */
export async function transcribeLongAudio(file: AudioFile, options: {
    choice: TranscriptionChoice; freeOnly: boolean; signal?: AbortSignal; api?: typeof transcribeAudioWithApi;
}): Promise<LongAudioResult> {
    const route = apiTranscriptionRoute(options.choice, options.freeOnly);
    if (!route) return { ok: false, reason: "no_model" };
    const format = audioFormat(file.name, file.mimeType);
    if (!format || (route.provider.kind === "gemini" && !format.gemini)) return { ok: false, reason: "unsupported" };
    if (file.bytes.byteLength > apiAudioLimit(route)) return { ok: false, reason: "too_large" };
    const observation = beginModelObservation({ providerId: route.provider.id, modelId: route.modelId, purpose: "transcription" });
    try {
        const bytes = Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
        const result = await (options.api ?? transcribeAudioWithApi)(route, bytes, format, { signal: options.signal, timeoutMs: LONG_AUDIO_TIMEOUT_MS });
        if (!result.ok) {
            observation.finish({ error: result.status === null ? { name: "TimeoutError" } : { status: result.status } });
            return { ok: false, reason: apiFailure(result.status, result.transient) };
        }
        observation.firstAnswer();
        observation.finish();
        const text = result.text.trim();
        return text ? { ok: true, text, model: route.modelId } : { ok: false, reason: "empty" };
    } catch (error) {
        observation.finish({ error, ...(options.signal?.aborted ? { status: "aborted" as const } : {}) });
        throw error;
    }
}

/** Runs transcription under the owner's data rule and saves the model calls it made. */
export async function withTranscriptionRecord<T>(freeOnly: boolean, run: () => Promise<T>): Promise<T> {
    const calls: ModelCallObservation[] = [];
    try {
        return await withModelObservationCollector(calls, () => {
            configureModelDataPolicy(freeOnly);
            return run();
        }, [], ["personal"]);
    } finally {
        if (calls.length) await persistModelObservations(calls).catch(() => {});
    }
}

const FAILURE_TEXT: Record<LongAudioFailure, string> = {
    no_model: "no API transcription model is chosen and approved on /admin",
    unsupported: "the transcription model does not take this audio format",
    too_large: "the file is larger than the transcription model takes",
    busy: "the transcription model is busy or over its free limit",
    timeout: "the transcription model took too long",
    unavailable: "the transcription model is unavailable",
    error: "the transcription model refused the audio",
    empty: "no speech was heard",
    unconfigured: "no API transcription model is chosen and approved on /admin",
};

export function longAudioFailureText(reason: LongAudioFailure): string {
    return reason === "empty" ? "No speech was heard in that recording." : `Too long to transcribe right now: ${FAILURE_TEXT[reason]}.`;
}
