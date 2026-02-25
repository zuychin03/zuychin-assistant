import { generateEmbedding, ai, MODEL } from "@/lib/gemini";
import { searchEmbeddings, storeEmbedding, getRecentMessages, saveMessage, getDefaultProfile, updateConversationTitle } from "@/lib/db";
import { buildGeminiFunctionDeclarations, executeTool } from "@/lib/ai/mcp-service";
import type { MessageChannel, FileAttachment } from "@/lib/types";



/** Main RAG pipeline: embed → search → augment → generate (with tool loop) → store */
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts: any[] = [];

    let fullPrompt = `${sysPrompt}\n\n`;

    if (relevantContext) {
        fullPrompt += `## Relevant Memories\n${relevantContext}\n\n`;
    }

    if (historyText) {
        fullPrompt += `## Recent Conversation\n${historyText}\n\n`;
    }

    fullPrompt += `## Current Message\nUser: ${message}`;
    parts.push({ text: fullPrompt });

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

    // Generate with function calling loop (max 5 tool rounds)
    const toolDeclarations = buildGeminiFunctionDeclarations();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contents: any[] = [{ role: "user", parts }];

    const config = {
        tools: [{ functionDeclarations: toolDeclarations }],
        ...(thinking && { thinkingConfig: { thinkingBudget: 8192 } }),
    };

    let response = await ai.models.generateContent({
        model: MODEL,
        contents,
        config,
    });

    const MAX_TOOL_ROUNDS = 5;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const fc = response.functionCalls?.[0];
        if (!fc?.name) break; // No tool call → done

        const toolName = fc.name;
        console.log(`[MCP] Tool call: ${toolName}(${JSON.stringify(fc.args)})`);

        // Execute the tool
        const toolResult = await executeTool(toolName, (fc.args ?? {}) as Record<string, unknown>);
        console.log(`[MCP] Tool result: ${toolResult.substring(0, 100)}...`);

        // Append model response + function result to contents
        contents.push(response.candidates![0].content);
        contents.push({
            role: "user",
            parts: [{
                functionResponse: {
                    name: toolName,
                    response: { result: toolResult },
                },
            }],
        });

        // Re-generate with full conversation history
        response = await ai.models.generateContent({
            model: MODEL,
            contents,
            config,
        });
    }

    const reply = response.text ?? "";

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
