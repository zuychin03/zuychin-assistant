import { NextRequest, NextResponse } from "next/server";
import { ragChat } from "@/lib/ai/rag-service";
import { sendTelegramMessage, sendTelegramChatAction, downloadTelegramFile } from "@/lib/messaging/telegram-service";
import type { FileAttachment } from "@/lib/types";

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

// Vercel Pro: up to 60s
export const maxDuration = 60;

// Telegram file_id -> mime type mapping
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

// POST /api/telegram/webhook — receives updates from Telegram
export async function POST(req: NextRequest) {
    // Validate webhook secret
    const secretHeader = req.headers.get("x-telegram-bot-api-secret-token");
    if (WEBHOOK_SECRET && secretHeader !== WEBHOOK_SECRET) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const update = await req.json();
        const message = update.message;
        if (!message) {
            return NextResponse.json({ ok: true });
        }

        const chatId = message.chat.id;
        let text = message.text?.trim() || message.caption?.trim() || "";

        // /search and /think command prefixes
        // Telegram may append bot username: /search@botname query
        let useSearch = false;
        let useThinking = false;
        const commandMatch = text.match(/^\/(search|think)(?:@\S+)?\s*([\s\S]*)/);
        if (commandMatch) {
            if (commandMatch[1] === "search") useSearch = true;
            if (commandMatch[1] === "think") useThinking = true;
            text = commandMatch[2].trim();
        }

        // Politely decline voice/audio messages (not supported)
        if (message.voice || message.audio) {
            await sendTelegramMessage(chatId, "🎙️ Voice messages aren't supported yet. Please type your message instead!");
            return NextResponse.json({ ok: true });
        }

        // Skip empty messages without attachments
        const photo = message.photo;
        const document = message.document;
        const video = message.video;
        const hasAttachment = photo || document || video;

        if (!text && !hasAttachment) {
            return NextResponse.json({ ok: true });
        }

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
                    // Photos come as array of sizes, pick the largest
                    const largest = photo[photo.length - 1];
                    fileId = largest.file_id;
                    fileName = "photo.jpg";
                    fileSize = largest.file_size || 0;
                } else if (document) {
                    fileId = document.file_id;
                    fileName = document.file_name || "document";
                    fileSize = document.file_size || 0;
                } else if (video) {
                    fileId = video.file_id;
                    fileName = video.file_name || "video.mp4";
                    fileSize = video.file_size || 0;
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

        // Send reply
        const replyText = reply || "No response.";
        await sendTelegramMessage(chatId, replyText);

        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error("[Telegram Webhook] Error:", error);
        return NextResponse.json({ ok: true }); // Always return 200 to prevent Telegram retries
    }
}
