import { ThinkingLevel } from "@google/genai";
import { geminiClient } from "@/lib/gemini";
import { getProviderApiKey, type ResolvedChat } from "@/lib/ai/providers";
import { observeGeminiClient } from "@/lib/ai/model-observations";
import { openaiCompatChat } from "@/lib/ai/openai-compat";
import type { ResolvedEmbedding } from "@/lib/ai/embeddings";

const CONSULT_SYSTEM = "Answer the request directly and concisely. You have no tools, so work only from the text you are given. Plain text or Markdown.";

/** One text-only call for ask_model and compare_models. Tools are withheld so a consulted model cannot act. */
export async function consultModel(resolved: ResolvedChat, prompt: string, maxTokens: number, embRef: ResolvedEmbedding, signal: AbortSignal): Promise<string> {
    if (resolved.provider.kind === "gemini") {
        const client = observeGeminiClient(geminiClient(getProviderApiKey(resolved.provider)), { providerId: resolved.provider.id, purpose: "consult" });
        const response = await client.models.generateContent({
            model: resolved.model.id,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: { systemInstruction: CONSULT_SYSTEM, maxOutputTokens: maxTokens, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, abortSignal: signal },
        });
        return response.text ?? "";
    }
    return openaiCompatChat({
        purpose: "consult",
        provider: resolved.provider,
        // Declaring no tools at all; an empty tool list makes some providers reject the request.
        model: { ...resolved.model, supportsTools: false },
        systemText: CONSULT_SYSTEM,
        userText: prompt,
        embRef,
        genParams: { maxTokens },
        signal,
    });
}
