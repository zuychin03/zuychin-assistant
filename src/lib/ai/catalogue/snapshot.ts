import type { ProfileRecord } from "@/lib/ai/models/profiles";
import type { ModelKind } from "@/lib/ai/catalogue/sources";

export type CatalogueOrigin = "seed" | "discovered";
export type ProbeStatus = "untested" | "passed" | "failed" | "inconclusive";
export type ExpiresSource = "listing" | "lookup" | "gone";

/** Probe and listing facts for non-chat rows; every field is optional and absent means unknown. */
export interface ModelTraits {
    voices?: string[];
    defaultVoice?: string;
    /** Response audio, e.g. "pcm" or "wav", with its sample rate and channel count. */
    audioFormat?: string;
    sampleRate?: number;
    channels?: number;
    firstAudioMs?: number;
    /** Seconds of audio from the speech probe's fixed sentence. */
    audioSec?: number;
    needsInputType?: boolean;
    /** The route takes input_type (or a Gemini task type), so query and passage calls can differ. */
    acceptsInputType?: boolean;
    asymmetric?: boolean;
    truncatable?: boolean;
    batch?: boolean;
    /** Share of the transcription clip's words heard in order, 0 to 1. */
    accuracy?: number;
    familyId?: string;
    lookupUrl?: string;
}

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
    /** Absent on rows read before v7-model-types.sql, which are all chat rows. */
    kind?: ModelKind;
    dimension?: number | null;
    expiresAt?: string | null;
    expiresSource?: ExpiresSource | null;
    notifiedExpiryDays?: number | null;
    expiryCheckedAt?: string | null;
    /** Knowledge partition id this embedding route reproduces. */
    spaceOf?: string | null;
    traits?: ModelTraits;
}

export function rowKind(row: Pick<CatalogueRow, "kind">): ModelKind {
    return row.kind ?? "chat";
}

export type CatalogueStorage = "empty" | "ok" | "migration_required" | "unavailable";

export interface CatalogueSnapshot {
    version: number;
    loadedAt: number;
    storage: CatalogueStorage;
    /** Chat rows only, so every chat-model path keeps its meaning. */
    rows: readonly CatalogueRow[];
    /** Embedding, speech and transcription rows. */
    typedRows: readonly CatalogueRow[];
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
    holder[KEY] ??= { snapshot: { version: 0, loadedAt: 0, storage: "empty", rows: [], typedRows: [], profiles: [], profileStorage: "empty" }, refreshing: null, autoRefresh: false };
    return holder[KEY];
}

function split(rows: readonly CatalogueRow[]): { rows: CatalogueRow[]; typedRows: CatalogueRow[] } {
    return { rows: rows.filter((row) => rowKind(row) === "chat"), typedRows: rows.filter((row) => rowKind(row) !== "chat") };
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
                    ? { version: current.snapshot.version + 1, loadedAt: Date.now(), storage: "ok", ...split(result.rows), ...profileState }
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
    current.snapshot = { version: current.snapshot.version + 1, loadedAt: Date.now(), storage, ...split(rows), profiles, profileStorage: storage };
}
