import { z } from "zod";
import {
    actionSetV1Schema, connectorSnapshotV1Schema, hostFenceV1Schema, policyActionV1Schema,
    principalV1Schema, resourceRefV1Schema, type CouncilPolicyActionV1,
} from "./contracts-v1";
import { REFERENCE_POLICY_VERSION } from "./policy-versions";

const uuid = z.string().uuid();
const instant = z.string().datetime();
const actions = actionSetV1Schema;
const names = z.array(z.string().min(1).max(100)).max(100).refine(values => new Set(values).size === values.length);
const campaignStatus = z.enum(["running", "blocked", "complete", "cancelled"]).nullable();
const integrationStatus = z.enum(["pending", "running", "verified", "conflict", "failed"]).nullable();
const sessionStatus = z.enum(["open", "concluding", "awaiting_owner", "closed", "expired"]);
const leaseSchema = hostFenceV1Schema.extend({ expiresAt: instant, released: z.boolean() }).strict();
const lifecycleShape = { sessionStatus, pausedAt: instant.nullable(), campaignStatus, integrationStatus };
const approvalSchema = z.object({
    state: z.enum(["not_required", "pending", "approved", "denied"]),
    action: policyActionV1Schema.nullable(), resourceId: uuid.nullable(), participantId: uuid.nullable(),
}).strict();

export const policyInputV1Schema = z.object({
    schemaVersion: z.literal(1), policyVersion: z.string().min(1).max(100), action: policyActionV1Schema,
    principal: principalV1Schema, connector: connectorSnapshotV1Schema, resource: resourceRefV1Schema,
    grant: z.object({
        sessionId: uuid, participantId: uuid, allowedActions: actions, resourceScopeIds: names,
        expiresAt: instant, revoked: z.boolean(), policyVersion: z.string().min(1).max(100),
        hostFence: hostFenceV1Schema.nullable(),
    }).strict(),
    context: z.object({
        now: instant, sessionId: uuid, ...lifecycleShape, principalAuthenticated: z.boolean(), reachable: z.boolean(),
        lease: leaseSchema.nullable(), currentDeliveryId: uuid.nullable(),
        hostAllowedActions: actions, templateAllowedActions: actions,
        assignment: z.object({
            participantId: uuid, workItemId: uuid, allowedActions: actions, resourceScopeIds: names,
        }).strict().nullable(),
        closerParticipantId: uuid.nullable(), reviewerParticipantIds: z.array(uuid).max(100),
        nominatedIntegratorId: uuid.nullable(),
        resourceFacts: z.object({
            resourceId: uuid, canonical: z.boolean(), withinScope: z.boolean(), baseMatches: z.boolean(),
            protectedRef: z.boolean(), exactSubmission: z.boolean(), frozenManifest: z.boolean(),
            filesystemMediationRequired: z.boolean(), terminalMediationRequired: z.boolean(),
            networkMediationRequired: z.boolean(), hostOwnedCheckRunner: z.boolean(), gitControlled: z.boolean(),
        }).strict(),
        approval: approvalSchema,
    }).strict(),
}).strict();

export const seatLifetimeInputV1Schema = z.object({
    schemaVersion: z.literal(1), policyVersion: z.string().min(1).max(100), now: instant, ...lifecycleShape,
    credential: z.object({
        issuer: z.enum(["host", "owner"]), expiresAt: instant, revoked: z.boolean(), hostFence: hostFenceV1Schema.nullable(),
    }).strict(),
    lease: leaseSchema.nullable(),
}).strict();

export type CouncilReferencePolicyInputV1 = z.infer<typeof policyInputV1Schema>;
export type CouncilSeatLifetimeInputV1 = z.infer<typeof seatLifetimeInputV1Schema>;
export type CouncilReferenceDenialV1 =
    | "invalid_input" | "unsupported_version" | "unsupported_policy" | "unknown_action" | "policy_mismatch"
    | "unauthenticated" | "seat_required" | "wrong_council" | "wrong_seat" | "revoked" | "expired_grant"
    | "stale_host" | "unverified_identity" | "owner_only" | "unreachable" | "unsupported_action"
    | "seat_action_denied" | "host_action_denied" | "template_action_denied" | "task_denied" | "scope_denied"
    | "resource_mismatch" | "uncanonical_resource" | "base_mismatch" | "protected_ref" | "role_denied"
    | "unmediated_filesystem" | "unmediated_terminal" | "unmediated_network" | "unmediated_git"
    | "paused" | "paused_expired" | "council_expired" | "council_closed" | "council_inactive" | "campaign_inactive"
    | "delivery_mismatch" | "unfrozen_manifest" | "unverified_submission" | "approval_denied" | "approval_mismatch";
export type CouncilReferenceDecisionV1 = { decision: "allow"; code: "allowed" }
    | { decision: "deny"; code: CouncilReferenceDenialV1 }
    | { decision: "needs_approval"; code: "approval_required" };
