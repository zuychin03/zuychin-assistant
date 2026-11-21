import type { CatalogueRow } from "../../src/lib/ai/catalogue/snapshot";

// The chat models P5 moved out of providers.ts, as their seeded, approved catalogue rows (v7-model-catalogue.sql).
type Seed = Pick<CatalogueRow, "providerId" | "modelId" | "label" | "shortName" | "supportsTools" | "supportsVision" | "supportsThinking" | "supportsSearch">
    & Partial<Pick<CatalogueRow, "free" | "metered" | "maxOutputTokens" | "supportsStructured">>;

function seed(entry: Seed): CatalogueRow {
    return {
        origin: "seed", description: null, developer: null, free: true, metered: false, mayTrain: null, contextTokens: null, maxOutputTokens: null,
        inputs: ["Text"], listedTools: null, listedStructured: null, listedThinking: null,
        probeStatus: "untested", probeAttempts: 0, probedAt: null, probeChatMs: null, supportsStructured: null,
        firstSeenAt: "2026-11-18T00:00:00.000Z", lastSeenAt: "2026-11-18T00:00:00.000Z", missedChecks: 0, missingSince: null, notifiedMissingAt: null,
        approvedAt: "2026-11-18T00:00:00.000Z",
        ...entry,
    };
}

const ULTRA_FREE = { modelId: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra (free)", shortName: "nemotron-3-ultra", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, maxOutputTokens: 65536 };
const LAGUNA_S_FREE = { modelId: "poolside/laguna-s-2.1:free", label: "Laguna S 2.1 (free)", shortName: "laguna-s-2.1", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true, maxOutputTokens: 32768 };

export const CODE_SEED_ROWS: readonly CatalogueRow[] = [
    seed({ providerId: "openrouter", ...ULTRA_FREE }),
    seed({ providerId: "openrouter", ...LAGUNA_S_FREE }),
    seed({ providerId: "openrouter", modelId: "google/gemma-4-31b-it:free", label: "Gemma 4 31B IT (free)", shortName: "gemma-4", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, maxOutputTokens: 32768 }),
    seed({ providerId: "openrouter", modelId: "google/gemma-4-26b-a4b-it", label: "Gemma 4 26B A4B", shortName: "gemma-4-26b", free: false, metered: true, supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, supportsStructured: true, maxOutputTokens: 16384 }),
    seed({ providerId: "kilo", ...ULTRA_FREE }),
    seed({ providerId: "kilo", modelId: "inclusionai/ling-3.0-flash-vl:free", label: "Ling 3.0 Flash VL (free)", shortName: "ling-3.0-flash-vl", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, maxOutputTokens: 32768 }),
    seed({ providerId: "kilo", modelId: "stepfun/step-3.7-flash:free", label: "Step 3.7 Flash (free)", shortName: "step-3.7-flash", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true, maxOutputTokens: 262144 }),
    seed({ providerId: "kilo", ...LAGUNA_S_FREE }),
    seed({ providerId: "nvidia-nim", modelId: "google/gemma-4-31b-it", label: "Gemma 4 31B IT (free)", shortName: "gemma-4", supportsTools: true, supportsVision: true, supportsThinking: false, supportsSearch: true, supportsStructured: true, maxOutputTokens: 131072 }),
    seed({ providerId: "nvidia-nim", modelId: "poolside/laguna-xs-2.1", label: "Laguna XS 2.1 (free)", shortName: "laguna-xs-2.1", supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: true, supportsStructured: true }),
    seed({ providerId: "tokenrouter", modelId: "moonshotai/kimi-k3-free", label: "Kimi K3 (free)", shortName: "kimi-k3", supportsTools: true, supportsVision: true, supportsThinking: true, supportsSearch: true }),
];
