import { executeTool } from "@/lib/ai/mcp-service";
import { withModelObservationCollector, configureModelDataPolicy, type ModelCallObservation } from "@/lib/ai/model-observations";
import { persistModelObservations } from "@/lib/ai/model-health";
import { decideAction, finishAction } from "@/lib/tasks/run-store";
import { canonicalAction, confirmedActionReceipt, withApprovedAction } from "@/lib/tasks/unattended-policy";
import { approvalActionLabel, approvalOutcomeLine, settleApprovalNotice } from "@/lib/tasks/approval-notices";
import { taskId, taskOwner } from "@/lib/tasks/http";
import type { ActionApproval } from "@/lib/tasks/types";
import { saveMessage } from "@/lib/db";
import { isMessageChannel } from "@/lib/types";

/** Who decided: a signed-in web session, or the owner's tap in the allowed Telegram chat. */
export type ApprovalAuthority = "web" | "telegram";
export type ApprovalDecision = "approve" | "reject";

export type ApprovalClaim =
    | { kind: "missing" }
    | { kind: "taken"; approval: ActionApproval }
    | { kind: "claimed"; approval: ActionApproval; token: string | null; argsHash: string; userProfileId: string };

export interface ApprovalOutcome {
    approval: ActionApproval;
    /** False when the action may have run but its receipt was not saved. */
    stored: boolean;
}

/** Edits any Telegram notice and, for a chat approval, tells the conversation what happened, so the next turn knows. */
async function settle(approval: ActionApproval, userProfileId: string): Promise<void> {
    await settleApprovalNotice(approval);
    const outcome = approvalOutcomeLine(approval);
    if (approval.source !== "chat" || !approval.conversationId || !outcome) return;
    try {
        await saveMessage({
            role: "assistant", content: `${approvalActionLabel(approval.tool)}: ${outcome}`,
            channel: isMessageChannel(approval.channel) ? approval.channel : "telegram",
            userProfileId, conversationId: approval.conversationId, metadata: { source: "chat_approval", approvalId: approval.id },
        });
    } catch (error) {
        console.warn("[Approvals] The outcome was not saved into the conversation:", error instanceof Error ? error.message : error);
    }
}

/** Claims the decision. "taken" means already decided, expired or running; an expired notice is settled here. */
export async function claimApproval(id: string, decision: ApprovalDecision): Promise<ApprovalClaim> {
    const approvalId = taskId(id);
    const userProfileId = await taskOwner();
    const result = await decideAction(approvalId, userProfileId, decision);
    if (!result) return { kind: "missing" };
    if (!result.claimed) {
        if (result.approval.status === "expired") await settle(result.approval, userProfileId);
        return { kind: "taken", approval: result.approval };
    }
    return { kind: "claimed", approval: result.approval, token: result.token, argsHash: result.argsHash, userProfileId };
}

/** Runs an approved action exactly once under its permit, records the receipt and settles any notice. */
export async function completeApproval(claim: Extract<ApprovalClaim, { kind: "claimed" }>, authority: ApprovalAuthority): Promise<ApprovalOutcome> {
    const { approval, userProfileId } = claim;
    if (approval.status === "rejected") {
        await settle(approval, userProfileId);
        console.log(`[Approvals] ${approval.id} rejected from ${authority}.`);
        return { approval, stored: true };
    }
    let status: "succeeded" | "outcome_unknown" = "outcome_unknown";
    let receipt = "The action's outcome could not be confirmed. Check its destination before attempting anything else.";
    const observations: ModelCallObservation[] = [];
    try {
        if (!claim.token || canonicalAction(approval.tool, approval.args).hash !== claim.argsHash) throw new Error("Action identity mismatch.");
        receipt = await withModelObservationCollector(observations, () => {
            configureModelDataPolicy(false);
            return withApprovedAction({
                runId: approval.runId ?? "", taskId: approval.taskId ?? "", taskTitle: approval.taskTitle, instruction: approval.instruction,
                userProfileId, tool: approval.tool, argsHash: claim.argsHash,
            }, () => executeTool(approval.tool, approval.args, undefined, { userProfileId }));
        }, [], ["personal", "unattended"]);
        status = confirmedActionReceipt(approval.tool, approval.args, receipt) ? "succeeded" : "outcome_unknown";
    } catch { }
    finally { await persistModelObservations(observations, { userProfileId }); }
    const stored = Boolean(claim.token) && await finishAction(approval.id, claim.token!, status, receipt);
    const settled: ActionApproval = { ...approval, status: stored ? status : "outcome_unknown", receipt };
    await settle(settled, userProfileId);
    console.log(`[Approvals] ${approval.id} approved from ${authority}: ${settled.status}.`);
    return { approval: settled, stored };
}
