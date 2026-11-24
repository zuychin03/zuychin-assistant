import { effectiveFreeOnly } from "@/lib/ai/model-policy";
import { NextRequest, NextResponse } from "next/server";
import { synthesizeSpeech, speechStream, getVoicePrefs, planSpeech, FULL_TTS_CHARS } from "@/lib/ai/tts";
import { readVoiceChoices } from "@/lib/ai/voice-choices";
import { getDefaultProfile } from "@/lib/db";
import { requireChatAuth } from "@/lib/auth/guard";
import { withModelObservationCollector, configureModelDataPolicy, type ModelCallObservation } from "@/lib/ai/model-observations";
import { persistModelObservations } from "@/lib/ai/model-health";
import { sameOrigin } from "@/lib/auth/config";
import { BodyTooLargeError, readJsonCapped } from "@/lib/http/body";

// Clients send one reply chunk or a filler phrase at a time; the server speaks at most FULL_TTS_CHARS of it.
const MAX_TEXT_CHARS = 20_000;

// TTS generation scales with text length; the full-reply streaming cap is
// sized to finish inside this window (~45s worst case).
export const maxDuration = 60;

export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    const profile = await getDefaultProfile();
    return NextResponse.json({ voice: getVoicePrefs(profile?.preferences) });
}

export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    if (!sameOrigin(req)) return NextResponse.json({ error: "Speech requests must come from this app." }, { status: 403 });
    const calls: ModelCallObservation[] = [];
    let userProfileId: string | undefined;
    let persistence: ReturnType<typeof persistModelObservations> | undefined;
    const finish = () => persistence ??= persistModelObservations(calls, { userProfileId });
    let freeOnly = false;
    const collect = <T,>(run: () => T) => withModelObservationCollector(calls, () => { configureModelDataPolicy(freeOnly); return run(); }, [], ["personal"]);
    let text = "";
    let voiceName: string | undefined;
    let wantStream = false;
    let requestedFreeOnly = false;
    try {
        const body = await readJsonCapped(req);
        if (typeof body.text === "string") text = body.text;
        if (typeof body.voiceName === "string") voiceName = body.voiceName;
        wantStream = body.stream === true;
        if (body.freeOnly !== undefined && typeof body.freeOnly !== "boolean") return NextResponse.json({ error: "Free only must be a boolean." }, { status: 400 });
        requestedFreeOnly = body.freeOnly === true;
    } catch (error) {
        if (error instanceof BodyTooLargeError) return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (!text.trim()) {
        return NextResponse.json({ error: "text is required" }, { status: 400 });
    }
    if (text.length > MAX_TEXT_CHARS) return NextResponse.json({ error: "The text is too long to speak (max 20,000 characters)." }, { status: 400 });

    try {
        const profile = await getDefaultProfile();
        userProfileId = profile?.id;
        freeOnly = effectiveFreeOnly(profile, requestedFreeOnly);
        await readVoiceChoices();
        const plan = planSpeech(getVoicePrefs(profile?.preferences), { freeOnly, voiceName });
        if (!plan.local && !plan.api) {
            return freeOnly
                ? NextResponse.json({ error: "Free only: voice synthesis has no eligible free route." }, { status: 409 })
                : NextResponse.json({ error: "The on-box voice is not available." }, { status: 503 });
        }

        if (!wantStream) {
            const { buffer, mimeType, provider, model } = await collect(() => synthesizeSpeech(text, plan, req.signal));
            await finish();
            return new NextResponse(new Uint8Array(buffer), {
                headers: { "Content-Type": mimeType, "Cache-Control": "no-store", "X-Model-Provider": provider, "X-Model-Id": model },
            });
        }

        // Streaming: raw headerless PCM chunks so the client can start playing
        // while the model is still speaking. The first chunk is awaited here so
        // synth errors surface as a clean 502 instead of a broken stream, and
        // its mimeType carries the sample rate for the response header.
        // Streaming clients can afford the full-reply cap: generation outpaces
        // playback, so long clips still start in ~2.5s.
        const controller = new AbortController();
        const gen = speechStream(text, plan, FULL_TTS_CHARS, AbortSignal.any([req.signal, controller.signal]));
        const first = await collect(() => gen.next());
        if (first.done) {
            await finish();
            return NextResponse.json({ error: "TTS returned no audio" }, { status: 502 });
        }
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(first.value.pcm));
            },
            async pull(controller) {
                try {
                    const { value, done } = await gen.next();
                    if (done) { await finish(); controller.close(); }
                    else controller.enqueue(new Uint8Array(value.pcm));
                } catch (err) {
                    await finish();
                    console.error("[TTS] Stream failed mid-flight.");
                    controller.error(err);
                }
            },
            async cancel() {
                controller.abort();
                try { await gen.return(undefined); } finally { await finish(); }
            },
        });
        return new NextResponse(stream, {
            headers: {
                "Content-Type": "application/octet-stream",
                "X-Sample-Rate": String(first.value.sampleRate),
                "Cache-Control": "no-store",
                "X-Model-Provider": first.value.provider, "X-Model-Id": first.value.model,
            },
        });
    } catch {
        await finish();
        console.error("[TTS] Synthesis failed.");
        return NextResponse.json({ error: "Speech synthesis failed" }, { status: 502 });
    }
}
