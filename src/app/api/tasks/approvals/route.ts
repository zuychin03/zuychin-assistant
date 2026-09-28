import { NextRequest, NextResponse } from "next/server";
import { executeTool } from "@/lib/ai/mcp-service";
import { withModelObservationCollector, configureModelDataPolicy, type ModelCallObservation } from "@/lib/ai/model-observations";
import { persistModelObservations } from "@/lib/ai/model-health";
import { decideAction, finishAction } from "@/lib/tasks/run-store";
import { canonicalAction, confirmedActionReceipt, withApprovedAction } from "@/lib/tasks/unattended-policy";
import { taskId, taskOwner, taskFailure, requireApprovalOwner, TaskInputError } from "@/lib/tasks/http";

export const maxDuration = 300;
export async function POST(req: NextRequest) {
    const denied = await requireApprovalOwner(req); if (denied) return denied;
    try {
        const body = await req.json();
        if (!body || typeof body !== "object" || Object.keys(body).some((key) => !["id","decision"].includes(key)) || !["approve","reject"].includes(body.decision)) throw new TaskInputError("Provide an approval ID and approve or reject decision.");
        const userProfileId = await taskOwner();
        const result = await decideAction(taskId(body.id), userProfileId, body.decision);
        if (!result) return NextResponse.json({ error: "Approval not found." }, { status: 404 });
        const approval = result.approval;
        if (!result.claimed) return NextResponse.json({ approval, error: "This action is already decided, expired or executing." }, { status: 409 });
        if (body.decision === "reject") return NextResponse.json({ approval });
        let status: "succeeded" | "outcome_unknown" = "outcome_unknown";
        let receipt = "The action's outcome could not be confirmed. Check its destination before attempting anything else.";
        const observations: ModelCallObservation[] = [];
        try {
            if (!result.token || canonicalAction(approval.tool, approval.args).hash !== result.argsHash) throw new Error("Action identity mismatch.");
            receipt = await withModelObservationCollector(observations, () => {
                configureModelDataPolicy(false);
                return withApprovedAction({
                runId: approval.runId, taskId: approval.taskId, taskTitle: approval.taskTitle, instruction: approval.instruction,
                userProfileId, tool: approval.tool, argsHash: result.argsHash,
                }, () => executeTool(approval.tool, approval.args, undefined, { userProfileId }));
            }, [], ["personal", "unattended"]);
            status = confirmedActionReceipt(approval.tool, approval.args, receipt) ? "succeeded" : "outcome_unknown";
        } catch { }
        finally { await persistModelObservations(observations, { userProfileId }); }
        const stored = result.token && await finishAction(approval.id, result.token, status, receipt);
        return NextResponse.json({ approval: { ...approval, status: stored ? status : "outcome_unknown", receipt },
            ...(!stored ? { warning: "The action may have run, but its receipt could not be saved. Do not repeat it." } : {}) });
    } catch (error) { return taskFailure(error); }
}
