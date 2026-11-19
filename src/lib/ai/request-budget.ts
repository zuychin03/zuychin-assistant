// Per-minute token budgets for providers whose free plan caps tokens per minute below the context window (Groq).

/** Below this much room for the reply, a request is not worth sending. */
export const MIN_REPLY_TOKENS = 1024;
const WINDOW_MS = 60_000;
// JSON chat payloads run about 3.5 characters a token; overestimating skips a few requests that would have fitted
// rather than sending ones that are refused.
const CHARS_PER_TOKEN = 3.5;
const LEDGER = Symbol.for("zuychin.assistant.requestBudget");

export type RequestLimitReason = "request" | "minute" | "upstream";

export class RequestLimitError extends Error {
    /** Tools that already ran this turn; repeating the turn elsewhere would run them again. */
    toolsRun: string[] = [];

    constructor(
        readonly reason: RequestLimitReason,
        readonly providerLabel: string,
        readonly modelId: string,
        readonly limit: number,
        readonly estimatedTokens: number,
        readonly usedTokens: number,
        /** The provider's HTTP status when it refused the request itself; model-observations reads this. */
        readonly status?: number,
    ) {
        super(reason === "request"
            ? `${providerLabel}: this request (about ${estimatedTokens} tokens) does not fit the free tier's ${limit} tokens per minute for ${modelId}.`
            : reason === "minute"
                ? `${providerLabel}: ${modelId} has used about ${usedTokens} of its ${limit} free tokens this minute, too few left for this request (about ${estimatedTokens}).`
                : `${providerLabel} ${status}: free-tier limit reached for ${modelId}.`);
        this.name = "RequestLimitError";
    }
}

type Entry = { at: number; tokens: number };

function ledger(): Map<string, Entry[]> {
    const holder = globalThis as typeof globalThis & { [LEDGER]?: Map<string, Entry[]> };
    holder[LEDGER] ??= new Map();
    return holder[LEDGER];
}

export function budgetKey(providerId: string, modelId: string): string {
    return `${providerId}::${modelId}`;
}

export function estimateTokens(payload: unknown): number {
    return Math.ceil((JSON.stringify(payload ?? null) ?? "").length / CHARS_PER_TOKEN);
}

export function tokensUsedInLastMinute(key: string, now = Date.now()): number {
    const entries = ledger().get(key);
    if (!entries) return 0;
    const live = entries.filter((entry) => now - entry.at < WINDOW_MS);
    ledger().set(key, live);
    return live.reduce((total, entry) => total + entry.tokens, 0);
}

export function recordTokens(key: string, tokens: number, now = Date.now()): void {
    if (!(tokens > 0)) return;
    const live = (ledger().get(key) ?? []).filter((entry) => now - entry.at < WINDOW_MS);
    live.push({ at: now, tokens });
    ledger().set(key, live);
}

export type RequestPlan =
    | { ok: true; maxTokens: number; used: number }
    | { ok: false; reason: "request" | "minute"; used: number };

/** Caps the reply to the room left this minute, or refuses when the prompt and a minimal reply do not fit. */
export function planRequest(limit: number, key: string, estimate: number, requestedMax?: number, now = Date.now()): RequestPlan {
    if (estimate + MIN_REPLY_TOKENS > limit) return { ok: false, reason: "request", used: tokensUsedInLastMinute(key, now) };
    const used = tokensUsedInLastMinute(key, now);
    const room = limit - used - estimate;
    if (room < MIN_REPLY_TOKENS) return { ok: false, reason: "minute", used };
    return { ok: true, maxTokens: requestedMax === undefined ? room : Math.min(requestedMax, room), used };
}

/** A refused turn can move to another model only when every tool it already ran was read-only. */
export function canRepeatElsewhere(err: unknown, readOnlyTools: ReadonlySet<string>): err is RequestLimitError {
    return err instanceof RequestLimitError && err.toolsRun.every((name) => readOnlyTools.has(name));
}

export function fallbackNote(err: RequestLimitError, fallbackLabel: string): string {
    return `\n\n_[${err.providerLabel}'s free tier could not take this request, so ${fallbackLabel} answered.]_`;
}

export function stoppedAfterTools(err: RequestLimitError): Error {
    const tools = [...new Set(err.toolsRun)].join(", ");
    return new Error(`${err.message} This turn had already run ${tools}, so it was not repeated on another model. Ask again in a minute, or pick another model.`);
}

export function resetRequestBudgetsForTests(): void {
    ledger().clear();
}
