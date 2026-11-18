import { decryptApiKey, deriveKey, encryptApiKey, lastFour, type DerivedKey } from "@/lib/ai/provider-keys/crypto";
import { readMasterKeys, type MasterKeys, type MasterSource } from "@/lib/ai/provider-keys/master";
import type { KeyStorageFailure, KeyStore, StoredKeyRow } from "@/lib/ai/provider-keys/store";

export type KeyStorage = "empty" | "ok" | KeyStorageFailure;
export type MasterState = "ready" | "missing" | "invalid";

export interface ProviderKeyEntry {
    apiKey: string;
    lastFour: string;
    updatedAt: string;
}

export interface ProviderKeySnapshot {
    version: number;
    loadedAt: number;
    storage: KeyStorage;
    master: MasterState;
    masterSource: MasterSource | null;
    keyRef: string | null;
    keys: ReadonlyMap<string, ProviderKeyEntry>;
    /** Rows encrypted with a master key this server does not hold, such as another environment's. */
    otherRows: number;
    /** Providers whose row under this master key failed to decrypt. */
    unreadable: readonly string[];
    /** Providers moved from the previous master key since this process started. */
    rotated: readonly string[];
    rotationFailed: readonly string[];
    previousLoaded: boolean;
}

export type LoadedKeys = Omit<ProviderKeySnapshot, "version" | "loadedAt">;

const STALE_MS = 5 * 60_000;
// Instrumentation and route handlers can be separate bundles with separate module state.
const STATE_KEY = Symbol.for("zuychin.assistant.providerKeys");

interface State {
    snapshot: ProviderKeySnapshot;
    refreshing: Promise<void> | null;
    autoRefresh: boolean;
}

function emptySnapshot(): ProviderKeySnapshot {
    return {
        version: 0, loadedAt: 0, storage: "empty", master: "missing", masterSource: null, keyRef: null,
        keys: new Map(), otherRows: 0, unreadable: [], rotated: [], rotationFailed: [], previousLoaded: false,
    };
}

function state(): State {
    const holder = globalThis as typeof globalThis & { [STATE_KEY]?: State };
    holder[STATE_KEY] ??= { snapshot: emptySnapshot(), refreshing: null, autoRefresh: false };
    return holder[STATE_KEY];
}

function entry(apiKey: string, updatedAt: string): ProviderKeyEntry {
    return { apiKey, lastFour: lastFour(apiKey), updatedAt };
}

function tryDecrypt(key: DerivedKey, row: StoredKeyRow): string | null {
    try {
        return decryptApiKey(key, row.providerId, row.ciphertext);
    } catch {
        return null;
    }
}

/**
 * Decrypts this server's rows. With a previous master key, rows made with it are re-encrypted
 * under the current key and their old rows deleted, so a master key change needs no re-entry.
 */
