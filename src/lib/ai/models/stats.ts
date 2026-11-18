import { isPurposeTag, type PurposeTag } from "@/lib/ai/models/tags";

export const SPEED_WINDOW_DAYS = 14;
export const FEEDBACK_WINDOW_DAYS = 30;
export const MIN_TIMED_CALLS = 3;
export const FAST_FIRST_ANSWER_MS = 5_000;
export const MEDIUM_FIRST_ANSWER_MS = 20_000;
export const RELIABLE_SUCCESS_RATE = 0.8;
export const MIN_RELIABILITY_CALLS = 5;
export const MIN_FEEDBACK_RATINGS = 3;

export interface SpeedStats {
    providerId: string;
    modelId: string;
    timedCalls: number;
    medianFirstAnswerMs: number | null;
    p90FirstAnswerMs: number | null;
    medianDurationMs: number | null;
    medianTokensPerSecond: number | null;
    succeeded: number;
    failed: number;
    lastSuccessAt: string | null;
}

export interface FeedbackCount {
    useful: number;
    notUseful: number;
}

/** Per model: counts by purpose tag, plus "all" for every rating of that model. */
export type ModelFeedback = Partial<Record<PurposeTag | "all", FeedbackCount>>;

export type SpeedTier = "fast" | "medium" | "slow" | "unknown";

export interface ModelSpeed {
    tier: SpeedTier;
    firstAnswerMs: number | null;
    p90FirstAnswerMs: number | null;
    tokensPerSecond: number | null;
    /** Timed calls behind the numbers; 1 when they come from the latest test. */
    samples: number;
    source: "calls" | "test" | "none";
    calls: number;
    successRate: number | null;
    /** Null until enough calls are recorded to judge. */
    reliable: boolean | null;
}

export const statsKey = (providerId: string, modelId: string) => `${providerId}::${modelId}`;

export function speedTier(firstAnswerMs: number | null): SpeedTier {
    if (firstAnswerMs === null) return "unknown";
    return firstAnswerMs <= FAST_FIRST_ANSWER_MS ? "fast" : firstAnswerMs <= MEDIUM_FIRST_ANSWER_MS ? "medium" : "slow";
}

/** Measured speed from recorded calls, else the latest test's chat time. */
export function modelSpeed(stats: SpeedStats | undefined, probeChatMs: number | null): ModelSpeed {
    const calls = stats ? stats.succeeded + stats.failed : 0;
    const successRate = stats && calls > 0 ? stats.succeeded / calls : null;
    const reliable = successRate === null || calls < MIN_RELIABILITY_CALLS ? null : successRate >= RELIABLE_SUCCESS_RATE;
    if (stats && stats.timedCalls >= MIN_TIMED_CALLS && stats.medianFirstAnswerMs !== null) {
        return {
            tier: speedTier(stats.medianFirstAnswerMs), firstAnswerMs: stats.medianFirstAnswerMs, p90FirstAnswerMs: stats.p90FirstAnswerMs,
            tokensPerSecond: stats.medianTokensPerSecond, samples: stats.timedCalls, source: "calls", calls, successRate, reliable,
        };
    }
    if (probeChatMs !== null) {
        return { tier: speedTier(probeChatMs), firstAnswerMs: probeChatMs, p90FirstAnswerMs: null, tokensPerSecond: stats?.medianTokensPerSecond ?? null, samples: 1, source: "test", calls, successRate, reliable };
    }
    return { tier: "unknown", firstAnswerMs: null, p90FirstAnswerMs: null, tokensPerSecond: null, samples: 0, source: "none", calls, successRate, reliable };
}

