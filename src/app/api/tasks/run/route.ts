import { NextRequest, NextResponse, after } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { claimTaskRun } from "@/lib/tasks/run-store";
import { runScheduledTask } from "@/lib/tasks/runner";
import { taskId, taskOwner, taskFailure, TaskInputError } from "@/lib/tasks/http";

export const maxDuration = 300;
export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    try {
        const body = await req.json();
        if (!body || typeof body !== "object" || Object.keys(body).some((key) => !["id","requestId"].includes(key))) throw new TaskInputError("Provide only a task ID and request ID.");
        const claim = await claimTaskRun(taskId(body.id), taskId(body.requestId), "manual", await taskOwner());
        if (!claim) throw new Error("The run could not be claimed.");
        if (claim.status === "accepted") after(() => runScheduledTask(claim.task, claim.run.id).then(() => {}));
        return NextResponse.json({ runId: claim.run.id, status: claim.status,
            ...(claim.status === "active" ? { error: "This task is already running." } : {}) },
            { status: claim.status === "accepted" ? 202 : claim.status === "active" ? 409 : 200 });
    } catch (error) { return taskFailure(error); }
}
