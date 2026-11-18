import { supabaseAdmin } from "@/lib/supabase";
import { catalogueStorageFailure } from "@/lib/ai/catalogue/rows";

const READ_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 10_000;

export type KeyStorageFailure = "migration_required" | "unavailable";

export interface StoredKeyRow {
    providerId: string;
    keyRef: string;
    ciphertext: string;
    updatedAt: string;
}

export interface KeyStore {
    read(): Promise<{ ok: true; rows: StoredKeyRow[] } | { ok: false; reason: KeyStorageFailure }>;
    save(providerId: string, keyRef: string, ciphertext: string): Promise<"ok" | KeyStorageFailure>;
    remove(providerId: string, keyRef: string): Promise<"ok" | KeyStorageFailure>;
}

function rowFromDb(raw: unknown): StoredKeyRow | null {
    const row = raw as Record<string, unknown> | null;
    if (!row || typeof row.provider_id !== "string" || typeof row.key_ref !== "string" || typeof row.ciphertext !== "string") return null;
    return { providerId: row.provider_id, keyRef: row.key_ref, ciphertext: row.ciphertext, updatedAt: typeof row.updated_at === "string" ? row.updated_at : "" };
}

export const liveKeyStore: KeyStore = {
    async read() {
        try {
            const { data, error } = await supabaseAdmin.from("provider_keys").select("provider_id, key_ref, ciphertext, updated_at")
                .order("provider_id").abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
            if (error) return { ok: false, reason: catalogueStorageFailure(error) };
            if (!Array.isArray(data)) return { ok: false, reason: "unavailable" };
            return { ok: true, rows: data.map(rowFromDb).filter((row): row is StoredKeyRow => row !== null) };
        } catch {
            return { ok: false, reason: "unavailable" };
        }
    },
    async save(providerId, keyRef, ciphertext) {
        try {
            const { error } = await supabaseAdmin.from("provider_keys")
                .upsert({ provider_id: providerId, key_ref: keyRef, ciphertext, updated_at: new Date().toISOString() }, { onConflict: "provider_id,key_ref" })
                .abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS));
            return error ? catalogueStorageFailure(error) : "ok";
        } catch {
            return "unavailable";
        }
    },
    async remove(providerId, keyRef) {
        try {
            const { error } = await supabaseAdmin.from("provider_keys").delete().eq("provider_id", providerId).eq("key_ref", keyRef)
                .abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS));
            return error ? catalogueStorageFailure(error) : "ok";
        } catch {
            return "unavailable";
        }
    },
};
