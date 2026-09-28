import type { SupabaseClient } from "@supabase/supabase-js";
import type { Message } from "../types";
import { BranchError, safeCopiedMetadata, type BranchComparison, type BranchConversation, type ForkRequest } from "./branches";

function handleError(error: { code?: string; message?: string }): never {
    if (["PGRST202", "42883", "42P01", "PGRST205"].includes(error.code ?? "")) throw new BranchError("Conversation branching is not available until its database migration is applied.", 503);
    if (error.code === "42501" || error.code === "P0002") throw new BranchError("Conversation or source message is unavailable.", 404);
    if (error.code === "22023") throw new BranchError("The source conversation or request changed. Reload before branching.", 409);
    if (error.code === "54000") throw new BranchError("This conversation exceeds the safe branch size limit.", 413);
    throw new BranchError("Conversation branching is temporarily unavailable. Retry with the same request ID.", 503);
}
function conversation(row: Record<string, unknown>): BranchConversation {
    return { id: row.id as string, title: row.title as string, projectId: row.project_id as string | null,
        parentConversationId: (row.parent_conversation_id as string | null) ?? null,
        parentMessageId: (row.parent_message_id as string | null) ?? null,
        copiedCount: Number(row.copied_count ?? 0), createdAt: row.created_at as string };
}
function message(row: Record<string, unknown>): Message {
    let metadata = (row.metadata as Message["metadata"]) ?? undefined;
    const origin = metadata?.branchOrigin as { conversationId?: unknown; messageId?: unknown } | undefined;
    if (typeof origin?.conversationId === "string" && typeof origin.messageId === "string") {
        metadata = safeCopiedMetadata(metadata!, { conversationId: origin.conversationId, messageId: origin.messageId });
    }
    return { id: row.id as string, role: row.role as Message["role"], content: row.content as string,
        channel: row.channel as Message["channel"], createdAt: row.created_at as string,
        imageUrl: (row.image_url as string | null) ?? undefined, metadata };
}
export function createBranchStore(client: SupabaseClient) {
    return {
        async fork(input: ForkRequest, userId: string, signal?: AbortSignal): Promise<BranchConversation> {
            signal?.throwIfAborted();
            let query = client.rpc("assistant_fork_conversation", {
                p_conversation_id: input.conversationId, p_message_id: input.messageId, p_request_id: input.requestId,
                p_user_id: userId, p_title: input.title ?? null,
            });
            if (signal) query = query.abortSignal(signal);
            const { data, error } = await query;
            signal?.throwIfAborted();
            if (error) handleError(error);
            if (!data) throw new BranchError("Conversation branch was not returned. Retry with the same request ID.", 503);
            return conversation(data);
        },
        async list(conversationId: string, userId: string, signal?: AbortSignal): Promise<{ current: BranchConversation; related: BranchConversation[] }> {
            let query = client.rpc("assistant_related_conversations", { p_conversation_id: conversationId, p_user_id: userId });
            if (signal) query = query.abortSignal(signal);
            const { data, error } = await query;
            signal?.throwIfAborted();
            if (error) handleError(error);
            if (!data) throw new BranchError("Conversation is unavailable.", 404);
            return { current: conversation(data.current), related: data.related.map(conversation) };
        },
        async compare(left: string, right: string, userId: string, signal?: AbortSignal): Promise<BranchComparison> {
            let query = client.rpc("assistant_compare_conversations", { p_left: left, p_right: right, p_user_id: userId });
            if (signal) query = query.abortSignal(signal);
            const { data, error } = await query;
            signal?.throwIfAborted();
            if (error) handleError(error);
            if (!data) throw new BranchError("These conversations cannot be compared.", 404);
            for (const side of [data.left, data.right]) if (side.messages.length > 20_000) throw new BranchError("Conversation is too large to compare in one view.", 413);
            return { left: { conversation: conversation(data.left.conversation), messages: data.left.messages.map(message) },
                right: { conversation: conversation(data.right.conversation), messages: data.right.messages.map(message) } };
        },
        async isBranch(conversationId: string, userId: string, signal?: AbortSignal): Promise<boolean> {
            let query = client.from("assistant_conversation_branches").select("conversation_id").eq("conversation_id", conversationId).eq("user_profile_id", userId);
            if (signal) query = query.abortSignal(signal);
            const { data, error } = await query.maybeSingle();
            signal?.throwIfAborted();
            if (error) {
                if (["42P01", "PGRST205"].includes(error.code)) return false;
                handleError(error);
            }
            return !!data;
        },
    };
}
