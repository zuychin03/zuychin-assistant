import { resolveEmbedding, type EmbeddingModel } from "@/lib/ai/providers";

// Similarity cut-offs per embedding model. Each model spreads cosine scores differently, so fixed
// numbers silently drop real matches after a switch. Measure a new model with
// scripts/measure-embedding-cutoffs.ts and add it below, keyed by its native model id.

export interface SimilarityCutoffs {
    /** Chat turn: the message, embedded as a query, against notes and messages. */
    chatNotes: number;
    /** Chat turn: the message, embedded as a query, against memories. */
    chatMemories: number;
    /** Search tools: a query against notes, when hybrid search is unavailable. */
    toolNotes: number;
    /** Search tools: a query against past messages, when hybrid search is unavailable. */
    toolHistory: number;
    /** A new message against stored ones; at or above this it is the same text. */
    duplicate: number;
    /** Memory extraction: the message, as a query, against memories it may update. */
    memoryMerge: number;
    /** A new vault page, as a passage, against pages: link candidates and the vault search default. */
    vaultLink: number;
    /** Two unlinked vault pages this close are suggested as a link. */
    vaultSuggest: number;
    /** Link suggestions for one vault page. */
    pageSuggest: number;
}

// Measured 24/11/2026 on the live store (60 notes, 19 memories, 97 vault pages, 169 links). True-match
// p05/p10 as a query: notes 0.39/0.43, memories 0.30/0.40; vault links p25 0.43, unlinked p90 0.42; an
// edited duplicate p05 0.98 against the best other passage at 0.94.
const NEMOTRON_35: SimilarityCutoffs = {
    chatNotes: 0.4, chatMemories: 0.3, toolNotes: 0.4, toolHistory: 0.35, duplicate: 0.95,
    memoryMerge: 0.3, vaultLink: 0.4, vaultSuggest: 0.5, pageSuggest: 0.35,
};

const MEASURED: Record<string, SimilarityCutoffs> = {
    "nvidia/nemotron-3.5-embed-1b": NEMOTRON_35,
    // The fixed values used until 24/11/2026, tuned on this retired model.
    "nvidia/nemotron-3-embed-1b": {
        chatNotes: 0.72, chatMemories: 0.35, toolNotes: 0.6, toolHistory: 0.5, duplicate: 0.95,
        memoryMerge: 0.35, vaultLink: 0.4, vaultSuggest: 0.5, pageSuggest: 0.35,
    },
};

/** For a model nobody has measured: the current knowledge model's values, a better guess than none. */
export const UNMEASURED_CUTOFFS: SimilarityCutoffs = NEMOTRON_35;

export function measuredCutoffs(modelId: string): SimilarityCutoffs | null {
    return MEASURED[modelId] ?? null;
}

/** Cut-offs for a resolved model or a partition id (`model` or `model@dimension`). */
export function similarityCutoffs(model: Pick<EmbeddingModel, "id" | "apiId" | "spaceOf"> | string | null | undefined): SimilarityCutoffs {
    let resolved: Pick<EmbeddingModel, "id" | "apiId" | "spaceOf"> | null = null;
    if (typeof model === "string") {
        try { resolved = resolveEmbedding(model).model; } catch { return measuredCutoffs(model.split("@")[0]) ?? UNMEASURED_CUTOFFS; }
    } else resolved = model ?? null;
    if (!resolved) return UNMEASURED_CUTOFFS;
    // A same-space route gives the same vectors, so it shares its source's cut-offs.
    return measuredCutoffs(resolved.apiId ?? resolved.id) ?? (resolved.spaceOf ? measuredCutoffs(resolved.spaceOf) : null) ?? UNMEASURED_CUTOFFS;
}