/** -2 to +2 from the share of useful ratings, or 0 below the minimum number of ratings. */
export function feedbackScore(count: FeedbackCount | undefined): number {
    if (!count) return 0;
    const total = count.useful + count.notUseful;
    if (total < MIN_FEEDBACK_RATINGS) return 0;
    return Math.max(-2, Math.min(2, 4 * (count.useful / total - 0.5)));
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/;
const ms = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const count = (value: unknown): number => {
    const numeric = typeof value === "string" ? Number(value) : value;
    return typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
};

export function speedFromDb(raw: unknown): SpeedStats | null {
    const row = record(raw);
    if (typeof row.provider_id !== "string" || !ID.test(row.provider_id) || typeof row.model_id !== "string" || !ID.test(row.model_id)) return null;
    return {
        providerId: row.provider_id, modelId: row.model_id, timedCalls: count(row.timed_calls),
        medianFirstAnswerMs: ms(row.median_first_answer_ms), p90FirstAnswerMs: ms(row.p90_first_answer_ms),
        medianDurationMs: ms(row.median_duration_ms), medianTokensPerSecond: ms(row.median_tokens_per_second),
        succeeded: count(row.succeeded), failed: count(row.failed),
        lastSuccessAt: typeof row.last_success_at === "string" && Number.isFinite(Date.parse(row.last_success_at)) ? row.last_success_at : null,
    };
}

/** Folds `assistant_model_feedback` rows into per-model counts. */
export function feedbackFromDb(rows: readonly unknown[]): Map<string, ModelFeedback> {
    const out = new Map<string, ModelFeedback>();
    for (const raw of rows) {
        const row = record(raw);
        if (typeof row.provider_id !== "string" || !ID.test(row.provider_id) || typeof row.model_id !== "string" || !ID.test(row.model_id)) continue;
        const key = statsKey(row.provider_id, row.model_id);
        const entry = out.get(key) ?? {};
        const add = (bucket: PurposeTag | "all") => {
            const current = entry[bucket] ?? { useful: 0, notUseful: 0 };
            entry[bucket] = { useful: current.useful + count(row.useful), notUseful: current.notUseful + count(row.not_useful) };
        };
        add("all");
        if (isPurposeTag(row.purpose)) add(row.purpose);
        out.set(key, entry);
    }
    return out;
}

export type StatsStorage = "empty" | "ok" | "migration_required" | "unavailable";

export interface StatsSnapshot {
    loadedAt: number;
    storage: StatsStorage;
    speed: ReadonlyMap<string, SpeedStats>;
    feedback: ReadonlyMap<string, ModelFeedback>;
}

const STALE_MS = 10 * 60_000;
// Instrumentation and route handlers can be separate bundles with separate module state.
const KEY = Symbol.for("zuychin.assistant.modelStats");

interface State {
    snapshot: StatsSnapshot;
    refreshing: Promise<void> | null;
    autoRefresh: boolean;
}

function state(): State {
    const holder = globalThis as typeof globalThis & { [KEY]?: State };
    holder[KEY] ??= { snapshot: { loadedAt: 0, storage: "empty", speed: new Map(), feedback: new Map() }, refreshing: null, autoRefresh: false };
    return holder[KEY];
}

/** Current speed and feedback, never awaited. With auto refresh on, a stale snapshot starts a background reload. */
export function statsSnapshot(): StatsSnapshot {
    const current = state();
    if (current.autoRefresh && !current.refreshing && Date.now() - current.snapshot.loadedAt > STALE_MS) void refreshStatsSnapshot();
    return current.snapshot;
}

export async function refreshStatsSnapshot(): Promise<StatsSnapshot> {
    const current = state();
    if (!current.refreshing) {
        current.refreshing = (async () => {
            try {
                // Loaded lazily so importing the roster never builds a Supabase client.
                const { readModelStats } = await import("@/lib/ai/models/store");
                const result = await readModelStats();
                current.snapshot = result.ok
                    ? { loadedAt: Date.now(), storage: "ok", speed: result.speed, feedback: result.feedback }
                    : { ...current.snapshot, loadedAt: Date.now(), storage: result.reason };
            } catch (error) {
                console.error("[ModelStats] Refresh failed:", error instanceof Error ? error.message : error);
                current.snapshot = { ...current.snapshot, loadedAt: Date.now(), storage: "unavailable" };
            } finally {
                current.refreshing = null;
            }
        })();
    }
    await current.refreshing;
    return current.snapshot;
}

export function enableStatsRefresh(): void {
    state().autoRefresh = true;
}

export function setStatsSnapshotForTests(speed: readonly SpeedStats[], feedback: ReadonlyMap<string, ModelFeedback> = new Map()): void {
    state().snapshot = { loadedAt: Date.now(), storage: "ok", speed: new Map(speed.map((entry) => [statsKey(entry.providerId, entry.modelId), entry])), feedback };
}
