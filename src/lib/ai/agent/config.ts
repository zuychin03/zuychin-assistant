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
};
