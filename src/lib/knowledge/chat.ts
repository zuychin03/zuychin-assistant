import { effectiveFreeOnly, assertFreeModel, ModelPolicyError } from "@/lib/ai/model-policy";
import { configureModelDataPolicy } from "@/lib/ai/model-observations";
import { deleteMessage, getConversation, getDefaultProfile, saveMessage, updateConversationTitle } from "@/lib/db";
import { embedText, getEmbeddingRef } from "@/lib/ai/embeddings";
import { refreshEmbeddingOverride } from "@/lib/ai/embedding-override";
import { getConversationProject } from "@/lib/projects";
import { libraryDocumentDestination } from "@/lib/document-navigation";
import { groundRecall } from "@/lib/knowledge/recall";
import { recallKnowledge } from "@/lib/knowledge/store";
import type { KnowledgeRecallHit } from "@/lib/knowledge/types";
import type { MessageChannel, ReplyRef } from "@/lib/types";

export function knowledgeOnlyRequestError(params: {
    knowledgeOnly?: unknown; file?: unknown; imageBase64?: unknown; resumeRunId?: unknown;
}): string | null {
    if (params.knowledgeOnly !== undefined && typeof params.knowledgeOnly !== "boolean") {
        return "Knowledge only must be a boolean.";
    }
    if (!params.knowledgeOnly) return null;
    if (params.file != null || params.imageBase64 != null) {
        return "Knowledge only uses saved sources. Remove the attachment or turn Knowledge only off.";
    }
    if (params.resumeRunId != null) {
        return "Knowledge only cannot resume an agent run. Turn Knowledge only off to resume.";
    }
    return null;
}

function escapedText(text: string): string {
    return text.replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, "\\$&");
}

function sourceExcerpt(hit: KnowledgeRecallHit): string {
    const destination = new URL(libraryDocumentDestination(hit.path, "/knowledge"), "https://local.invalid");
    destination.searchParams.set("document", hit.documentId);
    destination.searchParams.set("chunk", hit.chunkId);
    const label = escapedText(`${hit.title}${hit.heading ? ` / ${hit.heading}` : ""}`);
    const excerpt = escapedText(hit.excerpt.trim()).split("\n").map((line) => `> ${line}`).join("\n");
    return `${excerpt}\n\n[${label}](${destination.pathname}${destination.search})`;
}

export async function knowledgeOnlyChat(params: {
    message: string; channel: MessageChannel; conversationId?: string; replyTo?: ReplyRef; signal?: AbortSignal;
    freeOnly?: boolean; paidOnly?: boolean;
    onSavedMessage?: (id: string) => void;
}): Promise<{ reply: string; messageId: string; userMessageId: string; artifacts: []; freeOnly?: boolean }> {
    const { message, channel, conversationId, replyTo, signal } = params;
    signal?.throwIfAborted();
    const profile = await getDefaultProfile();
    const freeOnly = effectiveFreeOnly(profile, params.freeOnly, params.paidOnly);
    configureModelDataPolicy(freeOnly);
    signal?.throwIfAborted();
    if (freeOnly) {
        await refreshEmbeddingOverride(signal, true);
        assertFreeModel(getEmbeddingRef());
        signal?.throwIfAborted();
    }
    let userId = "";
    let assistantId = "";
    try {
        userId = await saveMessage({ role: "user", content: message, channel, conversationId,
            userProfileId: profile?.id, metadata: { knowledgeOnly: true, ...(replyTo ? { replyTo } : {}) } });
        params.onSavedMessage?.(userId);
        signal?.throwIfAborted();
        let reply: string;
        try {
            await refreshEmbeddingOverride(signal, true);
            signal?.throwIfAborted();
            const embRef = getEmbeddingRef();
            if (freeOnly) assertFreeModel(embRef);
            const project = conversationId ? await getConversationProject(conversationId, true) : null;
            signal?.throwIfAborted();
            const queryEmbedding = await embedText(embRef, message, "query", signal);
            const hits = await recallKnowledge({ query: message, queryEmbedding, embRef,
                projectId: project?.id, matchCount: 6, strict: true });
            signal?.throwIfAborted();
            if (hits === null) throw new Error("Knowledge retrieval unavailable.");
            const grounded = groundRecall(message, hits);
            const selected = grounded.supported
                ? grounded.citations.flatMap((citation) => hits.filter((hit) => hit.chunkId === citation.chunkId))
                : hits.slice(0, 3);
            reply = grounded.supported
                ? "Saved source excerpts:\n\n" + selected.map(sourceExcerpt).join("\n\n")
                : grounded.answer + (selected.length
                    ? "\n\nClosest saved sources (insufficient evidence):\n\n" + selected.map(sourceExcerpt).join("\n\n")
                    : "");
        } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof ModelPolicyError) throw error;
            reply = "Saved-source retrieval is unavailable. I cannot answer in Knowledge only mode right now. Please try again later.";
        }
        signal?.throwIfAborted();
        assistantId = await saveMessage({ role: "assistant", content: reply, channel, conversationId,
            userProfileId: profile?.id, metadata: { knowledgeOnly: true } });
        params.onSavedMessage?.(assistantId);
        signal?.throwIfAborted();
        if (conversationId) {
            const conversation = await getConversation(conversationId).catch(() => null);
            signal?.throwIfAborted();
            if (conversation && (!conversation.title || conversation.title === "New Chat")) {
                await updateConversationTitle(conversationId, message.trim().replace(/\s+/g, " ").slice(0, 60)).catch(() => {});
            }
        }
        signal?.throwIfAborted();
        return { reply, messageId: assistantId, userMessageId: userId, artifacts: [], freeOnly };
    } catch (error) {
        if (signal?.aborted && !params.onSavedMessage) {
            if (assistantId) await deleteMessage(assistantId).catch(() => {});
            if (userId) await deleteMessage(userId).catch(() => {});
        }
        throw error;
    }
}
