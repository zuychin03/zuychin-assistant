import { ai, geminiClient, TTS_MODEL } from "@/lib/gemini";
import { stripMarkdown } from "@/lib/speech";
import { observeGeminiClient, withModelObservationCollector, configureModelDataPolicy, type ModelCallObservation } from "@/lib/ai/model-observations";
import { persistModelObservations } from "@/lib/ai/model-health";
import { isLocalVoice, LOCAL_SPEECH_MODEL, streamLocalSpeech, ttsConfigured, type LocalVoice } from "@/lib/voice/tts-client";

export async function observeSpeech<T>(userProfileId: string | undefined, run: () => Promise<T>): Promise<T> {
    const calls: ModelCallObservation[] = [];
    try { return await withModelObservationCollector(calls, () => { configureModelDataPolicy(false); return run(); }, [], ["personal"]); }
    finally { await persistModelObservations(calls, { userProfileId }); }
}

// "auto" speaks with the on-box voice when it is up and falls back to Gemini; "gemini" and "local" force one.
export type SpeechEngine = "auto" | "gemini" | "local";
const SPEECH_ENGINES: readonly SpeechEngine[] = ["auto", "gemini", "local"];

export type VoicePrefs = {
    replyWithVoice: "off" | "onVoiceInput" | "always";
    voiceName: string;
    speechEngine: SpeechEngine;
    localVoice: LocalVoice;
};

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
    replyWithVoice: "onVoiceInput",
    voiceName: "Kore",
    speechEngine: "auto",
    localVoice: "M2",
};

export function getVoicePrefs(preferences: unknown): VoicePrefs {
    const voice =
        preferences && typeof preferences === "object"
            ? (preferences as { voice?: Partial<VoicePrefs> }).voice
            : undefined;
    const merged = { ...DEFAULT_VOICE_PREFS, ...(voice ?? {}) };
    if (!SPEECH_ENGINES.includes(merged.speechEngine)) merged.speechEngine = DEFAULT_VOICE_PREFS.speechEngine;
    if (!isLocalVoice(merged.localVoice)) merged.localVoice = DEFAULT_VOICE_PREFS.localVoice;
    return merged;
}

// Caps keep synthesis inside the 60s serverless budget. Streaming generates
// at ~41.5 chars/s of wall time (measured), so ~1800 chars ≈ 45s generation
// ≈ 1¾ min of audio - callers that stream can afford the full-reply cap. The
// default stays lead-only: the Telegram webhook shares its 60s with the chat
// generation itself. The timeout is a safety net below the budget so cleanup
// runs before Vercel's hard kill.
// Which Gemini project speaks. Free only replies use the free key so they never spend the paid quota.
export type SpeechRoute = { providerId: "gemini" | "gemini-free"; apiKey?: string };
export const PAID_SPEECH: SpeechRoute = { providerId: "gemini" };
export function freeSpeechRoute(): SpeechRoute | null {
    const apiKey = process.env.GEMINI_FREE_API_KEY;
    return apiKey ? { providerId: "gemini-free", apiKey } : null;
}

export const LEAD_TTS_CHARS = 500;
export const FULL_TTS_CHARS = 1800;
const TTS_TIMEOUT_MS = 55_000;

// What may speak a reply: the on-box voice, Gemini, or both (local first). Both null means nothing is eligible.
export type SpeechPlan = {
    local: LocalVoice | null;
    gemini: { route: SpeechRoute; voiceName: string } | null;
};

type PlanOptions = {
    freeOnly: boolean;
    voiceName?: string;
    // Telegram and Discord never use the Gemini free key; in Free only they speak only with the on-box voice.
    geminiFree?: boolean;
    env?: Record<string, string | undefined>;
};

export function planSpeech(prefs: VoicePrefs, options: PlanOptions): SpeechPlan {
    const local = prefs.speechEngine !== "gemini" && ttsConfigured(options.env) ? prefs.localVoice : null;
    let gemini: SpeechPlan["gemini"] = null;
    if (prefs.speechEngine !== "local") {
        const route = options.freeOnly ? (options.geminiFree === false ? null : freeSpeechRoute()) : PAID_SPEECH;
        if (route) gemini = { route, voiceName: options.voiceName ?? prefs.voiceName };
    }
    return { local, gemini };
}

