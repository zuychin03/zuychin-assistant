import { observedMediaCall } from "@/lib/ai/media/observed";
import type { ProbeStep } from "@/lib/ai/catalogue/probe";
import type { ModelTraits } from "@/lib/ai/catalogue/snapshot";
import type { MediaFailure, MediaRoute } from "@/lib/ai/media/requests";

/** The shared result of the rerank, parse, image, decision, live and translate probes. */
export interface MediaProbeResult {
    status: "passed" | "failed" | "inconclusive";
    retired: boolean;
    retiredAt: string | null;
    ms: number | null;
    traits: ModelTraits;
    steps: Record<string, ProbeStep>;
}

export interface MediaProbeOptions {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    pollMs?: number;
}

export function failedStep(failure: MediaFailure): ProbeStep {
    const detail = failure.status === 404 ? `Not callable on this key: ${failure.error}` : failure.error;
    return { outcome: failure.transient ? "transient" : "fail", httpStatus: failure.status, ms: failure.ms, detail: detail.slice(0, 300) };
}

/** A failed call as a probe result; a 410 marks the model gone with the date from the reply. */
export function failedProbe(name: string, failure: MediaFailure, traits: ModelTraits = {}, steps: Record<string, ProbeStep> = {}): MediaProbeResult {
    return {
        status: failure.transient ? "inconclusive" : "failed", retired: failure.status === 410, retiredAt: failure.retiredAt, ms: null, traits,
        steps: { ...steps, [name]: failedStep(failure) },
    };
}

/** Records one probe call in the model observations, like the other typed probes. */
export function observedProbeCall<T extends { ok: boolean }>(route: MediaRoute, call: () => Promise<T>): Promise<T> {
    return observedMediaCall(route, "probe", call);
}
