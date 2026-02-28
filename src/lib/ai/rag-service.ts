import { generateEmbedding, ai, MODEL } from "@/lib/gemini";
import { searchEmbeddings, storeEmbedding, getRecentMessages, saveMessage, getDefaultProfile, updateConversationTitle } from "@/lib/db";
import { buildGeminiFunctionDeclarations, executeTool } from "@/lib/ai/mcp-service";
import type { MessageChannel, FileAttachment, Message } from "@/lib/types";

// --- RAG Configuration ---
const RAG_CONFIG = {
    /** Minimum cosine similarity for vector results */
    matchThreshold: 0.72,
    /** Max vector results to fetch (before reranking) */
    matchCount: 5,
    /** Max vector results to keep after reranking */
    maxContextItems: 3,
    /** Messages to fetch for history */
    historyFetchCount: 20,
    /** Keep this many recent messages verbatim; summarize the rest */
    recentMessageCount: 5,
    /** Min messages before summarization kicks in */
    summarizationThreshold: 8,
    /** Cosine similarity above which we consider an embedding a duplicate */
    deduplicationThreshold: 0.95,
    /** Max tool-call rounds per request */
    maxToolRounds: 5,
};


// ── Helpers ──────────────────────────────────────────────────

/**
 * Summarize older messages into a short paragraph using Gemini.
 * Keeps the conversation context small while preserving key information.
 */
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
        console.warn("[RAG] Summarization failed, falling back to truncation:", err);
        // Fallback: just take last few lines
        return transcript.slice(-500);
    }
}

/**
 * Rerank vector search results by combining cosine similarity with
 * keyword overlap and recency, then keep only the best matches.
 */
function rerankResults(
    results: { id: string; content: string; metadata?: Record<string, string>; similarity?: number }[],
    query: string,
    maxResults: number
): typeof results {
    const queryTerms = new Set(
        query.toLowerCase().split(/\s+/).filter((t) => t.length > 2)
    );

    const scored = results.map((r) => {
        // 1. Base score = cosine similarity (0-1)
        const cosineSim = r.similarity ?? 0.7;

        // 2. Keyword overlap bonus (0-0.2)
        const contentLower = r.content.toLowerCase();
        let keywordHits = 0;
        for (const term of queryTerms) {
            if (contentLower.includes(term)) keywordHits++;
        }
        const keywordScore = queryTerms.size > 0
            ? (keywordHits / queryTerms.size) * 0.2
            : 0;

        // 3. Recency bonus (0-0.1) — newer sources get a small boost
        const source = r.metadata?.source ?? "";
        const recencyBonus = source === "user_message" ? 0.05 : 0;

        const totalScore = cosineSim + keywordScore + recencyBonus;
        return { ...r, totalScore };
    });

    // Sort by total score descending, take top N
    scored.sort((a, b) => b.totalScore - a.totalScore);
    return scored.slice(0, maxResults);
}

/**
 * Check if a near-duplicate embedding already exists.
 * Returns true if we should skip storing (duplicate found).
 */
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
        return false; // On error, allow storing
    }
}


// ── Main Pipeline ────────────────────────────────────────────

/** Main RAG pipeline: embed → search → rerank → summarize → generate (with tool loop) → dedup → store */
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

    // ── Parallel: embedding search + conversation history ──
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

    // ── Rerank vector results ──
    const rankedMatches = rerankResults(rawMatches, message, RAG_CONFIG.maxContextItems);
    const relevantContext = rankedMatches.length > 0
        ? rankedMatches.map((m, i) => `[Memory ${i + 1}]: ${m.content}`).join("\n")
        : "";

    // ── Conversation summarization ──
    let historySection = "";
    if (recentMessages.length > RAG_CONFIG.summarizationThreshold) {
        // Split: older messages get summarized, recent ones stay verbatim
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

    // ── Dedup: store embedding only if not a near-duplicate ──
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

    // ── Assemble prompt ──
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

    // Attach image (legacy)
    if (imageBase64) {
        parts.push({
            inlineData: { mimeType: "image/jpeg", data: imageBase64 },
        });
    }

    // Attach file
    if (file) {
        parts.push({
            inlineData: { mimeType: file.mimeType, data: file.base64 },
        });
    }

    // ── Generate with Google Search grounding + function calling ──
    // Note: gemini-3-flash-preview doesn't support combining googleSearch
    // with functionDeclarations in one request. We try googleSearch first
    // (for web-grounded answers), then fall back to function calling if
    // the model doesn't use search grounding.
    const toolDeclarations = buildGeminiFunctionDeclarations();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contents: any[] = [{ role: "user", parts }];

    const thinkingOpts = thinking ? { thinkingConfig: { thinkingBudget: 8192 } } : {};

    // Config A: Google Search grounding (for real-time web info)
    const searchConfig = {
        tools: [{ googleSearch: {} }],
        ...thinkingOpts,
    };

    // Config B: MCP function calling (for tools like get_current_time, save_note)
    const toolConfig = {
        tools: [{ functionDeclarations: toolDeclarations }],
        ...thinkingOpts,
    };

    // Try with Google Search first; fall back to function calling on error
    let response;
    let usedSearch = true;
    try {
        response = await ai.models.generateContent({
            model: MODEL,
            contents,
            config: searchConfig,
        });
    } catch (searchErr) {
        console.warn("[RAG] Google Search grounding failed, falling back to function calling:", searchErr);
        usedSearch = false;
        response = await ai.models.generateContent({
            model: MODEL,
            contents,
            config: toolConfig,
        });
    }

    // If using function calling config, handle MCP tool loop
    if (!usedSearch) {
        for (let round = 0; round < RAG_CONFIG.maxToolRounds; round++) {
            const fc = response.functionCalls?.[0];
            if (!fc?.name) break;

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


// ── Knowledge Ingestion ──────────────────────────────────────

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
