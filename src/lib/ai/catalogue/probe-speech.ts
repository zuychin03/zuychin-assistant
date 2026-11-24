import { beginModelObservation } from "@/lib/ai/model-observations";
import type { ProbeStep } from "@/lib/ai/catalogue/probe";
import type { ModelTraits } from "@/lib/ai/catalogue/snapshot";
import type { ProviderConfig } from "@/lib/ai/providers";
import { apiSpeechStream, defaultVoice, knownVoices, SpeechRequestError } from "@/lib/voice/api-speech";
import { pcmRms, pcmSeconds } from "@/lib/voice/audio";

export const SPEECH_PROBE_TEXT = "The quick brown fox jumps over the lazy dog.";
// The sentence takes about 3 to 5 seconds; anything far outside that is not this sentence.
const MIN_AUDIO_SEC = 1.5;
const MAX_AUDIO_SEC = 15;
const SILENCE_RMS = 200;
const PROBE_TIMEOUT_MS = 60_000;

export interface SpeechProbeTarget {
    provider: Pick<ProviderConfig, "id" | "kind" | "baseUrl" | "extraHeaders">;
    modelId: string;
    apiKey: string;
    /** Voices the list published; the default voice comes from these or the pinned lists. */
    listedVoices?: readonly string[];
    /** A voice to confirm instead of the default. */
    voice?: string;
}

export interface SpeechProbeResult {
    status: "passed" | "failed" | "inconclusive";
    retired: boolean;
    retiredAt: string | null;
    /** Time to the first audio. */
    ms: number | null;
    traits: ModelTraits;
    steps: { speak: ProbeStep };
}

export async function probeSpeech(target: SpeechProbeTarget, options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<SpeechProbeResult> {
    const voice = target.voice ?? defaultVoice(target.provider, target.modelId, target.listedVoices);
    const voices = knownVoices(target.provider, target.modelId, target.listedVoices);
    const traits: ModelTraits = { ...(voices.length ? { voices } : {}), ...(voice ? { defaultVoice: voice } : {}) };
    const observation = beginModelObservation({ providerId: target.provider.id, modelId: target.modelId, purpose: "probe" });
    const started = performance.now();
    const pieces: Buffer[] = [];
    let firstMs: number | null = null, sampleRate = 0, format: "pcm" | "wav" | null = null;
    try {
        for await (const chunk of apiSpeechStream({ provider: target.provider, modelId: target.modelId, apiKey: target.apiKey, voice }, SPEECH_PROBE_TEXT, { ...options, timeoutMs: PROBE_TIMEOUT_MS })) {
            if (firstMs === null) { firstMs = Math.round(performance.now() - started); observation.firstAnswer(); }
            pieces.push(chunk.pcm);
            sampleRate = chunk.sampleRate;
            format = chunk.format;
        }
    } catch (error) {
        const ms = Math.round(performance.now() - started);
        if (!(error instanceof SpeechRequestError)) throw error;
        observation.finish({ error: error.status === null ? { name: error.transient ? "TimeoutError" : "TypeError" } : { status: error.status } });
        const outcome = error.transient ? "transient" : "fail";
        return {
            status: error.transient ? "inconclusive" : "failed", retired: error.status === 410, retiredAt: error.retiredAt, ms: null, traits,
            steps: { speak: { outcome, httpStatus: error.status, ms, detail: error.message.slice(0, 300) } },
        };
    }
    observation.finish();
    const pcm = Buffer.concat(pieces);
    const audioSec = Math.round(pcmSeconds(pcm, sampleRate) * 100) / 100;
    const silent = pcmRms(pcm) < SILENCE_RMS;
    const ok = !silent && audioSec >= MIN_AUDIO_SEC && audioSec <= MAX_AUDIO_SEC;
    Object.assign(traits, { audioFormat: format ?? undefined, sampleRate: sampleRate || undefined, channels: 1, audioSec, ...(firstMs !== null ? { firstAudioMs: firstMs } : {}) });
    const detail = ok ? `${audioSec} s at ${sampleRate} Hz (${format}).` : silent ? "The audio was silent." : `${audioSec} s of audio for a 4-second sentence.`;
    return {
        status: ok ? "passed" : "failed", retired: false, retiredAt: null, ms: firstMs, traits,
        steps: { speak: { outcome: ok ? "pass" : "fail", httpStatus: 200, ms: Math.round(performance.now() - started), detail } },
    };
}
