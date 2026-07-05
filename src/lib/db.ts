import { supabaseAdmin as supabase } from "./supabase";
import type { Message, MessageChannel, MessageMetadata, KnowledgeItem } from "./types";

export async function saveMessage(params: {
    role: "user" | "assistant" | "system";
    content: string;
    channel: MessageChannel;
    imageUrl?: string;
    userProfileId?: string;
    conversationId?: string;
    metadata?: MessageMetadata;
}): Promise<string> {
    const { data, error } = await supabase
        .from("messages")
        .insert({
            role: params.role,
            content: params.content,
            channel: params.channel,
            image_url: params.imageUrl ?? null,
            user_profile_id: params.userProfileId ?? null,
            conversation_id: params.conversationId ?? null,
            metadata: params.metadata ?? {},
        })
        .select("id")
        .single();

    if (error) {
        console.error("[DB] Failed to save message:", error.message);
        throw new Error("Failed to save message.");
    }

    if (params.conversationId) {
        // Bump updated_at so the sidebar sorts this conversation to the top.
        const { error: touchError } = await supabase
            .from("conversations")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", params.conversationId);
        if (touchError) {
            console.warn("[DB] Failed to touch conversation:", touchError.message);
        }
    }

    return data.id;
}

export async function getRecentMessages(
    limit: number = 20,
    channel?: MessageChannel,
    conversationId?: string
): Promise<Message[]> {
    let query = supabase
        .from("messages")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);

    if (conversationId) {
        query = query.eq("conversation_id", conversationId);
    } else if (channel) {
        query = query.eq("channel", channel);
    }

    const { data, error } = await query;

    if (error) {
        console.error("[DB] Failed to fetch messages:", error.message);
        return [];
    }

    return (data ?? []).reverse().map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        imageUrl: row.image_url,
        channel: row.channel,
        createdAt: row.created_at,
    }));
}

const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-2-preview";

export async function storeEmbedding(params: {
    content: string;
    embedding: number[];
    metadata?: Record<string, string>;
    userProfileId?: string;
    embeddingModel?: string;
}): Promise<string> {
    const { data, error } = await supabase
        .from("embeddings")
        .insert({
            content: params.content,
            embedding: JSON.stringify(params.embedding),
            metadata: params.metadata ?? {},
            user_profile_id: params.userProfileId ?? null,
            embedding_model: params.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
        })
        .select("id")
        .single();

    if (error) {
        console.error("[DB] Failed to store embedding:", error.message);
        throw new Error("Failed to store embedding.");
    }

    return data.id;
}

export async function searchEmbeddings(params: {
    queryEmbedding: number[];
    matchThreshold?: number;
    matchCount?: number;
    userId?: string;
    embeddingModel?: string;
}): Promise<KnowledgeItem[]> {
    const { data, error } = await supabase.rpc("match_embeddings", {
        query_embedding: JSON.stringify(params.queryEmbedding),
        match_threshold: params.matchThreshold ?? 0.7,
        match_count: params.matchCount ?? 5,
        filter_user_id: params.userId ?? null,
        filter_model: params.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
    });

    if (error) {
        console.error("[DB] Vector search failed:", error.message);
        return [];
    }

    return (data ?? []).map((row: { id: string; content: string; metadata: Record<string, string>; similarity: number }) => ({
        id: row.id,
        content: row.content,
        metadata: row.metadata,
        similarity: row.similarity,
        createdAt: "",
    }));
}

/**
 * BM25 + vector RRF over the knowledge base. Returns null when the hybrid RPC
 * is unavailable (DDL not applied yet) so callers can fall back to
 * searchEmbeddings with their own threshold.
 */
