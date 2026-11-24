import {
    MIGRATION_TABLES, applyMigration, mapBounded, planMigration, verifyMigration,
    type MigrationItem, type MigrationStore, type MigrationTable, type PreparedItem,
} from "./embedding-migration.ts";

// The knowledge model switch: re-embeds every stored row on the server, then activates the new partition.
// Progress lives in cron_state so a restart, the daily cron or the next /admin visit can resume it.

export const SWITCH_STATE_KEY = "knowledge_embedding_switch";
export const MAX_BATCH = 32;
export const SWITCH_CONCURRENCY = 2;
export const STALE_SWITCH_MS = 10 * 60_000;
const ROUND_ITEMS = 128;
const BACKOFF_MS = [2_000, 4_000, 8_000];
const MAX_FAILED_BATCHES = 5;
const MAX_IDLE_ROUNDS = 3;

export type SwitchStatus = "running" | "paused" | "done" | "failed";

export interface SwitchState {
    /** Partition id the store moves to. */
    target: string;
    providerId: string;
    modelId: string;
    dimension: number;
    status: SwitchStatus;
    done: number;
    remaining: number | null;
    startedAt: string;
    updatedAt: string;
    error: string | null;
}

export interface SwitchDeps {
    /** Conditional writes and activation. */
    store: MigrationStore;
    /** Scans only rows not yet on the target. */
    pending: MigrationStore;
    countRemaining(target: string): Promise<Record<MigrationTable, number>>;
    embed(texts: string[]): Promise<number[][]>;
    batchSize: number;
    concurrency?: number;
    saveState(state: SwitchState): Promise<void>;
    notify(text: string): Promise<void>;
    now(): number;
    sleep(ms: number): Promise<void>;
}

class QuotaPause extends Error {}

const total = (counts: Record<MigrationTable, number>) => MIGRATION_TABLES.reduce((sum, table) => sum + counts[table], 0);

function statusOf(error: unknown): number | null {
    const status = (error as { status?: unknown } | null)?.status;
    return typeof status === "number" ? status : null;
}

/** A 429 that names a daily allowance waits for the next day; a per-minute one is backed off. */
export function dailyQuota(error: unknown): boolean {
    return statusOf(error) === 429 && /per[\s_-]?day|daily/i.test(error instanceof Error ? error.message : String(error));
}

export function parseSwitchState(raw: unknown): SwitchState | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const text = (key: string) => typeof value[key] === "string" ? value[key] as string : null;
    const status = text("status");
    if (!text("target") || !text("providerId") || !text("modelId") || typeof value.dimension !== "number" || !text("startedAt") || !text("updatedAt")
        || !["running", "paused", "done", "failed"].includes(status ?? "")) return null;
    return {
        target: text("target")!, providerId: text("providerId")!, modelId: text("modelId")!, dimension: value.dimension,
        status: status as SwitchStatus, done: typeof value.done === "number" ? value.done : 0,
        remaining: typeof value.remaining === "number" ? value.remaining : null,
        startedAt: text("startedAt")!, updatedAt: text("updatedAt")!, error: text("error"),
    };
}

/** A paused job, or a running one that stopped reporting (a restart), is picked up again. */
export function shouldResume(state: SwitchState | null, nowMs: number): boolean {
    if (!state || (state.status !== "paused" && state.status !== "running")) return false;
    return nowMs - Date.parse(state.updatedAt) > STALE_SWITCH_MS;
}

/** A switch is in progress and still reporting, so another must not start. */
export function switchBusy(state: SwitchState | null, nowMs: number): boolean {
    return state?.status === "running" && nowMs - Date.parse(state.updatedAt) <= STALE_SWITCH_MS;
}

export function estimateSeconds(rows: number, msPerCall: number | null, batchSize: number, concurrency = SWITCH_CONCURRENCY): number | null {
    if (msPerCall === null || rows <= 0) return rows <= 0 ? 0 : null;
    return Math.ceil((Math.ceil(rows / Math.max(1, batchSize)) * msPerCall) / concurrency / 1000);
}

