import { supabaseAdmin as supabase } from "@/lib/supabase";

export type CampaignStatus = "running" | "complete" | "blocked" | "cancelled";
export type WorkItemStatus = "queued" | "in_progress" | "awaiting_review" | "verified" | "blocked" | "cancelled";
export type IntegrationStatus = "pending" | "running" | "verified" | "conflict" | "failed";

export interface CouncilWorkItemInput {
    agentName: string;
    title: string;
    instructions: string;
    acceptanceCriteria: string[];
    declaredPaths?: string[];
    verificationProfile?: string;
    dependencies?: string[];
}

export interface CouncilCampaign {
    id: string;
    sessionId: string;
    status: CampaignStatus;
    repoPath: string;
    baseBranch: string;
    createdAt: string;
    completedAt: string | null;
    integratorAgent: string | null;
    integrationBranch: string | null;
    integrationStatus: IntegrationStatus | null;
    integrationReport: string | null;
    integrationCheckedAt: string | null;
    baseSha: string | null;
    verificationProfile: string;
    integrationManifest: CouncilIntegrationManifest | null;
    manifestFrozenAt: string | null;
    integrationTipSha: string | null;
}

export interface CouncilIntegrationManifest {
    version: number;
    campaignId: string;
    baseSha: string;
    items: { itemId: string; sequence: number; agentName: string; branch: string; commitSha: string; verificationRunId: string; dependencies: string[] }[];
}

export interface CouncilWorkItem {
    id: string;
    campaignId: string;
    sequence: number;
    agentName: string;
    title: string;
    instructions: string;
    acceptanceCriteria: string[];
    status: WorkItemStatus;
    heartbeatAt: string | null;
    attempts: number;
    progress: string | null;
    commitHash: string | null;
    /** The agent's own account of its work. Never sufficient to accept an item. */
    verification: string | null;
    /** What the host checked itself. null = not checked yet. */
    hostVerified: boolean | null;
    hostVerification: string | null;
    hostCheckedAt: string | null;
    declaredPaths: string[];
    blockedReason: string | null;
    startedAt: string | null;
    completedAt: string | null;
    reviewedAt: string | null;
    branchName: string | null;
    acceptedCommitSha: string | null;
    verificationProfile: string;
    verificationRunId: string | null;
    dependencies: string[];
}

interface CampaignRow {
    id: string; session_id: string; status: CampaignStatus; repo_path: string; base_branch: string;
    created_at: string; completed_at: string | null;
    integrator_agent: string | null; integration_branch: string | null;
    integration_status: IntegrationStatus | null; integration_report: string | null;
    integration_checked_at: string | null;
    base_sha: string | null; verification_profile: string; integration_manifest: CouncilIntegrationManifest | null;
    manifest_frozen_at: string | null; integration_tip_sha: string | null;
}

interface WorkItemRow {
    id: string; campaign_id: string; sequence: number; agent_name: string; title: string;
    instructions: string; acceptance_criteria: string[] | null; status: WorkItemStatus;
    heartbeat_at: string | null; attempts: number; progress: string | null; commit_hash: string | null;
    verification: string | null; blocked_reason: string | null; started_at: string | null;
    completed_at: string | null; reviewed_at: string | null;
    host_verified: boolean | null; host_verification: string | null; host_checked_at: string | null;
    declared_paths: string[] | null;
    branch_name: string | null; accepted_commit_sha: string | null; verification_profile: string;
    verification_run_id: string | null; dependencies: string[] | null;
}

const CAMPAIGN_COLUMNS = "id, session_id, status, repo_path, base_branch, created_at, completed_at, "
    + "integrator_agent, integration_branch, integration_status, integration_report, integration_checked_at, base_sha, verification_profile, integration_manifest, manifest_frozen_at, integration_tip_sha";
const ITEM_COLUMNS = "id, campaign_id, sequence, agent_name, title, instructions, acceptance_criteria, status, heartbeat_at, attempts, progress, commit_hash, verification, blocked_reason, started_at, completed_at, reviewed_at, host_verified, host_verification, host_checked_at, declared_paths, branch_name, accepted_commit_sha, verification_profile, verification_run_id, dependencies";

function mapCampaign(row: CampaignRow): CouncilCampaign {
    return {
        id: row.id, sessionId: row.session_id, status: row.status, repoPath: row.repo_path,
        baseBranch: row.base_branch, createdAt: row.created_at, completedAt: row.completed_at,
        integratorAgent: row.integrator_agent, integrationBranch: row.integration_branch,
        integrationStatus: row.integration_status, integrationReport: row.integration_report,
        integrationCheckedAt: row.integration_checked_at,
        baseSha: row.base_sha, verificationProfile: row.verification_profile,
        integrationManifest: row.integration_manifest, manifestFrozenAt: row.manifest_frozen_at,
        integrationTipSha: row.integration_tip_sha,
    };
}

