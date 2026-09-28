import type { ScheduledTask } from "@/lib/tasks/store";

export type TaskRunStatus = "running" | "ok" | "error" | "interrupted";
export type ApprovalStatus = "pending" | "executing" | "succeeded" | "rejected" | "expired" | "outcome_unknown";
export interface ScheduledRun {
    id: string;
    taskId: string;
    taskTitle: string;
    trigger: "schedule" | "manual";
    status: TaskRunStatus;
    startedAt: string;
    finishedAt: string | null;
    detail: string | null;
    modelRoute: "paid";
}
export interface ActionApproval {
    id: string;
    taskId: string;
    runId: string;
    taskTitle: string;
    tool: string;
    args: Record<string, unknown>;
    instruction: string;
    sourceContext: string;
    status: ApprovalStatus;
    createdAt: string;
    expiresAt: string;
    decidedAt: string | null;
    receipt: string | null;
}
export interface TasksReport {
    tasks: ScheduledTask[];
    runs: ScheduledRun[];
    approvals: ActionApproval[];
    activationError?: string;
}