export async function hybridSearchKnowledge(params: {
    queryEmbedding: number[];
    queryText: string;
    matchCount?: number;
    userId?: string;
    embeddingModel?: string;
}): Promise<KnowledgeItem[] | null> {
    const { data, error } = await supabase.rpc("hybrid_match_knowledge", {
        query_embedding: JSON.stringify(params.queryEmbedding),
        query_text: params.queryText,
        match_count: params.matchCount ?? 5,
        filter_user_id: params.userId ?? null,
        filter_model: params.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
    });

    if (error) {
        console.warn("[DB] Hybrid search unavailable, falling back to vector:", error.message);
        return null;
    }

    return (data ?? []).map((row: { id: string; content: string; metadata: Record<string, string>; similarity: number }) => ({
        id: row.id,
        content: row.content,
        metadata: row.metadata,
        similarity: row.similarity,
        createdAt: "",
    }));
}

export async function getDefaultProfile() {
    const { data, error } = await supabase
        .from("user_profiles")
        .select("*")
        .limit(1)
        .single();

    if (error) {
        console.error("[DB] Failed to fetch profile:", error.message);
        return null;
    }

    return {
        id: data.id,
        displayName: data.display_name,
        systemPrompt: data.system_prompt,
        preferences: data.preferences,
    };
}

export async function updateSystemPrompt(
    profileId: string,
    systemPrompt: string
) {
    const { error } = await supabase
        .from("user_profiles")
        .update({ system_prompt: systemPrompt })
        .eq("id", profileId);

    if (error) {
        console.error("[DB] Failed to update system prompt:", error.message);
        throw new Error("Failed to update system prompt.");
    }
}

export async function updateProfilePreferences(
    profileId: string,
    preferences: Record<string, unknown>
) {
    const { error } = await supabase
        .from("user_profiles")
        .update({ preferences })
        .eq("id", profileId);

    if (error) {
        console.error("[DB] Failed to update preferences:", error.message);
        throw new Error("Failed to update preferences.");
    }
}

export async function createConversation(params: {
    title?: string;
    userProfileId?: string;
    projectId?: string;
}): Promise<{ id: string; title: string }> {
    const { data, error } = await supabase
        .from("conversations")
        .insert({
            title: params.title ?? "New Chat",
            user_profile_id: params.userProfileId ?? null,
            project_id: params.projectId ?? null,
        })
        .select("id, title")
        .single();

    if (error) {
        console.error("[DB] Failed to create conversation:", error.message);
        throw new Error("Failed to create conversation.");
    }

    return { id: data.id, title: data.title };
}

export async function listConversations(
    limit: number = 20
): Promise<{ id: string; title: string; updatedAt: string; createdAt: string; projectId: string | null }[]> {
    const { data, error } = await supabase
        .from("conversations")
        .select("id, title, updated_at, created_at, project_id")
        .order("updated_at", { ascending: false })
        .limit(limit);

    if (error) {
        console.error("[DB] Failed to list conversations:", error.message);
        return [];
    }

    return (data ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        updatedAt: row.updated_at,
        createdAt: row.created_at,
        projectId: row.project_id ?? null,
    }));
}

export async function getConversation(
    id: string
): Promise<{ id: string; title: string; projectId: string | null } | null> {
    const { data, error } = await supabase
        .from("conversations")
        .select("id, title, project_id")
        .eq("id", id)
        .single();

    if (error) {
        console.error("[DB] Failed to fetch conversation:", error.message);
        return null;
    }

    return { id: data.id, title: data.title, projectId: data.project_id ?? null };
}

export async function deleteConversation(id: string): Promise<void> {
    const { error } = await supabase
        .from("conversations")
        .delete()
        .eq("id", id);

    if (error) {
        console.error("[DB] Failed to delete conversation:", error.message);
        throw new Error("Failed to delete conversation.");
    }
}

export async function getConversationMessages(
    conversationId: string
): Promise<Message[]> {
    const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

    if (error) {
        console.error("[DB] Failed to fetch conversation messages:", error.message);
        return [];
    }

    return (data ?? []).map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        imageUrl: row.image_url,
        channel: row.channel,
        createdAt: row.created_at,
        metadata: row.metadata ?? undefined,
    }));
}

