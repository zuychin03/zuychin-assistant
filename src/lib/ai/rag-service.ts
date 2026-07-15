import { ai, MODEL } from "@/lib/gemini";
import { ThinkingLevel } from "@google/genai";
import { searchEmbeddings, storeEmbedding, getRecentMessages, saveMessage, deleteMessage, getDefaultProfile, getConversation, updateConversationTitle, updateProfilePreferences, listTodos, countUserMessagesSince } from "@/lib/db";
import { buildGeminiFunctionDeclarations, executeTool, type ToolContext } from "@/lib/ai/mcp-service";
import { classifyIntent } from "@/lib/ai/agent/router";
import { runAgent } from "@/lib/ai/agent/orchestrator";
import { getAgentRun } from "@/lib/ai/agent/run-store";
import { searchMemories } from "@/lib/ai/memory/store";
import { extractMemories } from "@/lib/ai/memory/extractor";
import { getConversationProject } from "@/lib/projects";
import { after } from "next/server";
import type { AgentEventSink } from "@/lib/ai/agent/events";
import { resolveChat, resolveModelKey, resolveMessagingDefault, resolveMessagingEmbedding, resolveEmbeddingKey, resolveChatByName, availableChatModels, resolveEmbeddingByName, availableEmbeddingModels, type ResolvedChat, type GenParams } from "@/lib/ai/providers";
import { embedText, getEmbeddingRef, type ResolvedEmbedding } from "@/lib/ai/embeddings";
import { openaiCompatChat } from "@/lib/ai/openai-compat";
import { currentDateTimeContext, APP_TIMEZONE } from "@/lib/datetime";
import { expandSlashCommand } from "@/lib/commands";
import { isTextLikeAttachment } from "@/lib/types";
import { formatTextAttachment } from "@/lib/attachments";
import { linkArtifactsToMessage } from "@/lib/artifacts/store";
import type { MessageChannel, FileAttachment, Message, ArtifactDescriptor, ReplyRef } from "@/lib/types";
import type { GenerateContentResponse } from "@google/genai";

const RAG_CONFIG = {
    matchThreshold: 0.72,
    matchCount: 5,
    maxContextItems: 3,
    factCount: 6,
    historyFetchCount: 20,
    recentMessageCount: 5,
    summarizationThreshold: 8,
    deduplicationThreshold: 0.95,
    maxToolRounds: 8,
};

function addCitations(response: GenerateContentResponse): string {
    let text = response.text ?? "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candidate = response.candidates?.[0] as any;
    const supports = candidate?.groundingMetadata?.groundingSupports;
    const chunks = candidate?.groundingMetadata?.groundingChunks;

    if (!supports?.length || !chunks?.length) return text;

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

function getStoredChannelModel(profile: Profile, channel: MessageChannel): string | undefined {
    const prefs = profile?.preferences as { channelModels?: Record<string, string> } | null | undefined;
    return prefs?.channelModels?.[channel];
}

function getStoredChannelEmbedding(profile: Profile, channel: MessageChannel): string | undefined {
    const prefs = profile?.preferences as { channelEmbeddings?: Record<string, string> } | null | undefined;
    return prefs?.channelEmbeddings?.[channel];
}

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

function formatModelListing(
    groups: { provider: string; providerId: string; models: { name: string; label: string }[] }[]
): string {
    return groups
        .map((g) => `${g.provider} (${g.providerId})\n` + g.models.map((m) => `  • ${m.name} — ${m.label}`).join("\n"))
        .join("\n");
}

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
    return `Embedding model set to ${resolved.model.label} (${resolved.provider.label}) for ${channel}. Note: the knowledge store now uses a single shared embedding partition, so this choice no longer affects how memories are stored or recalled.`;
}

function startOfTodayUtc(): Date {
    const now = new Date();
    const local = new Date(now.toLocaleString("en-US", { timeZone: APP_TIMEZONE }));
    const start = new Date(local);
    start.setHours(0, 0, 0, 0);
    return new Date(start.getTime() + (now.getTime() - local.getTime()));
}

// Reminder about undated pending tasks, appended to the first reply of the
// day. Dated tasks are covered by the calendar/agenda flows.
async function dailyNotesReminder(excludeMessageId?: string): Promise<string> {
    try {
        const earlierToday = await countUserMessagesSince(startOfTodayUtc().toISOString(), excludeMessageId);
        if (earlierToday > 0) return "";

        const undated = (await listTodos("pending", 50)).filter((t) => !t.dueDate);
        if (undated.length === 0) return "";

        const shown = undated.slice(0, 5).map((t) => `"${t.title}"`).join(", ");
        const more = undated.length > 5 ? ` and ${undated.length - 5} more` : "";
        const plural = undated.length === 1 ? "task" : "tasks";
        return `\n\n---\n📌 First chat of the day — you still have ${undated.length} pending ${plural} with no date: ${shown}${more}. Tick off anything already done in the Notes panel.`;
    } catch (err) {
        console.warn("[RAG] Daily notes reminder failed:", err);
        return "";
    }
}

