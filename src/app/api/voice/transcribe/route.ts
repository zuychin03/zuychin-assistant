import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { sameOrigin } from "@/lib/auth/config";
import { STT_MAX_BYTES, sttConfigured, transcribePcm } from "@/lib/voice/stt-client";
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
    if (!sttConfigured()) return fallback("unconfigured");

    const started = performance.now();
    const result = await transcribePcm(pcm, { signal: req.signal });
    const ms = Math.round(performance.now() - started);
    // Sizes and timings only: the transcript is the owner's speech.
    console.log(JSON.stringify({ event: "voice_transcribe", ok: result.ok, bytes: pcm.byteLength, ms,
        ...(result.ok ? { audioSec: result.audioSec, decodeMs: result.decodeMs } : { reason: result.reason }) }));
    if (!result.ok) return fallback(result.reason);
    return NextResponse.json({ text: result.text, audioSec: result.audioSec, ms }, { headers: NO_STORE });
}
