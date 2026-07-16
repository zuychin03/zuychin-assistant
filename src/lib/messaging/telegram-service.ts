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

export async function sendTelegramMessage(
    chatId: string | number,
    text: string,
    options?: { replyMarkup?: unknown }
): Promise<boolean> {
    if (!TELEGRAM_BOT_TOKEN) {
        console.warn("[Telegram] TELEGRAM_BOT_TOKEN not set, cannot send.");
        return false;
    }

    const formatted = toTelegramMarkdown(text);
    const chunks = formatted.length > 4096 ? splitMessage(formatted, 4096) : [formatted];

    try {
        for (const [i, chunk] of chunks.entries()) {
            // Inline keyboards belong on the final chunk only.
            const markup = i === chunks.length - 1 && options?.replyMarkup
                ? { reply_markup: options.replyMarkup }
                : {};

            let res = await fetch(`${TELEGRAM_API}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: chunk,
                    parse_mode: "MarkdownV2",
                    ...markup,
                }),
            });

            if (!res.ok) {
                console.warn("[Telegram] MarkdownV2 rejected, falling back to plain text.");
                res = await fetch(`${TELEGRAM_API}/sendMessage`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: text.length > 4096 ? text.substring(0, 4096) : text,
                        ...markup,
                    }),
                });
            }

            if (!res.ok) {
                const err = await res.text();
                console.error("[Telegram] sendMessage failed:", res.status, err);
                return false;
            }
        }

        return true;
    } catch (error) {
        console.error("[Telegram] sendMessage error:", error);
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
    doc: { filename: string; mimeType: string; body: Buffer | string; caption?: string }
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

        const res = await fetch(`${TELEGRAM_API}/sendDocument`, { method: "POST", body: form });
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
