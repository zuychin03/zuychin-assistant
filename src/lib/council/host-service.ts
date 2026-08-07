import { supabaseAdmin as supabase } from "@/lib/supabase";
import type {
    ConnectorCapabilitySnapshot, IdentityAssurance,
} from "./v3";

export interface HostLease {
    ok: boolean;
    reason?: string;
    hostId?: string;
    leaseEpoch?: number;
    leaseExpiresAt?: string;
}

export interface CouncilDelivery {
    id: string;
    participantId: string;
    fromSeq: number;
    throughSeq: number;
    promptHash: string;
    promptBody: string;
    status: "prepared" | "in_flight" | "acknowledged" | "failed";
    attempt: number;
    redelivered: boolean;
}

export async function claimHostLease(params: {
    sessionId: string; hostId: string; durationSeconds?: number;
}): Promise<HostLease> {
    const { data, error } = await supabase.rpc("claim_council_host_lease", {
        p_session_id: params.sessionId,
        p_host_id: params.hostId,
        p_duration_seconds: params.durationSeconds ?? 45,
    });
    if (error) throw new Error(error.message);
    return (data ?? { ok: false, reason: "no_result" }) as HostLease;
}

export async function renewHostLease(params: {
    sessionId: string; hostId: string; leaseEpoch: number; durationSeconds?: number;
}): Promise<HostLease> {
    const { data, error } = await supabase.rpc("renew_council_host_lease", {
        p_session_id: params.sessionId,
        p_host_id: params.hostId,
        p_lease_epoch: params.leaseEpoch,
        p_duration_seconds: params.durationSeconds ?? 45,
    });
    if (error) throw new Error(error.message);
    return (data ?? { ok: false, reason: "no_result" }) as HostLease;
}

export async function releaseHostLease(params: {
    sessionId: string; hostId: string; leaseEpoch: number;
}): Promise<boolean> {
    const { data, error } = await supabase.rpc("release_council_host_lease", {
        p_session_id: params.sessionId,
        p_host_id: params.hostId,
        p_lease_epoch: params.leaseEpoch,
    });
    if (error) throw new Error(error.message);
    return data === true;
}

export async function prepareDelivery(params: {
    sessionId: string;
    agentName: string;
    hostId: string;
    leaseEpoch: number;
    fromSeq: number;
    throughSeq: number;
    promptHash: string;
    promptBody: string;
}): Promise<{ ok: boolean; reason?: string; delivery?: CouncilDelivery }> {
    const { data, error } = await supabase.rpc("prepare_council_delivery", {
        p_session_id: params.sessionId,
        p_agent_name: params.agentName,
        p_host_id: params.hostId,
        p_lease_epoch: params.leaseEpoch,
        p_from_seq: params.fromSeq,
        p_through_seq: params.throughSeq,
        p_prompt_hash: params.promptHash,
        p_prompt_body: params.promptBody,
    });
    if (error) throw new Error(error.message);
    const row = (data ?? { ok: false, reason: "no_result" }) as {
        ok: boolean; reason?: string; delivery?: {
            id: string; participant_id: string; from_seq: number; through_seq: number;
            prompt_hash: string; status: CouncilDelivery["status"]; attempt: number;
            prompt_body: string; redelivered?: boolean;
        };
    };
    return row.delivery ? {
        ok: row.ok,
        delivery: {
            id: row.delivery.id,
            participantId: row.delivery.participant_id,
            fromSeq: row.delivery.from_seq,
            throughSeq: row.delivery.through_seq,
            promptHash: row.delivery.prompt_hash,
            promptBody: row.delivery.prompt_body,
            status: row.delivery.status,
            attempt: row.delivery.attempt,
            redelivered: row.delivery.redelivered === true,
        },
    } : { ok: row.ok, reason: row.reason };
}

export async function failDelivery(params: {
    deliveryId: string; hostId: string; leaseEpoch: number; error: string;
}): Promise<boolean> {
    const { data, error } = await supabase.rpc("fail_council_delivery", {
        p_delivery_id: params.deliveryId,
        p_host_id: params.hostId,
        p_lease_epoch: params.leaseEpoch,
        p_error: params.error,
    });
    if (error) throw new Error(error.message);
    return data === true;
}

export async function markDeliveryInFlight(params: {
    deliveryId: string; hostId: string; leaseEpoch: number;
}): Promise<boolean> {
    const { data, error } = await supabase.rpc("mark_council_delivery_in_flight", {
        p_delivery_id: params.deliveryId,
        p_host_id: params.hostId,
        p_lease_epoch: params.leaseEpoch,
    });
    if (error) throw new Error(error.message);
    return data === true;
}

export async function acknowledgeDelivery(params: {
    deliveryId: string; hostId: string; leaseEpoch: number;
}): Promise<{ ok: boolean; reason?: string; throughSeq?: number }> {
    const { data, error } = await supabase.rpc("ack_council_delivery", {
        p_delivery_id: params.deliveryId,
        p_host_id: params.hostId,
        p_lease_epoch: params.leaseEpoch,
    });
    if (error) throw new Error(error.message);
    return (data ?? { ok: false, reason: "no_result" }) as {
        ok: boolean; reason?: string; throughSeq?: number;
    };
}

export async function startAgentExecution(params: {
    sessionId: string;
    agentName: string;
    hostId: string;
    leaseEpoch: number;
    hostGeneration: string;
    capabilities: ConnectorCapabilitySnapshot;
    identityAssurance: IdentityAssurance;
    provider: string;
    adapterVersion?: string;
    requestedModel?: string;
    effectiveModel?: string;
    requestedReasoningEffort?: string;
    effectiveReasoningEffort?: string;
    modelSource?: string;
    branch?: string;
    worktree?: string;
    baseSha?: string;
}): Promise<{ ok: boolean; reason?: string; executionId?: string }> {
    const { data, error } = await supabase.rpc("start_council_agent_execution", {
        p_session_id: params.sessionId,
        p_agent_name: params.agentName,
        p_host_id: params.hostId,
        p_lease_epoch: params.leaseEpoch,
        p_host_generation: params.hostGeneration,
        p_connector_kind: params.capabilities.kind,
        p_connector_capabilities: params.capabilities,
        p_capability_source: params.capabilities.source,
        p_identity_assurance: params.identityAssurance,
        p_provider: params.provider,
        p_adapter_version: params.adapterVersion ?? null,
        p_requested_model: params.requestedModel ?? null,
        p_effective_model: params.effectiveModel ?? null,
        p_requested_reasoning_effort: params.requestedReasoningEffort ?? null,
        p_effective_reasoning_effort: params.effectiveReasoningEffort ?? null,
        p_model_source: params.modelSource ?? null,
        p_branch_name: params.branch ?? null,
        p_worktree_path: params.worktree ?? null,
        p_base_sha: params.baseSha ?? null,
    });
    if (error) throw new Error(error.message);
    return (data ?? { ok: false, reason: "no_result" }) as {
        ok: boolean; reason?: string; executionId?: string;
    };
}

export async function stopAgentExecution(params: {
    executionId: string; hostId: string; leaseEpoch: number; stopReason: string;
}): Promise<boolean> {
    const { data, error } = await supabase.rpc("stop_council_agent_execution", {
        p_execution_id: params.executionId,
        p_host_id: params.hostId,
        p_lease_epoch: params.leaseEpoch,
        p_stop_reason: params.stopReason,
    });
    if (error) throw new Error(error.message);
    return data === true;
}
