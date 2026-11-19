import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { sameOrigin } from "@/lib/auth/config";
import { sttWarm, sttWarmAvailable } from "@/lib/voice/stt-client";
import { ttsConfigured, ttsWarm } from "@/lib/voice/tts-client";

// Polled when a voice chat starts; the mic waits until speech-to-text has loaded. The box's one small CPU
// loaded both models together in about 8 s against about 2.5 s each alone, so the voice starts only once
// speech-to-text is no longer loading, and loads while the first turn is spoken.
export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    if (!sameOrigin(req)) return NextResponse.json({ error: "Voice requests must come from this app." }, { status: 403 });
    const started = performance.now();
    const state = await sttWarm();
    const speaker = state === "starting" || state === "loading" ? "deferred" : ttsConfigured() ? "started" : "unconfigured";
    // Not awaited: the request alone starts the service through its socket, and the mic need not wait for it.
    if (speaker === "started") void ttsWarm();
    console.log(JSON.stringify({ event: "voice_warm", state, speaker, ms: Math.round(performance.now() - started) }));
    return NextResponse.json({ available: sttWarmAvailable(state), loaded: state === "ready" }, { headers: { "Cache-Control": "no-store" } });
}
