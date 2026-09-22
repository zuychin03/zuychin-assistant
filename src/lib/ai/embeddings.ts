import { geminiClient } from "@/lib/gemini";
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

function validatedVector(ref: ResolvedEmbedding, vector: unknown): number[] {
    if (!Array.isArray(vector) || vector.length !== ref.model.dimension
        || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
        || !vector.some((value) => value !== 0)) {
        throw new Error(`Invalid ${ref.model.dimension}-dimensional embedding from ${ref.provider.label}.`);
    }
    return vector;
}

export async function embedText(
    ref: ResolvedEmbedding,
    text: string,
    inputType: EmbedInputType = "passage",
    signal?: AbortSignal,
): Promise<number[]> {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
    requestSignal.throwIfAborted();
    const apiKey = getProviderApiKey(ref.provider);
    if (!apiKey) {
        throw new Error(`Missing API key (${ref.provider.apiKeyEnv}) for ${ref.provider.label}.`);
    }
    if (ref.provider.kind === "gemini") {
        const result = await geminiClient(apiKey).models.embedContent({
            model: ref.model.id,
            contents: text,
            config: { outputDimensionality: ref.model.dimension, abortSignal: requestSignal },
        });
        return validatedVector(ref, result.embeddings?.[0]?.values);
    }

    const body: Record<string, unknown> = {
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
        signal: requestSignal,
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Embedding request failed (${ref.provider.label} ${res.status}): ${detail.slice(0, 300)}`);
    }

    const json = (await res.json()) as { data?: { embedding?: number[] }[] };
    return validatedVector(ref, json.data?.[0]?.embedding);
}
