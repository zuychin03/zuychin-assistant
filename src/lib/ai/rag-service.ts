import { generateEmbedding, ai, MODEL } from "@/lib/gemini";
import { searchEmbeddings, storeEmbedding, getRecentMessages, saveMessage, getDefaultProfile, updateConversationTitle } from "@/lib/db";
import { buildGeminiFunctionDeclarations, executeTool } from "@/lib/ai/mcp-service";
import type { MessageChannel, FileAttachment, Message } from "@/lib/types";


const RAG_CONFIG = {
    matchThreshold: 0.72,
    matchCount: 5,
    maxContextItems: 3,
    historyFetchCount: 20,
    recentMessageCount: 5,
    summarizationThreshold: 8,
    deduplicationThreshold: 0.95,
    maxToolRounds: 5,
};


async function summarizeHistory(messages: Message[]): Promise<string> {
    if (messages.length === 0) return "";

    const transcript = messages
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");

    try {
        const response = await ai.models.generateContent({
            model: MODEL,
            contents: `Summarize the following conversation in 2-3 concise sentences. 
Focus on key topics, decisions, and any facts the user shared about themselves. 
Do NOT include greetings or filler.

Conversation:
${transcript}`,
        });
        return response.text?.trim() ?? "";
    } catch (err) {
        return transcript.slice(-500);
    }
}

function rerankResults(
    results: { id: string; content: string; metadata?: Record<string, string>; similarity?: number }[],
    query: string,
    maxResults: number
): typeof results {
    const queryTerms = new Set(
        query.toLowerCase().split(/\s+/).filter((t) => t.length > 2)
    );

    const scored = results.map((r) => {
        const cosineSim = r.similarity ?? 0.7;

        const contentLower = r.content.toLowerCase();
        let keywordHits = 0;
        for (const term of queryTerms) {
            if (contentLower.includes(term)) keywordHits++;
        }
        const keywordScore = queryTerms.size > 0
            ? (keywordHits / queryTerms.size) * 0.2
            : 0;


        const source = r.metadata?.source ?? "";
        const recencyBonus = source === "user_message" ? 0.05 : 0;

        const totalScore = cosineSim + keywordScore + recencyBonus;
        return { ...r, totalScore };
    });


    scored.sort((a, b) => b.totalScore - a.totalScore);
    return scored.slice(0, maxResults);
}

async function isDuplicateEmbedding(
    queryEmbedding: number[],
    userId?: string
): Promise<boolean> {
    try {
        const dupes = await searchEmbeddings({
            queryEmbedding,
            matchThreshold: RAG_CONFIG.deduplicationThreshold,
            matchCount: 1,
            userId,
        });
        return dupes.length > 0;
    } catch {
        return false; // Default: allow storage on error
    }
}


