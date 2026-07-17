import { NextRequest, NextResponse } from "next/server";
import { synthesizeSpeech, synthesizeSpeechStream, getVoicePrefs, FULL_TTS_CHARS } from "@/lib/ai/tts";
import { getDefaultProfile } from "@/lib/db";

// TTS generation scales with text length; the full-reply streaming cap is
// sized to finish inside this window (~45s worst case).
export const maxDuration = 60;

export async function GET() {
    const profile = await getDefaultProfile();
    return NextResponse.json({ voice: getVoicePrefs(profile?.preferences) });
}

export async function POST(req: NextRequest) {
    let text = "";
    let voiceName: string | undefined;
    let wantStream = false;
    try {
        const body = await req.json();
        if (typeof body.text === "string") text = body.text;
        if (typeof body.voiceName === "string") voiceName = body.voiceName;
        wantStream = body.stream === true;
    } catch { }
    if (!text.trim()) {
        return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    try {
        const profile = await getDefaultProfile();
        const prefs = getVoicePrefs(profile?.preferences);
        const voice = voiceName ?? prefs.voiceName;

        if (!wantStream) {
            const { buffer, mimeType } = await synthesizeSpeech(text, voice);
            return new NextResponse(new Uint8Array(buffer), {
                headers: { "Content-Type": mimeType, "Cache-Control": "no-store" },
            });
        }

        // Streaming: raw headerless PCM chunks so the client can start playing
        // while the model is still speaking. The first chunk is awaited here so
        // synth errors surface as a clean 502 instead of a broken stream, and
        // its mimeType carries the sample rate for the response header.
        // Streaming clients can afford the full-reply cap: generation outpaces
        // playback, so long clips still start in ~2.5s.
        const gen = synthesizeSpeechStream(text, voice, FULL_TTS_CHARS);
        const first = await gen.next();
        if (first.done) {
            return NextResponse.json({ error: "TTS returned no audio" }, { status: 502 });
        }
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(first.value.pcm));
            },
            async pull(controller) {
                try {
                    const { value, done } = await gen.next();
                    if (done) controller.close();
                    else controller.enqueue(new Uint8Array(value.pcm));
                } catch (err) {
                    console.error("[TTS] Stream failed mid-flight:", err);
                    controller.error(err);
                }
            },
            cancel() {
                void gen.return(undefined);
            },
        });
        return new NextResponse(stream, {
            headers: {
                "Content-Type": "application/octet-stream",
                "X-Sample-Rate": String(first.value.sampleRate),
                "Cache-Control": "no-store",
            },
        });
    } catch (err) {
        console.error("[TTS] Synthesis failed:", err);
        return NextResponse.json({ error: "Speech synthesis failed" }, { status: 502 });
    }
}
