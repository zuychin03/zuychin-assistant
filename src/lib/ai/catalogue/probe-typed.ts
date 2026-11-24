import type { ProbeStep } from "@/lib/ai/catalogue/probe";
import type { ModelTraits } from "@/lib/ai/catalogue/snapshot";
import type { NonChatKind } from "@/lib/ai/catalogue/sources";
import type { ProviderConfig } from "@/lib/ai/providers";
import { probeEmbedding, type SpaceReference } from "@/lib/ai/catalogue/probe-embedding";
import { probeSpeech } from "@/lib/ai/catalogue/probe-speech";
import { probeTranscription } from "@/lib/ai/catalogue/probe-transcription";
import { probeRerank } from "@/lib/ai/catalogue/probe-rerank";
import { probeParse } from "@/lib/ai/catalogue/probe-parse";
import { probeImage } from "@/lib/ai/catalogue/probe-image";
import { probeDecision } from "@/lib/ai/catalogue/probe-decision";
import { probeLive } from "@/lib/ai/catalogue/probe-live";
import { probeTranslate } from "@/lib/ai/catalogue/probe-translate";
import type { LiveClient } from "@/lib/ai/media/live";
import { mediaRouteSupported } from "@/lib/ai/media/requests";
import type { MediaProbeResult } from "@/lib/ai/catalogue/probe-media";

/** One probe result shape for every non-chat row. */
export interface TypedProbeResult {
    status: "passed" | "failed" | "inconclusive";
    retired: boolean;
    /** Retirement date read from a 410 reply. */
    retiredAt: string | null;
    /** Main call time: per embedding call, first audio, the transcript, or the media call. */
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
    /** Translate rows: the prompt template stored from the model card. */
    template?: string;
}

export interface TypedProbeOptions {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    pollMs?: number;
    live?: LiveClient;
}

function typed(result: MediaProbeResult): TypedProbeResult {
    return { ...result, dimension: null, spaceOf: null };
}

export async function probeTypedModel(target: TypedProbeTarget, options: TypedProbeOptions = {}): Promise<TypedProbeResult> {
    const route = { provider: target.provider, modelId: target.modelId, apiKey: target.apiKey };
    switch (target.kind) {
        case "embedding": {
            const result = await probeEmbedding(target, options);
            return { status: result.status, retired: result.retired, retiredAt: result.retiredAt, ms: result.ms, dimension: result.dimension, spaceOf: result.spaceOf, traits: result.traits, steps: result.steps, vectors: result.vectors };
        }
        case "speech": return { ...await probeSpeech(target, options), dimension: null, spaceOf: null };
        case "transcription": return { ...await probeTranscription(target, options), dimension: null, spaceOf: null };
        default:
            if (!mediaRouteSupported(target.kind, target.provider)) {
                return typed({ status: "failed", retired: false, retiredAt: null, ms: null, traits: {}, steps: { [target.kind]: { outcome: "fail", httpStatus: null, ms: null, detail: `This app has no ${target.kind} request for ${target.provider.id} yet.` } } });
            }
            switch (target.kind) {
                case "rerank": return typed(await probeRerank(route, options));
                case "parse": return typed(await probeParse(route, options));
                case "image": return typed(await probeImage(route, options));
                case "decision": return typed(await probeDecision(route, options));
                case "live": return typed(await probeLive(route, options.live));
                case "translate": return typed(await probeTranslate(route, target.template, options));
            }
    }
}
