import { supabaseAdmin as supabase } from "@/lib/supabase";
import { parseExecutionEvidence } from "./execution-evidence";
import { integrationEvidenceSchema, sanitiseIntegrationEvidence, sanitiseIntegrationText, sanitiseVerificationReceipts } from "./integration-evidence";
import { ownerDigest, ownerObject, ownerUuid, parseOwnerAttemptSummary, parseOwnerManifest, type OwnerAttempt, type OwnerAttemptPage, type OwnerAttemptSummary, type OwnerVerification, type OwnerVerificationReceipt } from "./owner-evidence";

const SUMMARY_COLUMNS = "id,attempt_number,status,mode,integrator_agent,manifest_hash,base_branch,base_sha,branch,tip_sha,started_at,finished_at";
const ATTEMPT_COLUMNS = `${SUMMARY_COLUMNS},campaign_id,manifest,decision,open_questions,execution_id,execution_evidence,evidence`;
const VERIFICATION_COLUMNS = "id,work_item_id,commit_sha,base_sha,execution_id,profile_id,passed,checked_at,command_receipts,item:council_work_items!work_item_id(campaign_id,campaign:council_campaigns!campaign_id(session_id))";
const PAGE_SIZE = 20;
type ReadStatus = "available" | "not_found" | "unavailable";
const displayText = (value: unknown, limit = 300): string | null => typeof value === "string" ? sanitiseIntegrationText(value, undefined, limit) : null;

function summary(row: Record<string, unknown>): OwnerAttemptSummary | null {
    return parseOwnerAttemptSummary({
        attemptId: row.id, attemptNumber: row.attempt_number, status: row.status, mode: row.mode,
        integratorAgent: displayText(row.integrator_agent, 200), manifestHash: row.manifest_hash,
        baseBranch: displayText(row.base_branch), baseSha: row.base_sha, branch: displayText(row.branch),
        tipSha: row.tip_sha, startedAt: row.started_at, finishedAt: row.finished_at,
    });
}

export async function listOwnerAttempts(sessionId: string, cursor: number | null = null): Promise<OwnerAttemptPage> {
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1)) throw new Error("Invalid attempt cursor.");
    try {
        let query = supabase.from("council_integration_attempts").select(SUMMARY_COLUMNS).eq("session_id", sessionId)
            .order("attempt_number", { ascending: false }).limit(PAGE_SIZE + 1);
        if (cursor !== null) query = query.lt("attempt_number", cursor);
        const { data, error } = await query;
        if (error) throw error;
        const rows = (data ?? []).slice(0, PAGE_SIZE);
        const attempts = rows.flatMap(row => { const parsed = summary(row); return parsed ? [parsed] : []; });
        return { attempts, nextCursor: (data?.length ?? 0) > PAGE_SIZE ? Number(rows.at(-1)!.attempt_number) : null,
            status: attempts.length === rows.length ? "available" : "unavailable" };
    } catch { return { attempts: [], nextCursor: null, status: "unavailable" }; }
}

export async function readOwnerAttempt(sessionId: string, attemptId: string): Promise<{ status: ReadStatus; attempt: OwnerAttempt | null }> {
    if (!ownerUuid(attemptId)) return { status: "not_found", attempt: null };
    try {
        const { data, error } = await supabase.from("council_integration_attempts").select(ATTEMPT_COLUMNS)
            .eq("session_id", sessionId).eq("id", attemptId).maybeSingle();
        if (error) throw error;
        if (!data) return { status: "not_found", attempt: null };
        const parsed = summary(data);
        if (!parsed) throw new Error("Invalid attempt.");
        const manifest = parseOwnerManifest(data.manifest);
        if (manifest && (manifest.campaignId !== data.campaign_id || manifest.baseSha !== parsed.baseSha)) throw new Error("Mismatched manifest.");
        if (manifest) for (const item of manifest.items) {
            item.agentName = displayText(item.agentName, 200)!;
            item.branch = displayText(item.branch)!;
            if (item.executionEvidence) {
                item.executionEvidence = sanitiseExecution(item.executionEvidence);
            }
        }
        const evidenceInput = integrationEvidenceSchema.safeParse(data.evidence);
        const evidence = evidenceInput.success ? sanitiseIntegrationEvidence(evidenceInput.data) : null;
        const execution = parseExecutionEvidence(data.execution_evidence);
        const executionId = ownerUuid(data.execution_id) ? data.execution_id : null;
        const executionEvidence = execution?.executionId === executionId && execution.agentName === data.integrator_agent ? sanitiseExecution(execution) : null;
        const attempt: OwnerAttempt = { ...parsed, manifest,
            decision: displayText(data.decision, 16000),
            openQuestions: Array.isArray(data.open_questions) ? data.open_questions.slice(0, 50).flatMap(value => typeof value === "string" ? [displayText(value, 2000)!] : []) : [],
            executionId, executionEvidence, evidence,
            evidenceStatus: data.evidence == null ? "not_recorded" : evidence ? "available" : "unavailable",
        };
        return { status: "available", attempt };
    } catch { return { status: "unavailable", attempt: null }; }
}

