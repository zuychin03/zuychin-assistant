import { downloadTelegramFile, sendTelegramMessage } from "@/lib/messaging/telegram-service";
import { sendWithSaveButton } from "@/lib/messaging/telegram-recording";
import { getDefaultProfile } from "@/lib/db";
import { effectiveFreeOnly } from "@/lib/ai/model-policy";
import { acquireSlot } from "@/lib/capture/extract/gate";
import { videoFailureText, videoModels, videoTitle, videoToNotesRecorded, VIDEO_TELEGRAM_MAX_BYTES } from "@/lib/capture/video";
import { durationLabel } from "@/lib/voice/recording-limits";

// V8 F4 on Telegram: a video becomes notes in the webhook's after() work, one at a time (the "video" slot, shared
// with the Capture route), and comes back with the Save to Capture button the long-audio transcripts use.

export interface TelegramVideo { fileId: string; fileSize: number; seconds: number; title: string }

/** A video, round video or video file with no caption; a caption makes it a chat question about the video, as before. */
export function telegramVideo(message: { video?: Record<string, unknown>; videoNote?: Record<string, unknown>; document?: Record<string, unknown>; caption?: string; date?: unknown }): TelegramVideo | null {
    if (message.caption?.trim()) return null;
    const document = typeof message.document?.mime_type === "string" && message.document.mime_type.startsWith("video/") ? message.document : undefined;
    const source = message.video ?? message.videoNote ?? document;
    if (!source || typeof source.file_id !== "string") return null;
    return {
        fileId: source.file_id,
        fileSize: typeof source.file_size === "number" ? source.file_size : 0,
        seconds: typeof source.duration === "number" ? source.duration : 0,
        title: videoTitle({ fileName: source.file_name, sentAt: message.date }),
    };
}

export function videoNotesHeading(title: string, seconds: number): string {
    return `Video notes: ${title}${seconds > 0 ? ` (${durationLabel(seconds)})` : ""}`;
}

/** Runs in the webhook's after() work, so the model may take minutes. */
export async function summariseTelegramVideo(chatId: number, clip: TelegramVideo): Promise<void> {
    if (clip.fileSize > VIDEO_TELEGRAM_MAX_BYTES) {
        await sendTelegramMessage(chatId, "That video is over 20 MB, the most the bot can download. Trim it, or send a shorter clip.");
        return;
    }
    const profile = await getDefaultProfile().catch(() => null);
    // Without the profile, Free only is assumed so a paid model never sees the video by mistake.
    const freeOnly = profile ? effectiveFreeOnly(profile) : true;
    if (!videoModels(freeOnly).length) {
        await sendTelegramMessage(chatId, videoFailureText("no_model"));
        return;
    }
    const release = acquireSlot("video");
    if (!release) {
        await sendTelegramMessage(chatId, "I am already summarising a video. Send this one again when that one is done.");
        return;
    }
    try {
        await sendTelegramMessage(chatId, "Summarising the video. I will send the notes when done.");
        const downloaded = await downloadTelegramFile(clip.fileId);
        if (!downloaded) {
            await sendTelegramMessage(chatId, "The video could not be downloaded from Telegram. Send it again.");
            return;
        }
        const started = performance.now();
        const result = await videoToNotesRecorded({ bytes: downloaded.buffer, title: clip.title }, { freeOnly });
        console.log(JSON.stringify({ event: "telegram_video", ok: result.ok, bytes: downloaded.buffer.length, seconds: clip.seconds,
            ms: Math.round(performance.now() - started), ...(result.ok ? { model: result.model, speech: result.speech } : { reason: result.reason }) }));
        if (!result.ok) {
            await sendTelegramMessage(chatId, videoFailureText(result.reason));
            return;
        }
        const sent = await sendWithSaveButton(chatId, { heading: videoNotesHeading(result.title, clip.seconds), title: result.title, body: result.text, fileSuffix: "notes" });
        if (!sent) await sendTelegramMessage(chatId, "The notes are ready but could not be sent. Send the video again.");
    } finally {
        release();
    }
}
