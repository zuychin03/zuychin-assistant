import { requestDecision, type DecisionAnswer, type DecisionQuestion } from "@/lib/ai/media/requests";
import { observedMediaCall } from "@/lib/ai/media/observed";
import { resolveModelOfKind, type ResolvedMedia } from "@/lib/ai/media/resolve";

// V8 F14: yes/no, choice and score questions answered by a decision model with probabilities and no text. Every
// caller keeps its earlier code path for null, so a missing model, a refusal or a slow answer changes nothing.

export const DECISION_TIMEOUT_MS = 3_000;
const INPUT_CHARS = 12_000;

export interface Decided<Q extends Record<string, DecisionQuestion>> {
    answers: { [K in keyof Q]: DecisionAnswer };
    model: string;
    ms: number;
}

export interface DecideOptions {
    freeOnly: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** A route resolved earlier (null: none). */
    route?: ResolvedMedia | null;
    fetchImpl?: typeof fetch;
}

/** The decision model in use: the paid key in normal mode, the free key in Free only (V8 Decision 15). Never throws. */
export async function resolveDecider(freeOnly: boolean): Promise<ResolvedMedia | null> {
    try {
        return await resolveModelOfKind("decision", { freeOnly });
    } catch (error) {
        console.warn("[Decisions] Could not resolve a model:", error instanceof Error ? error.message : error);
        return null;
    }
}

/** The answers, or null on no model, a refused data route, a failure or a timeout. Throws only when the caller aborts. */
export async function decide<Q extends Record<string, DecisionQuestion>>(input: string, questions: Q, options: DecideOptions): Promise<Decided<Q> | null> {
    const text = input.trim().slice(0, INPUT_CHARS);
    if (!text) return null;
    const route = options.route !== undefined ? options.route : await resolveDecider(options.freeOnly);
    if (!route) return null;
    const model = route.row.label;
    try {
        const result = await observedMediaCall(route, "decision", () => requestDecision(route, text, questions,
            { fetchImpl: options.fetchImpl, signal: options.signal, timeoutMs: options.timeoutMs ?? DECISION_TIMEOUT_MS }));
        if (result.ok) return { answers: result.value, model, ms: result.ms };
        if (!result.timedOut) console.warn(`[Decisions] ${model} failed: ${result.error}`);
        return null;
    } catch (error) {
        options.signal?.throwIfAborted();
        console.warn("[Decisions] Not sent:", error instanceof Error ? error.message : error);
        return null;
    }
}
