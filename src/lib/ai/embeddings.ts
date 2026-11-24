import {
    resolveEmbedding, getProviderApiKey, isProviderAvailable, providers,
    type ResolvedEmbedding,
} from "@/lib/ai/providers";
import { cachedEmbeddingSetting } from "@/lib/ai/embedding-override";
import { embedPastScreen, isScreenRefusal } from "@/lib/ai/embedding-screening";
import { beginModelObservation, withModelPurpose } from "@/lib/ai/model-observations";
import { requestUsage } from "@/lib/ai/stream-usage";
import { requestEmbeddings, type EmbeddingResponse, type EmbeddingRoute, type EmbedInputType, type EmbedModality } from "@/lib/ai/embedding-request";

export type { ResolvedEmbedding, EmbedInputType };

const TIMEOUT_MS = 60_000;
const BACKUP_NOTICE_MS = 24 * 60 * 60_000;
const NOTICE_KEY = Symbol.for("zuychin.assistant.embeddingBackupNotice");

// Precedence: explicit model arg > saved knowledge model (set by the switch job)
// > KNOWLEDGE_EMBEDDING_MODEL env > DEFAULT_EMBEDDING.
export function getEmbeddingRef(modelId?: string, providerId?: string): ResolvedEmbedding {
    const setting = cachedEmbeddingSetting();
    const wanted = modelId ?? setting?.model;
    return resolveEmbedding(wanted, providerId ?? (setting && wanted === setting.model ? setting.providerId : undefined));
}

export function embeddingRoute(ref: ResolvedEmbedding, apiKey: string): EmbeddingRoute {
    return {
        provider: ref.provider, modelId: ref.model.apiId ?? ref.model.id, apiKey,
        inputType: ref.model.inputType ?? ref.provider.id === "nvidia-nim",
        // Gemini pins are stored at a reduced size; OpenAI-shaped routes are only reduced for an `@dimension` partition.
        ...(ref.model.apiId || ref.provider.kind === "gemini" ? { dimension: ref.model.dimension } : {}),
    };
}

function validatedVectors(ref: ResolvedEmbedding, vectors: readonly unknown[], count: number): number[][] {
    const invalid = () => new Error(`Invalid ${ref.model.dimension}-dimensional embedding from ${ref.provider.label}.`);
    if (vectors.length !== count) throw invalid();
    for (const vector of vectors) {
        if (!Array.isArray(vector) || vector.length !== ref.model.dimension
            || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
            || !vector.some((value) => value !== 0)) throw invalid();
    }
    return vectors as number[][];
}

async function callRoute(ref: ResolvedEmbedding, apiKey: string, texts: readonly string[], inputType: EmbedInputType, signal?: AbortSignal, modalities?: readonly EmbedModality[]): Promise<EmbeddingResponse> {
    signal?.throwIfAborted();
    const route = embeddingRoute(ref, apiKey);
    const observation = withModelPurpose("embedding", () => beginModelObservation({ providerId: ref.provider.id, modelId: route.modelId, purpose: "embedding" }));
    try {
        const result = await requestEmbeddings(route, texts, inputType, { signal, timeoutMs: TIMEOUT_MS, ...(modalities ? { modalities } : {}) });
        if (result.ok) observation.finish({ usage: requestUsage(result.usage, true) });
        else observation.finish({ error: result.timedOut ? { name: "TimeoutError" } : { status: result.status ?? undefined }, ...(result.timedOut ? { status: "transient" as const } : {}) });
        return result;
    } catch (error) {
        observation.finish({ error, ...(signal?.aborted ? { status: "aborted" as const } : {}) });
        throw error;
    }
}

const transient = (result: EmbeddingResponse) => !result.ok && (result.timedOut || result.status === null || result.status >= 500);
// The route itself is gone or refused, so a same-space route may still serve the partition.
const worthBackup = (result: EmbeddingResponse) => !result.ok && (transient(result) || result.status === 404 || result.status === 410);

/** Approved routes proven to reproduce this partition; a free primary only falls back to free routes. */
export function sameSpaceBackups(ref: ResolvedEmbedding): ResolvedEmbedding[] {
    const out: ResolvedEmbedding[] = [];
    for (const provider of providers()) {
        if (!isProviderAvailable(provider)) continue;
        for (const model of provider.embeddingModels) {
            const catalogue = model.catalogue;
            if (model.spaceOf !== (ref.model.apiId ? ref.model.apiId : ref.model.id) || model.retired || !catalogue?.approved || catalogue.status) continue;
            if (provider.id === ref.provider.id && model.id === (ref.model.apiId ?? ref.model.id)) continue;
            if (ref.model.free === true && model.free !== true) continue;
            out.push({ provider, model: ref.model.apiId ? { ...model, id: ref.model.id, apiId: model.id, dimension: ref.model.dimension } : model });
        }
    }
    return out;
}

function noticeBackup(primary: ResolvedEmbedding, backup: ResolvedEmbedding, detail: string): void {
    const holder = globalThis as typeof globalThis & { [NOTICE_KEY]?: number };
    if (Date.now() - (holder[NOTICE_KEY] ?? 0) < BACKUP_NOTICE_MS) return;
    holder[NOTICE_KEY] = Date.now();
    console.warn(`[Embeddings] ${primary.provider.label} ${primary.model.id} failed (${detail}); using backup ${backup.provider.label} ${backup.model.apiId ?? backup.model.id}.`);
    void import("@/lib/messaging/router")
        .then(({ notify }) => notify("model_catalogue", `**Knowledge model** ${primary.provider.label} ${primary.model.label} failed (${detail}); using backup ${backup.provider.label} ${backup.model.label}.`))
        .catch((error) => console.error("[Embeddings] Backup notice failed:", error instanceof Error ? error.message : error));
}

