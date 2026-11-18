export const AGENT_CONFIG = {
    maxIterations: 14,
    workerMaxRounds: 6,
    maxSubagentsPerCall: 4,
    maxTotalSubagents: 8,
    workerTimeoutMs: 120_000,
    compactionTokenThreshold: 150_000,
    // Covers the rounds before any usageMetadata has been observed.
    compactionCharFallback: 600_000,
    compactionKeepPairs: 3,
    // ask_model and compare_models share this budget per run.
    maxConsultCalls: 6,
    consultTimeoutMs: 60_000,
};
