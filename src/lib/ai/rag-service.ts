import { ai, MODEL } from "@/lib/gemini";
import { ThinkingLevel } from "@google/genai";
import { searchEmbeddings, storeEmbedding, getRecentMessages, saveMessage, getDefaultProfile, getConversation, updateConversationTitle, updateProfilePreferences } from "@/lib/db";
import { buildGeminiFunctionDeclarations, executeTool, type ToolContext } from "@/lib/ai/mcp-service";
import { classifyIntent } from "@/lib/ai/agent/router";
import { runAgent } from "@/lib/ai/agent/orchestrator";
import type { AgentEventSink } from "@/lib/ai/agent/events";
import { resolveChat, resolveModelKey, resolveMessagingDefault, resolveMessagingEmbedding, resolveEmbeddingKey, resolveChatByName, availableChatModels, resolveEmbeddingByName, availableEmbeddingModels, type ResolvedChat, type GenParams } from "@/lib/ai/providers";
import { embedText, getEmbeddingRef, type ResolvedEmbedding } from "@/lib/ai/embeddings";
import { openaiCompatChat } from "@/lib/ai/openai-compat";
import { currentDateTimeContext } from "@/lib/datetime";
import { isTextLikeAttachment } from "@/lib/types";
import { formatTextAttachment } from "@/lib/attachments";
import { linkArtifactsToMessage } from "@/lib/artifacts/store";
import type { MessageChannel, FileAttachment, Message, ArtifactDescriptor } from "@/lib/types";
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


// adds [1](url) style citations from Google Search grounding metadata
function addCitations(response: GenerateContentResponse): string {
    let text = response.text ?? "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candidate = response.candidates?.[0] as any;
    const supports = candidate?.groundingMetadata?.groundingSupports;
    const chunks = candidate?.groundingMetadata?.groundingChunks;

    if (!supports?.length || !chunks?.length) return text;

    // insert from the end so the indexes don't shift as we go
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
    } catch {
        return transcript.slice(-500);
    }
}

