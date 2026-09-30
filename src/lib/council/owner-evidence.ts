import { EXECUTION_ID_PATTERN, parseExecutionEvidence, type CouncilExecutionEvidence } from "./execution-evidence";
import type { IntegrationEvidence } from "./integration-evidence";

export interface OwnerManifestItem {
    itemId: string; sequence: number; agentName: string; branch: string; commitSha: string;
    verificationRunId: string; dependencies: string[];
    acceptedExecutionId: string | null; executionEvidence: CouncilExecutionEvidence | null;
}
export interface OwnerManifest {
    version: 1; campaignId: string; baseSha: string; items: OwnerManifestItem[];
}
export interface OwnerAttemptSummary {
    attemptId: string; attemptNumber: number; status: "running" | "verified" | "conflict" | "failed";
    mode: "host" | "agent"; integratorAgent: string | null; manifestHash: string; baseBranch: string;
    baseSha: string; branch: string | null; tipSha: string | null; startedAt: string; finishedAt: string | null;
}
export interface OwnerAttempt extends OwnerAttemptSummary {
    manifest: OwnerManifest | null; decision: string | null; openQuestions: string[];
    executionId: string | null; executionEvidence: CouncilExecutionEvidence | null;
    evidence: IntegrationEvidence | null; evidenceStatus: "available" | "not_recorded" | "unavailable";
}
export interface OwnerAttemptPage {
    attempts: OwnerAttemptSummary[]; nextCursor: number | null; status: "available" | "unavailable";
}
export interface OwnerVerificationReceipt {
    command: string[] | null; exitCode: number | null; durationMs: number; outputDigest: string;
    outputTail: string | null; timedOut: boolean; textStatus: "redacted" | "withheld";
}
export interface OwnerVerification {
    verificationRunId: string; itemId: string; commitSha: string; baseSha: string; executionId: string | null;
    profileId: string; passed: boolean; checkedAt: string; receipts: OwnerVerificationReceipt[];
}

export const ownerUuid = (value: unknown): value is string => typeof value === "string" && value.length === 36 && EXECUTION_ID_PATTERN.test(value);
export const ownerSha = (value: unknown): value is string => typeof value === "string" && value.length === 40 && /^[0-9a-f]+$/i.test(value);
export const ownerDigest = (value: unknown): value is string => typeof value === "string" && value.length === 64 && /^[0-9a-f]+$/i.test(value);
export const ownerObject = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const boundedText = (value: unknown, limit: number): value is string => typeof value === "string" && value.length > 0 && value.length <= limit;

export function ownerCompareCommand(baseSha: unknown, tipSha: unknown): string | null {
    return ownerSha(baseSha) && ownerSha(tipSha) ? `git diff ${baseSha} ${tipSha} --` : null;
}

export function parseOwnerManifest(value: unknown): OwnerManifest | null {
    const row = ownerObject(value);
    if (!row || row.version !== 1 || !ownerUuid(row.campaignId) || !ownerSha(row.baseSha)
        || !Array.isArray(row.items) || row.items.length === 0 || row.items.length > 200) return null;
    const items: OwnerManifestItem[] = [];
    for (const value of row.items) {
        const item = ownerObject(value);
        if (!item || !ownerUuid(item.itemId) || !ownerUuid(item.verificationRunId) || !ownerSha(item.commitSha)
            || !Number.isSafeInteger(item.sequence) || Number(item.sequence) < 0 || !boundedText(item.agentName, 200) || !boundedText(item.branch, 300)
            || !Array.isArray(item.dependencies) || item.dependencies.length > 200 || !item.dependencies.every(ownerUuid)
            || (item.acceptedExecutionId != null && !ownerUuid(item.acceptedExecutionId)) || items.some(old => old.itemId === item.itemId)) return null;
        const acceptedExecutionId = item.acceptedExecutionId as string ?? null;
        const parsed = parseExecutionEvidence(item.executionEvidence);
        items.push({
            itemId: item.itemId, sequence: Number(item.sequence), agentName: item.agentName, branch: item.branch,
            commitSha: item.commitSha, verificationRunId: item.verificationRunId, dependencies: [...item.dependencies],
            acceptedExecutionId, executionEvidence: parsed?.executionId === acceptedExecutionId && parsed.agentName === item.agentName ? parsed : null,
        });
    }
    return { version: 1, campaignId: row.campaignId, baseSha: row.baseSha, items };
}

export function parseOwnerAttemptSummary(value: unknown): OwnerAttemptSummary | null {
    const row = ownerObject(value);
    if (!row || !ownerUuid(row.attemptId) || !Number.isSafeInteger(row.attemptNumber) || Number(row.attemptNumber) < 1
        || !["running", "verified", "conflict", "failed"].includes(String(row.status)) || !["host", "agent"].includes(String(row.mode))
        || !ownerDigest(row.manifestHash) || !ownerSha(row.baseSha) || !boundedText(row.baseBranch, 300)
        || !boundedText(row.startedAt, 64) || !Number.isFinite(Date.parse(row.startedAt))
        || (row.finishedAt != null && (!boundedText(row.finishedAt, 64) || !Number.isFinite(Date.parse(row.finishedAt))))
        || (row.tipSha != null && !ownerSha(row.tipSha)) || (row.branch != null && !boundedText(row.branch, 300))
        || (row.integratorAgent != null && !boundedText(row.integratorAgent, 200))) return null;
    return { attemptId: row.attemptId, attemptNumber: Number(row.attemptNumber), status: row.status as OwnerAttemptSummary["status"],
        mode: row.mode as OwnerAttemptSummary["mode"], integratorAgent: row.integratorAgent as string ?? null,
        manifestHash: row.manifestHash, baseBranch: row.baseBranch, baseSha: row.baseSha,
        branch: row.branch as string ?? null, tipSha: row.tipSha as string ?? null, startedAt: row.startedAt,
        finishedAt: row.finishedAt as string ?? null };
}
