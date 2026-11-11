import { timingSafeEqual } from "node:crypto";

// Anyone on Telegram can message the bot, and every turn runs as the owner, so
// only the owner's chat (the one notifications go to) may start one.
export function allowedTelegramChats(env: Record<string, string | undefined> = process.env): Set<string> {
    return new Set([env.TELEGRAM_CHAT_ID, ...(env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",")]
        .map((id) => id?.trim() ?? "")
        .filter((id) => /^-?\d+$/.test(id)));
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
