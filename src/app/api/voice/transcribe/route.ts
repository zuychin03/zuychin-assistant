import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { sameOrigin } from "@/lib/auth/config";
import { getDefaultProfile } from "@/lib/db";
import { effectiveFreeOnly } from "@/lib/ai/model-policy";
import { configureModelDataPolicy, withModelObservationCollector, type ModelCallObservation } from "@/lib/ai/model-observations";
import { persistModelObservations } from "@/lib/ai/model-health";
import { readVoiceChoices } from "@/lib/ai/voice-choices";
import { STT_MAX_BYTES, sttConfigured } from "@/lib/voice/stt-client";
import { apiTranscriptionRoute, transcribeInOrder, transcriptionSteps } from "@/lib/voice/transcribe-order";
import { BodyTooLargeError, readBodyCapped } from "@/lib/http/body";

export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };

// 503 with fallback tells the client to send the original audio instead.
function fallback(reason: string) {
    return NextResponse.json({ fallback: true, reason }, { status: 503, headers: NO_STORE });
}

export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    if (!sameOrigin(req)) return NextResponse.json({ error: "Voice requests must come from this app." }, { status: 403 });
    if (!(req.headers.get("content-type") ?? "").startsWith("application/octet-stream")) {
        return NextResponse.json({ error: "Send 16 kHz 16-bit PCM as application/octet-stream." }, { status: 415 });
    }
    const tooLong = NextResponse.json({ error: "Voice turns are limited to 60 seconds." }, { status: 413 });
    const pcm = await readBodyCapped(req, STT_MAX_BYTES).catch((error) => { if (error instanceof BodyTooLargeError) return null; throw error; });
    if (!pcm) return tooLong;
    if (!pcm.byteLength || pcm.byteLength % 2) return NextResponse.json({ error: "The recording was empty or malformed." }, { status: 400 });

    const { transcription } = await readVoiceChoices();
    // The profile is read only when an API step may run: Free only decides whether a paid model may hear the audio.
    let freeOnly = false;
    if (transcription.order !== "local") {
        const profile = await getDefaultProfile().catch(() => null);
        freeOnly = profile ? effectiveFreeOnly(profile, req.nextUrl.searchParams.get("freeOnly") === "1") : true;
    }
    const apiRoute = apiTranscriptionRoute(transcription, freeOnly);
    const steps = transcriptionSteps(transcription.order, sttConfigured(), !!apiRoute);
    if (!steps.length) return fallback("unconfigured");

    const calls: ModelCallObservation[] = [];
    const started = performance.now();
    const result = await withModelObservationCollector(calls, () => {
        configureModelDataPolicy(freeOnly);
        return transcribeInOrder(pcm, { steps, apiRoute, signal: req.signal });
    }, [], ["personal"]);
    const ms = Math.round(performance.now() - started);
    if (calls.length) await persistModelObservations(calls).catch(() => {});
    // Sizes and timings only: the transcript is the owner's speech.
    console.log(JSON.stringify({ event: "voice_transcribe", ok: result.ok, bytes: pcm.byteLength, ms, order: transcription.order,
        ...(result.ok ? { engine: result.engine, model: result.model, audioSec: result.audioSec } : { reason: result.reason }) }));
    if (!result.ok) return fallback(result.reason);
    return NextResponse.json({ text: result.text, audioSec: result.audioSec, ms, engine: result.engine }, { headers: NO_STORE });
}
