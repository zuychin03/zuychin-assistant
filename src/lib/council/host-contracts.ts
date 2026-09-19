import { z } from "zod";
import { isCouncilHost } from "../agents/scopes";

export interface CouncilCaller {
    readonly scopes: readonly string[];
}

export function requireCouncilHost(caller: CouncilCaller | undefined): void {
    if (!Array.isArray(caller?.scopes) || !isCouncilHost(caller.scopes)) {
        throw new Error("This tool requires the dedicated Council host credential.");
    }
}

export const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
export const reportSchema = z.string().min(1).max(16000);
export const hostFenceShape = {
    hostId: z.string().uuid(),
    leaseEpoch: z.number().int().positive(),
};

export const claimLeaseSchema = z.object({
    sessionId: z.string().uuid(),
    hostId: hostFenceShape.hostId,
    durationSeconds: z.number().int().positive().optional(),
});
export const renewLeaseSchema = claimLeaseSchema.extend({ leaseEpoch: hostFenceShape.leaseEpoch });
export const sessionFenceSchema = z.object({ sessionId: z.string().uuid(), ...hostFenceShape });
export const issueHostSeatSchema = sessionFenceSchema.extend({
    seatName: z.string().min(1),
    ttlHours: z.number().positive().finite().optional(),
});

export const deliveryFenceSchema = z.object({ deliveryId: z.string().uuid(), ...hostFenceShape });
export const failDeliverySchema = deliveryFenceSchema.extend({ error: z.string().max(2000) });
export const prepareDeliverySchema = sessionFenceSchema.extend({
    agentName: z.string().min(1),
    fromSeq: z.number().int().nonnegative(),
    throughSeq: z.number().int().nonnegative(),
    promptHash: z.string().min(1),
    promptBody: z.string(),
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
    hostGeneration: z.string().min(1),
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

export const verificationReceiptSchema = z.object({
    command: z.array(z.string()),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().nonnegative().finite(),
    outputDigest: z.string(),
    outputTail: z.string(),
    timedOut: z.boolean().optional(),
});
export const exactVerificationSchema = z.object({
    itemId: z.string().uuid(),
    ...hostFenceShape,
    commitSha: commitShaSchema,
    baseSha: commitShaSchema,
    branchName: z.string().min(1).max(300),
    profileId: z.string().min(1).max(100),
    passed: z.boolean(),
    receipts: z.array(verificationReceiptSchema).max(20),
    outputDigest: z.string().min(1),
    report: reportSchema.describe("Checks run and their outcomes, bound to the exact commit and frozen base."),
});
export const integrationReportSchema = sessionFenceSchema.extend({
    status: z.enum(["running", "verified", "conflict", "failed"]),
    branch: z.string().max(200).optional(),
    tipSha: commitShaSchema.optional(),
    reporter: z.string().min(1),
    report: reportSchema,
});
