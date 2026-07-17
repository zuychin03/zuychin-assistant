import { ai } from "@/lib/gemini";
import {
    resolveEmbedding, getProviderApiKey,
    type ResolvedEmbedding,
} from "@/lib/ai/providers";
import { cachedEmbeddingOverride } from "@/lib/ai/embedding-override";

export type { ResolvedEmbedding };

// Precedence: explicit model arg > runtime override (set by the admin
// re-embed flow) > KNOWLEDGE_EMBEDDING_MODEL env > DEFAULT_EMBEDDING.
export function getEmbeddingRef(modelId?: string): ResolvedEmbedding {
    return resolveEmbedding(modelId ?? cachedEmbeddingOverride() ?? undefined);
}

export type EmbedInputType = "query" | "passage";

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
