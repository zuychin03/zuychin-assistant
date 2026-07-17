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

export function cachedEmbeddingOverride(): string | null {
    return cached;
}

/** TTL-cached read of the override; never throws (falls back to env/default). */
export async function refreshEmbeddingOverride(): Promise<void> {
    if (loadedAt && Date.now() - loadedAt < TTL_MS) return;
    try {
        const state = await getCronState<{ model?: string }>(STATE_KEY);
        cached = state?.model ?? null;
    } catch {
        // Pre-DDL or transient failure: keep the last known value.
    }
    loadedAt = Date.now();
}

export async function setEmbeddingOverride(model: string): Promise<void> {
    await setCronState(STATE_KEY, { model });
    cached = model;
    loadedAt = Date.now();
}
