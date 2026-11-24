import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";
import { getDefaultProfile, saveMessage } from "@/lib/db";
import type { MessageMetadata } from "@/lib/types";

export type ThreadChannel = "telegram" | "discord";

const DEFAULT_GAP_MINUTES = 6 * 60;
const MISSING = new Set(["PGRST202", "PGRST205", "42P01", "42883"]);
let warnedMissing = false;

/** CHANNEL_QUIET_GAP_MINUTES exists for live testing; the gap is 6 hours otherwise. */
export function quietGapSeconds(env: Record<string, string | undefined> = process.env): number {
    const minutes = Number(env.CHANNEL_QUIET_GAP_MINUTES);
    return Math.round((Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULT_GAP_MINUTES) * 60);
}

/**
 * The chat's current conversation, or a new one when forced or after the quiet gap.
 * Null when the thread table is missing or unreachable: callers then take the legacy path,
 * where a channel's history has no conversation.
 */
export async function resolveChannelConversation(
    params: { channel: ThreadChannel; chatKey: string; profileId: string | null | undefined; forceNew?: boolean },
    client: SupabaseClient = supabaseAdmin,
): Promise<string | null> {
    const { data, error } = await client.rpc("assistant_channel_thread", {
        p_channel: params.channel,
        p_chat_key: params.chatKey,
        p_profile: params.profileId ?? null,
        p_gap_seconds: quietGapSeconds(),
        p_force_new: params.forceNew === true,
    });
    if (error) {
        if (!MISSING.has((error as { code?: string }).code ?? "")) console.warn(`[${params.channel}] Conversation lookup failed:`, error.message);
        else if (!warnedMissing) {
            warnedMissing = true;
            console.warn(`[${params.channel}] assistant_channel_thread is missing; apply scripts/migrations/v7-channel-threads.sql. Chats keep one shared history.`);
        }
        return null;
    }
    return typeof data === "string" ? data : null;
}

export type ChannelTurn =
    | { kind: "help" }
    | { kind: "started"; conversationId: string | null }
    | { kind: "message"; message: string; conversationId: string | null };

type TurnDeps = {
    resolve?: typeof resolveChannelConversation;
    profile?: () => Promise<{ id: string } | null>;
};

const NEW_COMMAND = /^[/!](?:new|start)(?:@\S+)?(?=\s|$)\s*([\s\S]*)$/i;
const HELP_COMMAND = /^[/!]help(?:@\S+)?$/i;

/** Handles /new and /help for a chat channel and finds the conversation the message belongs to. */
export async function channelTurn(channel: ThreadChannel, chatKey: string, message: string, deps: TurnDeps = {}): Promise<ChannelTurn> {
    const trimmed = message.trim();
    if (HELP_COMMAND.test(trimmed)) return { kind: "help" };
    const fresh = NEW_COMMAND.exec(trimmed);
    const profile = await (deps.profile ?? getDefaultProfile)();
    const conversationId = await (deps.resolve ?? resolveChannelConversation)({ channel, chatKey, profileId: profile?.id, forceNew: fresh !== null });
    if (fresh && !fresh[1].trim()) return { kind: "started", conversationId };
    return { kind: "message", message: fresh ? fresh[1].trim() : message, conversationId };
}

export const CHANNEL_COMMANDS: { command: string; argument?: string; description: string }[] = [
    { command: "new", description: "Start a new conversation" },
    { command: "search", argument: "question", description: "Answer with a web search" },
    { command: "think", argument: "question", description: "Think it through first" },
    { command: "agent", argument: "task", description: "Work through it step by step" },
    { command: "model", description: "Show or change the model for this chat" },
    { command: "brief", description: "Spoken briefing of today; add study for a Study recap" },
    { command: "translate", argument: "language", description: "Translate the text after the language, or the message you reply to" },
    { command: "help", description: "Show this list" },
];

export function channelHelpText(env: Record<string, string | undefined> = process.env): string {
    const minutes = quietGapSeconds(env) / 60;
    const gap = minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} minute${minutes === 1 ? "" : "s"}`;
    return [
        ...CHANNEL_COMMANDS.map((c) => `/${c.command}${c.argument ? ` <${c.argument}>` : ""} - ${c.description.toLowerCase()}`),
        "",
        `A new conversation also starts after ${gap} without messages.`,
    ].join("\n");
}

export const CHANNEL_STARTED_TEXT = "Started a new conversation.";

/** Saves a message the assistant sent on its own (a nudge, a task result) into the chat's conversation, so a reply has it in context. */
export async function recordChannelMessage(params: { channel: ThreadChannel; chatKey: string; content: string; metadata?: MessageMetadata }): Promise<void> {
    try {
        const profile = await getDefaultProfile();
        const conversationId = await resolveChannelConversation({ channel: params.channel, chatKey: params.chatKey, profileId: profile?.id });
        if (!conversationId) return;
        await saveMessage({
            role: "assistant", content: params.content, channel: params.channel,
            userProfileId: profile?.id, conversationId, metadata: params.metadata,
        });
    } catch (error) {
        console.warn(`[${params.channel}] Could not save the sent message into the conversation:`, error instanceof Error ? error.message : error);
    }
}
