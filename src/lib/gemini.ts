import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY!;

export const ai = new GoogleGenAI({ apiKey });

export const MODEL = "gemini-3.5-flash-lite";

// TTS requires a dedicated model; the chat model cannot emit audio. Preview
// ids churn, so the env override is the escape hatch.
export const TTS_MODEL = process.env.GEMINI_TTS_MODEL ?? "gemini-3.1-flash-tts-preview";
