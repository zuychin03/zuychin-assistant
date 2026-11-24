import { getCronState, setCronState } from "@/lib/cron-state";

// Runtime override for the knowledge store's embedding partition, set by the
// switch job (/api/admin/embedding/switch) AFTER a full re-embed finishes.
// Kept in cron_state so it survives deploys without an env change; the cache
// makes getEmbeddingRef() stay synchronous. Async entry points (chat, tools,
// MCP, crons) must await refreshEmbeddingOverride() before resolving refs so
// a cold lambda can't briefly serve the wrong partition.

const STATE_KEY = "knowledge_embedding";
const TTL_MS = 60_000;

/** `model` is the partition id; `providerId` picks the primary route when several serve it. */
export interface EmbeddingSetting {
    model: string;
    providerId?: string;
    dimension?: number;
}

let cached: EmbeddingSetting | null = null;
let loadedAt = 0;
let lastReadSucceeded = false;

export function parseEmbeddingSetting(raw: unknown): EmbeddingSetting | null {
    if (!raw || typeof raw !== "object") return null;
    const { model, providerId, dimension } = raw as Record<string, unknown>;
    if (typeof model !== "string" || !model.trim()) return null;
    return {
        model,
        ...(typeof providerId === "string" && providerId ? { providerId } : {}),
        ...(typeof dimension === "number" && Number.isInteger(dimension) && dimension > 0 ? { dimension } : {}),
    };
}

export function cachedEmbeddingOverride(): string | null {
    return cached?.model ?? null;
}

export function cachedEmbeddingSetting(): EmbeddingSetting | null {
    return cached;
}

/** Strict callers require a confirmed partition; ordinary callers retain fallback behaviour. */
export async function refreshEmbeddingOverride(signal?: AbortSignal, strict = false): Promise<void> {
    if (loadedAt && Date.now() - loadedAt < TTL_MS && (!strict || lastReadSucceeded)) return;
    try {
        cached = parseEmbeddingSetting(await getCronState<Record<string, unknown>>(STATE_KEY, signal));
        lastReadSucceeded = true;
    } catch {
        lastReadSucceeded = false;
        if (strict) throw new Error("Knowledge embedding partition is unavailable.");
    }
    loadedAt = Date.now();
}

export async function setEmbeddingOverride(model: string, signal?: AbortSignal, route: Omit<EmbeddingSetting, "model"> = {}): Promise<void> {
    const setting: EmbeddingSetting = { model, ...route };
    await setCronState(STATE_KEY, { ...setting }, signal);
    cached = setting;
    lastReadSucceeded = true;
    loadedAt = Date.now();
}
