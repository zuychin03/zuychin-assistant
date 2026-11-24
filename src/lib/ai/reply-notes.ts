// No imports: the reply details panel renders these lines in the browser.

/** How a retrieved list was ordered: by a rerank model, or by the app's own score when none answered. */
export interface ReplyRanking {
    target: "memories" | "knowledge" | "vault";
    by: "model" | "keyword";
    /** The rerank model that ranked the list, or the one that did not answer. */
    model?: string;
    reason?: "off" | "refused" | "timeout" | "failed";
    ms?: number;
    candidates: number;
}

const RANKING_TARGETS: Record<ReplyRanking["target"], string> = { memories: "Memories", knowledge: "Knowledge", vault: "Vault search" };
const RANKING_REASONS: Record<NonNullable<ReplyRanking["reason"]>, string> = {
    off: "no rerank model is in use", refused: "the data policy refused the rerank model", timeout: "the rerank model was too slow", failed: "the rerank model failed",
};

export function describeRanking(ranking: ReplyRanking): string {
    const target = RANKING_TARGETS[ranking.target] ?? "Results";
    if (ranking.by === "model") return `${target}: reranked by ${ranking.model ?? "a rerank model"} (${ranking.candidates} candidates${typeof ranking.ms === "number" ? `, ${ranking.ms} ms` : ""}).`;
    const reason = ranking.reason ? RANKING_REASONS[ranking.reason] : undefined;
    return `${target}: keyword ranking${reason ? `, because ${reason}` : ""}.`;
}

/** Where outside text entered a turn. The memory gate cannot say which one held the instructions, only that one did. */
export type UntrustedSource = "search results" | "emails" | "calendar events" | "an attached file" | "your message";

/** Set when the memory gate judged that fetched or quoted text tried to instruct the assistant. */
export interface UntrustedNote {
    sources: UntrustedSource[];
}

function list(items: readonly string[]): string {
    return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

export function describeUntrusted(note: UntrustedNote): string {
    const sources = note.sources.length ? list(note.sources) : "quoted text";
    return `Untrusted content: text in ${sources} looked like instructions to the assistant, so nothing from this turn was saved to memory.`;
}
