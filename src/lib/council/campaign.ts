import { supabaseAdmin as supabase } from "@/lib/supabase";

export type CampaignStatus = "running" | "complete" | "blocked" | "cancelled";
export type WorkItemStatus = "queued" | "in_progress" | "awaiting_review" | "verified" | "blocked" | "cancelled";

export interface CouncilWorkItemInput {
    agentName: string;
    title: string;
    instructions: string;
    acceptanceCriteria: string[];
}

export interface CouncilCampaign {
    id: string;
    sessionId: string;
    status: CampaignStatus;
    repoPath: string;
    baseBranch: string;
    createdAt: string;
    completedAt: string | null;
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
    verification: string | null;
    blockedReason: string | null;
    startedAt: string | null;
    completedAt: string | null;
    reviewedAt: string | null;
}

interface CampaignRow {
    id: string; session_id: string; status: CampaignStatus; repo_path: string; base_branch: string;
    created_at: string; completed_at: string | null;
}

interface WorkItemRow {
    id: string; campaign_id: string; sequence: number; agent_name: string; title: string;
    instructions: string; acceptance_criteria: string[] | null; status: WorkItemStatus;
    heartbeat_at: string | null; attempts: number; progress: string | null; commit_hash: string | null;
    verification: string | null; blocked_reason: string | null; started_at: string | null;
    completed_at: string | null; reviewed_at: string | null;
}

const CAMPAIGN_COLUMNS = "id, session_id, status, repo_path, base_branch, created_at, completed_at";
const ITEM_COLUMNS = "id, campaign_id, sequence, agent_name, title, instructions, acceptance_criteria, status, heartbeat_at, attempts, progress, commit_hash, verification, blocked_reason, started_at, completed_at, reviewed_at";

function mapCampaign(row: CampaignRow): CouncilCampaign {
    return {
        id: row.id, sessionId: row.session_id, status: row.status, repoPath: row.repo_path,
        baseBranch: row.base_branch, createdAt: row.created_at, completedAt: row.completed_at,
    };
}

function mapItem(row: WorkItemRow): CouncilWorkItem {
    return {
        id: row.id, campaignId: row.campaign_id, sequence: row.sequence, agentName: row.agent_name,
        title: row.title, instructions: row.instructions, acceptanceCriteria: row.acceptance_criteria ?? [],
        status: row.status, heartbeatAt: row.heartbeat_at, attempts: row.attempts, progress: row.progress,
        commitHash: row.commit_hash, verification: row.verification, blockedReason: row.blocked_reason,
        startedAt: row.started_at, completedAt: row.completed_at, reviewedAt: row.reviewed_at,
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
    return data ? mapCampaign(data as CampaignRow) : null;
}

export async function getCampaignForSession(sessionId: string): Promise<CouncilCampaign | null> {
    const { data, error } = await supabase.from("council_campaigns").select(CAMPAIGN_COLUMNS).eq("session_id", sessionId).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? mapCampaign(data as CampaignRow) : null;
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

export async function reviewWorkItem(params: { itemId: string; reviewer: string; accepted: boolean; note: string }): Promise<boolean> {
    const { data, error } = await supabase.rpc("review_council_work_item", {
        p_item_id: params.itemId, p_reviewer: params.reviewer, p_accepted: params.accepted, p_note: params.note,
    });
    if (error) throw new Error(error.message);
    return data === true;
}
