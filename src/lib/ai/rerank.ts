import { requestRerank } from "@/lib/ai/media/requests";
import { observedMediaCall } from "@/lib/ai/media/observed";
import { resolveModelOfKind, type ResolvedMedia } from "@/lib/ai/media/resolve";
import { recordReplyRanking } from "@/lib/ai/reply-sources";
import type { ReplyRanking } from "@/lib/ai/reply-trace";

// V8 F1: a rerank model orders retrieved passages before they reach a prompt or a result list. Every caller keeps its
// own ranking as the fallback, so a missing model, a refusal or a slow answer only costs the better order.

export const RERANK_TIMEOUT_MS = 1_500;
// Cut so a long chunk cannot push a query and passage pair past the model's token limit.
const PASSAGE_CHARS = 2_000;
const QUERY_CHARS = 1_000;

export type RerankSkip = "few" | "off" | "refused" | "timeout" | "failed";

export type RerankOutcome<T> =
    | { ok: true; items: T[]; scores: number[]; model: string; ms: number }
    | { ok: false; reason: RerankSkip; model?: string; ms?: number };

export interface RerankOptions<T> {
    freeOnly: boolean;
    text: (item: T) => string;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Orders items the model scored equally; input order after that. */
    tieBreak?: (a: T, b: T) => number;
    /** A route resolved earlier (null: none), so one turn reads the catalogue once. */
    route?: ResolvedMedia | null;
    fetchImpl?: typeof fetch;
}

function clip(text: string, max: number): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > max ? line.slice(0, max) : line;
}

/** The rerank model in use, or null. Never throws. */
export async function resolveReranker(freeOnly: boolean): Promise<ResolvedMedia | null> {
    try {
        return await resolveModelOfKind("rerank", { freeOnly });
    } catch (error) {
        console.warn("[Rerank] Could not resolve a model:", error instanceof Error ? error.message : error);
        return null;
    }
}

/** The items in the model's order, best first, or why the caller's own order applies. Throws only when the caller aborts. */
export async function rerank<T>(query: string, items: readonly T[], options: RerankOptions<T>): Promise<RerankOutcome<T>> {
    const question = clip(query, QUERY_CHARS);
    if (items.length < 2 || !question) return { ok: false, reason: "few" };
    const route = options.route !== undefined ? options.route : await resolveReranker(options.freeOnly);
    if (!route) return { ok: false, reason: "off" };
    const model = route.row.label;
    const passages = items.map((item) => clip(options.text(item), PASSAGE_CHARS) || "-");
    let result: Awaited<ReturnType<typeof requestRerank>>;
    try {
        result = await observedMediaCall(route, "rerank", () => requestRerank(route, question, passages,
            { fetchImpl: options.fetchImpl, signal: options.signal, timeoutMs: options.timeoutMs ?? RERANK_TIMEOUT_MS }));
    } catch (error) {
        options.signal?.throwIfAborted();
        console.warn("[Rerank] Not sent:", error instanceof Error ? error.message : error);
        return { ok: false, reason: "refused", model };
    }
    if (!result.ok) {
        if (!result.timedOut) console.warn(`[Rerank] ${model} failed: ${result.error}`);
        return { ok: false, reason: result.timedOut ? "timeout" : "failed", model, ms: result.ms };
    }
    const tie = options.tieBreak;
    const ranked = [...result.value].sort((a, b) => (b.logit - a.logit) || (tie ? tie(items[a.index], items[b.index]) : 0) || a.index - b.index);
    return { ok: true, items: ranked.map((entry) => items[entry.index]), scores: ranked.map((entry) => entry.logit), model, ms: result.ms };
}

export function rankingOf(target: ReplyRanking["target"], outcome: RerankOutcome<unknown>, candidates: number): ReplyRanking | null {
    if (outcome.ok) return { target, by: "model", model: outcome.model, ms: Math.round(outcome.ms), candidates };
    if (outcome.reason === "few") return null;
    return { target, by: "keyword", reason: outcome.reason, ...(outcome.model ? { model: outcome.model } : {}), candidates };
}

/** Notes in the reply details how a list was ordered, so a silent fallback shows. */
export function recordRanking(target: ReplyRanking["target"], outcome: RerankOutcome<unknown>, candidates: number): void {
    const ranking = rankingOf(target, outcome, candidates);
    if (ranking) recordReplyRanking(ranking);
}
