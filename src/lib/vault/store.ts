import { supabaseAdmin as supabase } from "@/lib/supabase";
import { embedText, type EmbedInputType, type ResolvedEmbedding } from "@/lib/ai/embeddings";

export interface VaultPageHit {
    path: string;
    title: string;
    summary: string;
    category: string;
    similarity: number;
}

export interface VaultPageMeta {
    path: string;
    title: string;
    summary: string;
    category: string;
}

export async function upsertVaultPage(
    meta: VaultPageMeta,
    markdown: string,
    embRef: ResolvedEmbedding,
): Promise<void> {
    const embedding = await embedText(embRef, `${meta.title}\n\n${markdown}`.slice(0, 8000));

    const { error } = await supabase
        .from("vault_pages")
        .upsert(
            {
                path: meta.path,
                title: meta.title,
                summary: meta.summary,
                category: meta.category,
                embedding: JSON.stringify(embedding),
                embedding_model: embRef.model.id,
                updated_at: new Date().toISOString(),
            },
            { onConflict: "path" },
        );

    if (error) {
        console.error("[Vault] Failed to upsert page index:", error.message);
        throw new Error("Failed to index vault page.");
    }
}

export interface VaultPageRow extends VaultPageMeta {
    embeddingModel: string;
}

/** All indexed pages (no vectors) — used by lint to reconcile repo vs index. */
export async function listVaultPages(): Promise<VaultPageRow[]> {
    const { data, error } = await supabase
        .from("vault_pages")
        .select("path, title, summary, category, embedding_model");
    if (error) {
        console.error("[Vault] Failed to list page index:", error.message);
        throw new Error("Failed to list the vault page index.");
    }
    return (data ?? []).map((r: { path: string; title: string; summary: string; category: string; embedding_model: string }) => ({
        path: r.path,
        title: r.title,
        summary: r.summary,
        category: r.category,
        embeddingModel: r.embedding_model,
    }));
}

export async function deleteVaultPage(path: string): Promise<void> {
    const { error } = await supabase.from("vault_pages").delete().eq("path", path);
    if (error) console.error("[Vault] Failed to delete page index:", error.message);
}

export async function searchVaultPages(params: {
    query: string;
    embRef: ResolvedEmbedding;
    matchThreshold?: number;
    matchCount?: number;
    // "query" for question→page search; "passage" when comparing a document
    // against stored pages (symmetric doc↔doc scores run notably higher).
    inputType?: EmbedInputType;
}): Promise<VaultPageHit[]> {
    const embedding = await embedText(params.embRef, params.query, params.inputType ?? "query");

    const { data, error } = await supabase.rpc("match_vault_pages", {
        query_embedding: JSON.stringify(embedding),
        match_threshold: params.matchThreshold ?? 0.5,
        match_count: params.matchCount ?? 8,
        filter_model: params.embRef.model.id,
    });

    if (error) {
        console.error("[Vault] Page search failed:", error.message);
        return [];
    }

    return (data ?? []).map((row: { path: string; title: string; summary: string; category: string; similarity: number }) => ({
        path: row.path,
        title: row.title,
        summary: row.summary,
        category: row.category,
        similarity: row.similarity,
    }));
}
