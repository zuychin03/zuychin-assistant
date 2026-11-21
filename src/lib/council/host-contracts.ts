import { z } from "zod";
import { isCouncilHost } from "../agents/scopes";
import { NODE_POLICY_VERSION } from "./policy-versions";

export interface CouncilCaller {
    readonly scopes: readonly string[];
}

export function requireCouncilHost(caller: CouncilCaller | undefined): void {
    if (!Array.isArray(caller?.scopes) || !isCouncilHost(caller.scopes)) {
        throw new Error("This tool requires the dedicated Council host credential.");
    }
}

export const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
export const hostFenceShape = {
    hostId: z.string().uuid(),
    leaseEpoch: z.number().int().positive(),
};

export const claimLeaseSchema = z.object({
    sessionId: z.string().uuid(),
    hostId: hostFenceShape.hostId,
    durationSeconds: z.number().int().positive().optional(),
    policyVersion: z.literal(NODE_POLICY_VERSION).optional(),
});
export const renewLeaseSchema = claimLeaseSchema.extend({ leaseEpoch: hostFenceShape.leaseEpoch });
export const sessionFenceSchema = z.object({ sessionId: z.string().uuid(), ...hostFenceShape });
export const issueHostSeatSchema = sessionFenceSchema.extend({
    seatName: z.string().min(1),
    bindExecution: z.boolean().optional(),
    ttlHours: z.number().positive().finite().optional(),
});

export const capabilitySchema = z.object({
    kind: z.enum(["acp", "mcp", "managed_api", "managed_cli", "text_only", "manual"]),
    source: z.enum(["probed", "configured", "declared"]),
    streaming: z.boolean(), cancellation: z.boolean(), sessionResume: z.boolean(),
    modelSelection: z.boolean(), structuredActions: z.boolean(), toolCalls: z.boolean(),
    permissionCallbacks: z.boolean(), filesystemMediated: z.boolean(), terminalMediated: z.boolean(),
    observedAt: z.string().datetime(),
});
export const startExecutionSchema = sessionFenceSchema.extend({
    agentName: z.string().min(1),
    seatTokenHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    hostGeneration: z.string().min(1),
    policyVersion: z.literal(NODE_POLICY_VERSION).optional(),
    capabilities: capabilitySchema,
    identityAssurance: z.enum(["verified_seat", "host_bound", "owner_relay", "unverified_declaration"]),
    provider: z.string().min(1),
    adapterVersion: z.string().optional(),
    requestedModel: z.string().optional(),
    effectiveModel: z.string().optional(),
    requestedReasoningEffort: z.string().optional(),
    effectiveReasoningEffort: z.string().optional(),
    modelSource: z.string().optional(),
    branch: z.string().optional(),
    worktree: z.string().optional(),
    baseSha: commitShaSchema.optional(),
});
export const stopExecutionSchema = z.object({
    executionId: z.string().uuid(),
    ...hostFenceShape,
    stopReason: z.string().min(1).max(500),
});
