import { z } from "zod";
import { integrationEvidenceSchema } from "./integration-evidence";
import { AGENT_INTENTS, INTENTS_REQUIRING_REPLY_TO, INTENTS_REQUIRING_TARGET } from "./protocol";
import { isValidBranchName, isValidWorkspaceName } from "./supervisor";

export const COUNCIL_CONTRACT_VERSION = 1 as const;
export const COUNCIL_ACTIONS_V1 = [
    "discuss", "read_repo", "write_worktree", "run_approved_command", "commit_branch",
    "review_submission", "integrate_accepted_commits", "conclude", "merge_protected_ref",
] as const;
export const policyActionV1Schema = z.enum(COUNCIL_ACTIONS_V1);
export const seatRoleV1Schema = z.enum(["member", "reviewer", "closer", "integrator"]);
const version = { schemaVersion: z.literal(COUNCIL_CONTRACT_VERSION) };
const uuid = z.string().uuid();
const sha = z.string().regex(/^[0-9a-f]{40}$/i);
const digest = z.string().regex(/^[0-9a-f]{64}$/i);
const text = (limit: number) => z.string().min(1).max(limit).refine(value => value.trim().length > 0);
const name = text(100).refine(value => !/[\u0000-\u001f\u007f-\u009f]/.test(value));
const workspace = z.string().refine(isValidWorkspaceName);
const branch = z.string().refine(isValidBranchName);
const unique = <T,>(values: T[]) => new Set(values).size === values.length;
export const actionSetV1Schema = z.array(policyActionV1Schema).max(COUNCIL_ACTIONS_V1.length).refine(unique);
export const hostFenceV1Schema = z.object({ hostId: uuid, leaseEpoch: z.number().int().positive().safe() }).strict();

export const principalV1Schema = z.discriminatedUnion("kind", [
    z.object({ ...version, kind: z.literal("owner"), ownerId: uuid }).strict(),
    z.object({ ...version, kind: z.literal("host"), sessionId: uuid, ...hostFenceV1Schema.shape }).strict(),
    z.object({
        ...version, kind: z.literal("seat"), sessionId: uuid, participantId: uuid, seatName: name,
        role: seatRoleV1Schema,
        identityAssurance: z.enum(["verified_seat", "host_bound", "owner_relay", "unverified_declaration"]),
        hostFence: hostFenceV1Schema.nullable(),
    }).strict(),
]);

export const connectorSnapshotV1Schema = z.object({
    ...version, kind: z.enum(["acp", "mcp", "managed_api", "managed_cli", "text_only", "manual"]),
    source: z.enum(["probed", "configured", "declared"]),
    streaming: z.boolean(), cancellation: z.boolean(), sessionResume: z.boolean(),
    modelSelection: z.boolean(), structuredActions: z.boolean(), toolCalls: z.boolean(),
    permissionCallbacks: z.boolean(), filesystemMediated: z.boolean(), terminalMediated: z.boolean(),
    networkMediated: z.boolean(), observedAt: z.string().datetime(), adapterVersion: text(200).nullable(),
    supportedActions: actionSetV1Schema,
    evidence: z.object({
        effectiveModelReadback: z.boolean(), toolReceipts: z.boolean(),
        commandReceipts: z.boolean(), commitReceipts: z.boolean(),
    }).strict(),
    reliability: z.object({
        healthProbe: z.boolean(), idempotency: z.boolean(),
        maxPromptBytes: z.number().int().positive().max(16_777_216),
        maxResultBytes: z.number().int().positive().max(16_777_216),
    }).strict(),
}).strict();

export const launchV1Schema = z.object({
    ...version, workspace, baseBranch: branch, attach: z.string().regex(/^CN-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/).nullable(),
    seats: z.array(z.object({
        seatName: name, instanceName: name, modelId: text(200).nullable(), reasoningEffort: text(100).nullable(),
    }).strict()).min(1).max(32).refine(seats => unique(seats.map(seat => seat.seatName))),
}).strict();

