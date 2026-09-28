import { getCronState, setCronState } from "@/lib/cron-state";

// Runtime override for the knowledge store's embedding partition, set by the
// admin re-embed flow (/api/admin/reembed) AFTER a full migration finishes.
// Kept in cron_state so it survives deploys without an env change; the cache
// makes getEmbeddingRef() stay synchronous. Async entry points (chat, tools,
// MCP, crons) must await refreshEmbeddingOverride() before resolving refs so
// a cold lambda can't briefly serve the wrong partition.

const STATE_KEY = "knowledge_embedding";
const TTL_MS = 60_000;

let cached: string | null = null;
let loadedAt = 0;
let lastReadSucceeded = false;

export function cachedEmbeddingOverride(): string | null {
    return cached;
}

/** Strict callers require a confirmed partition; ordinary callers retain fallback behaviour. */
export async function refreshEmbeddingOverride(signal?: AbortSignal, strict = false): Promise<void> {
    if (loadedAt && Date.now() - loadedAt < TTL_MS && (!strict || lastReadSucceeded)) return;
    try {
        const state = await getCronState<{ model?: string }>(STATE_KEY, signal);
        cached = state?.model ?? null;
        lastReadSucceeded = true;
    } catch {
        lastReadSucceeded = false;
        if (strict) throw new Error("Knowledge embedding partition is unavailable.");
    }
    loadedAt = Date.now();
}

export async function setEmbeddingOverride(model: string, signal?: AbortSignal): Promise<void> {
    await setCronState(STATE_KEY, { model }, signal);
    cached = model;
    lastReadSucceeded = true;
    loadedAt = Date.now();
}