export type CouncilSeatLifetimeDecisionV1 =
    | { decision: "renew"; code: "renewed"; expiresAt: string }
    | { decision: "keep"; code: "not_due"; expiresAt: null }
    | { decision: "deny"; code: CouncilReferenceDenialV1 | "owner_reissue_required" | "no_unfinished_campaign"; expiresAt: null };

type Lifecycle = Pick<CouncilSeatLifetimeInputV1, "sessionStatus" | "pausedAt" | "campaignStatus" | "integrationStatus">;
function unfinished(value: Lifecycle): boolean {
    return value.campaignStatus === "running" || value.campaignStatus === "blocked"
        || (value.campaignStatus === "complete" && (value.integrationStatus === null
            || value.integrationStatus === "pending" || value.integrationStatus === "running"));
}
function pausedReason(value: Lifecycle, now: number): "paused" | "paused_expired" | null {
    if (value.pausedAt === null) return null;
    return now - Date.parse(value.pausedAt) >= 7 * 24 * 60 * 60 * 1000 ? "paused_expired" : "paused";
}
type Fence = z.infer<typeof hostFenceV1Schema>;
function sameFence(first: Fence | null, second: Fence | null): boolean {
    return first === null ? second === null : second !== null
        && first.hostId === second.hostId && first.leaseEpoch === second.leaseEpoch;
}
function liveLease(lease: z.infer<typeof leaseSchema> | null, now: number): boolean {
    return lease !== null && !lease.released && Date.parse(lease.expiresAt) > now;
}
function header(input: unknown): CouncilReferenceDenialV1 | null {
    if (!input || typeof input !== "object" || Array.isArray(input)) return "invalid_input";
    const row = input as Record<string, unknown>;
    if (row.schemaVersion !== 1) return "unsupported_version";
    if (row.policyVersion !== REFERENCE_POLICY_VERSION) return "unsupported_policy";
    return null;
}

const mutations: readonly CouncilPolicyActionV1[] = ["write_worktree", "run_approved_command", "commit_branch", "integrate_accepted_commits"];
const assignedActions: readonly CouncilPolicyActionV1[] = ["write_worktree", "run_approved_command", "commit_branch"];

