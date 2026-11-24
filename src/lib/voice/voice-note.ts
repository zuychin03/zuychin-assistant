import { decodeOggOpus, VoiceDecodeError } from "@/lib/voice/ogg-opus";
import { sttConfigured, transcribePcm, type SttFailure } from "@/lib/voice/stt-client";
import { cachedVoiceChoices, type TranscriptionChoice } from "@/lib/ai/voice-choices";
import { apiTranscriptionRoute, transcribeInOrder, transcriptionSteps } from "@/lib/voice/transcribe-order";
import type { transcribeWithApi } from "@/lib/voice/api-stt";
import { LONG_AUDIO_SECONDS } from "@/lib/voice/recording-limits";

export const VOICE_NOTE_MAX_SECONDS = LONG_AUDIO_SECONDS;
// The speech service gives a request 14 s including a cold model load; 30 s of audio
// takes about 5 to 7 s on the box, where 60 s could run past the limit.
export const VOICE_NOTE_PIECE_SECONDS = 30;
export const VOICE_NOTE_FALLBACK_TEXT = "[Voice note, not transcribed]";

export type VoiceNoteFailure = SttFailure | "too_long" | "invalid";
export type VoiceNoteResult = { ok: true; text: string; audioSec: number } | { ok: false; reason: VoiceNoteFailure };

type Deps = {
    configured?: () => boolean; transcribe?: typeof transcribePcm; decode?: typeof decodeOggOpus; signal?: AbortSignal;
    /** The owner's order; defaults to the cached /admin choice (the webhook refreshes it first). */
    choice?: TranscriptionChoice;
    /** Free only: an API model hears the note only when it is free. */
    freeOnly?: boolean;
    api?: typeof transcribeWithApi;
};

/** Transcript of a Telegram voice note in the owner's order, piece by piece. Any failure means the caller sends the audio itself. */
export async function transcribeVoiceNote(bytes: Uint8Array, durationSec: number | undefined, deps: Deps = {}): Promise<VoiceNoteResult> {
    const choice = deps.choice ?? cachedVoiceChoices().transcription;
    const apiRoute = apiTranscriptionRoute(choice, deps.freeOnly ?? true);
    const steps = transcriptionSteps(choice.order, (deps.configured ?? sttConfigured)(), !!apiRoute);
    if (!steps.length) return { ok: false, reason: "unconfigured" };
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
        const result = await transcribeInOrder(piece, { steps, apiRoute, signal: deps.signal, local: deps.transcribe, api: deps.api });
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
