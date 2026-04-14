import { convert } from "telegram-markdown-v2";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Convert standard markdown to Telegram MarkdownV2 format
function toTelegramMarkdown(text: string): string {
    try {
        return convert(text);
    } catch {
        console.warn("[Telegram] MarkdownV2 conversion failed, escaping as plain text.");
        return escapeTelegramPlain(text);
    }
}

// Escape special chars for MarkdownV2 plain-text fallback
function escapeTelegramPlain(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

export async function sendTelegramMessage(
    chatId: string | number,
    text: string
): Promise<boolean> {
    if (!TELEGRAM_BOT_TOKEN) {
        console.warn("[Telegram] TELEGRAM_BOT_TOKEN not set, cannot send.");
        return false;
    }

    const formatted = toTelegramMarkdown(text);
    const chunks = formatted.length > 4096 ? splitMessage(formatted, 4096) : [formatted];

    try {
        for (const chunk of chunks) {
            // Try sending with MarkdownV2 first
            let res = await fetch(`${TELEGRAM_API}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: chunk,
                    parse_mode: "MarkdownV2",
                }),
            });

            // Fallback to plain text if MarkdownV2 is rejected
            if (!res.ok) {
                console.warn("[Telegram] MarkdownV2 rejected, falling back to plain text.");
                res = await fetch(`${TELEGRAM_API}/sendMessage`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: text.length > 4096 ? text.substring(0, 4096) : text,
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
