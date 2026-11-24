// Google shuts gemini-3.1-flash-tts-preview down on 18/12/2026; the owner moved the default on 24/11/2026.
export const DEFAULT_GEMINI_TTS_MODEL = "gemini-3.8-flash-lite-tts";

/** The Gemini speech model used when /admin has no backup voice; `GEMINI_TTS_MODEL` overrides it. */
export function geminiTtsModel(env: Record<string, string | undefined> = process.env): string {
    return env.GEMINI_TTS_MODEL?.trim() || DEFAULT_GEMINI_TTS_MODEL;
}
