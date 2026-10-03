import { supabaseAdmin as supabase } from "@/lib/supabase";
import { z } from "zod";
import {
    claimLeaseSchema, deliveryFenceSchema, failDeliverySchema, prepareDeliverySchema,
    renewLeaseSchema, requireCouncilHost, sessionFenceSchema, startExecutionSchema,
    stopExecutionSchema, type CouncilCaller,
} from "./host-contracts";
import type {
    ConnectorCapabilitySnapshot, IdentityAssurance,
} from "./v3";
import { COUNCIL_HOST_GENERATION } from "./v3";

export interface HostLease {
    ok: boolean;
    reason?: string;
    hostId?: string;
    leaseEpoch?: number;
    leaseExpiresAt?: string;
    hostGeneration?: string | null;
    policyVersion?: string | null;
    hasExecutionHistory?: boolean;
    cleanupConfirmed?: boolean;
}

const executionBoundarySchema = z.object({
    ok: z.literal(true),
    hostGeneration: z.string().min(1).max(100).nullable(),
    policyVersion: z.string().min(1).max(100).nullable(),
    hasExecutionHistory: z.boolean(),
}).strict();

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
    sessionId: string; hostId: string; durationSeconds?: number; policyVersion?: string;
}, caller: CouncilCaller | undefined): Promise<HostLease> {
    requireCouncilHost(caller);
    params = claimLeaseSchema.parse(params);
    const { data, error } = await supabase.rpc("claim_council_host_lease", {
        p_session_id: params.sessionId,
        p_host_id: params.hostId,
        p_duration_seconds: params.durationSeconds ?? 45,
    });
    if (error) throw new Error(error.message);
    const lease = (data ?? { ok: false, reason: "no_result" }) as HostLease;
    if (!params.policyVersion || !lease.ok) return lease;
    if (!Number.isSafeInteger(lease.leaseEpoch) || lease.leaseEpoch! <= 0) {
        return { ok: false, reason: "execution_policy_unavailable", cleanupConfirmed: false };
    }
    const fence = { sessionId: params.sessionId, hostId: params.hostId, leaseEpoch: lease.leaseEpoch! };
    try {
        const result = await supabase.rpc("get_council_execution_boundary", {
            p_session_id: fence.sessionId, p_host_id: fence.hostId, p_lease_epoch: fence.leaseEpoch,
        });
        if (!result.error) {
            const boundary = executionBoundarySchema.safeParse(result.data);
            if (boundary.success) return { ...lease, ...boundary.data };
        }
    } catch { /* The acquired lease still needs cleanup. */ }
    let cleanupConfirmed = false;
    try { cleanupConfirmed = await releaseHostLease(fence, caller); }
    catch { /* Lease expiry remains the fallback. */ }
    return { ok: false, reason: "execution_policy_unavailable", cleanupConfirmed };
}

export async function renewHostLease(params: {
    sessionId: string; hostId: string; leaseEpoch: number; durationSeconds?: number;
}, caller: CouncilCaller | undefined): Promise<HostLease> {
    requireCouncilHost(caller);
    params = renewLeaseSchema.parse(params);
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
}, caller: CouncilCaller | undefined): Promise<boolean> {
    requireCouncilHost(caller);
    params = sessionFenceSchema.parse(params);
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
}, caller: CouncilCaller | undefined): Promise<{ ok: boolean; reason?: string; delivery?: CouncilDelivery }> {
    requireCouncilHost(caller);
    params = prepareDeliverySchema.parse(params);
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
}, caller: CouncilCaller | undefined): Promise<boolean> {
    requireCouncilHost(caller);
    params = failDeliverySchema.parse(params);
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
}, caller: CouncilCaller | undefined): Promise<boolean> {
    requireCouncilHost(caller);
    params = deliveryFenceSchema.parse(params);
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
}, caller: CouncilCaller | undefined): Promise<{ ok: boolean; reason?: string; throughSeq?: number }> {
    requireCouncilHost(caller);
    params = deliveryFenceSchema.parse(params);
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
    seatTokenHash?: string;
    hostId: string;
    leaseEpoch: number;
    hostGeneration: string;
    policyVersion?: string;
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
}, caller: CouncilCaller | undefined): Promise<{ ok: boolean; reason?: string; executionId?: string; seatBound?: boolean; policyVersion?: string | null; hostGeneration?: string }> {
    requireCouncilHost(caller);
    params = startExecutionSchema.parse(params);
    if (params.policyVersion && (!params.seatTokenHash || params.hostGeneration !== COUNCIL_HOST_GENERATION)) {
        throw new Error("Versioned executions require a bound seat and the supported host generation.");
    }
    const operation = params.policyVersion ? "start_council_versioned_bound_execution"
        : params.seatTokenHash ? "start_council_bound_agent_execution" : "start_council_agent_execution";
    const { data, error } = await supabase.rpc(operation, {
        ...(params.policyVersion ? { p_policy_version: params.policyVersion } : {}),
        ...(params.seatTokenHash ? { p_seat_token_hash: params.seatTokenHash } : {}),
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
        ok: boolean; reason?: string; executionId?: string; seatBound?: boolean; policyVersion?: string | null; hostGeneration?: string;
    };
}

export async function stopAgentExecution(params: {
    executionId: string; hostId: string; leaseEpoch: number; stopReason: string;
}, caller: CouncilCaller | undefined): Promise<boolean> {
    requireCouncilHost(caller);
    params = stopExecutionSchema.parse(params);
    const { data, error } = await supabase.rpc("stop_council_agent_execution", {
        p_execution_id: params.executionId,
        p_host_id: params.hostId,
        p_lease_epoch: params.leaseEpoch,
        p_stop_reason: params.stopReason,
    });
    if (error) throw new Error(error.message);
    return data === true;
}
