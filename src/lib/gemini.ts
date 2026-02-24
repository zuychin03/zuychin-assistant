import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY!;

const genAI = new GoogleGenerativeAI(apiKey);

// Chat model
export const geminiModel = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",
});

// Embedding model
export const embeddingModel = genAI.getGenerativeModel({
    model: "gemini-embedding-001",
});

/** Generate a 768-dim embedding vector for text. */
export async function generateEmbedding(text: string): Promise<number[]> {
    const result = await embeddingModel.embedContent(text);
    const values = result.embedding.values;
    // Truncate from 3072 to 768 dims to match our DB column
    return values.length > 768 ? values.slice(0, 768) : values;
}

/** Generate content with optional deep thinking mode. */
export async function generateWithThinking(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parts: any[],
    thinking: boolean = false
) {
    const model = genAI.getGenerativeModel({
        model: "gemini-3-flash-preview",
        // thinkingConfig for Gemini 3
        ...(thinking && {
            generationConfig: {
                // @ts-expect-error — thinkingConfig not yet in SDK types
                thinkingConfig: { thinkingLevel: "HIGH" },
            },
        }),
    });

    return model.generateContent(parts);
}

export { genAI };
