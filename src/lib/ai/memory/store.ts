import { supabaseAdmin as supabase } from "@/lib/supabase";
import { embedText, getEmbeddingRef, type ResolvedEmbedding } from "@/lib/ai/embeddings";
import { refreshEmbeddingOverride } from "@/lib/ai/embedding-override";

export type MemoryCategory =
    | "identity" | "preference" | "relationship" | "project" | "routine" | "fact" | "other";

export type MemoryStatus = "candidate" | "confirmed";

// Work/study observations start as invisible candidates and only become
// Known Facts once the same pattern repeats across distinct conversations.
export { PROMOTE_EVIDENCE_COUNT } from "@/lib/types";
import { PROMOTE_EVIDENCE_COUNT } from "@/lib/types";

export interface MemoryFact {
    id: string;
    fact: string;
    category: MemoryCategory;
    projectId: string | null;
    source: string;
    status: MemoryStatus;
    evidenceCount: number;
    createdAt: string;
    updatedAt: string;
}

export interface MemoryHit {
    id: string;
    fact: string;
    category: MemoryCategory;
    projectId: string | null;
    similarity: number;
    status: MemoryStatus;
    evidenceCount: number;
}

// Fact memory always lives in the DEFAULT embedding partition, regardless of
// the per-message embedding selection. Facts are one shared pool; splitting
// them by partition made facts invisible whenever the selection changed.
// Async so a cold lambda picks up the runtime partition override first.
export async function memoryEmbeddingRef(): Promise<ResolvedEmbedding> {
    await refreshEmbeddingOverride();
    return getEmbeddingRef();
}

// Column-missing errors (pre-DDL) get a legacy retry so memory keeps working
// until supabase-setup.sql is re-run.
function isMissingColumn(message: string): boolean {
    return /column .* does not exist|could not find the .* column/i.test(message);
}

export async function insertMemory(params: {
    fact: string;
    category: MemoryCategory;
    source: string;
    userProfileId?: string;
    projectId?: string;
    status?: MemoryStatus;
    evidenceKey?: string;
}): Promise<string | null> {
    const embRef = await memoryEmbeddingRef();
    const embedding = await embedText(embRef, params.fact);
    const base = {
        fact: params.fact,
        category: params.category,
        source: params.source,
        embedding: JSON.stringify(embedding),
        embedding_model: embRef.model.id,
        user_profile_id: params.userProfileId ?? null,
        project_id: params.projectId ?? null,
    };
    let { data, error } = await supabase
        .from("memories")
        .insert({
            ...base,
            status: params.status ?? "confirmed",
            evidence_count: 1,
            last_evidence_key: params.evidenceKey ?? null,
        })
        .select("id")
        .single();

    if (error && isMissingColumn(error.message)) {
        ({ data, error } = await supabase.from("memories").insert(base).select("id").single());
    }
    if (error) {
        console.warn("[Memory] Failed to insert fact:", error.message);
        return null;
    }
    return data!.id as string;
}

/**
 * Counts one more sighting of a candidate pattern. Evidence only accrues from
 * a different conversation/day than the last one, and the fact is promoted to
 * confirmed at PROMOTE_EVIDENCE_COUNT.
 */
export async function reinforceMemory(id: string, evidenceKey: string): Promise<boolean> {
    const { data, error } = await supabase
        .from("memories")
        .select("status, evidence_count, last_evidence_key")
        .eq("id", id)
        .single();
    if (error) {
        if (!isMissingColumn(error.message)) console.warn("[Memory] Reinforce read failed:", error.message);
        return false;
    }
    if (data.status !== "candidate") return true;
    if (data.last_evidence_key && data.last_evidence_key === evidenceKey) return true;

    const evidence = (data.evidence_count ?? 1) + 1;
    const { error: upErr } = await supabase
        .from("memories")
        .update({
            evidence_count: evidence,
            last_evidence_key: evidenceKey,
            ...(evidence >= PROMOTE_EVIDENCE_COUNT ? { status: "confirmed" } : {}),
        })
        .eq("id", id);
    if (upErr) {
        console.warn("[Memory] Reinforce failed:", upErr.message);
        return false;
    }
    return true;
}

export async function updateMemoryFact(params: {
    id: string;
    fact: string;
    category?: MemoryCategory;
}): Promise<boolean> {
    const embRef = await memoryEmbeddingRef();
    const embedding = await embedText(embRef, params.fact);
    const { error } = await supabase
        .from("memories")
        .update({
            fact: params.fact,
            ...(params.category ? { category: params.category } : {}),
            embedding: JSON.stringify(embedding),
            embedding_model: embRef.model.id,
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
        .select("*")
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
        status: (row.status ?? "confirmed") as MemoryStatus,
        evidenceCount: row.evidence_count ?? 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }));
}

export async function searchMemories(params: {
    queryEmbedding: number[];
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
        filter_model: (await memoryEmbeddingRef()).model.id,
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
        status: (row.status ?? "confirmed") as MemoryStatus,
        evidenceCount: row.evidence_count ?? 1,
    }));
    /* eslint-enable @typescript-eslint/no-explicit-any */
}
