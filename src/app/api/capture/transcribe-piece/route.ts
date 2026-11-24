import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { sameOrigin } from "@/lib/auth/config";
import { BodyTooLargeError, readBodyCapped } from "@/lib/http/body";
import { captureProfile } from "@/lib/capture/store";
import { CaptureError } from "@/lib/capture/service";
import { acquireSlot } from "@/lib/capture/extract/gate";
import { effectiveFreeOnly } from "@/lib/ai/model-policy";
import { readVoiceChoices } from "@/lib/ai/voice-choices";
import { sttConfigured, type SttFailure } from "@/lib/voice/stt-client";
import { apiTranscriptionRoute } from "@/lib/voice/transcribe-order";
import { recordingSteps, transcribeRecordingPiece, withTranscriptionRecord } from "@/lib/voice/long-audio";
import { RECORDING_PIECE_BYTES, RECORDING_SAMPLE_RATE } from "@/lib/voice/recording-limits";

export const maxDuration = 100;
const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

const FAILED: Partial<Record<SttFailure, { status: number; error: string }>> = {
    busy: { status: 429, error: "The transcription model is busy. Try again in a moment." },
    timeout: { status: 504, error: "Transcribing this piece took too long." },
    unavailable: { status: 503, error: "The transcription service is unavailable right now." },
    unconfigured: { status: 503, error: "The transcription service is unavailable right now." },
};

/** One piece of a Capture recording: up to 3 minutes of 16 kHz 16-bit mono PCM as the raw body (V8 F5). */
export async function POST(req: NextRequest) {
    const denied = await requireSession(req); if (denied) return denied;
    if (!sameOrigin(req)) return respond({ error: "Open Capture on this site before transcribing." }, 403);
    if (!(req.headers.get("content-type") ?? "").startsWith("application/octet-stream")) {
        return respond({ error: "Send 16 kHz 16-bit mono PCM as application/octet-stream." }, 415);
    }
    const pcm = await readBodyCapped(req, RECORDING_PIECE_BYTES).catch((error) => { if (error instanceof BodyTooLargeError) return null; throw error; });
    if (!pcm) return respond({ error: "A piece holds at most 3 minutes of audio." }, 413);
    if (!pcm.byteLength || pcm.byteLength % 2) return respond({ error: "The piece was empty or malformed." }, 400);
    const release = acquireSlot("audio");
    if (!release) return respond({ error: "Another piece is being transcribed. Try again when it finishes." }, 429);
    try {
        const [profile, { transcription }] = await Promise.all([captureProfile(), readVoiceChoices()]);
        const freeOnly = effectiveFreeOnly(profile);
        const apiRoute = apiTranscriptionRoute(transcription, freeOnly);
        const steps = recordingSteps(transcription.order, sttConfigured(), !!apiRoute);
        if (!steps.length) return respond({ error: "No transcription is set up. Choose and approve an API transcription model on /admin." }, 503);
        const started = performance.now();
        const result = await withTranscriptionRecord(freeOnly, () => transcribeRecordingPiece(pcm, { steps, apiRoute, signal: req.signal }));
        const seconds = pcm.byteLength / (RECORDING_SAMPLE_RATE * 2);
        console.log(JSON.stringify({ event: "recording_piece", ok: result.ok, bytes: pcm.byteLength, ms: Math.round(performance.now() - started), order: transcription.order,
            ...(result.ok ? { engine: result.engine, model: result.model } : { reason: result.reason }) }));
        if (result.ok) return respond({ text: result.text, engine: result.engine, model: result.model, seconds });
        if (result.reason === "empty") return respond({ text: "", engine: null, model: null, seconds });
        const failed = FAILED[result.reason] ?? { status: 502, error: "The transcription model could not read this piece." };
        return respond({ error: failed.error }, failed.status);
    } catch (error) {
        if (error instanceof CaptureError) return respond({ error: error.message }, error.status);
        if (req.signal.aborted) return respond({ error: "Stopped." }, 499);
        console.error("[Capture] Piece transcription failed:", error instanceof Error ? error.message : error);
        return respond({ error: "The piece could not be transcribed. Try again." }, 503);
    } finally { release(); }
}
