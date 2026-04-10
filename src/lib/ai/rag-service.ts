import { generateEmbedding, ai, MODEL } from "@/lib/gemini";
import { ThinkingLevel } from "@google/genai";
import { searchEmbeddings, storeEmbedding, getRecentMessages, saveMessage, getDefaultProfile, updateConversationTitle } from "@/lib/db";
import { buildGeminiFunctionDeclarations, executeTool } from "@/lib/ai/mcp-service";
import type { MessageChannel, FileAttachment, Message } from "@/lib/types";
import type { GenerateContentResponse } from "@google/genai";


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


// Extract inline citations from Google Search grounding metadata
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addCitations(response: GenerateContentResponse): string {
    let text = response.text ?? "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candidate = response.candidates?.[0] as any;
    const supports = candidate?.groundingMetadata?.groundingSupports;
    const chunks = candidate?.groundingMetadata?.groundingChunks;

    if (!supports?.length || !chunks?.length) return text;

    // Sort by endIndex descending to insert from end (avoids index shifting)
    const sorted = [...supports].sort(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a: any, b: any) => (b.segment?.endIndex ?? 0) - (a.segment?.endIndex ?? 0)
    );

    for (const support of sorted) {
        const endIndex = support.segment?.endIndex;
        if (endIndex === undefined || !support.groundingChunkIndices?.length) continue;

        const links = support.groundingChunkIndices
            .map((i: number) => {
                const uri = chunks[i]?.web?.uri;
                return uri ? `[${i + 1}](${uri})` : null;
            })
            .filter(Boolean);

        if (links.length > 0) {
            text = text.slice(0, endIndex) + " " + links.join(", ") + text.slice(endIndex);
        }
    }

    return text;
}

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
        return false;
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

    let userMsgId = "";
    try {
        userMsgId = await saveMessage({
            role: "user",
            content: message,
            channel,
            userProfileId: profile?.id,
            conversationId,
        });
    } catch (err) {
        console.error("[RAG] Failed to save user message:", err);
    }

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

    const toolDeclarations = buildGeminiFunctionDeclarations();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contents: any[] = [{ role: "user", parts }];

    const thinkingOpts = { thinkingConfig: { thinkingLevel: thinking ? ThinkingLevel.HIGH : ThinkingLevel.LOW } };

    const mcpConfig = {
        tools: [{ functionDeclarations: toolDeclarations }],
        ...thinkingOpts,
    };

    const groundingConfig = {
        tools: [{ googleSearch: {} }, { urlContext: {} }],
        ...thinkingOpts,
    };

    const mapsConfig = {
        tools: [{ googleMaps: {} }],
        ...thinkingOpts,
    };

    // Detect location-based queries to route to Google Maps instead of Search
    const isLocationQuery = (q: string) => {
        const loc = /\b(near me|nearby|restaurant|cafe|coffee|hotel|hospital|pharmacy|cinema|gym|airport|station|directions?|map|address|open now|hours|rating|review|how far|distance|km|miles?|street|suburb|postcode|zip code|where is|located|location)\b/i;
        return loc.test(q);
    };

    // Explicit /search: skip MCP tools, use grounding only
    if (search) {
        const response = await ai.models.generateContent({
            model: MODEL,
            contents,
            config: groundingConfig,
        });

        const reply = addCitations(response);

        try {
            await saveMessage({
                role: "assistant",
                content: reply,
                channel,
                userProfileId: profile?.id,
                conversationId,
            });
        } catch (err) {
            console.error("[RAG] Failed to save assistant message:", err);
        }

        return { reply, messageId: userMsgId };
    }

    // MCP function calling pass
    let response = await ai.models.generateContent({
        model: MODEL,
        contents,
        config: mcpConfig,
    });

    let usedTool = false;
    for (let round = 0; round < RAG_CONFIG.maxToolRounds; round++) {
        const calls = response.functionCalls;
        if (!calls || calls.length === 0) break;

        usedTool = true;

        // Execute all function calls in parallel
        const results = await Promise.all(
            calls.map(async (fc) => {
                console.log(`[MCP] Tool call: ${fc.name}(${JSON.stringify(fc.args)})`);
                const result = await executeTool(fc.name!, (fc.args ?? {}) as Record<string, unknown>);
                console.log(`[MCP] Tool result (${fc.name}): ${result.substring(0, 100)}...`);
                return { name: fc.name!, result, id: (fc as any).id }; // eslint-disable-line @typescript-eslint/no-explicit-any
            })
        );

        // Preserve full model response (toolCall, toolResponse, thoughtSignature)
        contents.push(response.candidates![0].content);
        contents.push({
            role: "user",
            parts: results.map((r) => ({
                functionResponse: {
                    name: r.name,
                    response: { result: r.result },
                    id: r.id,
                },
            })),
        });

        response = await ai.models.generateContent({
            model: MODEL,
            contents,
            config: mcpConfig,
        });
    }

    // Grounding fallback: route to Maps or Search based on query type
    if (!usedTool) {
        const fallbackConfig = isLocationQuery(message) ? mapsConfig : groundingConfig;
        const label = isLocationQuery(message) ? "Maps" : "Search";
        try {
            const groundingResponse = await ai.models.generateContent({
                model: MODEL,
                contents,
                config: fallbackConfig,
            });
            if (groundingResponse.text) {
                console.log(`[RAG] Grounding fallback triggered (${label}).`);
                response = groundingResponse;
            }
        } catch (err) {
            console.warn(`[RAG] Grounding fallback failed (${label}):`, err);
        }
    }

    const reply = addCitations(response);

    try {
        await saveMessage({
            role: "assistant",
            content: reply,
            channel,
            userProfileId: profile?.id,
            conversationId,
        });
    } catch (err) {
        console.error("[RAG] Failed to save assistant message:", err);
    }

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
