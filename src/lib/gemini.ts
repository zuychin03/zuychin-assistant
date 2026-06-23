import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY!;

export const ai = new GoogleGenAI({ apiKey });

export const MODEL = "gemini-3-flash-preview";
