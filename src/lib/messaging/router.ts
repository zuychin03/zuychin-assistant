// Single dispatch authority for outbound notifications. Every cron / task /
// agent posts through notify(type, text); the ROUTES table below is the only
// place that decides destination channel and whether to mirror to web-push,
// so a single logical event never fans out to Discord + Telegram + push at once.

import { sendDiscordMessage } from "./discord-service";
import { sendTelegramMessageWithId } from "./telegram-service";
import { broadcastPush } from "./push-service";
import { discordChannel, type DiscordPurpose } from "./channels";
import { recordChannelMessage } from "./channel-threads";

const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export type NotificationType =
    | "daily_briefing"
    | "event_reminder"
    | "todo_due"
    | "email_obligation"
    | "calendar_event"
    | "scheduled_task"
    | "agent_run_complete"
    | "initiative_nudge"
    | "proactive_checkin"
    | "run_review"
    | "model_catalogue"
    | "provider_key"
    | "council_convened"
    | "council_conclusion"
    | "council_stalled"
    | "action_approval";

interface Route {
    discord?: DiscordPurpose;
    // Opt-in channels set this false so they stay silent until configured.
    discordFallback?: boolean;
    // Discord only when Telegram is not configured, so one event never reaches both.
    discordWithoutTelegram?: DiscordPurpose;
    telegram?: boolean;
    // Saved into the Telegram chat's conversation, so a reply to it has context.
    conversation?: boolean;
    push?: boolean;
}

// Splitting rule: scheduled/structured/logged -> Discord; spontaneous/urgent
// -> Telegram; push only mirrors the time-sensitive types.
const ROUTES: Record<NotificationType, Route> = {
    daily_briefing: { discord: "briefing" },
    event_reminder: { discord: "reminders", push: true },
    todo_due: { discord: "tasks" },
    email_obligation: { discord: "bills", push: true },
    calendar_event: { discord: "calendar" },
    scheduled_task: { discord: "tasks" },
    agent_run_complete: { discord: "coworking" },
    initiative_nudge: { telegram: true, conversation: true, push: true },
    proactive_checkin: { telegram: true, conversation: true },
    run_review: { discord: "system", discordFallback: false },
    model_catalogue: { discord: "system", discordFallback: false },
    // A key change is a security event, so it falls back to the default channel when no system channel is set.
    provider_key: { discord: "system" },
    // Milestones only, never per turn: sendDiscordMessage chunks over 2000 chars
    // into sequential POSTs and aborts the rest on the first non-ok.
    council_convened: { discord: "coworking" },
    council_conclusion: { discord: "coworking" },
    council_stalled: { discord: "coworking" },
    action_approval: { telegram: true, discordWithoutTelegram: "tasks" },
};

export interface NotifyOptions {
    signal?: AbortSignal;
    // Overrides the resolved Discord channel (e.g. a scheduled task's own target).
    discordChannelId?: string;
    telegramReplyMarkup?: unknown;
    // Sends the text as is, for content that must not be read as Markdown.
    telegramPlain?: boolean;
    pushTitle?: string;
    pushBody?: string;
    pushUrl?: string;
    // Suppress the push mirror for this send even if the route enables it.
    noPush?: boolean;
}

export interface NotifyResult {
    discord: boolean;
    telegram: boolean;
    telegramMessageId: number | null;
    push: number;
}

export async function notify(
    type: NotificationType,
    text: string,
    options: NotifyOptions = {},
): Promise<NotifyResult> {
    const route = ROUTES[type];
    const result: NotifyResult = { discord: false, telegram: false, telegramMessageId: null, push: 0 };
    const sends: Promise<void>[] = [];

    const discordPurpose = route.discord ?? (TELEGRAM_CHAT_ID ? undefined : route.discordWithoutTelegram);
    if (discordPurpose) {
        const channelId = options.discordChannelId
            ?? discordChannel(discordPurpose, route.discordFallback !== false);
        if (channelId) {
            sends.push(sendDiscordMessage(channelId, text, options.signal).then((ok) => { result.discord = ok; }));
        }
    }

    if (route.telegram && TELEGRAM_CHAT_ID) {
        const opts = { replyMarkup: options.telegramReplyMarkup, signal: options.signal, plain: options.telegramPlain };
        sends.push(sendTelegramMessageWithId(TELEGRAM_CHAT_ID, text, opts).then((id) => { result.telegram = id !== null; result.telegramMessageId = id; }));
    }

    if (route.push && !options.noPush) {
        sends.push(
            broadcastPush({
                title: options.pushTitle ?? "Zuychin",
                // Push bodies are plain text; strip markdown emphasis.
                body: options.pushBody ?? text.replace(/\*\*/g, ""),
                url: options.pushUrl,
            }).then((n) => { result.push = n; }),
        );
    }

    await Promise.all(sends);
    if (result.telegram && route.conversation && TELEGRAM_CHAT_ID) {
        await recordChannelMessage({ channel: "telegram", chatKey: TELEGRAM_CHAT_ID, content: text, metadata: { source: type } });
    }
    return result;
}