const turnAction = z.enum(["speak", "pass", "conclude", "needs_input"]);
const message = z.object({
    seq: z.number().int().positive().safe(), round: z.number().int().nonnegative().safe(), speaker: name,
    role: z.enum(["agent", "moderator", "system"]), addressedTo: name,
    intent: z.enum(["propose", "challenge", "answer", "concede", "refine", "ask", "pass", "moderate", "verdict", "system"]),
    replyToSeq: z.number().int().positive().safe().nullable(), body: z.string().max(6000),
    answered: z.boolean(), createdAt: z.string().datetime(), executionId: uuid.nullable(),
}).strict();
export const deliveryV1Schema = z.object({
    ...version, deliveryId: uuid, councilCode: z.string().regex(/^CN-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/),
    participantId: uuid, seatName: name, role: seatRoleV1Schema,
    fromSeq: z.number().int().nonnegative().safe(), throughSeq: z.number().int().nonnegative().safe(),
    transcriptSlice: z.array(message).max(20), obligations: z.array(text(2000)).max(32),
    allowedActions: z.array(turnAction).min(1).max(4).refine(unique),
    responseSchema: z.object({ contract: z.literal("action"), ...version }).strict(),
    budgets: z.object({
        deadlineMs: z.number().int().positive().max(900_000),
        maxInputTokens: z.number().int().positive().max(1_000_000).optional(),
        maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
    }).strict(),
}).strict().refine(value => value.fromSeq <= value.throughSeq
    && value.transcriptSlice.every((item, index) => item.seq > value.fromSeq && item.seq <= value.throughSeq
        && (index === 0 || item.seq > value.transcriptSlice[index - 1].seq))
    && value.transcriptSlice.reduce((total, item) => total + item.body.length, 0) <= 12000);

const actionCommon = { ...version, deliveryId: uuid, clientKey: text(200) };
export const actionV1Schema = z.discriminatedUnion("action", [
    z.object({
        ...actionCommon, action: z.literal("speak"), intent: z.enum(AGENT_INTENTS as [string, ...string[]]),
        body: text(6000), targetSeat: name.optional(), replyToSeq: z.number().int().positive().safe().optional(),
    }).strict(),
    z.object({ ...actionCommon, action: z.literal("pass"), body: text(1000), done: z.boolean() }).strict(),
    z.object({
        ...actionCommon, action: z.literal("conclude"), verdict: text(16000), openQuestions: z.array(text(2000)).max(32),
    }).strict(),
    z.object({ ...actionCommon, action: z.literal("needs_input"), body: text(6000) }).strict(),
]).refine(value => value.action !== "speak"
    || ((!INTENTS_REQUIRING_TARGET.includes(value.intent as typeof AGENT_INTENTS[number])
        || (value.targetSeat !== undefined && value.targetSeat !== "all"))
        && (!INTENTS_REQUIRING_REPLY_TO.includes(value.intent as typeof AGENT_INTENTS[number]) || value.replyToSeq !== undefined)));

const relativePath = text(1024).refine(value => !/[:\\\u0000-\u001f\u007f-\u009f]/.test(value)
    && value.split("/").every(part => part !== "" && part !== "." && part !== ".."));
const resourceCommon = { id: uuid, scopeId: name };
const repoResource = { ...resourceCommon, workspace, baseSha: sha };
export const resourceRefV1Schema = z.discriminatedUnion("kind", [
    z.object({ ...resourceCommon, kind: z.literal("conversation"), sessionId: uuid, deliveryId: uuid }).strict(),
    z.object({ ...repoResource, kind: z.literal("file"), relativePath, workItemId: uuid.nullable() }).strict(),
    z.object({ ...repoResource, kind: z.literal("command_profile"), profileId: name, workItemId: uuid }).strict(),
    z.object({ ...repoResource, kind: z.literal("branch"), ref: branch, workItemId: uuid }).strict(),
    z.object({ ...repoResource, kind: z.literal("submission"), workItemId: uuid, commitSha: sha, executionId: uuid.nullable() }).strict(),
    z.object({ ...repoResource, kind: z.literal("manifest"), manifestHash: digest, ref: branch }).strict(),
]);
export const toolRequestV1Schema = z.object({
    ...version, executionId: uuid, deliveryId: uuid,
    action: z.enum(["read_repo", "write_worktree", "run_approved_command", "commit_branch"]),
    resource: resourceRefV1Schema,
}).strict().refine(value => ({
    read_repo: "file", write_worktree: "file", run_approved_command: "command_profile", commit_branch: "branch",
}[value.action]) === value.resource.kind
    && (value.action !== "write_worktree" || (value.resource.kind === "file" && value.resource.workItemId !== null)));
