import { requestRerank, type MediaRoute } from "@/lib/ai/media/requests";
import { failedProbe, observedProbeCall, type MediaProbeOptions, type MediaProbeResult } from "@/lib/ai/catalogue/probe-media";

// Fixed public passages. Passages 0 and 2 answer the query; 1 and 3 do not.
export const RERANK_PROBE_QUERY = "How does a reranker improve search results?";
export const RERANK_PROBE_PASSAGES = [
    "A reranker scores each candidate passage against the query and reorders them so the most relevant come first.",
    "The cafe on the corner opens at 7 am and serves good flat whites.",
    "Embeddings retrieve candidates quickly; a cross-encoder reranker then picks the best few for the answer.",
    "Remember to water the basil on the balcony twice a week in summer.",
] as const;
const RELEVANT = new Set([0, 2]);
const PROBE_TIMEOUT_MS = 30_000;

export async function probeRerank(route: MediaRoute, options: MediaProbeOptions = {}): Promise<MediaProbeResult> {
    const result = await observedProbeCall(route, () => requestRerank(route, RERANK_PROBE_QUERY, RERANK_PROBE_PASSAGES, { ...options, timeoutMs: PROBE_TIMEOUT_MS }));
    if (!result.ok) return failedProbe("rerank", result);
    const order = result.value.map((entry) => entry.index);
    const ok = order.slice(0, RELEVANT.size).every((index) => RELEVANT.has(index));
    return {
        status: ok ? "passed" : "failed", retired: false, retiredAt: null, ms: result.ms, traits: {},
        steps: { rerank: { outcome: ok ? "pass" : "fail", httpStatus: result.status, ms: result.ms, detail: `Order ${order.join(", ")}${ok ? "." : "; the two relevant passages did not rank first."}` } },
    };
}
