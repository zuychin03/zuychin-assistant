export const AGENT_CONFIG = {
    maxIterations: 14,          // lead-agent tool rounds before we force a wrap-up
    workerMaxRounds: 6,         // tool rounds per worker sub-agent
    maxSubagentsPerCall: 4,     // parallel workers per run_subagents dispatch
    maxTotalSubagents: 8,       // workers per whole run (guards runaway fan-out)
    workerTimeoutMs: 120_000,   // hard cap per worker so one can't stall the run
};