function sanitiseExecution(record: NonNullable<ReturnType<typeof parseExecutionEvidence>>) {
    return { ...record, agentName: displayText(record.agentName, 200)!, connectorKind: displayText(record.connectorKind, 100)!,
        identityAssurance: displayText(record.identityAssurance, 100)!, provider: displayText(record.provider),
        adapterVersion: displayText(record.adapterVersion), requestedModel: displayText(record.requestedModel),
        effectiveModel: displayText(record.effectiveModel), requestedReasoningEffort: displayText(record.requestedReasoningEffort),
        effectiveReasoningEffort: displayText(record.effectiveReasoningEffort), modelSource: displayText(record.modelSource, 100),
        hostGeneration: displayText(record.hostGeneration, 100), policyVersion: displayText(record.policyVersion, 100) };
}

function verificationReceipts(value: unknown): OwnerVerificationReceipt[] | null {
    if (!Array.isArray(value) || value.length > 20) return null;
    const receipts: OwnerVerificationReceipt[] = [];
    for (const entry of value) {
        const row = ownerObject(entry);
        if (!row || !ownerDigest(row.outputDigest) || typeof row.durationMs !== "number" || !Number.isFinite(row.durationMs) || row.durationMs < 0
            || (row.exitCode !== null && !Number.isSafeInteger(row.exitCode)) || (row.timedOut != null && typeof row.timedOut !== "boolean")) return null;
        if (row.redactionVersion === 1) {
            try {
                const safe = sanitiseVerificationReceipts([row])[0];
                if (!safe) return null;
                receipts.push({ command: safe.command, exitCode: safe.exitCode, durationMs: safe.durationMs, outputDigest: safe.outputDigest,
                    outputTail: safe.outputTail, timedOut: safe.timedOut ?? false, textStatus: "redacted" });
            } catch { return null; }
        } else {
            receipts.push({ command: null, exitCode: row.exitCode as number | null, durationMs: row.durationMs,
                outputDigest: row.outputDigest, outputTail: null, timedOut: row.timedOut as boolean ?? false, textStatus: "withheld" });
        }
    }
    return receipts;
}

export async function readOwnerVerification(sessionId: string, attemptId: string, runId: string): Promise<{ status: ReadStatus; verification: OwnerVerification | null }> {
    const loaded = await readOwnerAttempt(sessionId, attemptId);
    if (loaded.status !== "available" || !loaded.attempt) return { status: loaded.status, verification: null };
    if (!loaded.attempt.manifest) return { status: "unavailable", verification: null };
    const item = loaded.attempt.manifest.items.find(item => item.verificationRunId === runId);
    if (!item || !ownerUuid(runId)) return { status: "not_found", verification: null };
    try {
        const { data, error } = await supabase.from("council_verification_runs").select(VERIFICATION_COLUMNS)
            .eq("id", runId).eq("work_item_id", item.itemId).eq("commit_sha", item.commitSha).eq("base_sha", loaded.attempt.baseSha).maybeSingle();
        if (error || !data) throw error ?? new Error("Missing verification.");
        const row = data as unknown as Record<string, unknown>;
        const linkedItem = ownerObject(row.item), linkedCampaign = ownerObject(linkedItem?.campaign);
        const receipts = verificationReceipts(row.command_receipts);
        if (row.id !== runId || row.work_item_id !== item.itemId || row.commit_sha !== item.commitSha || row.base_sha !== loaded.attempt.baseSha
            || (row.execution_id ?? null) !== item.acceptedExecutionId || linkedItem?.campaign_id !== loaded.attempt.manifest.campaignId
            || linkedCampaign?.session_id !== sessionId || !receipts || typeof row.passed !== "boolean" || typeof row.profile_id !== "string"
            || typeof row.checked_at !== "string" || !Number.isFinite(Date.parse(row.checked_at))) throw new Error("Mismatched verification.");
        return { status: "available", verification: { verificationRunId: runId, itemId: item.itemId, commitSha: item.commitSha,
            baseSha: loaded.attempt.baseSha, executionId: item.acceptedExecutionId, profileId: displayText(row.profile_id, 100)!,
            passed: row.passed, checkedAt: row.checked_at, receipts } };
    } catch { return { status: "unavailable", verification: null }; }
}
