import { generateEmbedding, generateWithThinking } from "@/lib/gemini";
import { searchEmbeddings, storeEmbedding, getRecentMessages, saveMessage, getDefaultProfile, updateConversationTitle } from "@/lib/db";
import { buildToolSystemPrompt } from "@/lib/ai/mcp-service";
import type { MessageChannel, FileAttachment } from "@/lib/types";



/** Main RAG pipeline: embed → search → augment → generate → store */
export async function ragChat(params: {
    message: string;
    channel: MessageChannel;
    imageBase64?: string;
    file?: FileAttachment;
    conversationId?: string;
    thinking?: boolean;
}): Promise<{ reply: string; messageId: string }> {
    const { message, channel, imageBase64, file, conversationId, thinking = false } = params;

    // Load profile
    const profile = await getDefaultProfile();
    const sysPrompt = profile?.systemPrompt ??
        "You are Zuychin, a helpful personal AI assistant.";

    // Persist user message
    const userMsgId = await saveMessage({
        role: "user",
        content: message,
        channel,
        userProfileId: profile?.id,
        conversationId,
    });

    // Embed & search for relevant context
    let relevantContext = "";
    try {
        const queryEmbedding = await generateEmbedding(message);

        // Vector similarity search
        const matches = await searchEmbeddings({
            queryEmbedding,
            matchThreshold: 0.65,
            matchCount: 3,
            userId: profile?.id,
        });

        if (matches.length > 0) {
            relevantContext = matches
                .map((m, i) => `[Memory ${i + 1}]: ${m.content}`)
                .join("\n");
        }

        // Store embedding for future lookups
        await storeEmbedding({
            content: message,
            embedding: queryEmbedding,
            metadata: { source: "user_message", channel },
            userProfileId: profile?.id,
        });
    } catch (err) {
        console.warn("[RAG] Embedding/search failed, proceeding without context:", err);
    }

    // Build conversation context
    const recentMessages = await getRecentMessages(10, channel, conversationId);
    const historyText = recentMessages
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");

    // Assemble prompt parts
    const parts: (string | { inlineData: { mimeType: string; data: string } })[] = [];


    let fullPrompt = `${sysPrompt}\n\n${buildToolSystemPrompt()}\n\n`;

    if (relevantContext) {
        fullPrompt += `## Relevant Memories\n${relevantContext}\n\n`;
    }

    if (historyText) {
        fullPrompt += `## Recent Conversation\n${historyText}\n\n`;
    }

    fullPrompt += `## Current Message\nUser: ${message}`;
    parts.push(fullPrompt);

    // Attach image (legacy)
    if (imageBase64) {
        parts.push({
            inlineData: {
                mimeType: "image/jpeg",
                data: imageBase64,
            },
        });
    }

    // Attach file
    if (file) {
        parts.push({
            inlineData: {
                mimeType: file.mimeType,
                data: file.base64,
            },
        });
    }

    // Generate
    const result = await generateWithThinking(parts, thinking);
    const reply = result.response.text();

    // Persist reply
    await saveMessage({
        role: "assistant",
        content: reply,
        channel,
        userProfileId: profile?.id,
        conversationId,
    });

    // Auto-title conversation from first message
    if (conversationId) {
        try {
            const title = message.length > 40 ? message.slice(0, 40) + "..." : message;
            await updateConversationTitle(conversationId, title);
        } catch { /* non-critical */ }
    }

    return { reply, messageId: userMsgId };
}

// --- Knowledge Ingestion ---


/** Embed and store a piece of text for future retrieval. */
export async function ingestKnowledge(params: {
    content: string;
    metadata?: Record<string, string>;
    userProfileId?: string;
}): Promise<string> {
    const embedding = await generateEmbedding(params.content);

    const id = await storeEmbedding({
        content: params.content,
        embedding,
        metadata: params.metadata,
        userProfileId: params.userProfileId,
    });

    return id;
}