export async function loadProviderKeys(store: KeyStore, masters: MasterKeys, earlier: LoadedKeys = emptySnapshot()): Promise<LoadedKeys> {
    const current = masters.current.ok ? deriveKey(masters.current.key) : null;
    const previous = current && masters.previous ? deriveKey(masters.previous) : null;
    const rotating = previous && previous.ref !== current?.ref ? previous : null;
    const master: MasterState = masters.current.ok ? "ready" : masters.current.reason;
    const base = { master, masterSource: masters.current.source, keyRef: current?.ref ?? null, previousLoaded: !!rotating };

    const read = await store.read();
    if (!read.ok) return { ...earlier, ...base, storage: read.reason };

    const keys = new Map<string, ProviderKeyEntry>();
    const unreadable: string[] = [];
    const rotated = new Set(earlier.rotated);
    const rotationFailed: string[] = [];

    for (const row of read.rows) {
        if (!current || row.keyRef !== current.ref) continue;
        const apiKey = tryDecrypt(current, row);
        if (apiKey) keys.set(row.providerId, entry(apiKey, row.updatedAt));
        else unreadable.push(row.providerId);
    }
    if (current && rotating) {
        for (const row of read.rows) {
            if (row.keyRef !== rotating.ref) continue;
            if (keys.has(row.providerId)) {
                await store.remove(row.providerId, rotating.ref);
                continue;
            }
            const apiKey = tryDecrypt(rotating, row);
            if (!apiKey) {
                unreadable.push(row.providerId);
                continue;
            }
            keys.set(row.providerId, entry(apiKey, row.updatedAt));
            const saved = await store.save(row.providerId, current.ref, encryptApiKey(current, row.providerId, apiKey));
            if (saved === "ok" && await store.remove(row.providerId, rotating.ref) === "ok") rotated.add(row.providerId);
            else rotationFailed.push(row.providerId);
        }
    }

    const known = new Set([current?.ref, rotating?.ref].filter(Boolean));
    if (unreadable.length) console.warn(`[ProviderKeys] Could not decrypt the saved key for ${unreadable.join(", ")}; using the environment instead.`);
    if (rotated.size > earlier.rotated.length) console.info(`[ProviderKeys] Re-encrypted ${rotated.size - earlier.rotated.length} saved key(s) with the new master key.`);
    if (rotationFailed.length) console.warn(`[ProviderKeys] Could not re-encrypt the saved key for ${rotationFailed.join(", ")}.`);
    return {
        ...base, storage: "ok", keys,
        otherRows: read.rows.filter((row) => !known.has(row.keyRef)).length,
        unreadable, rotated: [...rotated], rotationFailed,
    };
}

export function providerKeySnapshot(): ProviderKeySnapshot {
    return state().snapshot;
}

/** The saved key for a provider, never awaited. With auto refresh on, a stale snapshot starts a background reload. */
export function storedProviderKey(providerId: string): string | undefined {
    const current = state();
    if (current.autoRefresh && !current.refreshing && Date.now() - current.snapshot.loadedAt > STALE_MS) {
        void refreshProviderKeys();
    }
    return current.snapshot.keys.get(providerId)?.apiKey;
}

/** A saved key wins; the env var is the fallback. */
export function providerKeyOrEnv(providerId: string, envName: string): string | undefined {
    return storedProviderKey(providerId) ?? (process.env[envName] || undefined);
}

export async function refreshProviderKeys(): Promise<ProviderKeySnapshot> {
    const current = state();
    if (!current.refreshing) {
        current.refreshing = (async () => {
            try {
                // Loaded lazily so importing providers.ts never builds a Supabase client.
                const { liveKeyStore } = await import("@/lib/ai/provider-keys/store");
                const loaded = await loadProviderKeys(liveKeyStore, readMasterKeys(), current.snapshot);
                current.snapshot = { ...loaded, version: current.snapshot.version + 1, loadedAt: Date.now() };
            } catch (error) {
                console.error("[ProviderKeys] Refresh failed:", error instanceof Error ? error.message : error);
                current.snapshot = { ...current.snapshot, loadedAt: Date.now(), storage: "unavailable" };
            } finally {
                current.refreshing = null;
            }
        })();
    }
    await current.refreshing;
    return current.snapshot;
}

export function enableProviderKeyRefresh(): void {
    state().autoRefresh = true;
}

/** Applies a dashboard save (entry) or clear (null) in this process at once, ahead of the next reload. */
export function applyProviderKeyChange(providerId: string, change: { apiKey: string; updatedAt: string } | null): void {
    const current = state();
    const keys = new Map(current.snapshot.keys);
    if (change) keys.set(providerId, entry(change.apiKey, change.updatedAt));
    else keys.delete(providerId);
    current.snapshot = { ...current.snapshot, keys, unreadable: current.snapshot.unreadable.filter((id) => id !== providerId), version: current.snapshot.version + 1 };
}

export function setProviderKeySnapshotForTests(keys: Record<string, string> = {}, overrides: Partial<ProviderKeySnapshot> = {}): void {
    const current = state();
    current.snapshot = {
        ...emptySnapshot(), storage: "ok", master: "ready", loadedAt: Date.now(),
        keys: new Map(Object.entries(keys).map(([providerId, apiKey]) => [providerId, entry(apiKey, new Date().toISOString())])),
        ...overrides, version: current.snapshot.version + 1,
    };
}
