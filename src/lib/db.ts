import { supabase } from "./supabase";
import type { Message, MessageChannel, KnowledgeItem } from "./types";



/** Save a message and return its ID. */
export async function saveMessage(params: {
    role: "user" | "assistant" | "system";
    content: string;
    channel: MessageChannel;
    imageUrl?: string;
    userProfileId?: string;
    conversationId?: string;
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
        })
        .select("id")
        .single();

    if (error) {
        console.error("[DB] Failed to save message:", error.message);
        throw new Error("Failed to save message.");
    }

    return data.id;
}

/** Fetch last N messages, optionally scoped by channel or conversation. */
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

// --- Embeddings ---


/** Store a content embedding in the vector store. */
export async function storeEmbedding(params: {
    content: string;
    embedding: number[];
    metadata?: Record<string, string>;
    userProfileId?: string;
}): Promise<string> {
    const { data, error } = await supabase
        .from("embeddings")
        .insert({
            content: params.content,
            embedding: JSON.stringify(params.embedding),
            metadata: params.metadata ?? {},
            user_profile_id: params.userProfileId ?? null,
        })
        .select("id")
        .single();

    if (error) {
        console.error("[DB] Failed to store embedding:", error.message);
        throw new Error("Failed to store embedding.");
    }

    return data.id;
}

/** Cosine similarity search via the match_embeddings RPC. */
export async function searchEmbeddings(params: {
    queryEmbedding: number[];
    matchThreshold?: number;
    matchCount?: number;
    userId?: string;
}): Promise<KnowledgeItem[]> {
    const { data, error } = await supabase.rpc("match_embeddings", {
        query_embedding: JSON.stringify(params.queryEmbedding),
        match_threshold: params.matchThreshold ?? 0.7,
        match_count: params.matchCount ?? 5,
        filter_user_id: params.userId ?? null,
    });

    if (error) {
        console.error("[DB] Vector search failed:", error.message);
        return [];
    }

    return (data ?? []).map((row: { id: string; content: string; metadata: Record<string, string>; similarity: number }) => ({
        id: row.id,
        content: row.content,
        metadata: row.metadata,
        createdAt: "",
    }));
}

// --- User Profiles ---


/** Get the first user profile. */
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

/** Update a profile's system prompt. */
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

// --- Conversations ---


/** Create a new conversation. */
export async function createConversation(params: {
    title?: string;
    userProfileId?: string;
}): Promise<{ id: string; title: string }> {
    const { data, error } = await supabase
        .from("conversations")
        .insert({
            title: params.title ?? "New Chat",
            user_profile_id: params.userProfileId ?? null,
        })
        .select("id, title")
        .single();

    if (error) {
        console.error("[DB] Failed to create conversation:", error.message);
        throw new Error("Failed to create conversation.");
    }

    return { id: data.id, title: data.title };
}

/** List conversations, newest first. */
export async function listConversations(
    limit: number = 20
): Promise<{ id: string; title: string; updatedAt: string; createdAt: string }[]> {
    const { data, error } = await supabase
        .from("conversations")
        .select("id, title, updated_at, created_at")
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
    }));
}

/** Delete a conversation (cascades to messages). */
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

/** Get all messages for a conversation. */
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
    }));
}

/** Update conversation title. */
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