async function embedBatch(ref: ResolvedEmbedding, texts: readonly string[], inputType: EmbedInputType, signal?: AbortSignal, modalities?: readonly EmbedModality[]): Promise<number[][]> {
    const apiKey = getProviderApiKey(ref.provider);
    if (!apiKey) throw new Error(`Missing API key for ${ref.provider.label}. Save one on the dashboard or set ${ref.provider.apiKeyEnv}.`);
    let result = await callRoute(ref, apiKey, texts, inputType, signal, modalities);
    if (transient(result)) result = await callRoute(ref, apiKey, texts, inputType, signal, modalities);
    if (result.ok) return validatedVectors(ref, result.vectors, texts.length);
    if (result.status === 200) throw new Error(`Invalid ${ref.model.dimension}-dimensional embedding from ${ref.provider.label}.`);
    const detail = result.timedOut ? "timed out" : `HTTP ${result.status ?? "error"}`;
    // Backup routes were proven on text only.
    if (worthBackup(result) && !modalities?.includes("image")) {
        for (const backup of sameSpaceBackups(ref)) {
            const key = getProviderApiKey(backup.provider);
            if (!key) continue;
            const answer = await callRoute(backup, key, texts, inputType, signal);
            if (!answer.ok) continue;
            const vectors = validatedVectors(ref, answer.vectors, texts.length);
            noticeBackup(ref, backup, detail);
            return vectors;
        }
    }
    throw Object.assign(new Error(`Embedding request failed (${ref.provider.label} ${result.status ?? "timeout"}): ${result.error.slice(0, 300)}`), { status: result.status });
}

function embedOne(ref: ResolvedEmbedding, text: string, inputType: EmbedInputType, signal?: AbortSignal): Promise<number[]> {
    return embedPastScreen(text, async (input) => (await embedBatch(ref, [input], inputType, signal))[0]);
}

/** One vector per text. Routes probed for batching get one request; others get one request per text. */
export async function embedTexts(ref: ResolvedEmbedding, texts: readonly string[], inputType: EmbedInputType = "passage", signal?: AbortSignal): Promise<number[][]> {
    if (!texts.length) return [];
    if (texts.length > 1 && ref.model.batch) {
        try { return await embedBatch(ref, texts, inputType, signal); } catch (error) {
            // One refused text fails the whole batch; each text then goes alone past the screen.
            if (!isScreenRefusal(error)) throw error;
        }
    }
    const out: number[][] = [];
    for (const text of texts) out.push(await embedOne(ref, text, inputType, signal));
    return out;
}

export async function embedText(
    ref: ResolvedEmbedding,
    text: string,
    inputType: EmbedInputType = "passage",
    signal?: AbortSignal,
): Promise<number[]> {
    return embedOne(ref, text, inputType, signal);
}

export interface PassageImage { mimeType: "image/png" | "image/jpeg"; base64: string }

/** Unit-length sum of two unit vectors, so a photo and its text weigh the same. */
export function fuseVectors(a: readonly number[], b: readonly number[]): number[] {
    if (a.length !== b.length || !a.length) throw new Error("Vectors to fuse must have the same length.");
    const length = (vector: readonly number[]) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    const la = length(a), lb = length(b);
    const sum = a.map((value, index) => value / la + b[index] / lb);
    const total = length(sum);
    return sum.map((value) => value / total);
}

// A 4xx other than a timeout or rate limit: the route will not take this image or text, so a narrower request may.
function refused(error: unknown): boolean {
    const status = (error as { status?: unknown } | null)?.status;
    return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * A photo's passage vector. With a model probed for images, the photo and its text go in one request and their vectors
 * are fused (0.58 for a matching query against 0.49 image alone and 0.55 text alone, 24/11/2026); otherwise the text alone.
 */
export async function embedImagePassage(
    ref: ResolvedEmbedding,
    input: { image: PassageImage; text: string },
    signal?: AbortSignal,
): Promise<{ vector: number[]; withImage: boolean }> {
    const text = input.text.trim();
    if (!text) throw new Error("A photo needs text to embed.");
    if (!ref.model.images || ref.provider.kind === "gemini") return { vector: await embedOne(ref, text, "passage", signal), withImage: false };
    const dataUrl = `data:${input.image.mimeType};base64,${input.image.base64}`;
    try {
        const [image, words] = await embedBatch(ref, [dataUrl, text], "passage", signal, ["image", "text"]);
        return { vector: fuseVectors(image, words), withImage: true };
    } catch (error) {
        if (!refused(error)) throw error;
    }
    // The screen may refuse the text, or the route the image, so each goes alone.
    const words = await embedOne(ref, text, "passage", signal);
    try {
        const [image] = await embedBatch(ref, [dataUrl], "passage", signal, ["image"]);
        return { vector: fuseVectors(image, words), withImage: true };
    } catch (error) {
        if (!refused(error)) throw error;
        return { vector: words, withImage: false };
    }
}
