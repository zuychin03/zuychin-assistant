import { ai, TTS_MODEL } from "@/lib/gemini";

export type VoicePrefs = {
    replyWithVoice: "off" | "onVoiceInput" | "always";
    voiceName: string;
};

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
    replyWithVoice: "onVoiceInput",
    voiceName: "Kore",
};

export function getVoicePrefs(preferences: unknown): VoicePrefs {
    const voice =
        preferences && typeof preferences === "object"
            ? (preferences as { voice?: Partial<VoicePrefs> }).voice
            : undefined;
    return { ...DEFAULT_VOICE_PREFS, ...(voice ?? {}) };
}

// Long replies stall the Telegram webhook (maxDuration 60); a spoken reply
// reads only the lead of a long answer.
const MAX_TTS_CHARS = 1500;
const TTS_TIMEOUT_MS = 20_000;

function stripMarkdown(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, " (code omitted) ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/[*_~#>|]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
    header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

export async function synthesizeSpeech(
    text: string,
    voiceName: string = DEFAULT_VOICE_PREFS.voiceName
): Promise<{ buffer: Buffer; mimeType: "audio/wav" }> {
    const spoken = stripMarkdown(text).slice(0, MAX_TTS_CHARS);
    if (!spoken) throw new Error("Nothing to speak.");

    const res = await ai.models.generateContent({
        model: TTS_MODEL,
        contents: [{ role: "user", parts: [{ text: spoken }] }],
        config: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
            abortSignal: AbortSignal.timeout(TTS_TIMEOUT_MS),
        },
    });

    const inline = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
    if (!inline?.data) throw new Error("TTS returned no audio.");

    // Output is raw 16-bit PCM mono ("audio/L16;...;rate=24000"); Telegram and
    // <audio> both need a WAV header on top.
    const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? "")?.[1] ?? 24000);
    return { buffer: pcmToWav(Buffer.from(inline.data, "base64"), rate), mimeType: "audio/wav" };
}
