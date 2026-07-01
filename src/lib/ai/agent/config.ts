// Caps for agent runs. Kept in one place so limits are easy to tune. Wall-clock
// budget stays under Vercel Pro's 300s function limit.
export const AGENT_CONFIG = {
    maxIterations: 14,          // lead-agent tool rounds before we force a wrap-up
    workerMaxRounds: 6,         // tool rounds per worker sub-agent
    maxSubagentsPerCall: 4,     // parallel workers per run_subagents dispatch
    maxTotalSubagents: 8,       // workers per whole run (guards runaway fan-out)
};
