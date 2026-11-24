import { ThinkingLevel } from "@google/genai";
import { geminiClient } from "@/lib/gemini";
import { getProviderApiKey, type ResolvedChat } from "@/lib/ai/providers";
import { observeGeminiClient, type ModelCallPurpose } from "@/lib/ai/model-observations";
import { maskGeminiClient } from "@/lib/ai/privacy/gemini";
import { openaiCompatChat } from "@/lib/ai/openai-compat";
import type { ResolvedEmbedding } from "@/lib/ai/embeddings";

const CONSULT_SYSTEM = "Answer the request directly and concisely. You have no tools, so work only from the text and images you are given. Plain text or Markdown.";

export interface ConsultImage {
    base64: string;
    mimeType: string;
}

export interface SingleTurn {
    system: string;
    prompt: string;
    maxTokens: number;
    purpose: ModelCallPurpose;
    embRef: ResolvedEmbedding;
    signal: AbortSignal;
    images?: readonly ConsultImage[];
}

/** One call with no tools, so the model cannot act. Images go only to vision models (callers check). */
export async function singleTurn(resolved: ResolvedChat, turn: SingleTurn): Promise<string> {
    const images = turn.images ?? [];
    if (resolved.provider.kind === "gemini") {
        const client = maskGeminiClient(observeGeminiClient(geminiClient(getProviderApiKey(resolved.provider)), { providerId: resolved.provider.id, purpose: turn.purpose }), resolved.provider.id);
        const response = await client.models.generateContent({
            model: resolved.model.id,
            contents: [{ role: "user", parts: [...images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.base64 } })), { text: turn.prompt }] }],
            config: { systemInstruction: turn.system, maxOutputTokens: turn.maxTokens, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, abortSignal: turn.signal },
        });
        return response.text ?? "";
    }
    return openaiCompatChat({
        purpose: turn.purpose,
        provider: resolved.provider,
        // Declaring no tools at all; an empty tool list makes some providers reject the request.
        model: { ...resolved.model, supportsTools: false },
        systemText: turn.system,
        userText: turn.prompt,
        // openaiCompatChat takes one inline image and one file; the chat turn carries at most one of each.
        imageBase64: images[0]?.base64,
        imageMimeType: images[0]?.mimeType,
        file: images[1] ? { name: "image-2", mimeType: images[1].mimeType, base64: images[1].base64, size: Math.floor(images[1].base64.length * 0.75) } : undefined,
        embRef: turn.embRef,
        genParams: { maxTokens: turn.maxTokens },
        signal: turn.signal,
    });
}

/** ask_model and compare_models. */
export function consultModel(resolved: ResolvedChat, prompt: string, maxTokens: number, embRef: ResolvedEmbedding, signal: AbortSignal, images: readonly ConsultImage[] = []): Promise<string> {
    return singleTurn(resolved, { system: CONSULT_SYSTEM, prompt, maxTokens, purpose: "consult", embRef, signal, images });
}
