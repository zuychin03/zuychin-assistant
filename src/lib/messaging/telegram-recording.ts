import { createHash } from "node:crypto";
import { answerTelegramCallbackQuery, downloadTelegramFile, editTelegramMessageReplyMarkup, sendTelegramDocument, sendTelegramMessage } from "@/lib/messaging/telegram-service";
import { getDefaultProfile } from "@/lib/db";
import { effectiveFreeOnly } from "@/lib/ai/model-policy";
import { readVoiceChoices } from "@/lib/ai/voice-choices";
import { ownerLink } from "@/lib/public-url";
import { longAudioFailureText, transcribeLongAudio, withTranscriptionRecord } from "@/lib/voice/long-audio";
import { apiTranscriptionRoute } from "@/lib/voice/transcribe-order";
import { CAPTURE_TEXT_MAX, durationLabel, LONG_AUDIO_SECONDS } from "@/lib/voice/recording-limits";

// V8 F5: Telegram audio over 5 minutes goes to the API transcription model as the compressed file, inside the
// webhook's after() work, and comes back as a transcript with a Save to Capture button. The tap reads the
// transcript from the message itself, so nothing is kept on the server in between.

/** getFile serves bot downloads up to 20 MB. */
export const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const SAVE_TRANSCRIPT_CALLBACK = "cap:save";
// telegram-service's plain chunk size: a longer transcript goes as a text file so the button sees all of it.
const INLINE_MAX = 3500;
const SAVE_BUTTON = { inline_keyboard: [[{ text: "Save to Capture", callback_data: SAVE_TRANSCRIPT_CALLBACK }]] };
const HEADING = /^Transcript: (.+) \((\d+ (?:min|s))\)$/;

export interface TelegramRecording { fileId: string; fileSize: number; seconds: number; name: string; mimeType: string; title: string }

export function recordingTitle(input: { title?: unknown; fileName?: unknown; sentAt?: unknown }): string {
    const named = typeof input.title === "string" && input.title.trim() ? input.title
        : typeof input.fileName === "string" ? input.fileName.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[_-]+/g, " ") : "";
    const clean = named.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    if (clean) return clean.slice(0, 150);
    const sent = typeof input.sentAt === "number" ? new Date(input.sentAt * 1000) : new Date();
    return `Voice note ${sent.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", day: "2-digit", month: "2-digit", year: "numeric" })}`;
}

/** A voice note or audio file over 5 minutes, from a Telegram message's voice or audio object. */
export function longRecording(message: { voice?: Record<string, unknown>; audio?: Record<string, unknown>; date?: unknown }): TelegramRecording | null {
    const source = message.voice ?? message.audio;
    const seconds = source?.duration;
    if (!source || typeof source.file_id !== "string" || typeof seconds !== "number" || seconds <= LONG_AUDIO_SECONDS) return null;
    const audio = message.voice ? undefined : message.audio;
    return {
        fileId: source.file_id, fileSize: typeof source.file_size === "number" ? source.file_size : 0, seconds,
        // Voice notes are Ogg Opus whatever their file_path says.
        name: audio ? typeof audio.file_name === "string" ? audio.file_name : "audio" : "voice.ogg",
        mimeType: audio ? typeof audio.mime_type === "string" ? audio.mime_type : "" : "audio/ogg",
        title: recordingTitle({ title: audio?.title, fileName: audio?.file_name, sentAt: message.date }),
    };
}

export function transcriptHeading(title: string, seconds: number): string {
    return `Transcript: ${title} (${durationLabel(seconds)})`;
}

export function parseTranscriptMessage(text: string): { title: string; text: string } | null {
    const [first, ...rest] = text.replace(/\r\n/g, "\n").split("\n");
    const heading = HEADING.exec(first.trim());
    const body = rest.join("\n").trim();
    return heading && body ? { title: heading[1].slice(0, 200), text: body } : null;
}

const fileName = (title: string) => `${title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").slice(0, 100)} transcript.txt`;

export async function sendTranscript(chatId: number, recording: Pick<TelegramRecording, "title" | "seconds">, transcript: string): Promise<boolean> {
    const heading = transcriptHeading(recording.title, recording.seconds);
    const full = `${heading}\n\n${transcript}`;
    if (full.length <= INLINE_MAX) return sendTelegramMessage(chatId, full, { plain: true, replyMarkup: SAVE_BUTTON });
    return sendTelegramDocument(chatId, { filename: fileName(recording.title), mimeType: "text/plain; charset=utf-8", body: `${full}\n`,
        caption: `${heading}. The full text is attached.`, replyMarkup: SAVE_BUTTON });
}

