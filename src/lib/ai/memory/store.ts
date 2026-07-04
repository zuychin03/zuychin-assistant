import { supabaseAdmin as supabase } from "@/lib/supabase";
import { embedText, getEmbeddingRef, type ResolvedEmbedding } from "@/lib/ai/embeddings";

export type MemoryCategory =
    | "identity" | "preference" | "relationship" | "project" | "routine" | "fact" | "other";

export interface MemoryFact {
    id: string;
    fact: string;
    category: MemoryCategory;
    projectId: string | null;
    source: string;
    createdAt: string;
    updatedAt: string;
}

export interface MemoryHit {
    id: string;
    fact: string;
    category: MemoryCategory;
    projectId: string | null;
    similarity: number;
}

export async function insertMemory(params: {
    fact: string;
    category: MemoryCategory;
    source: string;
    embRef: ResolvedEmbedding;
    userProfileId?: string;
    projectId?: string;
}): Promise<string | null> {
    const embedding = await embedText(params.embRef, params.fact);
    const { data, error } = await supabase
        .from("memories")
        .insert({
            fact: params.fact,
            category: params.category,
            source: params.source,
            embedding: JSON.stringify(embedding),
            embedding_model: params.embRef.model.id,
            user_profile_id: params.userProfileId ?? null,
            project_id: params.projectId ?? null,
        })
        .select("id")
        .single();

    if (error) {
        console.warn("[Memory] Failed to insert fact:", error.message);
        return null;
    }
    return data.id as string;
}

export async function updateMemoryFact(params: {
    id: string;
    fact: string;
    category?: MemoryCategory;
    embRef: ResolvedEmbedding;
}): Promise<boolean> {
    const embedding = await embedText(params.embRef, params.fact);
    const { error } = await supabase
        .from("memories")
        .update({
            fact: params.fact,
            ...(params.category ? { category: params.category } : {}),
            embedding: JSON.stringify(embedding),
            embedding_model: params.embRef.model.id,
        })
        .eq("id", params.id);

    if (error) {
        console.warn("[Memory] Failed to update fact:", error.message);
        return false;
    }
    return true;
}

export async function deleteMemory(id: string): Promise<boolean> {
    const { error } = await supabase.from("memories").delete().eq("id", id);
    if (error) {
        console.warn("[Memory] Failed to delete fact:", error.message);
        return false;
    }
    return true;
}

export async function listMemories(limit = 100, category?: string): Promise<MemoryFact[]> {
    let query = supabase
        .from("memories")
        .select("id, fact, category, project_id, source, created_at, updated_at")
        .order("updated_at", { ascending: false })
        .limit(limit);
    if (category) query = query.eq("category", category);

    const { data, error } = await query;
    if (error) {
        console.error("[Memory] Failed to list facts:", error.message);
        return [];
    }
    return (data ?? []).map((row) => ({
        id: row.id,
        fact: row.fact,
        category: row.category as MemoryCategory,
        projectId: row.project_id,
        source: row.source,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }));
}

export async function searchMemories(params: {
    queryEmbedding: number[];
    embeddingModel?: string;
    userId?: string;
    projectId?: string;
    matchThreshold?: number;
    matchCount?: number;
}): Promise<MemoryHit[]> {
    const { data, error } = await supabase.rpc("match_memories", {
        query_embedding: JSON.stringify(params.queryEmbedding),
        match_threshold: params.matchThreshold ?? 0.5,
        match_count: params.matchCount ?? 8,
        filter_user_id: params.userId ?? null,
        filter_model: params.embeddingModel ?? getEmbeddingRef().model.id,
        filter_project: params.projectId ?? null,
    });

    if (error) {
        console.warn("[Memory] Search failed:", error.message);
        return [];
    }
    /* eslint-disable @typescript-eslint/no-explicit-any */
    return ((data ?? []) as any[]).map((row) => ({
        id: row.id,
        fact: row.fact,
        category: row.category,
        projectId: row.project_id,
        similarity: row.similarity,
    }));
    /* eslint-enable @typescript-eslint/no-explicit-any */
}
