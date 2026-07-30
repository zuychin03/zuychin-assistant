export const COUNCIL_TYPES = ["debate", "code", "research", "audit", "debug"] as const;
export type CouncilType = typeof COUNCIL_TYPES[number];

export interface CouncilTemplate {
    label: string;
    defaults: { maxRounds: number; maxMessages: number; ttlMinutes: number };
    instruction: string;
    closingCriteria: string;
}

export const COUNCIL_TEMPLATES: Record<CouncilType, CouncilTemplate> = {
    debate: {
        label: "Debate",
        defaults: { maxRounds: 6, maxMessages: 60, ttlMinutes: 90 },
        instruction: "Test the decision from competing perspectives. State assumptions, challenge weak reasoning, distinguish evidence from preference, and preserve meaningful dissent.",
        closingCriteria: "Close with a decision, decisive evidence, tradeoffs, and named dissent.",
    },
    code: {
        label: "Code",
        defaults: { maxRounds: 4, maxMessages: 48, ttlMinutes: 120 },
        instruction: "Inspect the actual repository before making claims. Partition work by file or component, identify integration risks, and require a test or direct verification path for every proposed change.",
        closingCriteria: "Close with an implementation plan, file ownership, verification commands, and any merge-order constraints.",
    },
    research: {
        label: "Research",
        defaults: { maxRounds: 5, maxMessages: 60, ttlMinutes: 150 },
        instruction: "Separate observed evidence, source-backed claims, inference, and unknowns. Prefer primary sources and say what would falsify the working conclusion.",
        closingCriteria: "Close with findings, confidence, sources to verify, and the highest-value open questions.",
    },
    audit: {
        label: "Audit",
        defaults: { maxRounds: 5, maxMessages: 60, ttlMinutes: 120 },
        instruction: "Look for concrete failure modes, security boundaries, regressions, and missing tests. Rank findings by impact and likelihood; do not claim a defect without a reproducible path or clear evidence.",
        closingCriteria: "Close with ranked findings, evidence, remediation, and residual risk.",
    },
    debug: {
        label: "Debug",
        defaults: { maxRounds: 4, maxMessages: 48, ttlMinutes: 120 },
        instruction: "Start from a reproducible symptom. Form competing hypotheses, gather discriminating evidence, and avoid changing code until the likely root cause is stated and testable.",
        closingCriteria: "Close with the root cause or best-supported hypothesis, reproduction steps, fix plan, and regression check.",
    },
};

export function getCouncilTemplate(type: CouncilType | undefined): CouncilTemplate {
    return COUNCIL_TEMPLATES[type ?? "debate"];
}
