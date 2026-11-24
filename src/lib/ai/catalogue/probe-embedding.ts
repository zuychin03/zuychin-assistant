import { beginModelObservation } from "@/lib/ai/model-observations";
import { cosine, requestEmbeddings, retiredAtFrom, type EmbedInputType, type EmbeddingResponse, type EmbeddingRoute } from "@/lib/ai/embedding-request";
import type { ProbeStep } from "@/lib/ai/catalogue/probe";
import type { ModelTraits } from "@/lib/ai/catalogue/snapshot";
import type { ProviderConfig } from "@/lib/ai/providers";

// Fixed public texts only. The two queries must each rank their own passage first.
export const PROBE_PASSAGES = [
    "The quick brown fox jumps over the lazy dog near the riverbank.",
    "Knead the bread dough for ten minutes, then let it rise in a warm place for an hour.",
    "Tomorrow will be cloudy in the morning with light rain clearing by the afternoon.",
] as const;
export const PROBE_QUERIES = [
    { text: "Which animal jumps over the lazy dog?", passage: 0 },
    { text: "What is the weather forecast for tomorrow?", passage: 2 },
] as const;

// Same-space and same-vector threshold; identical routes measured 1.0000 on 23/11/2026.
export const SAME_SPACE_MIN = 0.999;
const ASYMMETRIC_BELOW = 0.99;
const TRUNCATED_DIMENSION = 512;
const CALL_TIMEOUT_MS = 30_000;

export type EmbeddingProbeStepName = "plain" | "typed" | "retrieval" | "truncate" | "batch" | "space";

/** Vectors of the active partition's primary route for the same fixed texts. */
export interface SpaceReference {
    partitionId: string;
    passages: number[][];
    queries: number[][];
}

export interface EmbeddingProbeTarget {
    provider: Pick<ProviderConfig, "id" | "kind" | "baseUrl" | "extraHeaders">;
    modelId: string;
    apiKey: string;
    /** Compared only when the dimension matches. */
    reference?: SpaceReference;
}

export interface EmbeddingProbeResult {
    status: "passed" | "failed" | "inconclusive";
    retired: boolean;
    retiredAt: string | null;
    dimension: number | null;
    /** Median single-call time. */
    ms: number | null;
    traits: ModelTraits;
    /** The partition id this route reproduces, or null. */
    spaceOf: string | null;
    vectors: { passages: number[][]; queries: number[][] } | null;
    steps: Partial<Record<EmbeddingProbeStepName, ProbeStep>>;
}

const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

function transient(response: Extract<EmbeddingResponse, { ok: false }>): boolean {
    return response.timedOut || response.status === null || TRANSIENT_HTTP.has(response.status);
}

function median(values: number[]): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function step(outcome: ProbeStep["outcome"], response: EmbeddingResponse | null, detail: string | null = null): ProbeStep {
    return { outcome, httpStatus: response ? (response.ok ? 200 : response.status) : null, ms: response?.ms ?? null, detail: detail ?? (response && !response.ok ? response.error : null) };
}