export interface RagContext {
    profile: Profile;
    chat: ResolvedChat;
    embRef: ResolvedEmbedding;
    contextBlock: string;
    allowThinking: boolean;
    allowSearch: boolean;
    lastAssistantMessage?: string;
    /** Set when the conversation belongs to a project; scopes fact extraction. */
    projectId?: string;
}

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
    hasAudioAttachment?: boolean;
}): Promise<RagContext> {
    const { message, channel, conversationId, provider, model, thinking, search, profile } = params;

    let chat = resolveChatForRequest(channel, provider, model, profile);
    // Only Gemini can hear: the OpenAI-compat client drops audio bytes, so an
    // audio turn on a non-Gemini selection falls back to Gemini for this turn.
    if (params.hasAudioAttachment && chat.provider.kind !== "gemini") {
        chat = resolveChat();
    }
    // The knowledge store lives in ONE embedding partition (the default
    // model), like fact memory: honoring per-turn/per-channel embedding
    // selections fragmented recall across partitions, so they are ignored.
    const embRef = getEmbeddingRef();

    const allowThinking = thinking && chat.model.supportsThinking;
    const allowSearch = search && chat.model.supportsSearch;

    const sysPrompt = profile?.systemPrompt ??
        "You are Zuychin, a helpful personal AI assistant.";

    // Project lookup runs alongside the embed call: the project's id scopes
    // the fact search below and its instructions join the prompt. One query
    // vector serves message search, fact search, and the message save — all
    // three live in the same default partition. If the embedding provider is
    // down the turn continues on recent history alone rather than failing.
    const [queryEmbedding, project] = await Promise.all([
        embedText(embRef, message).catch((err): null => {
            console.warn("[RAG] Query embed failed, continuing without vector recall:", err);
            return null;
        }),
        conversationId ? getConversationProject(conversationId) : Promise.resolve(null),
    ]);

    const [rawMatches, recentMessages, factHits] = await Promise.all([
        queryEmbedding
            ? searchEmbeddings({
                queryEmbedding,
                matchThreshold: RAG_CONFIG.matchThreshold,
                matchCount: RAG_CONFIG.matchCount,
                userId: profile?.id,
                embeddingModel: embRef.model.id,
            }).catch((err) => {
                console.warn("[RAG] Vector search failed:", err);
                return [];
            })
            : Promise.resolve([]),
        getRecentMessages(RAG_CONFIG.historyFetchCount, channel, conversationId),
        queryEmbedding
            ? searchMemories({
                queryEmbedding,
                userId: profile?.id,
                projectId: project?.id,
                matchThreshold: 0.35,
                matchCount: RAG_CONFIG.factCount + 4,
            })
            : Promise.resolve([]),
    ]);
    // Candidates (unconfirmed work/study patterns) never reach the prompt.
    const knownFacts = factHits.filter((f) => f.status !== "candidate").slice(0, RAG_CONFIG.factCount);

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

    if (queryEmbedding && !(await isDuplicateEmbedding(queryEmbedding, embRef, profile?.id))) {
        storeEmbedding({
            content: message,
            embedding: queryEmbedding,
            embeddingModel: embRef.model.id,
            metadata: { source: "user_message", channel },
            userProfileId: profile?.id,
        }).catch((err) => console.warn("[RAG] Failed to store embedding:", err));
    }

    let contextBlock = sysPrompt + "\n\n";
    if (project) {
        contextBlock += `## Project: ${project.name}\n`;
        if (project.instructions.trim()) contextBlock += `${project.instructions.trim()}\n`;
        contextBlock += "\n";
    }
    contextBlock += currentDateTimeContext() + "\n\n";
    if (knownFacts.length > 0) {
        contextBlock += `## Known Facts (long-term memory)\n${knownFacts.map((f) => `- [${f.category}] ${f.fact}`).join("\n")}\n\n`;
    }
    if (relevantContext) contextBlock += `## Relevant Memories\n${relevantContext}\n\n`;
    if (historySection) contextBlock += `${historySection}\n\n`;

    const lastAssistantMessage = [...recentMessages].reverse().find((m) => m.role === "assistant")?.content;

    return { profile, chat, embRef, contextBlock, allowThinking, allowSearch, lastAssistantMessage, projectId: project?.id };
}

