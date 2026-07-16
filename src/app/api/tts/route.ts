import { NextRequest, NextResponse } from "next/server";
import { synthesizeSpeech, getVoicePrefs } from "@/lib/ai/tts";
import { getDefaultProfile } from "@/lib/db";

export const maxDuration = 30;

export async function GET() {
    const profile = await getDefaultProfile();
    return NextResponse.json({ voice: getVoicePrefs(profile?.preferences) });
}

export async function POST(req: NextRequest) {
    let text = "";
    let voiceName: string | undefined;
    try {
        const body = await req.json();
        if (typeof body.text === "string") text = body.text;
        if (typeof body.voiceName === "string") voiceName = body.voiceName;
    } catch { }
    if (!text.trim()) {
        return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    try {
        const profile = await getDefaultProfile();
        const prefs = getVoicePrefs(profile?.preferences);
        const { buffer, mimeType } = await synthesizeSpeech(text, voiceName ?? prefs.voiceName);
        return new NextResponse(new Uint8Array(buffer), {
            headers: { "Content-Type": mimeType, "Cache-Control": "no-store" },
        });
    } catch (err) {
        console.error("[TTS] Synthesis failed:", err);
        return NextResponse.json({ error: "Speech synthesis failed" }, { status: 502 });
    }
}
