import type { ProfileRecord } from "@/lib/ai/models/profiles";

export type CatalogueOrigin = "seed" | "discovered";
export type ProbeStatus = "untested" | "passed" | "failed" | "inconclusive";

export interface CatalogueRow {
    providerId: string;
    modelId: string;
    origin: CatalogueOrigin;
    label: string;
    shortName: string;
    description: string | null;
    developer: string | null;
    free: boolean;
    metered: boolean;
    mayTrain: boolean | null;
    contextTokens: number | null;
    maxOutputTokens: number | null;
    inputs: string[];
    listedTools: boolean | null;
    listedStructured: boolean | null;
    listedThinking: boolean | null;
    probeStatus: ProbeStatus;
    probeAttempts: number;
    probedAt: string | null;
    probeChatMs: number | null;
    supportsTools: boolean | null;
    supportsSearch: boolean | null;
    supportsVision: boolean | null;
    supportsThinking: boolean | null;
    supportsStructured: boolean | null;
    firstSeenAt: string;
    lastSeenAt: string | null;
    missedChecks: number;
    missingSince: string | null;
    notifiedMissingAt: string | null;
    approvedAt: string | null;
}

export type CatalogueStorage = "empty" | "ok" | "migration_required" | "unavailable";

export interface CatalogueSnapshot {
    version: number;
    loadedAt: number;
    storage: CatalogueStorage;
    rows: readonly CatalogueRow[];
    /** Purpose tags and profiles; empty with its own storage state until v7-model-awareness.sql is applied. */
    profiles: readonly ProfileRecord[];
    profileStorage: CatalogueStorage;
}

const STALE_MS = 5 * 60_000;
// Instrumentation and route handlers can be separate bundles with separate module state.
const KEY = Symbol.for("zuychin.assistant.modelCatalogue");

interface State {
    snapshot: CatalogueSnapshot;
    refreshing: Promise<void> | null;
    autoRefresh: boolean;
}

function state(): State {
    const holder = globalThis as typeof globalThis & { [KEY]?: State };
    holder[KEY] ??= { snapshot: { version: 0, loadedAt: 0, storage: "empty", rows: [], profiles: [], profileStorage: "empty" }, refreshing: null, autoRefresh: false };
    return holder[KEY];
}

/** Current catalogue, never awaited. With auto refresh on, a stale snapshot starts a background reload. */
export function catalogueSnapshot(): CatalogueSnapshot {
    const current = state();
    if (current.autoRefresh && !current.refreshing && Date.now() - current.snapshot.loadedAt > STALE_MS) {
        void refreshCatalogueSnapshot();
    }
    return current.snapshot;
}

export async function refreshCatalogueSnapshot(): Promise<CatalogueSnapshot> {
    const current = state();
    if (!current.refreshing) {
        current.refreshing = (async () => {
            try {
                // Loaded lazily so importing providers.ts never builds a Supabase client.
                const { readCatalogueRows } = await import("@/lib/ai/catalogue/store");
                const { readProfiles } = await import("@/lib/ai/models/store");
                const [result, profiles] = await Promise.all([readCatalogueRows(), readProfiles()]);
                const profileState = profiles.ok
                    ? { profiles: profiles.profiles, profileStorage: "ok" as const }
                    : { profiles: current.snapshot.profiles, profileStorage: profiles.reason };
                current.snapshot = result.ok
                    ? { version: current.snapshot.version + 1, loadedAt: Date.now(), storage: "ok", rows: result.rows, ...profileState }
                    : { ...current.snapshot, ...profileState, loadedAt: Date.now(), storage: result.reason };
            } catch (error) {
                console.error("[ModelCatalogue] Refresh failed:", error instanceof Error ? error.message : error);
                current.snapshot = { ...current.snapshot, loadedAt: Date.now(), storage: "unavailable" };
            } finally {
                current.refreshing = null;
            }
        })();
    }
    await current.refreshing;
    return current.snapshot;
}

export function enableCatalogueRefresh(): void {
    state().autoRefresh = true;
}

export function setCatalogueSnapshotForTests(rows: readonly CatalogueRow[], storage: CatalogueStorage = "ok", profiles: readonly ProfileRecord[] = []): void {
    const current = state();
    current.snapshot = { version: current.snapshot.version + 1, loadedAt: Date.now(), storage, rows, profiles, profileStorage: storage };
}
