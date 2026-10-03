export interface CouncilExecutionEvidence {
    executionId: string;
    agentName: string;
    connectorKind: string;
    identityAssurance: string;
    provider: string | null;
    adapterVersion: string | null;
    requestedModel: string | null;
    effectiveModel: string | null;
    requestedReasoningEffort: string | null;
    effectiveReasoningEffort: string | null;
    modelSource: string | null;
    hostGeneration: string | null;
    policyVersion: string | null;
}

export interface CouncilExecutionRecord extends CouncilExecutionEvidence {
    startedAt: string;
    endedAt: string | null;
    predecessorExecutionId: string | null;
}

export interface CouncilExecutionPage {
    records: CouncilExecutionRecord[];
    referencedRecords: CouncilExecutionRecord[];
    nextCursor: string | null;
    historyStatus: "available" | "unavailable";
    referencesStatus: "available" | "unavailable";
}

export const EXECUTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function object(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseExecutionEvidence(value: unknown): CouncilExecutionEvidence | null {
    const row = object(value);
    if (!row || typeof row.executionId !== "string" || !EXECUTION_ID_PATTERN.test(row.executionId)) return null;
    if (![row.agentName, row.connectorKind, row.identityAssurance].every(v => typeof v === "string" && v.length > 0)) return null;
    const fields = ["provider", "adapterVersion", "requestedModel", "effectiveModel", "requestedReasoningEffort", "effectiveReasoningEffort", "modelSource", "hostGeneration", "policyVersion"] as const;
    if (fields.some(key => row[key] != null && typeof row[key] !== "string")) return null;
    return {
        executionId: row.executionId, agentName: row.agentName as string,
        connectorKind: row.connectorKind as string, identityAssurance: row.identityAssurance as string,
        provider: row.provider as string ?? null, adapterVersion: row.adapterVersion as string ?? null,
        requestedModel: row.requestedModel as string ?? null, effectiveModel: row.effectiveModel as string ?? null,
        requestedReasoningEffort: row.requestedReasoningEffort as string ?? null,
        effectiveReasoningEffort: row.effectiveReasoningEffort as string ?? null,
        modelSource: row.modelSource as string ?? null,
        hostGeneration: row.hostGeneration as string ?? null, policyVersion: row.policyVersion as string ?? null,
    };
}

export function parseExecutionRecord(value: unknown): CouncilExecutionRecord | null {
    const row = object(value), evidence = parseExecutionEvidence(value);
    if (!row || !evidence || typeof row.startedAt !== "string" || !Number.isFinite(Date.parse(row.startedAt))) return null;
    if (row.endedAt != null && (typeof row.endedAt !== "string" || !Number.isFinite(Date.parse(row.endedAt)))) return null;
    if (row.predecessorExecutionId != null && (typeof row.predecessorExecutionId !== "string" || !EXECUTION_ID_PATTERN.test(row.predecessorExecutionId))) return null;
    return { ...evidence, startedAt: row.startedAt, endedAt: row.endedAt as string ?? null, predecessorExecutionId: row.predecessorExecutionId as string ?? null };
}

export function resolveExecutionEvidence(executionId: string | null | undefined, records: CouncilExecutionEvidence[]): {
    status: "recorded" | "not_recorded" | "unavailable"; evidence: CouncilExecutionEvidence | null;
} {
    if (!executionId) return { status: "not_recorded", evidence: null };
    const evidence = records.find(record => record.executionId === executionId) ?? null;
    return { status: evidence ? "recorded" : "unavailable", evidence };
}

export function executionSourceLabel(source: string | null): string {
    return ({ adapter_config: "Adapter readback", adapter_legacy_models: "Adapter reported", adapter_legacy_set_model: "Selection acknowledged", configured_cli: "Configured, unverified", unknown: "Not reported" } as Record<string, string>)[source ?? "unknown"] ?? "Unrecognised source";
}

export function executionIdentityLabel(identity: string): string {
    return ({ verified_seat: "Verified seat", host_bound: "Host bound", owner_relay: "Owner relayed", unverified_declaration: "Unverified declaration" } as Record<string, string>)[identity] ?? "Not reported";
}

export interface FrozenExecutionItem {
    itemId: string;
    sequence: number;
    agentName: string;
    commitSha: string;
    acceptedExecutionId: string | null;
    executionEvidence: CouncilExecutionEvidence | null;
}

export function parseFrozenExecutionItems(value: unknown): FrozenExecutionItem[] {
    const manifest = object(value);
    if (!manifest || !Array.isArray(manifest.items)) return [];
    return manifest.items.flatMap((value): FrozenExecutionItem[] => {
        const row = object(value);
        if (!row || typeof row.itemId !== "string" || typeof row.sequence !== "number" || typeof row.agentName !== "string" || typeof row.commitSha !== "string") return [];
        const acceptedExecutionId = typeof row.acceptedExecutionId === "string" ? row.acceptedExecutionId : null;
        const evidence = parseExecutionEvidence(row.executionEvidence);
        return [{ itemId: row.itemId, sequence: row.sequence, agentName: row.agentName, commitSha: row.commitSha, acceptedExecutionId,
            executionEvidence: evidence?.executionId === acceptedExecutionId && evidence.agentName === row.agentName ? evidence : null }];
    });
}
