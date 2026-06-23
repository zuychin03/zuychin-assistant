// Generates embeddings using whichever embedding model was picked. Each model's
// vectors are stored separately since vectors from different models can't be mixed.

import { ai } from "@/lib/gemini";
import {
    resolveEmbedding, getProviderApiKey,
    type ResolvedEmbedding,
} from "@/lib/ai/providers";

export type { ResolvedEmbedding };

// look up an embedding model by id (defaults to Gemini 768d)
export function getEmbeddingRef(modelId?: string): ResolvedEmbedding {
    return resolveEmbedding(modelId);
}

// Whether the text is being embedded for storage ("passage") or for searching
// ("query"). NVIDIA's bi-encoder retrieval models use this to pick the right mode.
export type EmbedInputType = "query" | "passage";

// turn text into an embedding vector with the given model
export async function embedText(
    ref: ResolvedEmbedding,
    text: string,
    inputType: EmbedInputType = "passage",
): Promise<number[]> {
    if (ref.provider.kind === "gemini") {
        const result = await ai.models.embedContent({
            model: ref.model.id,
            contents: text,
            config: { outputDimensionality: ref.model.dimension },
        });
        return result.embeddings?.[0]?.values ?? [];
    }

    // OpenAI-compatible embeddings endpoint.
    const apiKey = getProviderApiKey(ref.provider);
    if (!apiKey) {
        throw new Error(`Missing API key (${ref.provider.apiKeyEnv}) for ${ref.provider.label}.`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: Record<string, any> = {
        model: ref.model.id,
        input: text,
        encoding_format: "float",
    };
    // NVIDIA NIM's retrieval embedders require the query/passage mode.
    if (ref.provider.id === "nvidia-nim") body.input_type = inputType;

    const res = await fetch(`${ref.provider.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...(ref.provider.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Embedding request failed (${ref.provider.label} ${res.status}): ${detail.slice(0, 300)}`);
    }

    const json = (await res.json()) as { data?: { embedding?: number[] }[] };
    const vector = json.data?.[0]?.embedding;
    if (!vector || !Array.isArray(vector)) {
        throw new Error(`Embedding response from ${ref.provider.label} had no vector.`);
    }
    return vector;
}
