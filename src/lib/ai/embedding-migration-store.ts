import type { SupabaseClient } from "@supabase/supabase-js";
import {
    assertCasSafe, type MigrationItem, type MigrationRow, type MigrationStore, type MigrationTable,
} from "./embedding-migration.ts";

const PROJECTIONS: Record<MigrationTable, string> = {
    embeddings: "id,content,embedding_model,embedding",
    memories: "id,fact,updated_at,embedding_model,embedding",
    vault_pages: "id,title,content,updated_at,embedding_model,embedding",
    knowledge_chunks: "id,content,heading_path,content_hash,updated_at,embedding_model,embedding,document:knowledge_documents(title)",
    knowledge_assertions: "id,assertion,updated_at,embedding_model,embedding",
};

export function createMigrationStore(
    sb: SupabaseClient,
    activate?: (target: string, signal?: AbortSignal) => Promise<void>,
    options: { pendingModel?: string; signal?: AbortSignal } = {},
): MigrationStore {
    return {
        async scan(table, afterId, limit) {
            let query = sb.from(table).select(PROJECTIONS[table]).order("id").limit(limit);
            if (afterId) query = query.gt("id", afterId);
            if (options.pendingModel) query = query.or(`embedding.is.null,embedding_model.is.null,embedding_model.neq.${options.pendingModel}`);
            if (options.signal) query = query.abortSignal(options.signal);
            const { data, error } = await query;
            if (error) throw new Error(`${table} scan failed.`);
            return (data ?? []) as unknown as MigrationRow[];
        },
        async read(table, id) {
            let query = sb.from(table).select(PROJECTIONS[table]).eq("id", id);
            if (options.signal) query = query.abortSignal(options.signal);
            const { data, error } = await query.maybeSingle();
            if (error) throw new Error(`${table} conditional read failed.`);
            return data as unknown as MigrationRow | null;
        },
        async update(item: MigrationItem, vector, target) {
            const { table, row } = item;
            assertCasSafe(table, row);
            let query = sb.from(table).update({ embedding: JSON.stringify(vector), embedding_model: target }).eq("id", row.id);
            query = row.embedding_model == null ? query.is("embedding_model", null) : query.eq("embedding_model", row.embedding_model);
            query = row.embedding == null ? query.is("embedding", null) : query.not("embedding", "is", null);
            if (table === "embeddings") query = query.eq("content", row.content);
            else query = query.eq("updated_at", row.updated_at);
            if (table === "knowledge_chunks") query = query.eq("content_hash", row.content_hash);
            if (options.signal) query = query.abortSignal(options.signal);
            const { data, error } = await query.select("id").maybeSingle();
            if (error) throw new Error(`${table} conditional update failed.`);
            return !!data;
        },
        async activate(target) {
            options.signal?.throwIfAborted();
            if (activate) return activate(target, options.signal);
            let query = sb.from("cron_state").upsert({ key: "knowledge_embedding", value: { model: target } }, { onConflict: "key" });
            if (options.signal) query = query.abortSignal(options.signal);
            const { error } = await query;
            if (error) throw new Error("Verified vectors are saved, but runtime activation failed. Rerun to retry activation.");
        },
    };
}
