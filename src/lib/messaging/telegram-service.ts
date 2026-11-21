import { convert } from "telegram-markdown-v2";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

function toTelegramMarkdown(text: string): string {
    try {
        return convert(text);
    } catch {
        console.warn("[Telegram] MarkdownV2 conversion failed, escaping as plain text.");
        return escapeTelegramPlain(text);
    }
}

function escapeTelegramPlain(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

const MAX_TEXT = 4096;
// MarkdownV2 escaping lengthens text, so plain chunks leave room for it.
const PLAIN_CHUNK = 3500;

type SendOptions = { replyMarkup?: unknown; signal?: AbortSignal; allowFormattingFallback?: boolean; plain?: boolean };

// Split the plain text, not the converted text: a rejected chunk then falls back
// to its own words, and no split lands inside a MarkdownV2 escape.
export function telegramChunks(text: string): { plain: string; formatted: string }[] {
    const chunks: { plain: string; formatted: string }[] = [];
    const pending = text.length > PLAIN_CHUNK ? splitMessage(text, PLAIN_CHUNK) : [text];
    while (pending.length > 0) {
        const plain = pending.shift()!;
        const formatted = toTelegramMarkdown(plain);
        if (formatted.length <= MAX_TEXT || plain.length < 2) chunks.push({ plain, formatted });
        else pending.unshift(...splitMessage(plain, Math.ceil(plain.length / 2)));
    }
    return chunks;
}

async function sendChunks(chatId: string | number, text: string, options?: SendOptions): Promise<{ ok: boolean; messageId: number | null }> {
    if (!TELEGRAM_BOT_TOKEN) {
        console.warn("[Telegram] TELEGRAM_BOT_TOKEN not set, cannot send.");
        return { ok: false, messageId: null };
    }

    const chunks = telegramChunks(text);
    let messageId: number | null = null;
    try {
        for (const [i, chunk] of chunks.entries()) {
            options?.signal?.throwIfAborted();
            // Inline keyboards belong on the final chunk only.
            const markup = i === chunks.length - 1 && options?.replyMarkup
                ? { reply_markup: options.replyMarkup }
                : {};

            let res = await postSendMessage(options?.plain
                ? { chat_id: chatId, text: chunk.plain.slice(0, MAX_TEXT), ...markup }
                : { chat_id: chatId, text: chunk.formatted, parse_mode: "MarkdownV2", ...markup }, options?.signal);
            if (!res.ok && !options?.plain && options?.allowFormattingFallback !== false) {
                console.warn("[Telegram] MarkdownV2 rejected, falling back to plain text.");
                res = await postSendMessage({ chat_id: chatId, text: chunk.plain.slice(0, MAX_TEXT), ...markup }, options?.signal);
            }

            if (!res.ok) {
                const err = await res.text();
                console.error("[Telegram] sendMessage failed:", res.status, err);
                return { ok: false, messageId };
            }
            messageId = await sentMessageId(res);
        }
        return { ok: true, messageId };
    } catch (error) {
        console.error("[Telegram] sendMessage error:", error);
        return { ok: false, messageId };
    }
}

function postSendMessage(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    return fetch(`${TELEGRAM_API}/sendMessage`, {
        signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

async function sentMessageId(res: Response): Promise<number | null> {
    const body = await res.json().catch(() => null) as { result?: { message_id?: unknown } } | null;
    return typeof body?.result?.message_id === "number" ? body.result.message_id : null;
}

export async function sendTelegramMessage(chatId: string | number, text: string, options?: SendOptions): Promise<boolean> {
    return (await sendChunks(chatId, text, options)).ok;
}

/** The last chunk's message_id, for later edits; null when the send failed. */
export async function sendTelegramMessageWithId(chatId: string | number, text: string, options?: SendOptions): Promise<number | null> {
    const sent = await sendChunks(chatId, text, options);
    return sent.ok ? sent.messageId : null;
}

/** Plain text, so receipts and names need no MarkdownV2 escaping. Omitting replyMarkup strips the keyboard. */
export async function editTelegramMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    replyMarkup?: unknown
): Promise<boolean> {
    if (!TELEGRAM_BOT_TOKEN) return false;
    try {
        const res = await fetch(`${TELEGRAM_API}/editMessageText`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId,
                text: text.slice(0, MAX_TEXT),
                ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            }),
        });
        if (!res.ok) console.warn("[Telegram] editMessageText failed:", res.status, await res.text());
        return res.ok;
    } catch (error) {
        console.warn("[Telegram] editMessageText error:", error);
        return false;
    }
}

