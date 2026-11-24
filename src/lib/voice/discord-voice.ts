import { getDefaultProfile } from "@/lib/db";
import { effectiveFreeOnly } from "@/lib/ai/model-policy";
import { readVoiceChoices } from "@/lib/ai/voice-choices";
import { oggOpusSeconds } from "@/lib/voice/ogg-opus";
import { transcribeVoiceNote } from "@/lib/voice/voice-note";
import { longAudioFailureText, transcribeLongAudio, withTranscriptionRecord } from "@/lib/voice/long-audio";
import { durationLabel, LONG_AUDIO_SECONDS } from "@/lib/voice/recording-limits";
import type { FileAttachment } from "@/lib/types";

// V8 F6: Discord voice messages arrive from the bot as an audio/ogg file. Up to 5 minutes, the transcript
// becomes the message, as with Telegram voice notes; longer, the reply is the transcript itself. The bot calls
// the app on 127.0.0.1, so a long transcription is not cut at 100 seconds.

// Discord messages hold 2,000 characters; a longer transcript is attached as a text file.
const INLINE_MAX = 1800;
const PREVIEW_CHARS = 600;

export interface TranscriptArtifact { id: string; name: string; mime: string; kind: "document"; size: number; base64: string }
export type DiscordVoice =
    | { kind: "spoken"; text: string }
    | { kind: "reply"; reply: string; artifacts: TranscriptArtifact[] }
    | { kind: "audio" };

export function isDiscordVoice(file: Pick<FileAttachment, "mimeType">): boolean {
    return file.mimeType.split(";")[0].trim().toLowerCase() === "audio/ogg";
}

/** The bot's stand-in text when a message has only an attachment. */
export function botPlaceholder(text: string, file: Pick<FileAttachment, "name">): boolean {
    return text.trim() === `[Sent ${file.name}]`;
}

export function transcriptReply(name: string, seconds: number | null, text: string): { reply: string; artifacts: TranscriptArtifact[] } {
    const heading = `Transcript of ${name}${seconds ? ` (${durationLabel(seconds)})` : ""}`;
    if (heading.length + text.length + 8 <= INLINE_MAX) return { reply: `**${heading}**\n\n${text}`, artifacts: [] };
    const body = Buffer.from(`${heading}\n\n${text}\n`, "utf-8");
    const preview = text.slice(0, PREVIEW_CHARS).replace(/\s+\S*$/, "");
    return {
        reply: `**${heading}**\n\n${preview}…\n\nThe full transcript is attached.`,
        artifacts: [{ id: "transcript", name: "transcript.txt", mime: "text/plain", kind: "document", size: body.length, base64: body.toString("base64") }],
    };
}

type Deps = { voiceNote?: typeof transcribeVoiceNote; longAudio?: typeof transcribeLongAudio };

/** Any failure short of a long recording leaves the audio for the chat model, as before. */
export async function discordVoice(file: FileAttachment, requestedFreeOnly: boolean, signal?: AbortSignal, deps: Deps = {}): Promise<DiscordVoice> {
    const bytes = Buffer.from(file.base64, "base64");
    const seconds = oggOpusSeconds(bytes);
    try {
        const [profile, choices] = await Promise.all([getDefaultProfile().catch(() => null), readVoiceChoices()]);
        // Without the profile, Free only is assumed so a paid model never hears the message by mistake.
        const freeOnly = profile ? effectiveFreeOnly(profile, requestedFreeOnly) : true;
        if (seconds === null || seconds <= LONG_AUDIO_SECONDS) {
            const note = await withTranscriptionRecord(freeOnly, () => (deps.voiceNote ?? transcribeVoiceNote)(bytes, seconds ?? undefined, { choice: choices.transcription, freeOnly, signal }));
            if (note.ok) return { kind: "spoken", text: note.text };
            if (note.reason !== "too_long") {
                console.log(`[Chat] Discord voice message not transcribed (${note.reason}); sending the audio instead.`);
                return { kind: "audio" };
            }
        }
        const started = performance.now();
        const result = await withTranscriptionRecord(freeOnly, () => (deps.longAudio ?? transcribeLongAudio)(
            { bytes, name: file.name, mimeType: file.mimeType }, { choice: choices.transcription, freeOnly, signal }));
        console.log(JSON.stringify({ event: "discord_long_audio", ok: result.ok, bytes: bytes.length, seconds, ms: Math.round(performance.now() - started),
            ...(result.ok ? { model: result.model } : { reason: result.reason }) }));
        if (!result.ok) return { kind: "reply", reply: longAudioFailureText(result.reason), artifacts: [] };
        return { kind: "reply", ...transcriptReply(file.name, seconds, result.text) };
    } catch (error) {
        if (signal?.aborted) throw error;
        console.warn("[Chat] Discord voice message not transcribed:", error instanceof Error ? error.message : error);
        return { kind: "audio" };
    }
}