export const workSubmissionV1Schema = z.object({
    ...version, itemId: uuid, executionId: uuid, commitSha: sha, agentReport: text(16000),
}).strict();
export const integrationReportV1Schema = z.object({
    ...version, attemptId: uuid, ...hostFenceV1Schema.shape, status: z.enum(["verified", "conflict", "failed"]),
    branch: branch.nullable(), tipSha: sha.nullable(), executionId: uuid.nullable(), evidence: integrationEvidenceSchema,
}).strict().refine(value => {
    if (value.status !== "verified") return true;
    const { before, after } = value.evidence.protectedRefs;
    return value.branch !== null && value.tipSha !== null && value.evidence.changedPaths !== null
        && value.evidence.diffSummary !== null && value.evidence.receipts.length > 0
        && value.evidence.receipts.every(receipt => receipt.exitCode === 0 && !receipt.timedOut)
        && before !== null && after !== null && Object.keys(before).length > 0
        && Object.keys(before).length === Object.keys(after).length
        && Object.entries(before).every(([key, sha]) => after[key] === sha);
});

export const councilV1Schemas = {
    principal: principalV1Schema, connector_snapshot: connectorSnapshotV1Schema, launch: launchV1Schema,
    delivery: deliveryV1Schema, action: actionV1Schema, tool_request: toolRequestV1Schema,
    work_submission: workSubmissionV1Schema, integration_report: integrationReportV1Schema,
} as const;
export type CouncilContractKindV1 = keyof typeof councilV1Schemas;
export type CouncilPrincipalV1 = z.infer<typeof principalV1Schema>;
export type ConnectorSnapshotV1 = z.infer<typeof connectorSnapshotV1Schema>;
export type CouncilLaunchV1 = z.infer<typeof launchV1Schema>;
export type CouncilDeliveryV1 = z.infer<typeof deliveryV1Schema>;
export type CouncilActionEnvelopeV1 = z.infer<typeof actionV1Schema>;
export type CouncilToolRequestV1 = z.infer<typeof toolRequestV1Schema>;
export type CouncilWorkSubmissionV1 = z.infer<typeof workSubmissionV1Schema>;
export type CouncilIntegrationReportV1 = z.infer<typeof integrationReportV1Schema>;
export type CouncilResourceRefV1 = z.infer<typeof resourceRefV1Schema>;
export type CouncilPolicyActionV1 = z.infer<typeof policyActionV1Schema>;
export type CouncilContractValueV1 = z.infer<typeof councilV1Schemas[CouncilContractKindV1]>;
type ContractFailure = "unknown_contract" | "unsupported_version" | "unknown_field" | "invalid_contract";

export function parseCouncilContractV1(kind: string, input: unknown):
    { ok: true; value: CouncilContractValueV1 } | { ok: false; code: ContractFailure } {
    if (!Object.hasOwn(councilV1Schemas, kind)) return { ok: false, code: "unknown_contract" };
    if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, code: "invalid_contract" };
    if ((input as Record<string, unknown>).schemaVersion !== COUNCIL_CONTRACT_VERSION) {
        return { ok: false, code: "unsupported_version" };
    }
    const result = councilV1Schemas[kind as CouncilContractKindV1].safeParse(input);
    if (result.success) return { ok: true, value: result.data };
    return { ok: false, code: result.error.issues.every(issue => issue.code === "unrecognized_keys")
        ? "unknown_field" : "invalid_contract" };
}