export async function answerTelegramCallbackQuery(
    callbackQueryId: string,
    text?: string
): Promise<void> {
    if (!TELEGRAM_BOT_TOKEN) return;

    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
    }).catch(() => { });
}

/** Omitting replyMarkup strips the message's inline keyboard. */
export async function editTelegramMessageReplyMarkup(
    chatId: string | number,
    messageId: number,
    replyMarkup?: unknown
): Promise<void> {
    if (!TELEGRAM_BOT_TOKEN) return;

    await fetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
    }).catch(() => { });
}

export async function sendTelegramDocument(
    chatId: string | number,
    doc: { filename: string; mimeType: string; body: Buffer | string; caption?: string },
    signal?: AbortSignal
): Promise<boolean> {
    if (!TELEGRAM_BOT_TOKEN) {
        console.warn("[Telegram] TELEGRAM_BOT_TOKEN not set, cannot send document.");
        return false;
    }

    try {
        const bytes = typeof doc.body === "string" ? Buffer.from(doc.body, "utf-8") : doc.body;
        const form = new FormData();
        form.append("chat_id", String(chatId));
        if (doc.caption) form.append("caption", doc.caption.slice(0, 1024));

        const blob = new Blob([new Uint8Array(bytes)], { type: doc.mimeType || "application/octet-stream" });
        form.append("document", blob, doc.filename);

        signal?.throwIfAborted();
        const res = await fetch(`${TELEGRAM_API}/sendDocument`, { method: "POST", body: form, signal });
        if (!res.ok) {
            const err = await res.text();
            console.error("[Telegram] sendDocument failed:", res.status, err);
            return false;
        }
        return true;
    } catch (error) {
        console.error("[Telegram] sendDocument error:", error);
        return false;
    }
}

export async function sendTelegramChatAction(
    chatId: string | number,
    action: string = "typing"
): Promise<void> {
    if (!TELEGRAM_BOT_TOKEN) return;

    await fetch(`${TELEGRAM_API}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action }),
    }).catch(() => {});
}

/** Fills the bot's command menu. Telegram keeps the list, so once per server start is enough. */
export async function setTelegramCommands(commands: { command: string; description: string }[]): Promise<boolean> {
    if (!TELEGRAM_BOT_TOKEN) return false;
    try {
        const res = await fetch(`${TELEGRAM_API}/setMyCommands`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ commands }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) console.warn(`[Telegram] setMyCommands returned ${res.status}.`);
        return res.ok;
    } catch (error) {
        console.warn("[Telegram] setMyCommands failed:", error instanceof Error ? error.message : error);
        return false;
    }
}

export async function downloadTelegramFile(fileId: string): Promise<{
    buffer: Buffer;
    filePath: string;
} | null> {
    if (!TELEGRAM_BOT_TOKEN) return null;

    try {
        const fileRes = await fetch(`${TELEGRAM_API}/getFile`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file_id: fileId }),
        });

        if (!fileRes.ok) return null;

        const fileData = await fileRes.json();
        const filePath: string = fileData.result?.file_path;
        if (!filePath) return null;

        const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
        const downloadRes = await fetch(downloadUrl);
        if (!downloadRes.ok) return null;

        const arrayBuf = await downloadRes.arrayBuffer();
        return { buffer: Buffer.from(arrayBuf), filePath };
    } catch (error) {
        console.error("[Telegram] File download failed:", error);
        return null;
    }
}

function splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLength) {
        let splitIdx = remaining.lastIndexOf("\n", maxLength);
        if (splitIdx < maxLength / 2) splitIdx = remaining.lastIndexOf(" ", maxLength);
        if (splitIdx < maxLength / 2) splitIdx = maxLength;

        chunks.push(remaining.substring(0, splitIdx));
        remaining = remaining.substring(splitIdx).trimStart();
    }

    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
}
