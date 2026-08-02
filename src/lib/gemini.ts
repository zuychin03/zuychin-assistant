import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY!;

export const ai = new GoogleGenAI({ apiKey });

const clients = new Map<string, GoogleGenAI>();

/**
 * The client for one specific key. A key is a billing project and a quota, so a
 * model offered under the free-tier key has to call through its own client or
 * it silently spends the paid project's quota instead. Background work that
 * never sees a user's model choice keeps importing `ai` directly.
 */
export function geminiClient(key?: string): GoogleGenAI {
    if (!key || key === apiKey) return ai;
    let client = clients.get(key);
    if (!client) {
        client = new GoogleGenAI({ apiKey: key });
        clients.set(key, client);
    }
    return client;
}

export const MODEL = "gemini-3.5-flash-lite";

// Gemini reports a token-budget stop here and raises nothing, so every caller
// has to check it before treating the text as a finished answer.
export function cutShortAtMaxTokens(candidate: { finishReason?: unknown } | null | undefined): boolean {
    return String(candidate?.finishReason) === "MAX_TOKENS";
}

// TTS requires a dedicated model; the chat model cannot emit audio. Preview
// ids churn, so the env override is the escape hatch.
export const TTS_MODEL = process.env.GEMINI_TTS_MODEL ?? "gemini-3.1-flash-tts-preview";
