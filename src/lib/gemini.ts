import { GoogleGenAI } from "@google/genai";
import { PAID_CHAT } from "@/lib/ai/providers";
import { providerKeyOrEnv } from "@/lib/ai/provider-keys/snapshot";

const clients = new Map<string, GoogleGenAI>();

function clientFor(key: string): GoogleGenAI {
    let client = clients.get(key);
    if (!client) {
        client = new GoogleGenAI({ apiKey: key });
        clients.set(key, client);
    }
    return client;
}

/**
 * The paid project's client. It resolves the key on each use, so a key saved on
 * the dashboard reaches background work without a restart.
 */
export const ai: GoogleGenAI = new Proxy({} as GoogleGenAI, {
    get(_target, property) {
        const key = providerKeyOrEnv("gemini", "GEMINI_API_KEY");
        if (!key) throw new Error("No Gemini API key is set. Save one on the dashboard or set GEMINI_API_KEY.");
        return Reflect.get(clientFor(key), property);
    },
});

/**
 * The client for one specific key. A key is a billing project and a quota, so a
 * model offered under the free-tier key has to call through its own client or
 * it silently spends the paid project's quota instead. Background work that
 * never sees a user's model choice keeps importing `ai` directly.
 */
export function geminiClient(key?: string): GoogleGenAI {
    return key ? clientFor(key) : ai;
}

export const MODEL = PAID_CHAT.modelId;

// Gemini reports a token-budget stop here and raises nothing, so every caller
// has to check it before treating the text as a finished answer.
export function cutShortAtMaxTokens(candidate: { finishReason?: unknown } | null | undefined): boolean {
    return String(candidate?.finishReason) === "MAX_TOKENS";
}

// TTS requires a dedicated model; the chat model cannot emit audio. Preview
// ids churn, so the env override is the escape hatch.
export const TTS_MODEL = process.env.GEMINI_TTS_MODEL ?? "gemini-3.1-flash-tts-preview";