export async function updateConversationTitle(
    id: string,
    title: string
): Promise<void> {
    const { error } = await supabase
        .from("conversations")
        .update({ title })
        .eq("id", id);

    if (error) {
        console.error("[DB] Failed to update conversation title:", error.message);
    }
}

export async function countUserMessagesSince(
    sinceIso: string,
    excludeId?: string
): Promise<number> {
    let query = supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("role", "user")
        .gte("created_at", sinceIso);
    if (excludeId) {
        query = query.neq("id", excludeId);
    }

    const { count, error } = await query;

    if (error) {
        console.error("[DB] Failed to count messages:", error.message);
        // Fail as "not the first message" so callers don't over-trigger.
        return 1;
    }
    return count ?? 0;
}

export interface Todo {
    id: string;
    title: string;
    description: string;
    status: "pending" | "in_progress" | "done";
    priority: "low" | "medium" | "high";
    dueDate: string | null;
    createdAt: string;
}

export async function addTodo(params: {
    title: string;
    description?: string;
    priority?: "low" | "medium" | "high";
    dueDate?: string;
    userProfileId?: string;
}): Promise<string> {
    const { data, error } = await supabase
        .from("todos")
        .insert({
            title: params.title,
            description: params.description ?? "",
            priority: params.priority ?? "medium",
            due_date: params.dueDate ?? null,
            user_profile_id: params.userProfileId ?? null,
        })
        .select("id")
        .single();

    if (error) {
        console.error("[DB] Failed to add todo:", error.message);
        throw new Error("Failed to add todo.");
    }

    return data.id;
}

export async function listTodos(
    status?: "pending" | "in_progress" | "done" | "all",
    limit: number = 20
): Promise<Todo[]> {
    let query = supabase
        .from("todos")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);

    if (status && status !== "all") {
        query = query.eq("status", status);
    }

    const { data, error } = await query;

    if (error) {
        console.error("[DB] Failed to list todos:", error.message);
        return [];
    }

    return (data ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        dueDate: row.due_date,
        createdAt: row.created_at,
    }));
}

export async function updateTodoStatus(
    id: string,
    status: "pending" | "in_progress" | "done"
): Promise<boolean> {
    const { error } = await supabase
        .from("todos")
        .update({ status })
        .eq("id", id);

    if (error) {
        console.error("[DB] Failed to update todo:", error.message);
        return false;
    }
    return true;
}

export async function deleteTodo(id: string): Promise<boolean> {
    const { error } = await supabase
        .from("todos")
        .delete()
        .eq("id", id);

    if (error) {
        console.error("[DB] Failed to delete todo:", error.message);
        return false;
    }
    return true;
}

/**
 * Open todos due within `hoursAhead` that haven't been nagged in the last
 * `renagHours` — so overdue tasks re-nag roughly daily, not every cron tick.
 */
export async function listDueTodos(
    hoursAhead: number = 24,
    renagHours: number = 20
): Promise<Todo[]> {
    const now = Date.now();
    const cutoff = new Date(now + hoursAhead * 3_600_000).toISOString();
    const renagBefore = new Date(now - renagHours * 3_600_000).toISOString();

    const { data, error } = await supabase
        .from("todos")
        .select("*")
        .in("status", ["pending", "in_progress"])
        .not("due_date", "is", null)
        .lte("due_date", cutoff)
        .or(`reminded_at.is.null,reminded_at.lt.${renagBefore}`)
        .order("due_date", { ascending: true });

    if (error) {
        console.warn("[DB] Failed to list due todos:", error.message);
        return [];
    }

    return (data ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        dueDate: row.due_date,
        createdAt: row.created_at,
    }));
}

export async function markTodosReminded(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await supabase
        .from("todos")
        .update({ reminded_at: new Date().toISOString() })
        .in("id", ids);
    if (error) console.warn("[DB] Failed to mark todos reminded:", error.message);
}