// Ask the model for a short topic title from the first exchange. Always uses
// Gemini Flash (cheap) regardless of the chat model the user picked. Falls back to
// a trimmed version of the first message if the call fails.
async function generateConversationTitle(userMessage: string, reply: string): Promise<string> {
    const fallback = userMessage.length > 40 ? userMessage.slice(0, 40).trim() + "..." : userMessage;

    try {
        const response = await ai.models.generateContent({
            model: MODEL,
            contents: `Write a short, specific topic title (3-6 words, Title Case) for this conversation.
Return ONLY the title - no quotes, no trailing punctuation, no "Title:" prefix.

User: ${userMessage}
Assistant: ${reply}`,
        });

        let title = (response.text ?? "").trim();
        // strip wrapping quotes and any trailing punctuation the model adds
        title = title.replace(/^["'`]+|["'`]+$/g, "").replace(/[.!?,;:]+$/, "").trim();
        if (!title) return fallback;
        return title.length > 60 ? title.slice(0, 60).trim() : title;
    } catch {
        return fallback;
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
    embRef: ResolvedEmbedding,
    userId?: string
): Promise<boolean> {
    try {
        const dupes = await searchEmbeddings({
            queryEmbedding,
            matchThreshold: RAG_CONFIG.deduplicationThreshold,
            matchCount: 1,
            userId,
            embeddingModel: embRef.model.id,
        });
        return dupes.length > 0;
    } catch {
        return false;
    }
}


export type Profile = Awaited<ReturnType<typeof getDefaultProfile>>;

// Read the model a channel was switched to (stored as "providerId::modelId").
function getStoredChannelModel(profile: Profile, channel: MessageChannel): string | undefined {
    const prefs = profile?.preferences as { channelModels?: Record<string, string> } | null | undefined;
    return prefs?.channelModels?.[channel];
}

// Read the embedding model a channel was switched to (stored as "providerId::modelId").
function getStoredChannelEmbedding(profile: Profile, channel: MessageChannel): string | undefined {
    const prefs = profile?.preferences as { channelEmbeddings?: Record<string, string> } | null | undefined;
    return prefs?.channelEmbeddings?.[channel];
}

// Persist a "providerId::modelId" choice under the given preferences key for a
// channel. Returns false if it couldn't be saved.
async function saveChannelChoice(
    profile: Profile,
    channel: MessageChannel,
    key: "channelModels" | "channelEmbeddings",
    value: string
): Promise<boolean> {
    if (!profile?.id) return false;
    const prefs: Record<string, unknown> =
        profile.preferences && typeof profile.preferences === "object"
            ? { ...(profile.preferences as Record<string, unknown>) }
            : {};
    const map = { ...((prefs[key] as Record<string, string>) ?? {}) };
    map[channel] = value;
    prefs[key] = map;
    try {
        await updateProfilePreferences(profile.id, prefs);
        return true;
    } catch {
        return false;
    }
}

// Decide which chat model a request should use. Web sends provider/model from the
// dropdown; the messaging channels use their saved choice, then the free chain.
function resolveChatForRequest(
    channel: MessageChannel,
    provider: string | undefined,
    model: string | undefined,
    profile: Profile
): ResolvedChat {
    if (provider || model) return resolveChat(provider, model);
    if (channel !== "web") {
        return resolveModelKey(getStoredChannelModel(profile, channel)) ?? resolveMessagingDefault();
    }
    return resolveChat();
}

// Render the grouped model listing for a command's help text.
function formatModelListing(
    groups: { provider: string; providerId: string; models: { name: string; label: string }[] }[]
): string {
    return groups
        .map((g) => `${g.provider} (${g.providerId})\n` + g.models.map((m) => `  • ${m.name} — ${m.label}`).join("\n"))
        .join("\n");
}

// Handle "/model" (or "!model") on the messaging channels: list models or switch
// to "<provider> <model>" and persist. Each model has one unique name per provider.
async function handleModelCommand(message: string, channel: MessageChannel, profile: Profile): Promise<string> {
    const arg = message.trim().replace(/^[/!]model(?:@\S+)?\s*/i, "").trim();
    const current = resolveModelKey(getStoredChannelModel(profile, channel)) ?? resolveMessagingDefault();
    const usage = `Usage: /model <provider> <model>\n\nAvailable models:\n${formatModelListing(availableChatModels())}`;

    if (!arg || arg.toLowerCase() === "list") {
        return `Current model on ${channel}: ${current.model.label} (${current.provider.label}).\n\n${usage}`;
    }

    const parts = arg.split(/\s+/);
    if (parts.length < 2) {
        return `Please specify both a provider and a model.\n\n${usage}`;
    }

    const resolved = resolveChatByName(parts[0], parts[1]);
    if (!resolved) {
        return `Unknown or unavailable model "${arg}".\n\n${usage}`;
    }

    const saved = await saveChannelChoice(profile, channel, "channelModels", `${resolved.provider.id}::${resolved.model.id}`);
    if (!saved) {
        return "Couldn't save the model choice. Please try again later.";
    }
    return `Model set to ${resolved.model.label} (${resolved.provider.label}) for ${channel}.`;
}

// Handle "/embed-model" (or "!embed-model"): list embedding models or switch to
// "<provider> <model>" and persist. Switching changes which memory partition the
// channel reads/writes (vectors from different models aren't comparable).
async function handleEmbedModelCommand(message: string, channel: MessageChannel, profile: Profile): Promise<string> {
    const arg = message.trim().replace(/^[/!]embed-model(?:@\S+)?\s*/i, "").trim();
    const current = resolveEmbeddingKey(getStoredChannelEmbedding(profile, channel)) ?? resolveMessagingEmbedding();
    const usage = `Usage: /embed-model <provider> <model>\n\nAvailable embedding models:\n${formatModelListing(availableEmbeddingModels())}`;

    if (!arg || arg.toLowerCase() === "list") {
        return `Current embedding model on ${channel}: ${current.model.label} (${current.provider.label}).\n\n${usage}`;
    }

    const parts = arg.split(/\s+/);
    if (parts.length < 2) {
        return `Please specify both a provider and a model.\n\n${usage}`;
    }

    const resolved = resolveEmbeddingByName(parts[0], parts[1]);
    if (!resolved) {
        return `Unknown or unavailable embedding model "${arg}".\n\n${usage}`;
    }

    const saved = await saveChannelChoice(profile, channel, "channelEmbeddings", `${resolved.provider.id}::${resolved.model.id}`);
    if (!saved) {
        return "Couldn't save the embedding choice. Please try again later.";
    }
    return `Embedding model set to ${resolved.model.label} (${resolved.provider.label}) for ${channel}. Note: memories are stored per embedding model, so switching starts a fresh memory partition for this channel.`;
}

export interface RagContext {
    profile: Profile;
    chat: ResolvedChat;
    embRef: ResolvedEmbedding;
    // system prompt + current date/time + relevant memories + conversation history
    contextBlock: string;
    allowThinking: boolean;
    allowSearch: boolean;
}

// Resolves the model/embedding, runs retrieval (vector memories + history), stores
// the query embedding, and assembles the grounding context. Shared by the fast
// single-pass path (ragChat) and the agent orchestrator so both ground identically.
export async function buildRagContext(params: {
    message: string;
    channel: MessageChannel;
    conversationId?: string;
    provider?: string;
    model?: string;
    embeddingModel?: string;
    thinking: boolean;
    search: boolean;
    profile: Profile;
}): Promise<RagContext> {
    const { message, channel, conversationId, provider, model, embeddingModel, thinking, search, profile } = params;

    // Resolve which chat model to use. Web sends provider/model from its dropdown;
    // the messaging channels fall back to their saved choice, then the free chain.
    const chat = resolveChatForRequest(channel, provider, model, profile);
    // Web sends its embedding choice; messaging channels use their saved
    // "/embed-model" choice, then the free chain (Nemotron Embed if NIM is
    // configured, else Gemini).
    const embRef = embeddingModel
        ? getEmbeddingRef(embeddingModel)
        : channel !== "web"
            ? (resolveEmbeddingKey(getStoredChannelEmbedding(profile, channel)) ?? resolveMessagingEmbedding())
            : getEmbeddingRef();

    // check this on the server so it works on every channel, not just the web UI
    const allowThinking = thinking && chat.model.supportsThinking;
    const allowSearch = search && chat.model.supportsSearch;

    const sysPrompt = profile?.systemPrompt ??
        "You are Zuychin, a helpful personal AI assistant.";

    const queryEmbedding = await embedText(embRef, message);

    const [rawMatches, recentMessages] = await Promise.all([
        searchEmbeddings({
            queryEmbedding,
            matchThreshold: RAG_CONFIG.matchThreshold,
            matchCount: RAG_CONFIG.matchCount,
            userId: profile?.id,
            embeddingModel: embRef.model.id,
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

    const isDupe = await isDuplicateEmbedding(queryEmbedding, embRef, profile?.id);
    if (!isDupe) {
        storeEmbedding({
            content: message,
            embedding: queryEmbedding,
            embeddingModel: embRef.model.id,
            metadata: { source: "user_message", channel },
            userProfileId: profile?.id,
        }).catch((err) => console.warn("[RAG] Failed to store embedding:", err));
    }

    // build the context block: system prompt + current date/time + memories + history
    let contextBlock = sysPrompt + "\n\n";
    contextBlock += currentDateTimeContext() + "\n\n";
    if (relevantContext) contextBlock += `## Relevant Memories\n${relevantContext}\n\n`;
    if (historySection) contextBlock += `${historySection}\n\n`;

    return { profile, chat, embRef, contextBlock, allowThinking, allowSearch };
}

export async function ragChat(params: {
    message: string;
    channel: MessageChannel;
    imageBase64?: string;
    file?: FileAttachment;
    conversationId?: string;
    thinking?: boolean;
    search?: boolean;
    provider?: string;
    model?: string;
    embeddingModel?: string;
    genParams?: GenParams;
    agent?: boolean;
}, onEvent?: AgentEventSink): Promise<{ reply: string; messageId: string; artifacts: ArtifactDescriptor[] }> {
    const {
        message, channel, imageBase64, file, conversationId,
        thinking = false, search = false, provider, model, embeddingModel,
        genParams = {}, agent = false,
    } = params;

    const profile = await getDefaultProfile();

    // External channels can switch model/embedding with "/model" or "/embed-model"
    // (a "!" prefix also works, since Discord intercepts "/" as its slash-command
    // UI). Handle these before anything else and reply with a confirmation.
    if (channel !== "web") {
        const trimmed = message.trim();
        if (/^[/!]embed-model(?:@\S+)?(?:\s|$)/i.test(trimmed)) {
            return { reply: await handleEmbedModelCommand(message, channel, profile), messageId: "", artifacts: [] };
        }
        if (/^[/!]model(?:@\S+)?(?:\s|$)/i.test(trimmed)) {
            return { reply: await handleModelCommand(message, channel, profile), messageId: "", artifacts: [] };
        }
    }

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

    const rag = await buildRagContext({
        message, channel, conversationId, provider, model,
        embeddingModel, thinking, search, profile,
    });

    // Collect any files the model produces via the artifact tools so we can attach
    // them to the reply and return them to the client.
    const artifacts: ArtifactDescriptor[] = [];

    // Decide fast chat vs. multi-step agent. Forced by the client's `agent` flag,
    // else the router auto-escalates complex web requests. Visual attachments
    // (images / PDFs) stay on the fast path since the agent loop can't see them;
    // a text-like file is folded into the agent's prompt instead.
    const hasVisualAttachment = !!imageBase64 || (!!file && !isTextLikeAttachment(file.mimeType, file.name));
    let mode: "chat" | "agent" = "chat";
    if (agent) mode = "agent";
    else if (channel === "web" && !hasVisualAttachment) mode = (await classifyIntent(message)).mode;
    if (mode === "agent" && hasVisualAttachment) mode = "chat";

    let reply: string;
    if (mode === "agent") {
        const agentMessage = file && isTextLikeAttachment(file.mimeType, file.name)
            ? `${message}\n\n${formatTextAttachment(file)}`
            : message;
        onEvent?.({ type: "status", message: "Understanding your request…" });
        const res = await runAgent({
            rag, message: agentMessage, conversationId, userProfileId: profile?.id, onEvent,
        });
        reply = res.reply;
        artifacts.push(...res.artifacts);
    } else {
        const toolCtx: ToolContext = {
            conversationId,
            userProfileId: profile?.id,
            onArtifact: (a) => { artifacts.push(a); onEvent?.({ type: "artifact", artifact: a }); },
        };
        if (rag.chat.provider.kind === "gemini") {
            reply = await generateGeminiReply({
                contextBlock: rag.contextBlock, message, imageBase64, file, channel,
                thinking: rag.allowThinking, search: rag.allowSearch,
                model: rag.chat.model.id, embRef: rag.embRef, genParams, ctx: toolCtx,
            });
        } else {
            reply = await openaiCompatChat({
                provider: rag.chat.provider,
                model: rag.chat.model,
                systemText: rag.contextBlock.trim(),
                userText: message,
                imageBase64,
                file,
                embRef: rag.embRef,
                thinking: rag.allowThinking,
                search: rag.allowSearch,
                genParams,
                ctx: toolCtx,
            });
        }
    }

    try {
        const assistantMsgId = await saveMessage({
            role: "assistant",
            content: reply,
            channel,
            userProfileId: profile?.id,
            conversationId,
            metadata: artifacts.length > 0 ? { artifacts } : undefined,
        });
        if (artifacts.length > 0) {
            await linkArtifactsToMessage(artifacts.map((a) => a.id), assistantMsgId);
        }
    } catch (err) {
        console.error("[RAG] Failed to save assistant message:", err);
    }

    // Title the conversation once, on the first message, then leave it alone. We
    // only (re)generate while it's still the default "New Chat" so a failed first
    // attempt can recover, but an existing title is never overwritten.
    if (conversationId) {
        try {
            const convo = await getConversation(conversationId);
            if (!convo?.title || convo.title === "New Chat") {
                const title = await generateConversationTitle(message, reply);
                await updateConversationTitle(conversationId, title);
            }
        } catch { /* non-critical */ }
    }

    return { reply, messageId: userMsgId, artifacts };
}


// Gemini path: native function calling plus Google Search/Maps grounding.
async function generateGeminiReply(opts: {
    contextBlock: string;
    message: string;
    imageBase64?: string;
    file?: FileAttachment;
    channel: MessageChannel;
    thinking: boolean;
    search: boolean;
    model: string;
    embRef: ResolvedEmbedding;
    genParams: GenParams;
    ctx?: ToolContext;
}): Promise<string> {
    const { contextBlock, message, imageBase64, file, channel, thinking, search, model, embRef, genParams, ctx } = opts;

    // gemini uses slightly different names for these
    const genConfig: Record<string, number> = {};
    if (genParams.temperature !== undefined) genConfig.temperature = genParams.temperature;
    if (genParams.topP !== undefined) genConfig.topP = genParams.topP;
    if (genParams.maxTokens !== undefined) genConfig.maxOutputTokens = genParams.maxTokens;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts: any[] = [{ text: `${contextBlock}## Current Message\nUser: ${message}` }];

    if (imageBase64) {
        parts.push({ inlineData: { mimeType: "image/jpeg", data: imageBase64 } });
    }
    if (file) {
        // Machine-readable text (markdown/yaml/csv/code/…) is decoded and passed
        // inline as text so it works reliably; binary media goes through inlineData.
        if (isTextLikeAttachment(file.mimeType, file.name)) {
            parts.push({ text: formatTextAttachment(file) });
        } else {
            parts.push({ inlineData: { mimeType: file.mimeType, data: file.base64 } });
        }
    }

    const toolDeclarations = buildGeminiFunctionDeclarations();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contents: any[] = [{ role: "user", parts }];

    const thinkingOpts = { thinkingConfig: { thinkingLevel: thinking ? ThinkingLevel.HIGH : ThinkingLevel.LOW } };
    const mcpConfig = { tools: [{ functionDeclarations: toolDeclarations }], ...thinkingOpts, ...genConfig };
    const groundingConfig = { tools: [{ googleSearch: {} }, { urlContext: {} }], ...thinkingOpts, ...genConfig };
    const mapsConfig = { tools: [{ googleMaps: {} }], ...thinkingOpts, ...genConfig };

    // route location-ish questions to Maps instead of plain Search
    const isLocationQuery = (q: string) => {
        const loc = /\b(near me|nearby|restaurant|cafe|coffee|hotel|hospital|pharmacy|cinema|gym|airport|station|directions?|map|address|open now|hours|rating|review|how far|distance|km|miles?|street|suburb|postcode|zip code|where is|located|location)\b/i;
        return loc.test(q);
    };

    // explicit /search: skip the tools and just ground the answer
    if (search) {
        const response = await ai.models.generateContent({ model, contents, config: groundingConfig });
        return channel === "telegram" ? (response.text ?? "") : addCitations(response);
    }

    // MCP function calling pass
    let response = await ai.models.generateContent({ model, contents, config: mcpConfig });

    let usedTool = false;
    for (let round = 0; round < RAG_CONFIG.maxToolRounds; round++) {
        const calls = response.functionCalls;
        if (!calls || calls.length === 0) break;

        usedTool = true;

        const results = await Promise.all(
            calls.map(async (fc) => {
                const result = await executeTool(fc.name!, (fc.args ?? {}) as Record<string, unknown>, embRef, ctx);
                return { name: fc.name!, result, id: (fc as any).id }; // eslint-disable-line @typescript-eslint/no-explicit-any
            })
        );

        contents.push(response.candidates![0].content);
        contents.push({
            role: "user",
            parts: results.map((r) => ({
                functionResponse: { name: r.name, response: { result: r.result }, id: r.id },
            })),
        });

        response = await ai.models.generateContent({ model, contents, config: mcpConfig });
    }

    // if no tool was used, fall back to grounding (Maps or Search)
    if (!usedTool) {
        const fallbackConfig = isLocationQuery(message) ? mapsConfig : groundingConfig;
        const label = isLocationQuery(message) ? "Maps" : "Search";
        try {
            const groundingResponse = await ai.models.generateContent({ model, contents, config: fallbackConfig });
            if (groundingResponse.text) {
                response = groundingResponse;
            }
        } catch (err) {
            console.warn(`[RAG] Grounding fallback failed (${label}):`, err);
        }
    }

    return channel === "telegram" ? (response.text ?? "") : addCitations(response);
}


export async function ingestKnowledge(params: {
    content: string;
    metadata?: Record<string, string>;
    userProfileId?: string;
    embeddingModel?: string;
}): Promise<string> {
    const embRef = getEmbeddingRef(params.embeddingModel);
    const embedding = await embedText(embRef, params.content);

    const id = await storeEmbedding({
        content: params.content,
        embedding,
        embeddingModel: embRef.model.id,
        metadata: params.metadata,
        userProfileId: params.userProfileId,
    });

    return id;
}
