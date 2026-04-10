import { NextRequest, NextResponse } from "next/server";
import { ragChat } from "@/lib/ai/rag-service";
import { sendTelegramMessage, sendTelegramChatAction, downloadTelegramFile } from "@/lib/messaging/telegram-service";
import type { FileAttachment } from "@/lib/types";

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

// Vercel Pro: up to 60s
export const maxDuration = 60;

// File extension to MIME type mapping
const MIME_MAP: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    pdf: "application/pdf",
    mp4: "video/mp4",
    csv: "text/csv",
    txt: "text/plain",
    json: "application/json",
};

function getMimeType(filePath: string): string {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    return MIME_MAP[ext] || "application/octet-stream";
}

async function processUpdate(update: Record<string, unknown>) {
    const message = update.message as Record<string, unknown> | undefined;
    if (!message) return;

    const chatId = (message.chat as Record<string, unknown>).id as number;
    let text = ((message.text as string | undefined)?.trim() ?? (message.caption as string | undefined)?.trim() ?? "");

    // Command prefixes: /search, /think
    let useSearch = false;
    let useThinking = false;
    const commandMatch = text.match(/^\/(?:search|think)(?:@\S+)?\s*([\s\S]*)/);
    if (commandMatch) {
        const cmd = text.split(/\s|@/)[0].slice(1);
        if (cmd === "search") useSearch = true;
        if (cmd === "think") useThinking = true;
        text = commandMatch[1].trim();
    }

    // Decline voice/audio (unsupported)
    if (message.voice || message.audio) {
        await sendTelegramMessage(chatId, "🎙️ Voice messages aren't supported yet. Please type your message instead!");
        return;
    }

    // Skip empty messages without attachments
    const photo = message.photo as unknown[] | undefined;
    const document = message.document as Record<string, unknown> | undefined;
    const video = message.video as Record<string, unknown> | undefined;
    const hasAttachment = photo || document || video;

    if (!text && !hasAttachment) return;

    console.log(`[Telegram] Chat ${chatId}: ${text.substring(0, 50)}${hasAttachment ? " [+attachment]" : ""}`);

    // Send typing indicator
    await sendTelegramChatAction(chatId);

    // Download attachment if present
    let file: FileAttachment | undefined;
    if (hasAttachment) {
        try {
            let fileId: string | undefined;
            let fileName = "attachment";
            let fileSize = 0;

            if (photo) {
                const largest = photo[photo.length - 1] as Record<string, unknown>;
                fileId = largest.file_id as string;
                fileName = "photo.jpg";
                fileSize = (largest.file_size as number) || 0;
            } else if (document) {
                fileId = document.file_id as string;
                fileName = (document.file_name as string) || "document";
                fileSize = (document.file_size as number) || 0;
            } else if (video) {
                fileId = video.file_id as string;
                fileName = (video.file_name as string) || "video.mp4";
                fileSize = (video.file_size as number) || 0;
            }

            if (fileId && fileSize <= MAX_FILE_SIZE) {
                const downloaded = await downloadTelegramFile(fileId);
                if (downloaded) {
                    const mimeType = getMimeType(downloaded.filePath);
                    file = {
                        name: fileName,
                        mimeType,
                        base64: downloaded.buffer.toString("base64"),
                        size: downloaded.buffer.length,
                    };
                    console.log(`[Telegram] Attachment: ${fileName} (${(file.size / 1024).toFixed(0)} KB, ${mimeType})`);
                }
            } else if (fileSize > MAX_FILE_SIZE) {
                console.warn(`[Telegram] File too large: ${(fileSize / 1024 / 1024).toFixed(1)} MB`);
            }
        } catch (dlErr) {
            console.error("[Telegram] Failed to download attachment:", dlErr);
        }
    }

    // Call the RAG pipeline
    const { reply } = await ragChat({
        message: text || (file ? `[Sent ${file.name}]` : ""),
        channel: "telegram",
        file,
        thinking: useThinking,
        search: useSearch,
    });

    await sendTelegramMessage(chatId, reply || "No response.");
}

// POST /api/telegram/webhook
export async function POST(req: NextRequest) {
    const secretHeader = req.headers.get("x-telegram-bot-api-secret-token");
    if (WEBHOOK_SECRET && secretHeader !== WEBHOOK_SECRET) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let update: Record<string, unknown>;
    try {
        update = await req.json();
    } catch {
        return NextResponse.json({ ok: true });
    }

    // Respond immediately to prevent Telegram from retrying (which causes duplicate responses)
    const response = NextResponse.json({ ok: true });

    // Process in background after response is sent
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (req as any)[Symbol.for("next.request.context")]?.waitUntil;
    if (typeof ctx === "function") {
        ctx(processUpdate(update).catch((err: unknown) => console.error("[Telegram Webhook] Error:", err)));
    } else {
        // Fallback: fire-and-forget
        processUpdate(update).catch((err) => console.error("[Telegram Webhook] Error:", err));
    }

    return response;
}