/** Runs in the webhook's after() work, so the model may take minutes. */
export async function transcribeTelegramRecording(chatId: number, recording: TelegramRecording): Promise<void> {
    if (recording.fileSize > TELEGRAM_DOWNLOAD_MAX_BYTES) {
        await sendTelegramMessage(chatId, "That recording is over 20 MB, the most the bot can download. Upload it on the Capture page instead.");
        return;
    }
    const [profile, choices] = await Promise.all([getDefaultProfile().catch(() => null), readVoiceChoices()]);
    // Without the profile, Free only is assumed so a paid model never hears the recording by mistake.
    const freeOnly = profile ? effectiveFreeOnly(profile) : true;
    if (!apiTranscriptionRoute(choices.transcription, freeOnly)) {
        await sendTelegramMessage(chatId, longAudioFailureText("no_model"));
        return;
    }
    await sendTelegramMessage(chatId, `Transcribing ${durationLabel(recording.seconds)} of audio. I will send it when done.`);
    const downloaded = await downloadTelegramFile(recording.fileId);
    if (!downloaded) {
        await sendTelegramMessage(chatId, "The recording could not be downloaded from Telegram. Send it again.");
        return;
    }
    const started = performance.now();
    const result = await withTranscriptionRecord(freeOnly, () => transcribeLongAudio(
        { bytes: downloaded.buffer, name: recording.name, mimeType: recording.mimeType }, { choice: choices.transcription, freeOnly }));
    console.log(JSON.stringify({ event: "telegram_long_audio", ok: result.ok, bytes: downloaded.buffer.length, seconds: recording.seconds,
        ms: Math.round(performance.now() - started), ...(result.ok ? { model: result.model } : { reason: result.reason }) }));
    if (!result.ok) {
        await sendTelegramMessage(chatId, longAudioFailureText(result.reason));
        return;
    }
    if (!await sendTranscript(chatId, recording, result.text)) await sendTelegramMessage(chatId, "The transcript is ready but could not be sent. Send the recording again.");
}

/** A stable capture id per transcript message, so a second tap finds the first capture instead of adding another. */
export function transcriptCaptureId(chatId: number, messageId: number): string {
    const hex = createHash("sha256").update(`telegram-transcript:${chatId}:${messageId}`).digest("hex");
    const variant = (8 + (parseInt(hex[16], 16) & 3)).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type CaptureDeps = { capture(id: string, source: { kind: "text"; title: string; text: string }): Promise<void> };
const liveCapture: CaptureDeps = {
    async capture(id, source) {
        const { captureProfile, captureService } = await import("@/lib/capture/store");
        const profile = await captureProfile();
        await captureService.capture(profile.id, id, source);
    },
};

/** The webhook has already checked the secret, the chat and that the tap came from an owner id. */
export async function saveTranscriptTap(cb: Record<string, unknown>, deps: CaptureDeps = liveCapture): Promise<void> {
    const cbId = cb.id as string;
    const message = cb.message as Record<string, unknown> | undefined;
    const chatId = (message?.chat as Record<string, unknown> | undefined)?.id;
    const messageId = message?.message_id;
    if (typeof chatId !== "number" || typeof messageId !== "number") {
        await answerTelegramCallbackQuery(cbId, "This transcript is no longer available.");
        return;
    }
    let text = typeof message?.text === "string" ? message.text : null;
    const document = message?.document as Record<string, unknown> | undefined;
    if (text === null && typeof document?.file_id === "string") text = (await downloadTelegramFile(document.file_id))?.buffer.toString("utf-8") ?? null;
    const transcript = text === null ? null : parseTranscriptMessage(text);
    if (!transcript) {
        await answerTelegramCallbackQuery(cbId, "This transcript could not be read. Send the recording again.");
        return;
    }
    const id = transcriptCaptureId(chatId, messageId);
    try {
        await deps.capture(id, { kind: "text", title: transcript.title, text: transcript.text.slice(0, CAPTURE_TEXT_MAX) });
    } catch (error) {
        console.error("[Telegram] Transcript not saved to Capture:", error instanceof Error ? error.message : error);
        await answerTelegramCallbackQuery(cbId, "Couldn't save it. Try again, or open Capture.");
        return;
    }
    await answerTelegramCallbackQuery(cbId, "Saved to Capture for review.");
    const link = ownerLink(`/capture?review=${id}`);
    await editTelegramMessageReplyMarkup(chatId, messageId, link.startsWith("https://") ? { inline_keyboard: [[{ text: "Review in Capture", url: link }]] } : undefined);
}
