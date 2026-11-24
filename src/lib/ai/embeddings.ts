import {
    resolveEmbedding, getProviderApiKey, isProviderAvailable, providers,
    type ResolvedEmbedding,
} from "@/lib/ai/providers";
import { cachedEmbeddingSetting } from "@/lib/ai/embedding-override";
import { embedPastScreen, isScreenRefusal } from "@/lib/ai/embedding-screening";
import { beginModelObservation, withModelPurpose } from "@/lib/ai/model-observations";
import { requestUsage } from "@/lib/ai/stream-usage";
import { requestEmbeddings, type EmbeddingResponse, type EmbeddingRoute, type EmbedInputType } from "@/lib/ai/embedding-request";

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

async function callRoute(ref: ResolvedEmbedding, apiKey: string, texts: readonly string[], inputType: EmbedInputType, signal?: AbortSignal): Promise<EmbeddingResponse> {
    signal?.throwIfAborted();
    const route = embeddingRoute(ref, apiKey);
    const observation = withModelPurpose("embedding", () => beginModelObservation({ providerId: ref.provider.id, modelId: route.modelId, purpose: "embedding" }));
    try {
        const result = await requestEmbeddings(route, texts, inputType, { signal, timeoutMs: TIMEOUT_MS });
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

async function embedBatch(ref: ResolvedEmbedding, texts: readonly string[], inputType: EmbedInputType, signal?: AbortSignal): Promise<number[][]> {
    const apiKey = getProviderApiKey(ref.provider);
    if (!apiKey) throw new Error(`Missing API key for ${ref.provider.label}. Save one on the dashboard or set ${ref.provider.apiKeyEnv}.`);
    let result = await callRoute(ref, apiKey, texts, inputType, signal);
    if (transient(result)) result = await callRoute(ref, apiKey, texts, inputType, signal);
    if (result.ok) return validatedVectors(ref, result.vectors, texts.length);
    if (result.status === 200) throw new Error(`Invalid ${ref.model.dimension}-dimensional embedding from ${ref.provider.label}.`);
    const detail = result.timedOut ? "timed out" : `HTTP ${result.status ?? "error"}`;
    if (worthBackup(result)) {
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
