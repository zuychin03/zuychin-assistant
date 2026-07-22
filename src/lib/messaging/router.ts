// Single dispatch authority for outbound notifications. Every cron / task /
// agent posts through notify(type, text); the ROUTES table below is the only
// place that decides destination channel and whether to mirror to web-push,
// so a single logical event never fans out to Discord + Telegram + push at once.

import { sendDiscordMessage } from "./discord-service";
import { sendTelegramMessage } from "./telegram-service";
import { broadcastPush } from "./push-service";
import { discordChannel, type DiscordPurpose } from "./channels";

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
    | "run_review";

interface Route {
    discord?: DiscordPurpose;
    // Opt-in channels set this false so they stay silent until configured.
    discordFallback?: boolean;
    telegram?: boolean;
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
    initiative_nudge: { telegram: true, push: true },
    proactive_checkin: { telegram: true },
    run_review: { discord: "system", discordFallback: false },
};

export interface NotifyOptions {
    // Overrides the resolved Discord channel (e.g. a scheduled task's own target).
    discordChannelId?: string;
    telegramReplyMarkup?: unknown;
    pushTitle?: string;
    pushBody?: string;
    pushUrl?: string;
    // Suppress the push mirror for this send even if the route enables it.
    noPush?: boolean;
}

export interface NotifyResult {
    discord: boolean;
    telegram: boolean;
    push: number;
}

export async function notify(
    type: NotificationType,
    text: string,
    options: NotifyOptions = {},
): Promise<NotifyResult> {
    const route = ROUTES[type];
    const result: NotifyResult = { discord: false, telegram: false, push: 0 };
    const sends: Promise<void>[] = [];

    if (route.discord) {
        const channelId = options.discordChannelId
            ?? discordChannel(route.discord, route.discordFallback !== false);
        if (channelId) {
            sends.push(sendDiscordMessage(channelId, text).then((ok) => { result.discord = ok; }));
        }
    }

    if (route.telegram && TELEGRAM_CHAT_ID) {
        const opts = options.telegramReplyMarkup ? { replyMarkup: options.telegramReplyMarkup } : undefined;
        sends.push(sendTelegramMessage(TELEGRAM_CHAT_ID, text, opts).then((ok) => { result.telegram = ok; }));
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
    return result;
}
