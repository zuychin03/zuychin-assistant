import type { SupabaseClient } from "@supabase/supabase-js";
import type { Message } from "../types";
import { contextScopeKey, historyFingerprint, orderContextMessages, type ConversationContextScope, type ConversationContextStore, type ConversationSnapshot } from "./conversation-context";

const PAGE_SIZE = 500;
const MAX_MESSAGES = 20_000;

function mapMessage(row: Record<string, unknown>): Message {
    return {
        id: row.id as string, role: row.role as Message["role"], content: row.content as string,
        channel: row.channel as Message["channel"], createdAt: row.created_at as string,
        imageUrl: (row.image_url as string | null) ?? undefined,
        metadata: (row.metadata as Message["metadata"]) ?? undefined,
    };
}

function missingMigration(error: { code?: string }): boolean {
    return ["PGRST202", "42883", "42P01", "PGRST205"].includes(error.code ?? "");
}

function checkSize(count: number): void {
    if (count > MAX_MESSAGES) throw new Error("Conversation exceeds the 20,000-message context safety limit. Start a new conversation; no history was silently omitted.");
}

export function createConversationContextStore(client: SupabaseClient): ConversationContextStore {
    async function legacySnapshot(scope: ConversationContextScope, signal?: AbortSignal): Promise<ConversationSnapshot> {
        let projectId: string | null = null;
        if (scope.conversationId) {
            let query = client.from("conversations").select("project_id").eq("id", scope.conversationId);
            query = scope.userId ? query.eq("user_profile_id", scope.userId) : query.is("user_profile_id", null);
            if (signal) query = query.abortSignal(signal);
            const { data, error } = await query.single();
            signal?.throwIfAborted();
            if (error || !data) throw new Error("Conversation scope is unavailable.");
            projectId = data.project_id ?? null;
        }
        const messages: Message[] = [];
        for (let offset = 0; offset <= MAX_MESSAGES; offset += PAGE_SIZE) {
            signal?.throwIfAborted();
            let query = client.from("messages").select("id, role, content, channel, created_at, image_url, metadata")
                .eq("channel", scope.channel).order("created_at", { ascending: true }).order("id", { ascending: true })
                .range(offset, offset + PAGE_SIZE - 1);
            query = scope.conversationId ? query.eq("conversation_id", scope.conversationId) : query.is("conversation_id", null);
            query = scope.userId ? query.eq("user_profile_id", scope.userId) : query.is("user_profile_id", null);
            if (signal) query = query.abortSignal(signal);
            const { data, error } = await query;
            signal?.throwIfAborted();
            if (error) throw new Error("Conversation history is unavailable.");
            messages.push(...(data ?? []).map(mapMessage));
            checkSize(messages.length);
            if ((data?.length ?? 0) < PAGE_SIZE) break;
        }
        return { messages, revision: historyFingerprint(orderContextMessages(messages)), summary: null, persistent: false, projectId };
    }

    async function read(scope: ConversationContextScope, signal?: AbortSignal): Promise<ConversationSnapshot> {
        signal?.throwIfAborted();
        if (!scope.conversationId) return legacySnapshot(scope, signal);
        let query = client.rpc("assistant_context_snapshot", {
            p_conversation_id: scope.conversationId, p_channel: scope.channel,
            p_user_id: scope.userId ?? null, p_scope: contextScopeKey(scope),
        });
        if (signal) query = query.abortSignal(signal);
        const { data, error } = await query;
        signal?.throwIfAborted();
        if (error) {
            if (missingMigration(error)) return legacySnapshot(scope, signal);
            throw new Error("Conversation context snapshot is unavailable.");
        }
        if (!data) throw new Error("Conversation scope is unavailable.");
        checkSize(data.messages.length);
        return {
            messages: data.messages.map(mapMessage), revision: String(data.revision),
            summary: data.summary ?? null, persistent: true, projectId: data.project_id ?? null,
        };
    }

    return {
        read,
        async isCurrent(scope, snapshot, signal) {
            const current = await read(scope, signal);
            return current.projectId === snapshot.projectId && current.revision === snapshot.revision
                && current.persistent === snapshot.persistent;
        },
        async save(scope, snapshot, summary, signal) {
            signal?.throwIfAborted();
            let query = client.rpc("assistant_context_save", {
                p_conversation_id: scope.conversationId, p_scope: contextScopeKey(scope),
                p_revision: snapshot.revision, p_generation: snapshot.summary?.generation ?? 0,
                p_summary: summary,
            });
            if (signal) query = query.abortSignal(signal);
            const { data, error } = await query;
            signal?.throwIfAborted();
            if (error) {
                if (missingMigration(error)) return false;
                throw new Error("Conversation summary could not be saved safely.");
            }
            return data === true;
        },
    };
}