export async function probeEmbedding(target: EmbeddingProbeTarget, options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<EmbeddingProbeResult> {
    const steps: EmbeddingProbeResult["steps"] = {};
    const timings: number[] = [];
    const traits: ModelTraits = {};
    const route = (inputType: boolean, dimension?: number): EmbeddingRoute => ({ provider: target.provider, modelId: target.modelId, apiKey: target.apiKey, inputType, ...(dimension ? { dimension } : {}) });
    const call = async (embedRoute: EmbeddingRoute, texts: readonly string[], inputType: EmbedInputType): Promise<EmbeddingResponse> => {
        const observation = beginModelObservation({ providerId: target.provider.id, modelId: target.modelId, purpose: "probe" });
        const response = await requestEmbeddings(embedRoute, texts, inputType, { ...options, timeoutMs: CALL_TIMEOUT_MS });
        if (response.ok) observation.finish();
        else observation.finish({ error: response.timedOut ? { name: "TimeoutError" } : response.status === null ? { name: "TypeError" } : { status: response.status } });
        return response;
    };
    const done = (status: EmbeddingProbeResult["status"], extra: Partial<EmbeddingProbeResult> = {}): EmbeddingProbeResult => ({
        status, retired: false, retiredAt: null, dimension: null, ms: median(timings), traits, spaceOf: null, vectors: null, steps, ...extra,
    });
    const failed = (name: EmbeddingProbeStepName, response: Extract<EmbeddingResponse, { ok: false }>): EmbeddingProbeResult => {
        steps[name] = step(transient(response) ? "transient" : "fail", response);
        if (transient(response)) return done("inconclusive");
        if (response.status === 404) steps[name]!.detail = `Not callable on this key: ${response.error}`.slice(0, 300);
        return done("failed", { retired: response.status === 410, retiredAt: response.status === 410 ? retiredAtFrom(response.error) : null });
    };
    const gemini = target.provider.kind === "gemini";

    // 1. Without an input type: tells whether the route needs one.
    const plain = gemini ? null : await call(route(false), [PROBE_PASSAGES[0]], "passage");
    if (plain) {
        if (plain.ok) { steps.plain = step("pass", plain); timings.push(plain.ms); }
        else if (plain.status === 400 && /input_type/i.test(plain.error)) { steps.plain = step("pass", plain, "Needs input_type."); traits.needsInputType = true; }
        else return failed("plain", plain);
    }

    // 2. Every fixed text with its input type; the fox passage again as a query shows whether the two forms differ.
    let typedRoute = route(true);
    let first = await call(typedRoute, [PROBE_PASSAGES[0]], "passage");
    if (!first.ok && !gemini && first.status === 400 && plain?.ok) {
        // The route refuses input_type but embeds without it.
        typedRoute = route(false);
        first = plain;
    }
    if (!first.ok) return failed("typed", first);
    traits.acceptsInputType = gemini || typedRoute.inputType;
    if (first !== plain) timings.push(first.ms);
    const passages: number[][] = [first.vectors[0]];
    const queries: number[][] = [];
    for (const text of PROBE_PASSAGES.slice(1)) {
        const response = await call(typedRoute, [text], "passage");
        if (!response.ok) return failed("typed", response);
        timings.push(response.ms);
        passages.push(response.vectors[0]);
    }
    for (const query of PROBE_QUERIES) {
        const response = await call(typedRoute, [query.text], "query");
        if (!response.ok) return failed("typed", response);
        timings.push(response.ms);
        queries.push(response.vectors[0]);
    }
    const foxAsQuery = await call(typedRoute, [PROBE_PASSAGES[0]], "query");
    if (!foxAsQuery.ok) return failed("typed", foxAsQuery);
    timings.push(foxAsQuery.ms);
    const dimension = passages[0].length;
    if (![...passages, ...queries, foxAsQuery.vectors[0]].every((entry) => entry.length === dimension && entry.some((value) => value !== 0))) {
        steps.typed = step("fail", null, "Vectors differ in length or are all zero.");
        return done("failed");
    }
    traits.asymmetric = cosine(foxAsQuery.vectors[0], passages[0]) < ASYMMETRIC_BELOW;
    steps.typed = step("pass", first, `${dimension} dimensions.`);

    // 3. Retrieval sanity.
    const ranked = PROBE_QUERIES.map((query, index) => {
        const scores = passages.map((passage) => cosine(queries[index], passage));
        return scores.indexOf(Math.max(...scores)) === query.passage;
    });
    if (!ranked.every(Boolean)) {
        steps.retrieval = step("fail", null, "A query did not rank its own passage first.");
        return done("failed", { dimension });
    }
    steps.retrieval = step("pass", null);

    // 4. Reduced dimension.
    const reduced = dimension > TRUNCATED_DIMENSION ? await call(route(typedRoute.inputType, TRUNCATED_DIMENSION), [PROBE_PASSAGES[0]], "passage") : null;
    traits.truncatable = !!reduced?.ok && reduced.vectors[0].length === TRUNCATED_DIMENSION;
    steps.truncate = reduced ? step(traits.truncatable ? "pass" : reduced.ok ? "fail" : transient(reduced) ? "transient" : "fail", reduced, reduced.ok && !traits.truncatable ? `Returned ${reduced.vectors[0].length} dimensions.` : null) : step("skipped", null);

    // 5. Batch: two texts in one request, back in order.
    const batch = await call(typedRoute, PROBE_PASSAGES.slice(0, 2), "passage");
    traits.batch = batch.ok && batch.vectors.length === 2
        && cosine(batch.vectors[0], passages[0]) >= SAME_SPACE_MIN && cosine(batch.vectors[1], passages[1]) >= SAME_SPACE_MIN;
    steps.batch = step(traits.batch ? "pass" : batch.ok ? "fail" : transient(batch) ? "transient" : "fail", batch, batch.ok && !traits.batch ? "Batch vectors did not match single calls." : null);

    // 6. Same space as the active partition.
    let spaceOf: string | null = null;
    const reference = target.reference;
    if (reference && reference.passages.length === passages.length && reference.queries.length === queries.length && reference.passages[0]?.length === dimension) {
        const same = passages.every((entry, index) => cosine(entry, reference.passages[index]) >= SAME_SPACE_MIN)
            && queries.every((entry, index) => cosine(entry, reference.queries[index]) >= SAME_SPACE_MIN);
        spaceOf = same ? reference.partitionId : null;
        steps.space = step(same ? "pass" : "fail", null, same ? `Same vectors as ${reference.partitionId}.` : `Different vectors from ${reference.partitionId}.`);
    } else steps.space = step("skipped", null);

    return done("passed", { dimension, spaceOf, vectors: { passages, queries } });
}