async function embedWithRetry(deps: SwitchDeps, texts: string[]): Promise<number[][]> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await deps.embed(texts);
        } catch (error) {
            if (dailyQuota(error)) throw new QuotaPause(error instanceof Error ? error.message : String(error));
            const status = statusOf(error);
            const retryable = status === 429 || status === null || status >= 500;
            if (!retryable || attempt >= BACKOFF_MS.length) throw error;
            await deps.sleep(BACKOFF_MS[attempt]);
        }
    }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
    return out;
}

/** Runs the switch until it is done, paused or failed, saving progress after every round. */
export async function runSwitch(initial: SwitchState, deps: SwitchDeps): Promise<SwitchState> {
    const iso = () => new Date(deps.now()).toISOString();
    let state: SwitchState = { ...initial, status: "running", error: null, updatedAt: iso() };
    const save = async (patch: Partial<SwitchState>) => {
        state = { ...state, ...patch, updatedAt: iso() };
        await deps.saveState(state);
    };
    const verify = async (store: MigrationStore, target: string, dimension: number) => {
        const counts = await deps.countRemaining(target);
        return total(counts) ? counts : verifyMigration(store, target, dimension);
    };
    await save({});
    let failedBatches = 0, idleRounds = 0, lastError = "";
    try {
        for (;;) {
            const plan = await planMigration(deps.pending, state.target, state.dimension, { maxItems: ROUND_ITEMS, stopAfterMaxItems: true });
            const batches = chunks(plan.items, Math.min(MAX_BATCH, Math.max(1, deps.batchSize)));
            const embedded = await mapBounded(batches, deps.concurrency ?? SWITCH_CONCURRENCY, async (batch): Promise<PreparedItem[] | null> => {
                if (failedBatches >= MAX_FAILED_BATCHES) return null;
                try {
                    const vectors = await embedWithRetry(deps, batch.map((item) => item.text));
                    failedBatches = 0;
                    return batch.map((item, index) => ({ ...item, vector: vectors[index] }));
                } catch (error) {
                    if (error instanceof QuotaPause) throw error;
                    failedBatches++;
                    lastError = error instanceof Error ? error.message : String(error);
                    return null;
                }
            });
            if (failedBatches >= MAX_FAILED_BATCHES) {
                await save({ status: "paused", error: `Five batches failed in a row: ${lastError.slice(0, 300)}` });
                break;
            }
            const prepared = embedded.flatMap((batch) => batch ?? []);
            const items: MigrationItem[] = prepared.map(({ table, row, text }) => ({ table, row, text }));
            const result = await applyMigration(deps.store, { ...plan, items }, prepared, deps.concurrency ?? SWITCH_CONCURRENCY, verify);
            const progressed = result.updated + result.alreadyCurrent;
            idleRounds = progressed ? 0 : idleRounds + 1;
            if (result.complete) {
                await save({ status: "done", done: state.done + progressed, remaining: 0 });
                break;
            }
            await save({ done: state.done + progressed, remaining: total(result.remaining) });
            if (idleRounds >= MAX_IDLE_ROUNDS) {
                await save({ status: "paused", error: lastError ? `No rows moved in three rounds: ${lastError.slice(0, 300)}` : "No rows moved in three rounds; rows kept changing during the switch." });
                break;
            }
        }
    } catch (error) {
        if (error instanceof QuotaPause) await save({ status: "paused", error: `Daily quota reached; the next daily run resumes it. ${error.message.slice(0, 200)}` });
        else await save({ status: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
    }
    if (state.status !== "running") {
        const line = state.status === "done"
            ? `Knowledge model switch finished: ${state.done} rows now on ${state.target} (${state.providerId}).`
            : `Knowledge model switch to ${state.target} ${state.status}: ${state.error ?? "unknown error"} ${state.remaining ?? "Some"} rows left.`;
        await deps.notify(`**Knowledge model** ${line}`).catch(() => {});
    }
    return state;
}
