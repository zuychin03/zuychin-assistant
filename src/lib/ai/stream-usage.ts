export interface CompatUsage {
    promptTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cachedInputTokens: number | null;
    completeness: "complete" | "partial" | "unavailable";
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function addTokenCounts(left: number | null, right: number | null): number | null {
    return left === null || right === null ? null : count(left + right);
}

export function requestUsage(raw: unknown, finished: boolean): CompatUsage {
    const usage = record(raw);
    const promptTokens = count(usage.prompt_tokens);
    const outputTokens = count(usage.completion_tokens);
    const totalTokens = count(usage.total_tokens);
    const details = record(usage.prompt_tokens_details);
    const cached = count("cached_tokens" in details ? details.cached_tokens : usage.prompt_cache_hit_tokens);
    const cachedInputTokens = cached !== null && (promptTokens === null || cached <= promptTokens) ? cached : null;
    const known = [promptTokens, outputTokens, totalTokens, cachedInputTokens].some((value) => value !== null);
    return {
        promptTokens: finished ? promptTokens : null,
        outputTokens: finished ? outputTokens : null,
        totalTokens: finished ? totalTokens : null,
        cachedInputTokens: finished ? cachedInputTokens : null,
        completeness: !known ? "unavailable"
            : finished && promptTokens !== null && outputTokens !== null && totalTokens !== null ? "complete" : "partial",
    };
}

export function aggregateUsage(requests: CompatUsage[]): CompatUsage {
    const sum = (key: "promptTokens" | "outputTokens" | "totalTokens" | "cachedInputTokens") => {
        if (!requests.length || requests.some((request) => request[key] === null)) return null;
        return count(requests.reduce((total, request) => total + request[key]!, 0));
    };
    const promptTokens = sum("promptTokens");
    const outputTokens = sum("outputTokens");
    const totalTokens = sum("totalTokens");
    return {
        promptTokens, outputTokens, totalTokens,
        cachedInputTokens: sum("cachedInputTokens"),
        completeness: !requests.some((request) => request.completeness !== "unavailable") ? "unavailable"
            : requests.every((request) => request.completeness === "complete") && promptTokens !== null && outputTokens !== null && totalTokens !== null ? "complete" : "partial",
    };
}
