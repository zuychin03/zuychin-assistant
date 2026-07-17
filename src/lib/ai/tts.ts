import { ai, TTS_MODEL } from "@/lib/gemini";
import { stripMarkdown } from "@/lib/speech";

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

// Caps keep synthesis inside the 60s serverless budget. Streaming generates
// at ~41.5 chars/s of wall time (measured), so ~1800 chars ≈ 45s generation
// ≈ 1¾ min of audio — callers that stream can afford the full-reply cap. The
// default stays lead-only: the Telegram webhook shares its 60s with the chat
// generation itself. The timeout is a safety net below the budget so cleanup
// runs before Vercel's hard kill.
export const LEAD_TTS_CHARS = 500;
export const FULL_TTS_CHARS = 1800;
const TTS_TIMEOUT_MS = 55_000;

// Truncate on a sentence boundary where possible, else a word boundary, so
// the spoken lead never ends mid-word.
function clampForSpeech(text: string, max: number): string {
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    if (sentenceEnd > max * 0.6) return cut.slice(0, sentenceEnd + 1).trim();
    const wordEnd = cut.lastIndexOf(" ");
    return (wordEnd > 0 ? cut.slice(0, wordEnd) : cut).trim();
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

/**
 * Streams raw 16-bit PCM mono chunks ("audio/L16;...;rate=24000") as the TTS
 * model generates them. Measured: first chunk ~2.4s in, generation ~2.3x
 * realtime — so a consumer can start playback almost immediately.
 */
export async function* synthesizeSpeechStream(
    text: string,
    voiceName: string = DEFAULT_VOICE_PREFS.voiceName,
    maxChars: number = LEAD_TTS_CHARS
): AsyncGenerator<{ pcm: Buffer; sampleRate: number }> {
    const spoken = clampForSpeech(stripMarkdown(text), maxChars);
    if (!spoken) throw new Error("Nothing to speak.");

    const stream = await ai.models.generateContentStream({
        model: TTS_MODEL,
        contents: [{ role: "user", parts: [{ text: spoken }] }],
        config: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
            abortSignal: AbortSignal.timeout(TTS_TIMEOUT_MS),
        },
    });

    for await (const chunk of stream) {
        const inline = chunk.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
        if (!inline?.data) continue;
        yield {
            pcm: Buffer.from(inline.data, "base64"),
            sampleRate: Number(/rate=(\d+)/.exec(inline.mimeType ?? "")?.[1] ?? 24000),
        };
    }
}

// Aggregates the stream into one WAV (Telegram needs a whole file). The
// streaming call also finishes ~3x sooner than blocking generateContent for
// the same text, so this path stays on it.
export async function synthesizeSpeech(
    text: string,
    voiceName: string = DEFAULT_VOICE_PREFS.voiceName
): Promise<{ buffer: Buffer; mimeType: "audio/wav" }> {
    const parts: Buffer[] = [];
    let rate = 24000;
    for await (const { pcm, sampleRate } of synthesizeSpeechStream(text, voiceName)) {
        parts.push(pcm);
        rate = sampleRate;
    }
    if (parts.length === 0) throw new Error("TTS returned no audio.");
    return { buffer: pcmToWav(Buffer.concat(parts), rate), mimeType: "audio/wav" };
}
