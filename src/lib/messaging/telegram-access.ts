import { timingSafeEqual } from "node:crypto";

// Anyone on Telegram can message the bot, and every turn runs as the owner, so
// only the owner's chat (the one notifications go to) may start one.
export function allowedTelegramChats(env: Record<string, string | undefined> = process.env): Set<string> {
    return new Set([env.TELEGRAM_CHAT_ID, ...(env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",")]
        .map((id) => id?.trim() ?? "")
        .filter((id) => /^-?\d+$/.test(id)));
}

// A private chat's id is its user's id, so positive allowlisted chats name their owner.
// Groups need TELEGRAM_OWNER_USER_IDS, or every member could act as the owner.
export function allowedTelegramSenders(env: Record<string, string | undefined> = process.env): Set<string> {
    const owners = [...allowedTelegramChats(env)].filter((id) => !id.startsWith("-"));
    const extra = (env.TELEGRAM_OWNER_USER_IDS ?? "").split(",").map((id) => id.trim()).filter((id) => /^\d+$/.test(id));
    return new Set([...owners, ...extra]);
}

// channel_post carries no sender; only a channel's admins can post, so the chat check covers it.
export function telegramSenderAllowed(update: Record<string, unknown>, senders: Set<string>): boolean {
    if (update.callback_query) return senders.has(senderId(update.callback_query));
    if (update.message) return senders.has(senderId(update.message));
    return update.channel_post !== undefined;
}

function senderId(source: unknown): string {
    const id = (source as { from?: { id?: unknown } } | undefined)?.from?.id;
    return typeof id === "number" || typeof id === "string" ? String(id) : "";
}

export function updateChatId(update: Record<string, unknown>): string | null {
    const callback = update.callback_query as { message?: { chat?: { id?: unknown } } } | undefined;
    const message = (update.message ?? update.channel_post) as { chat?: { id?: unknown } } | undefined;
    const id = callback ? callback.message?.chat?.id : message?.chat?.id;
    return typeof id === "number" || typeof id === "string" ? String(id) : null;
}

export function telegramSecretMatches(provided: string | null, expected: string): boolean {
    if (provided === null) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}
