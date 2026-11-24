import { beginModelObservation } from "@/lib/ai/model-observations";
import type { ProbeStep } from "@/lib/ai/catalogue/probe";
import type { ModelTraits } from "@/lib/ai/catalogue/snapshot";
import type { ProviderConfig } from "@/lib/ai/providers";
import { transcribeWithApi, wordAccuracy } from "@/lib/voice/api-stt";
import { PROBE_CLIP_TEXT, PROBE_CLIP_WAV_BASE64 } from "@/lib/voice/probe-clip";

export const MIN_ACCURACY = 0.8;
const PROBE_TIMEOUT_MS = 60_000;

let clip: Buffer | null = null;
export function probeClip(): Buffer {
    clip ??= Buffer.from(PROBE_CLIP_WAV_BASE64, "base64");
    return clip;
}

export interface TranscriptionProbeTarget {
    provider: Pick<ProviderConfig, "id" | "kind" | "baseUrl" | "extraHeaders">;
    modelId: string;
    apiKey: string;
}

export interface TranscriptionProbeResult {
    status: "passed" | "failed" | "inconclusive";
    retired: boolean;
    retiredAt: string | null;
    ms: number | null;
    traits: ModelTraits;
    steps: { transcribe: ProbeStep };
}

export async function probeTranscription(target: TranscriptionProbeTarget, options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<TranscriptionProbeResult> {
    const observation = beginModelObservation({ providerId: target.provider.id, modelId: target.modelId, purpose: "probe" });
    const result = await transcribeWithApi(target, probeClip(), { ...options, timeoutMs: PROBE_TIMEOUT_MS });
    if (!result.ok) {
        observation.finish({ error: result.status === null ? { name: "TimeoutError" } : { status: result.status } });
        return {
            status: result.transient ? "inconclusive" : "failed", retired: result.status === 410, retiredAt: result.retiredAt, ms: null, traits: {},
            steps: { transcribe: { outcome: result.transient ? "transient" : "fail", httpStatus: result.status, ms: result.ms, detail: result.error } },
        };
    }
    observation.firstAnswer();
    observation.finish();
    const accuracy = Math.round(wordAccuracy(PROBE_CLIP_TEXT, result.text) * 100) / 100;
    const ok = accuracy >= MIN_ACCURACY;
    return {
        status: ok ? "passed" : "failed", retired: false, retiredAt: null, ms: result.ms, traits: { accuracy },
        steps: { transcribe: { outcome: ok ? "pass" : "fail", httpStatus: 200, ms: result.ms, detail: `${Math.round(accuracy * 100)}% of words: "${result.text.slice(0, 80)}"` } },
    };
}