function mapItem(row: WorkItemRow): CouncilWorkItem {
    return {
        id: row.id, campaignId: row.campaign_id, sequence: row.sequence, agentName: row.agent_name,
        title: row.title, instructions: row.instructions, acceptanceCriteria: row.acceptance_criteria ?? [],
        status: row.status, heartbeatAt: row.heartbeat_at, attempts: row.attempts, progress: row.progress,
        commitHash: row.commit_hash, verification: row.verification, blockedReason: row.blocked_reason,
        startedAt: row.started_at, completedAt: row.completed_at, reviewedAt: row.reviewed_at,
        hostVerified: row.host_verified, hostVerification: row.host_verification,
        hostCheckedAt: row.host_checked_at, declaredPaths: row.declared_paths ?? [],
        branchName: row.branch_name, acceptedCommitSha: row.accepted_commit_sha,
        verificationProfile: row.verification_profile, verificationRunId: row.verification_run_id,
        dependencies: row.dependencies ?? [],
    };
}

export async function createCampaign(params: {
    sessionId: string;
    createdBy: string;
    workItems: CouncilWorkItemInput[];
}): Promise<{ campaign: CouncilCampaign; created: boolean }> {
    const { data, error } = await supabase.rpc("create_council_campaign", {
        p_session_id: params.sessionId,
        p_created_by: params.createdBy,
        p_work_items: params.workItems.map((item) => ({
            agent_name: item.agentName,
            title: item.title,
            instructions: item.instructions,
            acceptance_criteria: item.acceptanceCriteria,
            declared_paths: item.declaredPaths ?? [],
            verification_profile: item.verificationProfile ?? "standard",
            dependencies: item.dependencies ?? [],
        })),
    });
    if (error) throw new Error(error.message);
    const result = data as { campaign_id?: string; created?: boolean } | null;
    if (!result?.campaign_id) throw new Error("Campaign could not be created.");
    const campaign = await getCampaignById(result.campaign_id);
    if (!campaign) throw new Error("Campaign was created but could not be read.");
    return { campaign, created: result.created === true };
}

export async function getCampaignById(id: string): Promise<CouncilCampaign | null> {
    const { data, error } = await supabase.from("council_campaigns").select(CAMPAIGN_COLUMNS).eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? mapCampaign(data as unknown as CampaignRow) : null;
}

export async function getCampaignForSession(sessionId: string): Promise<CouncilCampaign | null> {
    const { data, error } = await supabase.from("council_campaigns").select(CAMPAIGN_COLUMNS).eq("session_id", sessionId).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? mapCampaign(data as unknown as CampaignRow) : null;
}

export async function listCampaignWorkItems(campaignId: string): Promise<CouncilWorkItem[]> {
    const { data, error } = await supabase.from("council_work_items").select(ITEM_COLUMNS).eq("campaign_id", campaignId).order("sequence");
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => mapItem(row as WorkItemRow));
}

export async function claimNextWorkItem(sessionId: string, agentName: string): Promise<CouncilWorkItem | null> {
    const { data, error } = await supabase.rpc("claim_council_work_item", {
        p_session_id: sessionId,
        p_agent_name: agentName,
    });
    if (error) throw new Error(error.message);
    return data ? mapItem(data as WorkItemRow) : null;
}

export async function heartbeatWorkItem(params: { itemId: string; agentName: string; progress?: string }): Promise<boolean> {
    const { data, error } = await supabase.rpc("heartbeat_council_work_item", {
        p_item_id: params.itemId, p_agent_name: params.agentName, p_progress: params.progress ?? null,
    });
    if (error) throw new Error(error.message);
    return data === true;
}

export async function completeWorkItem(params: {
    itemId: string; agentName: string; commitHash: string; verification: string;
}): Promise<boolean> {
    const { data, error } = await supabase.rpc("complete_council_work_item", {
        p_item_id: params.itemId, p_agent_name: params.agentName,
        p_commit_hash: params.commitHash, p_verification: params.verification,
    });
    if (error) throw new Error(error.message);
    return data === true;
}

export async function blockWorkItem(params: { itemId: string; agentName: string; reason: string }): Promise<boolean> {
    const { data, error } = await supabase.rpc("block_council_work_item", {
        p_item_id: params.itemId, p_agent_name: params.agentName, p_reason: params.reason,
    });
    if (error) throw new Error(error.message);
    return data === true;
}