// Reference only: callers must authenticate and attest these facts before evaluation.
export function authorizeCouncilV1(input: unknown): CouncilReferenceDecisionV1 {
    const deny = (code: CouncilReferenceDenialV1): CouncilReferenceDecisionV1 => ({ decision: "deny", code });
    const invalidHeader = header(input);
    if (invalidHeader) return deny(invalidHeader);
    if (!policyActionV1Schema.safeParse((input as Record<string, unknown>).action).success) return deny("unknown_action");
    const parsed = policyInputV1Schema.safeParse(input);
    if (!parsed.success) return deny("invalid_input");
    const { action, principal, connector, resource, grant, context } = parsed.data;
    const { resourceFacts: facts, approval, assignment } = context;
    const now = Date.parse(context.now);
    if (!context.principalAuthenticated) return deny("unauthenticated");
    if (action === "merge_protected_ref") return deny("owner_only");
    if (principal.kind !== "seat") return deny("seat_required");
    if (principal.sessionId !== context.sessionId || grant.sessionId !== context.sessionId) return deny("wrong_council");
    if (grant.participantId !== principal.participantId) return deny("wrong_seat");
    if (grant.policyVersion !== REFERENCE_POLICY_VERSION) return deny("policy_mismatch");
    if (grant.revoked) return deny("revoked");
    if (Date.parse(grant.expiresAt) <= now) return deny("expired_grant");
    if (principal.identityAssurance === "host_bound" && principal.hostFence === null) return deny("stale_host");
    if (!sameFence(principal.hostFence, grant.hostFence)) return deny("stale_host");
    if ((grant.hostFence !== null && (!liveLease(context.lease, now) || !sameFence(grant.hostFence, context.lease)))
        || (mutations.includes(action) && !liveLease(context.lease, now))) return deny("stale_host");
    const paused = pausedReason(context, now);
    if (paused) return deny(paused);
    if (context.sessionStatus === "expired" && action !== "conclude") return deny("council_expired");
    const conversation = action === "discuss" || action === "conclude";
    if (context.sessionStatus === "closed" && (conversation || !unfinished(context))) return deny("council_closed");
    if (context.sessionStatus === "awaiting_owner") return deny("council_inactive");
    if ((mutations.includes(action) || action === "review_submission") && !unfinished(context)) return deny("campaign_inactive");
    if (principal.identityAssurance === "unverified_declaration"
        || (principal.identityAssurance === "owner_relay" && !conversation)) return deny("unverified_identity");
    if (!context.reachable) return deny("unreachable");
    if (action === "conclude" && (principal.role !== "closer" || context.closerParticipantId !== principal.participantId)) {
        return deny("role_denied");
    }
    if (action === "integrate_accepted_commits"
        && (principal.role !== "integrator" || context.nominatedIntegratorId !== principal.participantId)) return deny("role_denied");
    if (action === "review_submission" && !((principal.role === "reviewer" && context.reviewerParticipantIds.includes(principal.participantId))
        || (principal.role === "closer" && context.closerParticipantId === principal.participantId))) return deny("role_denied");
    if (!connector.supportedActions.includes(action)) return deny("unsupported_action");
    if (action === "review_submission" && !connector.structuredActions) return deny("unsupported_action");
    if (!grant.allowedActions.includes(action)) return deny("seat_action_denied");
    if (!context.hostAllowedActions.includes(action)) return deny("host_action_denied");
    if (!context.templateAllowedActions.includes(action)) return deny("template_action_denied");
    const expectedResource = {
        discuss: "conversation", conclude: "conversation", read_repo: "file", write_worktree: "file",
        run_approved_command: "command_profile", commit_branch: "branch", review_submission: "submission",
        integrate_accepted_commits: "manifest",
    }[action];
    if (resource.kind !== expectedResource || facts.resourceId !== resource.id) return deny("resource_mismatch");
    if (!facts.canonical) return deny("uncanonical_resource");
    if (!facts.withinScope || !grant.resourceScopeIds.includes(resource.scopeId)) return deny("scope_denied");
    if (resource.kind !== "conversation" && !facts.baseMatches) return deny("base_mismatch");
    if (mutations.includes(action) && facts.protectedRef) return deny("protected_ref");
    if (resource.kind === "conversation") {
        if (resource.sessionId !== context.sessionId) return deny("wrong_council");
        if (resource.deliveryId !== context.currentDeliveryId) return deny("delivery_mismatch");
        if (action === "conclude" && connector.kind !== "manual" && !connector.structuredActions) return deny("unsupported_action");
    }
    if (assignedActions.includes(action)) {
        if (!assignment || assignment.participantId !== principal.participantId || !assignment.allowedActions.includes(action)
            || !("workItemId" in resource) || assignment.workItemId !== resource.workItemId) return deny("task_denied");
        if (!assignment.resourceScopeIds.includes(resource.scopeId)) return deny("scope_denied");
    }
    if ((facts.filesystemMediationRequired || action === "read_repo" || action === "write_worktree")
        && !connector.filesystemMediated) return deny("unmediated_filesystem");
    if ((facts.terminalMediationRequired || action === "run_approved_command")
        && !connector.terminalMediated && !facts.hostOwnedCheckRunner) return deny("unmediated_terminal");
    if (facts.networkMediationRequired && !connector.networkMediated) return deny("unmediated_network");
    if ((action === "commit_branch" || action === "integrate_accepted_commits")
        && (!facts.gitControlled || !connector.evidence.commitReceipts)) return deny("unmediated_git");
    if (action === "review_submission" && !facts.exactSubmission) return deny("unverified_submission");
    if (action === "integrate_accepted_commits" && !facts.frozenManifest) return deny("unfrozen_manifest");
    if (approval.state === "denied") return deny("approval_denied");
    if (approval.state !== "not_required") {
        if (approval.action !== action || approval.resourceId !== resource.id || approval.participantId !== principal.participantId) {
            return deny("approval_mismatch");
        }
        if (approval.state === "pending") return { decision: "needs_approval", code: "approval_required" };
    } else if (approval.action !== null || approval.resourceId !== null || approval.participantId !== null) return deny("approval_mismatch");
    return { decision: "allow", code: "allowed" };
}

export function evaluateSeatLifetimeV1(input: unknown): CouncilSeatLifetimeDecisionV1 {
    const deny = (code: Extract<CouncilSeatLifetimeDecisionV1, { decision: "deny" }>["code"]): CouncilSeatLifetimeDecisionV1 =>
        ({ decision: "deny", code, expiresAt: null });
    const invalidHeader = header(input);
    if (invalidHeader) return deny(invalidHeader);
    const parsed = seatLifetimeInputV1Schema.safeParse(input);
    if (!parsed.success) return deny("invalid_input");
    const value = parsed.data;
    const now = Date.parse(value.now);
    if (value.credential.revoked) return deny("revoked");
    if (Date.parse(value.credential.expiresAt) <= now) return deny("expired_grant");
    const paused = pausedReason(value, now);
    if (paused) return deny(paused);
    if (value.sessionStatus === "expired") return deny("council_expired");
    if (value.sessionStatus === "awaiting_owner") return deny("council_inactive");
    if (value.credential.issuer === "owner") return deny("owner_reissue_required");
    if (!value.credential.hostFence || !liveLease(value.lease, now) || !sameFence(value.credential.hostFence, value.lease)) {
        return deny("stale_host");
    }
    if (!unfinished(value)) return deny("no_unfinished_campaign");
    if (Date.parse(value.credential.expiresAt) > now + 60 * 60 * 1000) return { decision: "keep", code: "not_due", expiresAt: null };
    return { decision: "renew", code: "renewed", expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString() };
}
