import { NextRequest, NextResponse } from "next/server";
import { ragChat } from "@/lib/ai/rag-service";
import { sendTelegramMessage, sendTelegramChatAction, sendTelegramDocument, downloadTelegramFile, answerTelegramCallbackQuery, editTelegramMessageReplyMarkup } from "@/lib/messaging/telegram-service";
import { setInitiativeFeedback } from "@/lib/ai/initiative-store";
import { getArtifact } from "@/lib/artifacts/store";
import { getVoicePrefs, synthesizeSpeech } from "@/lib/ai/tts";
import { getDefaultProfile } from "@/lib/db";
import type { FileAttachment } from "@/lib/types";

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const MAX_FILE_SIZE = 20 * 1024 * 1024;

export const maxDuration = 60;

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
    ogg: "audio/ogg",
    oga: "audio/ogg",
    mp3: "audio/mp3",
    m4a: "audio/x-aac",
    wav: "audio/wav",
    flac: "audio/flac",
};

function getMimeType(filePath: string): string {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    return MIME_MAP[ext] || "application/octet-stream";
}

// Best-effort: the text reply is already delivered, so a TTS failure or
// timeout must never take down the turn. sendVoice/sendAudio both reject WAV;
// a document attachment still plays inline in Telegram.
async function maybeSendVoiceReply(chatId: number, reply: string, audioTurn: boolean) {
    if (!reply) return;
    try {
        const profile = await getDefaultProfile();
        const voice = getVoicePrefs(profile?.preferences);
        if (voice.replyWithVoice === "off") return;
        if (voice.replyWithVoice === "onVoiceInput" && !audioTurn) return;

        await sendTelegramChatAction(chatId, "upload_document");
        const { buffer, mimeType } = await synthesizeSpeech(reply, voice.voiceName);
        const ok = await sendTelegramDocument(chatId, {
            filename: "reply.wav",
            mimeType,
            body: buffer,
        });
        console.log(`[Telegram] Voice reply ${ok ? "sent" : "failed"}.`);
    } catch (err) {
        console.warn("[Telegram] Voice reply skipped:", err);
    }
}

// Feedback taps on initiative messages: callback_data is `ini:<uuid>:1|-1`.
// Record the vote, toast an ack, and strip the buttons so it reads as done.
async function handleCallbackQuery(cb: Record<string, unknown>) {
    const cbId = cb.id as string;
    const data = (cb.data as string | undefined) ?? "";

    const match = /^ini:([0-9a-f-]{36}):(1|-1)$/.exec(data);
    if (!match) {
        console.log(`[Telegram] Ignoring unknown callback_data: ${data.slice(0, 64)}`);
        await answerTelegramCallbackQuery(cbId);
        return;
    }

    const ok = await setInitiativeFeedback(match[1], Number(match[2]) as 1 | -1);
    await answerTelegramCallbackQuery(cbId, ok ? "Noted, thanks!" : "Couldn't record that.");

    const msg = cb.message as Record<string, unknown> | undefined;
    const chatId = (msg?.chat as Record<string, unknown> | undefined)?.id as number | undefined;
    const messageId = msg?.message_id as number | undefined;
    if (ok && chatId !== undefined && messageId !== undefined) {
        await editTelegramMessageReplyMarkup(chatId, messageId);
    }
}

async function processUpdate(update: Record<string, unknown>) {
    const callbackQuery = update.callback_query as Record<string, unknown> | undefined;
    if (callbackQuery) {
        await handleCallbackQuery(callbackQuery);
        return;
    }

    const message = (update.message ?? update.channel_post) as Record<string, unknown> | undefined;
    if (!message) {
        console.log("[Telegram] No message/channel_post in update:", JSON.stringify(update).substring(0, 200));
        return;
    }

    const chatId = (message.chat as Record<string, unknown>).id as number;
    let text = ((message.text as string | undefined)?.trim() ?? (message.caption as string | undefined)?.trim() ?? "");

    console.log(`[Telegram] Processing from chat ${chatId}, type=${update.message ? "message" : "channel_post"}`);

    let useSearch = false;
    let useThinking = false;
    let useAgent = false;
    const commandMatch = text.match(/^[/!](?:search|think|agent)(?:@\S+)?\s*([\s\S]*)/i);
    if (commandMatch) {
        const cmd = text.split(/[\s@]/)[0].slice(1).toLowerCase();
        if (cmd === "search") useSearch = true;
        if (cmd === "think") useThinking = true;
        if (cmd === "agent") useAgent = true;
        text = commandMatch[1].trim();
    }

    const photo = message.photo as unknown[] | undefined;
    const document = message.document as Record<string, unknown> | undefined;
    const video = message.video as Record<string, unknown> | undefined;
    const voice = message.voice as Record<string, unknown> | undefined;
    const audio = message.audio as Record<string, unknown> | undefined;
    const hasAttachment = photo || document || video || voice || audio;

    if (!text && !hasAttachment) {
        console.log(`[Telegram] Skipping chat ${chatId} - empty message`);
        return;
    }

    console.log(`[Telegram] Chat ${chatId}: "${text.substring(0, 80)}"${hasAttachment ? " [+attachment]" : ""}`);

    await sendTelegramChatAction(chatId);

    let file: FileAttachment | undefined;
    if (hasAttachment) {
        try {
            let fileId: string | undefined;
            let fileName = "attachment";
            let fileSize = 0;
            let mimeOverride: string | undefined;

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
            } else if (voice) {
                // Telegram voice notes are Opus-in-OGG regardless of file_path extension.
                fileId = voice.file_id as string;
                fileName = "voice.ogg";
                fileSize = (voice.file_size as number) || 0;
                mimeOverride = "audio/ogg";
            } else if (audio) {
                fileId = audio.file_id as string;
                fileName = (audio.file_name as string) || "audio";
                fileSize = (audio.file_size as number) || 0;
                mimeOverride = (audio.mime_type as string) || undefined;
            }

            if (fileId && fileSize <= MAX_FILE_SIZE) {
                const downloaded = await downloadTelegramFile(fileId);
                if (downloaded) {
                    const mimeType = mimeOverride ?? getMimeType(downloaded.filePath);
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

    console.log(`[Telegram] Calling ragChat for chat ${chatId}...`);
    const { reply, artifacts } = await ragChat({
        message: text || (file ? `[Sent ${file.name}]` : ""),
        channel: "telegram",
        file,
        thinking: useThinking,
        search: useSearch,
        agent: useAgent,
    });

    console.log(`[Telegram] ragChat done. Reply length: ${reply?.length ?? 0}, artifacts: ${artifacts.length}`);
    await sendTelegramMessage(chatId, reply || "No response.");

    for (const artifact of artifacts) {
        const stored = await getArtifact(artifact.id);
        if (!stored) continue;
        const ok = await sendTelegramDocument(chatId, {
            filename: stored.name,
            mimeType: stored.mime,
            body: stored.body,
        });
        console.log(`[Telegram] Document ${stored.name} ${ok ? "sent" : "failed"}.`);
    }

    await maybeSendVoiceReply(chatId, reply, !!file && file.mimeType.startsWith("audio/"));
    console.log(`[Telegram] Reply sent to chat ${chatId}.`);
}

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

    console.log("[Telegram Webhook] Received update:", JSON.stringify(update).substring(0, 300));

    try {
        await processUpdate(update);
    } catch (err) {
        console.error("[Telegram Webhook] processUpdate failed:", err);
    }

    return NextResponse.json({ ok: true });
}
