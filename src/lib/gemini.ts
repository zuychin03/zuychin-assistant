import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY!;

export const ai = new GoogleGenAI({ apiKey });

export const MODEL = "gemini-3-flash-preview";
export const EMBEDDING_MODEL = "gemini-embedding-001";

/** Generate a 768-dim embedding vector for text. */
export async function generateEmbedding(text: string): Promise<number[]> {
    const result = await ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: text,
        config: { outputDimensionality: 768 },
    });
    return result.embeddings?.[0]?.values ?? [];
}