// Plan for a reply sent over Telegram or Discord, or null when the saved preference says to stay silent.
export function replyVoicePlan(preferences: unknown, options: { audioTurn: boolean; freeOnly: boolean }): SpeechPlan | null {
    const prefs = getVoicePrefs(preferences);
    if (prefs.replyWithVoice === "off") return null;
    if (prefs.replyWithVoice === "onVoiceInput" && !options.audioTurn) return null;
    const plan = planSpeech(prefs, { freeOnly: options.freeOnly, geminiFree: false });
    return plan.local || plan.gemini ? plan : null;
}

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
 * realtime - so a consumer can start playback almost immediately.
 */
async function* geminiSpeechStream(
    spoken: string,
    voiceName: string,
    route: SpeechRoute,
    signal?: AbortSignal,
): AsyncGenerator<{ pcm: Buffer; sampleRate: number }> {
    const client = route.apiKey ? geminiClient(route.apiKey) : ai;
    const stream = await observeGeminiClient(client, { providerId: route.providerId, purpose: "speech" }).models.generateContentStream({
        model: TTS_MODEL,
        contents: [{ role: "user", parts: [{ text: spoken }] }],
        config: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
            abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TTS_TIMEOUT_MS)]) : AbortSignal.timeout(TTS_TIMEOUT_MS),
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

export type SpeechChunk = { pcm: Buffer; sampleRate: number; provider: string; model: string };

/**
 * Speaks with the plan: the on-box voice first, then Gemini if the on-box voice fails before any audio.
 * Once audio has started it is never switched mid-reply; a later failure ends the stream with an error.
 * Logs carry engine, sizes and timings only, never text.
 */
export async function* speechStream(text: string, plan: SpeechPlan, maxChars: number = LEAD_TTS_CHARS, signal?: AbortSignal): AsyncGenerator<SpeechChunk> {
    const spoken = clampForSpeech(stripMarkdown(text), maxChars);
    if (!spoken) throw new Error("Nothing to speak.");

    if (plan.local) {
        const started = performance.now();
        let firstMs: number | undefined;
        try {
            for await (const chunk of streamLocalSpeech(spoken, plan.local, { signal })) {
                firstMs ??= Math.round(performance.now() - started);
                yield { ...chunk, provider: "local", model: LOCAL_SPEECH_MODEL };
            }
            console.log(JSON.stringify({ event: "voice_speak", engine: "local", ok: true, chars: spoken.length, firstMs, ms: Math.round(performance.now() - started) }));
            return;
        } catch (error) {
            signal?.throwIfAborted();
            const reason = (error as { reason?: unknown })?.reason;
            console.warn(JSON.stringify({ event: "voice_speak", engine: "local", ok: false, chars: spoken.length, started: firstMs !== undefined, reason: typeof reason === "string" ? reason : "error", ms: Math.round(performance.now() - started) }));
            if (firstMs !== undefined || !plan.gemini) throw error;
        }
    }
    if (!plan.gemini) throw new Error("No speech route is available.");
    const { route, voiceName } = plan.gemini;
    for await (const chunk of geminiSpeechStream(spoken, voiceName, route, signal)) yield { ...chunk, provider: route.providerId, model: TTS_MODEL };
}

// Aggregates the stream into one WAV (Telegram and Discord need a whole file). Local audio streams per
// sentence, and Gemini's streaming call finishes ~3x sooner than blocking generateContent, so this stays on streams.
export async function synthesizeSpeech(
    text: string,
    plan: SpeechPlan,
    signal?: AbortSignal,
): Promise<{ buffer: Buffer; mimeType: "audio/wav"; provider: string; model: string }> {
    const parts: Buffer[] = [];
    let rate = 24000, provider = "", model = "";
    for await (const chunk of speechStream(text, plan, LEAD_TTS_CHARS, signal)) {
        parts.push(chunk.pcm);
        ({ sampleRate: rate, provider, model } = chunk);
    }
    if (parts.length === 0) throw new Error("TTS returned no audio.");
    return { buffer: pcmToWav(Buffer.concat(parts), rate), mimeType: "audio/wav", provider, model };
}