export async function reviewWorkItem(params: {
    itemId: string; reviewer: string; accepted: boolean; note: string;
}): Promise<{ ok: boolean; reason?: string }> {
    const { data, error } = await supabase.rpc("review_council_work_item", {
        p_item_id: params.itemId, p_reviewer: params.reviewer, p_accepted: params.accepted, p_note: params.note,
    });
    if (error) throw new Error(error.message);
    return (data ?? { ok: false, reason: "no_result" }) as { ok: boolean; reason?: string };
}

// What the HOST observed, kept apart from what the agent claimed. A failure
// bounces the item back to its owner rather than parking it in review.
export async function recordHostVerification(params: {
    itemId: string; passed: boolean; report: string;
}): Promise<boolean> {
    const { data, error } = await supabase.rpc("record_host_verification", {
        p_item_id: params.itemId, p_passed: params.passed, p_report: params.report,
    });
    if (error) throw new Error(error.message);
    return data === true;
}

export async function setCampaignIntegrator(params: {
    sessionId: string; agentName: string;
}): Promise<{ ok: boolean; reason?: string; status?: string }> {
    const { data, error } = await supabase.rpc("set_campaign_integrator", {
        p_session_id: params.sessionId, p_agent: params.agentName,
    });
    if (error) throw new Error(error.message);
    return (data ?? { ok: false, reason: "no_result" }) as { ok: boolean; reason?: string; status?: string };
}

export async function recordCampaignIntegration(params: {
    sessionId: string; status: IntegrationStatus; branch?: string; report: string;
}): Promise<{ ok: boolean; reason?: string }> {
    const { data, error } = await supabase.rpc("record_campaign_integration", {
        p_session_id: params.sessionId, p_status: params.status,
        p_branch: params.branch ?? null, p_report: params.report,
    });
    if (error) throw new Error(error.message);
    return (data ?? { ok: false, reason: "no_result" }) as { ok: boolean; reason?: string };
}

export interface VerificationReceipt {
    command: string[];
    exitCode: number | null;
    durationMs: number;
    outputDigest: string;
    outputTail: string;
    timedOut?: boolean;
}

export async function recordExactVerification(params: {
    itemId: string; hostId: string; leaseEpoch: number; commitSha: string; baseSha: string;
    branchName: string; profileId: string; receipts: VerificationReceipt[];
    outputDigest: string; passed: boolean; report: string;
}): Promise<{ ok: boolean; reason?: string; verificationRunId?: string }> {
    const { data, error } = await supabase.rpc("record_council_verification", {
        p_item_id: params.itemId, p_host_id: params.hostId, p_lease_epoch: params.leaseEpoch,
        p_commit_sha: params.commitSha, p_base_sha: params.baseSha, p_branch_name: params.branchName,
        p_profile_id: params.profileId, p_command_receipts: params.receipts,
        p_output_digest: params.outputDigest, p_passed: params.passed, p_report: params.report,
    });
    if (error) throw new Error(error.message);
    return (data ?? { ok: false, reason: "no_result" }) as { ok: boolean; reason?: string; verificationRunId?: string };
}

export async function freezeIntegrationManifest(params: {
    sessionId: string; hostId: string; leaseEpoch: number;
}): Promise<{ ok: boolean; reason?: string; manifest?: CouncilIntegrationManifest; frozen?: boolean }> {
    const { data, error } = await supabase.rpc("freeze_council_integration_manifest", {
        p_session_id: params.sessionId, p_host_id: params.hostId, p_lease_epoch: params.leaseEpoch,
    });
    if (error) throw new Error(error.message);
    return (data ?? { ok: false, reason: "no_result" }) as { ok: boolean; reason?: string; manifest?: CouncilIntegrationManifest; frozen?: boolean };
}

export async function recordV3Integration(params: {
    sessionId: string; reporter: string; hostId: string; leaseEpoch: number;
    status: IntegrationStatus; branch?: string; tipSha?: string; report: string;
}): Promise<{ ok: boolean; reason?: string }> {
    const { data, error } = await supabase.rpc("record_council_integration_v3", {
        p_session_id: params.sessionId, p_reporter: params.reporter, p_host_id: params.hostId,
        p_lease_epoch: params.leaseEpoch, p_status: params.status, p_branch: params.branch ?? null,
        p_tip_sha: params.tipSha ?? null, p_report: params.report,
    });
    if (error) throw new Error(error.message);
    return (data ?? { ok: false, reason: "no_result" }) as { ok: boolean; reason?: string };
}
