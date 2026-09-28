import { supabaseAdmin as db } from "@/lib/supabase";
import type { ProposedAction } from "@/lib/tasks/unattended-policy";
import type { ActionApproval, ScheduledRun, TasksReport } from "@/lib/tasks/types";
import { mapScheduledTask, type ScheduledTask } from "@/lib/tasks/store";

type Row = Record<string, unknown>;
const deadline = () => AbortSignal.timeout(5000);
export class TaskStorageError extends Error {}
export function mapRun(row: Row): ScheduledRun {
    return { id: String(row.id), taskId: String(row.task_id), taskTitle: String(row.task_title),
        trigger: row.trigger as ScheduledRun["trigger"], status: row.status as ScheduledRun["status"],
        startedAt: String(row.started_at), finishedAt: row.finished_at as string | null,
        detail: row.detail as string | null, modelRoute: "paid" };
}
export function mapApproval(row: Row): ActionApproval {
    return { id: String(row.id), taskId: String(row.task_id), runId: String(row.run_id), taskTitle: String(row.task_title),
        tool: String(row.tool), args: row.args as Record<string, unknown>, instruction: String(row.instruction),
        sourceContext: String(row.source_context ?? ""), status: row.status as ActionApproval["status"],
        createdAt: String(row.created_at), expiresAt: String(row.expires_at), decidedAt: row.decided_at as string | null,
        receipt: row.receipt as string | null };
}
export async function claimTaskRun(taskId: string, requestId: string, trigger: "manual" | "schedule", userId: string, scheduled?: { dueAt: string; nextRunAt: string | null }) {
    const { data, error } = await db.rpc("assistant_claim_task_run", {
        p_task_id: taskId, p_request_id: requestId, p_trigger: trigger, p_user_id: userId, p_due_at: scheduled?.dueAt ?? null, p_next_at: scheduled?.nextRunAt ?? null,
    }).abortSignal(deadline());
    if (data?.status === "not_due") return null;
    if (error || !data?.run) throw new TaskStorageError(data?.error ?? "Scheduled run storage is unavailable. Apply the V6 scheduled-actions migration before running tasks.");
    return { status: data.status as "accepted" | "active" | "reused", run: mapRun(data.run),
        task: mapScheduledTask(data.run.task_snapshot), userId: String(data.run.user_profile_id) };
}
export async function startTaskRun(runId: string): Promise<boolean> {
    const { data, error } = await db.rpc("assistant_start_task_run", { p_run_id: runId }).abortSignal(deadline());
    if (error) throw new TaskStorageError("Could not safely start the scheduled run.");
    return data === true;
}
export async function claimTaskDelivery(runId: string): Promise<boolean> {
    const { data, error } = await db.rpc("assistant_claim_task_delivery", { p_run_id: runId }).abortSignal(deadline());
    if (error) throw new TaskStorageError("Delivery could not be claimed safely. No delivery was started.");
    return data === true;
}
export async function finishTaskRun(runId: string, status: "ok" | "error", detail: string): Promise<boolean> {
    const { data, error } = await db.rpc("assistant_finish_task_run", { p_run_id: runId, p_status: status, p_detail: detail.slice(0, 12000) }).abortSignal(deadline());
    if (error) throw new TaskStorageError("Run result could not be recorded.");
    return data === true;
}
export async function proposeAction(action: ProposedAction): Promise<{ id: string; status: string }> {
    const { data, error } = await db.rpc("assistant_propose_action", {
        p_run_id: action.runId, p_tool: action.tool, p_args: action.args, p_hash: action.argsHash, p_sources: action.sourceContext,
    }).abortSignal(deadline());
    if (error || !data?.id) throw new TaskStorageError("Approval storage unavailable.");
    return { id: data.id, status: data.status };
}
export async function taskReport(userId: string): Promise<TasksReport> {
    const tasks = await db.from("scheduled_tasks").select("*").eq("user_profile_id", userId).order("created_at", { ascending: false }).limit(200).abortSignal(deadline());
    if (tasks.error) throw new TaskStorageError("Scheduled tasks could not be loaded.");
    const now = new Date().toISOString();
    const expiredRuns = await db.from("assistant_task_runs").update({ status: "interrupted", finished_at: now, detail: "The runner stopped without a confirmed result. Review the destination before starting another run." })
        .eq("user_profile_id", userId).eq("status", "running").lte("expires_at", now).abortSignal(deadline());
    await db.from("assistant_action_approvals").update({ status: "expired" }).eq("user_profile_id", userId).eq("status", "pending").lte("expires_at", now).abortSignal(deadline());
    await db.from("assistant_action_approvals").update({ status: "outcome_unknown", receipt: "Execution did not return a confirmed receipt. Check the destination before taking further action." })
        .eq("user_profile_id", userId).eq("status", "executing").lt("decided_at", new Date(Date.now() - 10 * 60_000).toISOString()).abortSignal(deadline());
    const [runs, approvals] = await Promise.all([
        db.from("assistant_task_runs").select("*").eq("user_profile_id", userId).order("started_at", { ascending: false }).limit(100).abortSignal(deadline()),
        db.from("assistant_action_approvals").select("*").eq("user_profile_id", userId).order("created_at", { ascending: false }).limit(200).abortSignal(deadline()),
    ]);
    return { tasks: (tasks.data ?? []).map(mapScheduledTask), runs: (runs.data ?? []).map(mapRun),
        approvals: (approvals.data ?? []).map(mapApproval),
        ...(runs.error || approvals.error || expiredRuns.error ? { activationError: "Approval and run records are unavailable. Apply the V6 scheduled-actions migration, then refresh. Tasks cannot run safely until storage is available." } : {}) };
}
export async function ownedTask(id: string, userId: string): Promise<ScheduledTask | null> {
    const { data, error } = await db.from("scheduled_tasks").select("*").eq("id", id).eq("user_profile_id", userId).abortSignal(deadline()).maybeSingle();
    if (error) throw new TaskStorageError("Task lookup failed.");
    return data ? mapScheduledTask(data) : null;
}
export async function decideAction(id: string, userId: string, decision: "approve" | "reject") {
    const { data, error } = await db.rpc("assistant_decide_action", { p_id: id, p_user_id: userId, p_decision: decision }).abortSignal(deadline());
    if (error) throw new TaskStorageError("Approval could not be claimed safely. Refresh before trying again.");
    if (!data?.approval) return null;
    return { claimed: data.claimed === true, approval: mapApproval(data.approval),
        token: data.approval.execution_token as string | null, argsHash: String(data.approval.args_hash) };
}
export async function finishAction(id: string, token: string, status: "succeeded" | "outcome_unknown", receipt: string): Promise<boolean> {
    const { data, error } = await db.rpc("assistant_finish_action", { p_id: id, p_token: token, p_status: status, p_receipt: receipt }).abortSignal(deadline());
    return !error && data === true;
}
