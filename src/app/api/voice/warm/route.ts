import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { sameOrigin } from "@/lib/auth/config";
import { sttWarm, sttWarmAvailable } from "@/lib/voice/stt-client";
import { ttsWarm } from "@/lib/voice/tts-client";

// Sent when a voice chat starts, so the on-box models load while the first turn is being spoken. The speaker
// loads here too, because voice chat replies are spoken.
export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    if (!sameOrigin(req)) return NextResponse.json({ error: "Voice requests must come from this app." }, { status: 403 });
    const started = performance.now();
    const [state, speaker] = await Promise.all([sttWarm(), ttsWarm()]);
    console.log(JSON.stringify({ event: "voice_warm", state, speaker, ms: Math.round(performance.now() - started) }));
    return NextResponse.json({ available: sttWarmAvailable(state), loaded: state === "ready" }, { headers: { "Cache-Control": "no-store" } });
}
