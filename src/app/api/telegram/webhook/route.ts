import { effectiveFreeOnly } from "@/lib/ai/model-policy";
import { after, NextRequest, NextResponse } from "next/server";
import { BodyTooLargeError, readJsonCapped } from "@/lib/http/body";
import { ragChat } from "@/lib/ai/rag-service";
import { sendTelegramMessage, sendTelegramChatAction, sendTelegramDocument, sendTelegramPhoto, downloadTelegramFile, answerTelegramCallbackQuery, editTelegramMessageReplyMarkup } from "@/lib/messaging/telegram-service";
import { readSavedPhoto } from "@/lib/knowledge/photo-files";
import { setInitiativeFeedback } from "@/lib/ai/initiative-store";
import { getArtifact } from "@/lib/artifacts/store";
import { briefingVoicePlan, FULL_TTS_CHARS, replyVoicePlan, synthesizeSpeech, observeSpeech } from "@/lib/ai/tts";
import { readVoiceChoices } from "@/lib/ai/voice-choices";
import { getDefaultProfile } from "@/lib/db";
import { allowedTelegramChats, allowedTelegramSenders, telegramSecretMatches, telegramSenderAllowed, updateChatId } from "@/lib/messaging/telegram-access";
import { claimChannelUpdate } from "@/lib/messaging/channel-updates";
import { parseTelegramCommand, telegramFailureText, translateReplyRef, type TelegramCommand } from "@/lib/messaging/telegram-turn";
import { transcribeVoiceNote, VOICE_NOTE_FALLBACK_TEXT } from "@/lib/voice/voice-note";
import { longRecording, saveTranscriptTap, SAVE_TRANSCRIPT_CALLBACK, transcribeTelegramRecording } from "@/lib/messaging/telegram-recording";
import { summariseTelegramVideo, telegramVideo } from "@/lib/messaging/telegram-video";
import { CHANNEL_STARTED_TEXT, channelHelpText, channelTurn } from "@/lib/messaging/channel-threads";
import { APPROVAL_CALLBACK } from "@/lib/tasks/approval-notices";
import { claimApproval, completeApproval, type ApprovalDecision } from "@/lib/tasks/decide";
import type { ApprovalStatus } from "@/lib/tasks/types";
import type { FileAttachment, ReplyRef } from "@/lib/types";

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
// Telegram shows "typing" for about 5 seconds per chat action.
const TYPING_EVERY_MS = 4500;

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
// a document attachment still plays inline in Telegram. A /brief reply always speaks, at full length.
async function maybeSendVoiceReply(chatId: number, reply: string, audioTurn: boolean, freeOnly = false, briefing = false) {
    if (!reply) return;
    try {
        const [profile] = await Promise.all([getDefaultProfile(), readVoiceChoices()]);
        const free = effectiveFreeOnly(profile, freeOnly);
        const plan = briefing ? briefingVoicePlan(profile?.preferences, free) : replyVoicePlan(profile?.preferences, { audioTurn, freeOnly: free });
        if (!plan) return;

        await sendTelegramChatAction(chatId, "upload_document");
        const { buffer, mimeType } = await observeSpeech(profile?.id, () => synthesizeSpeech(reply, plan, undefined, briefing ? FULL_TTS_CHARS : undefined));
        const ok = await sendTelegramDocument(chatId, {
            filename: briefing ? "briefing.wav" : "reply.wav",
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
const TAKEN: Partial<Record<ApprovalStatus, string>> = {
    expired: "This approval has expired. Nothing was run.",
    executing: "Already approved. It is running.",
    succeeded: "Already approved and done.",
    rejected: "Already rejected.",
    outcome_unknown: "Already approved, but the outcome is unknown. Check Tasks.",
};

// The webhook has already checked the secret, the chat and that the tap came from an owner id.
async function handleApprovalTap(cbId: string, id: string, decision: ApprovalDecision, chatId?: number, messageId?: number) {
    let claim: Awaited<ReturnType<typeof claimApproval>>;
    try {
        claim = await claimApproval(id, decision);
    } catch (error) {
        console.error("[Telegram] Approval decision failed:", error);
        await answerTelegramCallbackQuery(cbId, "Couldn't record that. Try again, or open Tasks.");
        return;
    }
    if (claim.kind === "missing") {
        await answerTelegramCallbackQuery(cbId, "This approval is no longer available.");
        if (chatId !== undefined && messageId !== undefined) await editTelegramMessageReplyMarkup(chatId, messageId);
        return;
    }
    if (claim.kind === "taken") {
        await answerTelegramCallbackQuery(cbId, TAKEN[claim.approval.status] ?? "Already decided.");
        return;
    }
    await answerTelegramCallbackQuery(cbId, decision === "approve" ? "Approving…" : "Rejected.");
    await completeApproval(claim, "telegram");
}

async function handleCallbackQuery(cb: Record<string, unknown>) {
    const cbId = cb.id as string;
    const data = (cb.data as string | undefined) ?? "";
    const msg = cb.message as Record<string, unknown> | undefined;
    const chatId = (msg?.chat as Record<string, unknown> | undefined)?.id as number | undefined;
    const messageId = msg?.message_id as number | undefined;

    const approval = APPROVAL_CALLBACK.exec(data);
    if (approval) {
        await handleApprovalTap(cbId, approval[1], approval[2] === "a" ? "approve" : "reject", chatId, messageId);
        return;
    }
    if (data === SAVE_TRANSCRIPT_CALLBACK) {
        await saveTranscriptTap(cb);
        return;
    }

    const match = /^ini:([0-9a-f-]{36}):(1|-1)$/.exec(data);
    if (!match) {
        console.log(`[Telegram] Ignoring unknown callback_data: ${data.slice(0, 64)}`);
        await answerTelegramCallbackQuery(cbId);
        return;
    }

    const ok = await setInitiativeFeedback(match[1], Number(match[2]) as 1 | -1);
    await answerTelegramCallbackQuery(cbId, ok ? "Noted, thanks!" : "Couldn't record that.");
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
    const raw = ((message.text as string | undefined)?.trim() ?? (message.caption as string | undefined)?.trim() ?? "");

    console.log(`[Telegram] Processing from chat ${chatId}, type=${update.message ? "message" : "channel_post"}`);

    const photo = message.photo as unknown[] | undefined;
    const document = message.document as Record<string, unknown> | undefined;
    const video = message.video as Record<string, unknown> | undefined;
    const voice = message.voice as Record<string, unknown> | undefined;
    const audio = message.audio as Record<string, unknown> | undefined;
    const videoNote = message.video_note as Record<string, unknown> | undefined;
    const hasAttachment = photo || document || video || voice || audio || videoNote;

    if (!raw && !hasAttachment) {
        console.log(`[Telegram] Skipping chat ${chatId} - empty message`);
        return;
    }

    // Over 5 minutes is a recording to file, not a chat turn (V8 F5); this already runs after the webhook's 200.
    const recording = longRecording({ voice, audio, date: message.date });
    if (recording) {
        await transcribeTelegramRecording(chatId, recording);
        return;
    }
    // A video with no caption becomes notes (V8 F4); with a caption it stays a chat question about the video.
    const clip = telegramVideo({ video, videoNote, document, caption: raw, date: message.date });
    if (clip) {
        await summariseTelegramVideo(chatId, clip);
        return;
    }

    const turn = await channelTurn("telegram", String(chatId), raw);
    if (turn.kind === "help") {
        await sendTelegramMessage(chatId, channelHelpText());
        return;
    }
    if (turn.kind === "started" && !hasAttachment) {
        await sendTelegramMessage(chatId, CHANNEL_STARTED_TEXT);
        return;
    }
    const command = parseTelegramCommand(turn.kind === "message" ? turn.message : "");

    console.log(`[Telegram] Chat ${chatId}: "${command.text.substring(0, 80)}"${hasAttachment ? " [+attachment]" : ""}`);

    await sendTelegramChatAction(chatId);
    const typing = setInterval(() => void sendTelegramChatAction(chatId), TYPING_EVERY_MS);
    try {
        const replyTo = translateReplyRef(command.text, message.reply_to_message as Record<string, unknown> | undefined);
        await answerMessage(chatId, command, turn.conversationId ?? undefined, { photo, document, video, voice, audio, hasAttachment: !!hasAttachment }, replyTo);
    } finally {
        clearInterval(typing);
    }
}

type Attachments = {
    photo?: unknown[]; document?: Record<string, unknown>; video?: Record<string, unknown>;
    voice?: Record<string, unknown>; audio?: Record<string, unknown>; hasAttachment: boolean;
};

async function answerMessage(chatId: number, command: TelegramCommand, conversationId: string | undefined, attachments: Attachments, replyTo?: ReplyRef) {
    const { photo, document, video, voice, audio, hasAttachment } = attachments;
    const text = command.text;
    let file: FileAttachment | undefined;
    let voiceBytes: Buffer | undefined;
    if (hasAttachment) {
        try {
            let fileId: string | undefined;
            let fileName = "attachment";
            let fileSize = 0;
            let mimeOverride: string | undefined;
            let isVoiceNote = false;

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
                isVoiceNote = true;
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
                    if (isVoiceNote) voiceBytes = downloaded.buffer;
                    console.log(`[Telegram] Attachment: ${fileName} (${(file.size / 1024).toFixed(0)} KB, ${mimeType})`);
                }
            } else if (fileSize > MAX_FILE_SIZE) {
                console.warn(`[Telegram] File too large: ${(fileSize / 1024 / 1024).toFixed(1)} MB`);
            }
        } catch (dlErr) {
            console.error("[Telegram] Failed to download attachment:", dlErr);
        }
    }

    // A transcript lets any model answer; Gemini hears the audio only when no transcription step works.
    let note: Awaited<ReturnType<typeof transcribeVoiceNote>> | null = null;
    if (voiceBytes) {
        const [voiceProfile] = await Promise.all([getDefaultProfile().catch(() => null), readVoiceChoices()]);
        // Without the profile, Free only is assumed so a paid model never hears the note by mistake.
        const voiceFreeOnly = voiceProfile ? effectiveFreeOnly(voiceProfile) : true;
        note = await transcribeVoiceNote(voiceBytes, typeof voice?.duration === "number" ? voice.duration : undefined, { freeOnly: voiceFreeOnly });
    }
    if (note && !note.ok) console.log(`[Telegram] Voice note not transcribed (${note.reason}); sending the audio instead.`);
    const spoken = note?.ok ? note.text : null;
    const fallback = file ? (voiceBytes ? VOICE_NOTE_FALLBACK_TEXT : `[Sent ${file.name}]`) : "";

    console.log(`[Telegram] Calling ragChat for chat ${chatId}...`);
    const message = spoken !== null ? [text, spoken].filter(Boolean).join("\n\n") : text || fallback;
    // Email and calendar changes asked for in this turn wait for Approve / Reject buttons (runRagChat opens the gate).
    const { reply, artifacts, freeOnly, photos, speak } = await ragChat({
        message,
        channel: "telegram",
        conversationId,
        replyTo,
        file: spoken !== null ? undefined : file,
        inputMode: spoken !== null ? "voice" : undefined,
        thinking: command.thinking,
        search: command.search,
        agent: command.agent,
    });

    console.log(`[Telegram] ragChat done. Reply length: ${reply?.length ?? 0}, artifacts: ${artifacts.length}`);
    await sendTelegramMessage(chatId, reply || "No response.");

    for (const artifact of artifacts) {
        const stored = await getArtifact(artifact.id);
        if (!stored) continue;
        const file = { filename: stored.name, mimeType: stored.mime, body: stored.body };
        // Made images (V8 F10) arrive as pictures, everything else as files.
        const picture = stored.mime.startsWith("image/");
        const ok = picture ? await sendTelegramPhoto(chatId, file) : await sendTelegramDocument(chatId, file);
        console.log(`[Telegram] ${picture ? "Image" : "Document"} ${stored.name} ${ok ? "sent" : "failed"}.`);
    }

    for (const path of photos ?? []) {
        const photo = await readSavedPhoto(path);
        if (!photo) continue;
        const ok = await sendTelegramPhoto(chatId, { filename: photo.name, mimeType: photo.mimeType, body: photo.bytes });
        console.log(`[Telegram] Cited photo ${ok ? "sent" : "failed"}.`);
    }

    await maybeSendVoiceReply(chatId, reply, !!file && file.mimeType.startsWith("audio/"), freeOnly, speak === true);
    console.log(`[Telegram] Reply sent to chat ${chatId}.`);
}

export async function POST(req: NextRequest) {
    // Fails closed: an unsecured webhook lets anyone post an update the
    // assistant then acts on, with tools and memory writes behind it.
    const secretHeader = req.headers.get("x-telegram-bot-api-secret-token");
    if (!WEBHOOK_SECRET) {
        if (process.env.NODE_ENV === "production") {
            console.error("[Telegram] TELEGRAM_WEBHOOK_SECRET is not set; refusing update.");
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
    } else if (!telegramSecretMatches(secretHeader, WEBHOOK_SECRET)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let update: Record<string, unknown>;
    try {
        update = await readJsonCapped(req);
    } catch (error) {
        if (error instanceof BodyTooLargeError) console.warn("[Telegram] Ignored an update over the size limit.");
        return NextResponse.json({ ok: true });
    }

    // 200, not 401: Telegram retries anything else, and the sender learns nothing.
    const allowed = allowedTelegramChats();
    if (allowed.size === 0 && process.env.NODE_ENV === "production") {
        console.error("[Telegram] TELEGRAM_CHAT_ID is not set; ignoring update.");
        return NextResponse.json({ ok: true });
    }
    const chatId = updateChatId(update);
    if (allowed.size > 0 && (chatId === null || !allowed.has(chatId))) {
        console.warn(`[Telegram] Ignoring update from unlisted chat ${chatId ?? "unknown"}.`);
        return NextResponse.json({ ok: true });
    }

    if (allowed.size > 0) {
        const senders = allowedTelegramSenders();
        if (!telegramSenderAllowed(update, senders)) {
            console.warn(senders.size === 0
                ? "[Telegram] No owner user id is known; set TELEGRAM_OWNER_USER_IDS. Ignoring update."
                : `[Telegram] Ignoring update from a non-owner sender in chat ${chatId}.`);
            return NextResponse.json({ ok: true });
        }
    }

    if (typeof update.update_id === "number" && await claimChannelUpdate("telegram", String(update.update_id)) === "seen") {
        console.log(`[Telegram] Update ${update.update_id} was already handled; ignoring the re-delivery.`);
        return NextResponse.json({ ok: true });
    }

    console.log("[Telegram Webhook] Received update:", JSON.stringify(update).substring(0, 300));

    // Answer before the turn runs: Telegram re-sends an update it gets no 200 for,
    // and Cloudflare cuts any response at 100 seconds.
    await afterResponse(() => runUpdate(update, chatId));
    return NextResponse.json({ ok: true });
}

async function runUpdate(update: Record<string, unknown>, chatId: string | null) {
    try {
        await processUpdate(update);
    } catch (err) {
        console.error("[Telegram Webhook] processUpdate failed:", err);
        if (chatId !== null && !update.callback_query) await sendTelegramMessage(chatId, telegramFailureText(err));
    }
}

// after() needs a request scope; outside one (the offline suites) the work runs before the reply.
async function afterResponse(work: () => Promise<void>) {
    try {
        after(work);
    } catch {
        await work();
    }
}
