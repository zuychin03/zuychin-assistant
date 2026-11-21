import { decodeOggOpus, VoiceDecodeError } from "@/lib/voice/ogg-opus";
import { sttConfigured, transcribePcm, type SttFailure } from "@/lib/voice/stt-client";

export const VOICE_NOTE_MAX_SECONDS = 300;
// The speech service gives a request 14 s including a cold model load; 30 s of audio
// takes about 5 to 7 s on the box, where 60 s could run past the limit.
export const VOICE_NOTE_PIECE_SECONDS = 30;
export const VOICE_NOTE_FALLBACK_TEXT = "[Voice note, not transcribed]";

export type VoiceNoteFailure = SttFailure | "too_long" | "invalid";
export type VoiceNoteResult = { ok: true; text: string; audioSec: number } | { ok: false; reason: VoiceNoteFailure };

type Deps = { configured?: () => boolean; transcribe?: typeof transcribePcm; decode?: typeof decodeOggOpus; signal?: AbortSignal };

/** On-box transcript of a Telegram voice note. Any failure means the caller sends the audio itself. */
export async function transcribeVoiceNote(bytes: Uint8Array, durationSec: number | undefined, deps: Deps = {}): Promise<VoiceNoteResult> {
    if (!(deps.configured ?? sttConfigured)()) return { ok: false, reason: "unconfigured" };
    if (durationSec !== undefined && durationSec > VOICE_NOTE_MAX_SECONDS) return { ok: false, reason: "too_long" };

    let pieces: Uint8Array<ArrayBuffer>[];
    try {
        pieces = await (deps.decode ?? decodeOggOpus)(bytes, { maxSeconds: VOICE_NOTE_MAX_SECONDS, pieceSeconds: VOICE_NOTE_PIECE_SECONDS });
    } catch (error) {
        return { ok: false, reason: error instanceof VoiceDecodeError ? error.reason : "invalid" };
    }

    const texts: string[] = [];
    let audioSec = 0;
    for (const piece of pieces) {
        const result = await (deps.transcribe ?? transcribePcm)(piece, { signal: deps.signal });
        if (!result.ok) {
            if (result.reason === "empty") continue;
            return { ok: false, reason: result.reason };
        }
        texts.push(result.text);
        audioSec += result.audioSec;
    }
    const text = texts.join(" ").trim();
    return text ? { ok: true, text, audioSec } : { ok: false, reason: "empty" };
}