export async function ragChat(params: {
    message: string;
    channel: MessageChannel;
    imageBase64?: string;
    file?: FileAttachment;
    conversationId?: string;
    thinking?: boolean;
    search?: boolean;
}): Promise<{ reply: string; messageId: string }> {
    const { message, channel, imageBase64, file, conversationId, thinking = false, search = false } = params;

    const profile = await getDefaultProfile();
    const sysPrompt = profile?.systemPrompt ??
        "You are Zuychin, a helpful personal AI assistant.";

    const userMsgId = await saveMessage({
        role: "user",
        content: message,
        channel,
        userProfileId: profile?.id,
        conversationId,
    });

    const queryEmbedding = await generateEmbedding(message);

    const [rawMatches, recentMessages] = await Promise.all([
        searchEmbeddings({
            queryEmbedding,
            matchThreshold: RAG_CONFIG.matchThreshold,
            matchCount: RAG_CONFIG.matchCount,
            userId: profile?.id,
        }).catch((err) => {
            console.warn("[RAG] Vector search failed:", err);
            return [];
        }),
        getRecentMessages(RAG_CONFIG.historyFetchCount, channel, conversationId),
    ]);

    const rankedMatches = rerankResults(rawMatches, message, RAG_CONFIG.maxContextItems);
    const relevantContext = rankedMatches.length > 0
        ? rankedMatches.map((m, i) => `[Memory ${i + 1}]: ${m.content}`).join("\n")
        : "";

    let historySection = "";
    if (recentMessages.length > RAG_CONFIG.summarizationThreshold) {
        const olderMessages = recentMessages.slice(0, -RAG_CONFIG.recentMessageCount);
        const recentSlice = recentMessages.slice(-RAG_CONFIG.recentMessageCount);

        const summary = await summarizeHistory(olderMessages);
        const recentText = recentSlice
            .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
            .join("\n");

        historySection = `## Conversation Summary\n${summary}\n\n## Recent Messages\n${recentText}`;
    } else if (recentMessages.length > 0) {
        const historyText = recentMessages
            .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
            .join("\n");
        historySection = `## Recent Conversation\n${historyText}`;
    }

    const isDupe = await isDuplicateEmbedding(queryEmbedding, profile?.id);
    if (!isDupe) {
        storeEmbedding({
            content: message,
            embedding: queryEmbedding,
            metadata: { source: "user_message", channel },
            userProfileId: profile?.id,
        }).catch((err) => console.warn("[RAG] Failed to store embedding:", err));
    } else {
        console.log("[RAG] Skipping duplicate embedding");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts: any[] = [];

    let fullPrompt = `${sysPrompt}\n\n`;

    if (relevantContext) {
        fullPrompt += `## Relevant Memories\n${relevantContext}\n\n`;
    }

    if (historySection) {
        fullPrompt += `${historySection}\n\n`;
    }

    fullPrompt += `## Current Message\nUser: ${message}`;
    parts.push({ text: fullPrompt });

    if (imageBase64) {
        parts.push({
            inlineData: { mimeType: "image/jpeg", data: imageBase64 },
        });
    }

    if (file) {
        parts.push({
            inlineData: { mimeType: file.mimeType, data: file.base64 },
        });
    }

    // Gemini API can't combine googleSearch + functionDeclarations.
    // Try function calling first; fall back to Google Search if no tool was used.
    const toolDeclarations = buildGeminiFunctionDeclarations();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contents: any[] = [{ role: "user", parts }];

    const thinkingOpts = thinking ? { thinkingConfig: { thinkingBudget: 8192 } } : {};

    const toolConfig = {
        tools: [{ functionDeclarations: toolDeclarations }],
        ...thinkingOpts,
    };

    const searchConfig = {
        tools: [{ googleSearch: {} }],
        ...thinkingOpts,
    };

    // If search is explicitly requested, skip MCP tools and use Google Search directly
    if (search) {
        const response = await ai.models.generateContent({
            model: MODEL,
            contents,
            config: searchConfig,
        });

        const reply = response.text ?? "";

        await saveMessage({
            role: "assistant",
            content: reply,
            channel,
            userProfileId: profile?.id,
            conversationId,
        });

        return { reply, messageId: userMsgId };
    }

    // Function calling pass
    let response = await ai.models.generateContent({
        model: MODEL,
        contents,
        config: toolConfig,
    });

    let usedTool = false;
    for (let round = 0; round < RAG_CONFIG.maxToolRounds; round++) {
        const fc = response.functionCalls?.[0];
        if (!fc?.name) break;

        usedTool = true;
        const toolName = fc.name;
        console.log(`[MCP] Tool call: ${toolName}(${JSON.stringify(fc.args)})`);

        const toolResult = await executeTool(toolName, (fc.args ?? {}) as Record<string, unknown>);
        console.log(`[MCP] Tool result: ${toolResult.substring(0, 100)}...`);

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

        response = await ai.models.generateContent({
            model: MODEL,
            contents,
            config: toolConfig,
        });
    }

    // No MCP tool used — automatically try Google Search grounding
    // This gives the model access to current/real-time information
    if (!usedTool) {
        try {
            console.log("[RAG] No tool used, trying Google Search grounding...");
            const searchResponse = await ai.models.generateContent({
                model: MODEL,
                contents,
                config: searchConfig,
            });
            if (searchResponse.text && searchResponse.text.length > 0) {
                console.log("[RAG] Google Search grounding returned results.");
                response = searchResponse;
            }
        } catch (searchErr) {
            console.warn("[RAG] Google Search grounding failed:", searchErr);
        }
    }

    const reply = response.text ?? "";

    await saveMessage({
        role: "assistant",
        content: reply,
        channel,
        userProfileId: profile?.id,
        conversationId,
    });

    if (conversationId) {
        try {
            const title = message.length > 40 ? message.slice(0, 40) + "..." : message;
            await updateConversationTitle(conversationId, title);
        } catch { /* non-critical */ }
    }

    return { reply, messageId: userMsgId };
}


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
