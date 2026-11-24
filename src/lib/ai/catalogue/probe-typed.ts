import type { ProbeStep } from "@/lib/ai/catalogue/probe";
import type { ModelTraits } from "@/lib/ai/catalogue/snapshot";
import type { NonChatKind } from "@/lib/ai/catalogue/sources";
import type { ProviderConfig } from "@/lib/ai/providers";
import { probeEmbedding, type SpaceReference } from "@/lib/ai/catalogue/probe-embedding";
import { probeSpeech } from "@/lib/ai/catalogue/probe-speech";
import { probeTranscription } from "@/lib/ai/catalogue/probe-transcription";

/** One probe result shape for embedding, speech and transcription rows. */
export interface TypedProbeResult {
    status: "passed" | "failed" | "inconclusive";
    retired: boolean;
    /** Retirement date read from a 410 reply. */
    retiredAt: string | null;
    /** Main call time: per embedding call, first audio, or the transcript. */
    ms: number | null;
    dimension: number | null;
    spaceOf: string | null;
    traits: ModelTraits;
    steps: Record<string, ProbeStep>;
    /** Embedding probes only: the fixed texts' vectors, the reference for same-space checks. */
    vectors?: { passages: number[][]; queries: number[][] } | null;
}

export interface TypedProbeTarget {
    kind: NonChatKind;
    provider: Pick<ProviderConfig, "id" | "kind" | "baseUrl" | "extraHeaders">;
    modelId: string;
    apiKey: string;
    listedVoices?: readonly string[];
    voice?: string;
    reference?: SpaceReference;
}

export async function probeTypedModel(target: TypedProbeTarget, options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<TypedProbeResult> {
    if (target.kind === "embedding") {
        const result = await probeEmbedding(target, options);
        return { status: result.status, retired: result.retired, retiredAt: result.retiredAt, ms: result.ms, dimension: result.dimension, spaceOf: result.spaceOf, traits: result.traits, steps: result.steps, vectors: result.vectors };
    }
    if (target.kind === "speech") {
        const result = await probeSpeech(target, options);
        return { ...result, dimension: null, spaceOf: null };
    }
    const result = await probeTranscription(target, options);
    return { ...result, dimension: null, spaceOf: null };
}