// Summarizes an interrupted run so a fresh agent pass can pick up where it
// stopped instead of redoing completed work. No transcript replay — the new
// run re-derives context and treats this as briefing notes.
async function buildResumePrefix(resumeRunId: string): Promise<string | undefined> {
    try {
        const run = await getAgentRun(resumeRunId);
        if (!run) return undefined;
        const planLines = run.plan.map((s) => `- [${s.status}] ${s.title}`).join("\n");
        const eventLines = run.events
            .slice(-15)
            .map((e) => {
                switch (e.type) {
                    case "tool": return `tool ${e.name}: ${e.phase}`;
                    case "subagent": return `subagent (${e.model}) ${e.phase}: ${String(e.objective ?? "").slice(0, 100)}`;
                    case "artifact": {
                        const a = e.artifact as { name?: string } | undefined;
                        return `artifact created: ${a?.name ?? "?"}`;
                    }
                    case "status": return `status: ${e.message}`;
                    default: return "";
                }
            })
            .filter(Boolean)
            .join("\n");
        return `A previous attempt at this task was interrupted (status: ${run.status}). Its plan and progress:\n${planLines || "(no plan recorded)"}\n\nLast recorded activity:\n${eventLines || "(none)"}\n\nDo not redo completed work — artifacts already created were delivered. Continue from where it stopped.\n\n## Original Task\n`;
    } catch (err) {
        console.warn("[RAG] Failed to build resume prefix:", err);
        return undefined;
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
    provider?: string;
    model?: string;
    embeddingModel?: string;
    genParams?: GenParams;
    agent?: boolean;
    resumeRunId?: string;
    replyTo?: ReplyRef;
    signal?: AbortSignal;
}, onEvent?: AgentEventSink): Promise<{ reply: string; messageId: string; artifacts: ArtifactDescriptor[] }> {
    const {
        message, channel, imageBase64, file, conversationId,
        thinking = false, search = false, provider, model, embeddingModel,
        genParams = {}, agent = false, replyTo, signal,
    } = params;

    const profile = await getDefaultProfile();

    if (channel !== "web") {
        const trimmed = message.trim();
        if (/^[/!]embed-model(?:@\S+)?(?:\s|$)/i.test(trimmed)) {
            return { reply: await handleEmbedModelCommand(message, channel, profile), messageId: "", artifacts: [] };
        }
        if (/^[/!]model(?:@\S+)?(?:\s|$)/i.test(trimmed)) {
            return { reply: await handleModelCommand(message, channel, profile), messageId: "", artifacts: [] };
        }
    }

    // Slash commands expand into a full prompt; history keeps the raw command.
    const slash = channel === "web" ? expandSlashCommand(message) : null;
    // A reply quote is prepended for the model only; history keeps the raw
    // message plus metadata.replyTo so the UI can render the quote.
    const quotePrefix = replyTo
        ? `[Replying to this earlier ${replyTo.role === "user" ? "user" : "assistant"} message:]\n> ${replyTo.content.slice(0, 600).replace(/\n/g, "\n> ")}\n\n`
        : "";
    const effectiveMessage = quotePrefix + (slash?.prompt ?? message);

    let userMsgId = "";
    try {
        userMsgId = await saveMessage({
            role: "user",
            content: message,
            channel,
            userProfileId: profile?.id,
            conversationId,
            metadata: replyTo ? { replyTo } : undefined,
        });
    } catch (err) {
        console.error("[RAG] Failed to save user message:", err);
    }

    const rag = await buildRagContext({
        message: effectiveMessage, channel, conversationId, provider, model,
        embeddingModel, thinking, search, profile,
        hasAudioAttachment: !!file && file.mimeType.startsWith("audio/"),
    });

    const artifacts: ArtifactDescriptor[] = [];

    const hasVisualAttachment = !!imageBase64 || (!!file && !isTextLikeAttachment(file.mimeType, file.name));
    let mode: "chat" | "agent" = "chat";
    if (agent || slash?.agent) mode = "agent";
    else if (!slash && channel === "web" && !hasVisualAttachment) mode = (await classifyIntent(message, rag.lastAssistantMessage)).mode;
    if (mode === "agent" && hasVisualAttachment) mode = "chat";

    let reply: string;
    try {
        if (mode === "agent") {
            const agentMessage = file && isTextLikeAttachment(file.mimeType, file.name)
                ? `${effectiveMessage}\n\n${formatTextAttachment(file)}`
                : effectiveMessage;
            onEvent?.({ type: "status", message: "Understanding your request…" });
            const resumePrefix = params.resumeRunId ? await buildResumePrefix(params.resumeRunId) : undefined;
            const res = await runAgent({
                rag, message: agentMessage, conversationId, userProfileId: profile?.id, onEvent, resumePrefix, signal,
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
                    contextBlock: rag.contextBlock, message: effectiveMessage, imageBase64, file, channel,
                    thinking: rag.allowThinking, search: rag.allowSearch,
                    model: rag.chat.model.id, embRef: rag.embRef, genParams, ctx: toolCtx, signal,
                });
            } else {
                reply = await openaiCompatChat({
                    provider: rag.chat.provider,
                    model: rag.chat.model,
                    systemText: rag.contextBlock.trim(),
                    userText: effectiveMessage,
                    imageBase64,
                    file,
                    embRef: rag.embRef,
                    thinking: rag.allowThinking,
                    search: rag.allowSearch,
                    genParams,
                    ctx: toolCtx,
                    signal,
                });
            }
        }
    } catch (err) {
        // Full drop on cancel: remove the just-saved user message and save no
        // reply, so a mistaken send leaves no trace. Re-throw so the route
        // stays silent (the client already disconnected).
        if (signal?.aborted) {
            if (userMsgId) await deleteMessage(userMsgId).catch(() => { });
            throw err;
        }
        throw err;
    }

    if (signal?.aborted) {
        if (userMsgId) await deleteMessage(userMsgId).catch(() => { });
        throw new DOMException("Chat request cancelled.", "AbortError");
    }

    reply += await dailyNotesReminder(userMsgId || undefined);

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

    // Post-turn fact extraction, off the reply path. after() defers past the
    // response; the Discord bot calls ragChat outside a request scope, where
    // after() throws — fall back to plain fire-and-forget there.
    const extraction = () => extractMemories({
        userMessage: message,
        assistantReply: reply,
        channel,
        userProfileId: profile?.id,
        projectId: rag.projectId,
        conversationId,
    });
    try {
        after(extraction);
    } catch {
        void extraction();
    }

    if (conversationId) {
        try {
            const convo = await getConversation(conversationId);
            if (!convo?.title || convo.title === "New Chat") {
                const title = await generateConversationTitle(message, reply);
                await updateConversationTitle(conversationId, title);
            }
        } catch { }
    }

    return { reply, messageId: userMsgId, artifacts };
}

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
    signal?: AbortSignal;
}): Promise<string> {
    const { contextBlock, message, imageBase64, file, channel, thinking, search, model, embRef, genParams, ctx, signal } = opts;

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
        if (isTextLikeAttachment(file.mimeType, file.name)) {
            parts.push({ text: formatTextAttachment(file) });
        } else {
            parts.push({ inlineData: { mimeType: file.mimeType, data: file.base64 } });
        }
    }

    const toolDeclarations = buildGeminiFunctionDeclarations();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contents: any[] = [{ role: "user", parts }];

    // abortSignal rides in the shared base so every generateContent config
    // below (mcp/grounding/maps/wrap) is cancellable in one place.
    const thinkingOpts = {
        thinkingConfig: { thinkingLevel: thinking ? ThinkingLevel.HIGH : ThinkingLevel.LOW },
        ...(signal ? { abortSignal: signal } : {}),
    };
    const mcpConfig = { tools: [{ functionDeclarations: toolDeclarations }], ...thinkingOpts, ...genConfig };
    const groundingConfig = { tools: [{ googleSearch: {} }, { urlContext: {} }], ...thinkingOpts, ...genConfig };
    const mapsConfig = { tools: [{ googleMaps: {} }], ...thinkingOpts, ...genConfig };

    const isLocationQuery = (q: string) => {
        const loc = /\b(near me|nearby|restaurant|cafe|coffee|hotel|hospital|pharmacy|cinema|gym|airport|station|directions?|map|address|open now|hours|rating|review|how far|distance|km|miles?|street|suburb|postcode|zip code|where is|located|location)\b/i;
        return loc.test(q);
    };

    if (search) {
        const response = await ai.models.generateContent({ model, contents, config: groundingConfig });
        return channel === "telegram" ? (response.text ?? "") : addCitations(response);
    }

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

    // Same guard as the agent loop (gemini-loop.ts): if the tool budget runs
    // out with calls still pending, response.text is empty or mid-work
    // narration. Answer the calls with a stop notice and force one final
    // tool-free turn.
    if (response.functionCalls && response.functionCalls.length > 0) {
        contents.push(response.candidates![0].content);
        contents.push({
            role: "user",
            parts: response.functionCalls.map((fc) => ({
                functionResponse: {
                    name: fc.name!,
                    response: { result: "Tool budget for this reply is exhausted. Stop working. Tell the user exactly what you completed and what remains, and suggest they say 'continue' to finish the rest." },
                    id: (fc as any).id, // eslint-disable-line @typescript-eslint/no-explicit-any
                },
            })),
        });
        const wrapConfig = { ...thinkingOpts, ...genConfig };
        response = await ai.models.generateContent({ model, contents, config: wrapConfig });
    }

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
}): Promise<string> {
    const embRef = getEmbeddingRef();
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
