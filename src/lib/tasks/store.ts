import { randomUUID } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { computeNextRun, type ScheduleFields } from "@/lib/tasks/schedule";
import { APP_TIMEZONE } from "@/lib/datetime";

export type TaskChannel = "telegram" | "discord" | "web";

export interface ScheduledTask {
    id: string;
    title: string;
    instruction: string;
    scheduleType: "once" | "recurring";
    cron: string | null;
    runAt: string | null;
    timezone: string;
    channel: TaskChannel;
    conversationId: string | null;
    agentMode: boolean;
    enabled: boolean;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastStatus: "ok" | "error" | null;
    lastResult: string | null;
    createdAt: string;
    userProfileId?: string | null;
    claimedRunId?: string;
}

interface TaskRow {
    id: string;
    title: string;
    instruction: string;
    schedule_type: "once" | "recurring";
    cron: string | null;
    run_at: string | null;
    timezone: string;
    channel: TaskChannel;
    conversation_id: string | null;
    agent_mode: boolean;
    enabled: boolean;
    next_run_at: string | null;
    last_run_at: string | null;
    last_status: "ok" | "error" | null;
    last_result: string | null;
    created_at: string;
    user_profile_id?: string | null;
}

export function mapScheduledTask(row: TaskRow): ScheduledTask {
    return {
        id: row.id,
        title: row.title,
        instruction: row.instruction,
        scheduleType: row.schedule_type,
        cron: row.cron,
        runAt: row.run_at,
        timezone: row.timezone,
        channel: row.channel,
        conversationId: row.conversation_id,
        agentMode: row.agent_mode,
        enabled: row.enabled,
        nextRunAt: row.next_run_at,
        lastRunAt: row.last_run_at,
        lastStatus: row.last_status,
        lastResult: row.last_result,
        createdAt: row.created_at,
        userProfileId: row.user_profile_id ?? null,
    };
}

function scheduleFields(task: Pick<ScheduledTask, "scheduleType" | "cron" | "runAt" | "timezone">): ScheduleFields {
    return { scheduleType: task.scheduleType, cron: task.cron, runAt: task.runAt, timezone: task.timezone };
}

export async function createScheduledTask(params: {
    title: string;
    instruction: string;
    scheduleType: "once" | "recurring";
    cron?: string;
    runAt?: string;
    timezone?: string;
    channel?: TaskChannel;
    conversationId?: string;
    agentMode?: boolean;
    enabled?: boolean;
    userProfileId?: string;
}): Promise<ScheduledTask> {
    const timezone = params.timezone || APP_TIMEZONE;
    const nextRunAt = computeNextRun({
        scheduleType: params.scheduleType,
        cron: params.cron ?? null,
        runAt: params.runAt ?? null,
        timezone,
    });

    const { data, error } = await supabase
        .from("scheduled_tasks")
        .insert({
            title: params.title,
            instruction: params.instruction,
            schedule_type: params.scheduleType,
            cron: params.cron ?? null,
            run_at: params.runAt ?? null,
            timezone,
            channel: params.channel ?? "telegram",
            conversation_id: params.conversationId ?? null,
            agent_mode: params.agentMode ?? false,
            enabled: params.enabled ?? true,
            next_run_at: nextRunAt,
            user_profile_id: params.userProfileId ?? null,
        })
        .select("*")
        .single();

    if (error) {
        console.error("[Tasks] Failed to create task:", error.message);
        throw new Error("Failed to create the scheduled task.");
    }
    return mapScheduledTask(data);
}

export async function listScheduledTasks(limit: number = 50): Promise<ScheduledTask[]> {
    const { data, error } = await supabase
        .from("scheduled_tasks")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);

    if (error) {
        console.error("[Tasks] Failed to list tasks:", error.message);
        return [];
    }
    return (data ?? []).map(mapScheduledTask);
}

export async function getScheduledTask(id: string): Promise<ScheduledTask | null> {
    const { data, error } = await supabase
        .from("scheduled_tasks")
        .select("*")
        .eq("id", id)
        .single();

    if (error || !data) return null;
    return mapScheduledTask(data);
}

export async function updateScheduledTask(
    id: string,
    updates: Partial<Pick<ScheduledTask,
        "title" | "instruction" | "scheduleType" | "cron" | "runAt" | "timezone" | "channel" | "agentMode" | "enabled">>,
): Promise<ScheduledTask | null> {
    const existing = await getScheduledTask(id);
    if (!existing) return null;

    const patch: Record<string, unknown> = {};
    if (updates.title !== undefined) patch.title = updates.title;
    if (updates.instruction !== undefined) patch.instruction = updates.instruction;
    if (updates.scheduleType !== undefined) patch.schedule_type = updates.scheduleType;
    if (updates.cron !== undefined) patch.cron = updates.cron;
    if (updates.runAt !== undefined) patch.run_at = updates.runAt;
    if (updates.timezone !== undefined) patch.timezone = updates.timezone;
    if (updates.channel !== undefined) patch.channel = updates.channel;
    if (updates.agentMode !== undefined) patch.agent_mode = updates.agentMode;
    if (updates.enabled !== undefined) patch.enabled = updates.enabled;

    const scheduleChanged = ["scheduleType", "cron", "runAt", "timezone"].some(
        (k) => updates[k as keyof typeof updates] !== undefined,
    );
    if (scheduleChanged || updates.enabled === true) {
        patch.next_run_at = computeNextRun(scheduleFields({ ...existing, ...updates }));
    }

    const { data, error } = await supabase
        .from("scheduled_tasks")
        .update(patch)
        .eq("id", id)
        .select("*")
        .single();

    if (error) {
        console.error("[Tasks] Failed to update task:", error.message);
        return null;
    }
    return mapScheduledTask(data);
}

export async function deleteScheduledTask(id: string): Promise<boolean> {
    const existing = await getScheduledTask(id);
    if (!existing?.userProfileId) return false;
    const { data, error } = await supabase.rpc("assistant_delete_task", { p_id: id, p_user_id: existing.userProfileId });
    return !error && data === true;
}

// Each schedule advances in the same transaction that records its run.
export async function claimDueTasks(limit: number = 3): Promise<ScheduledTask[]> {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
        .from("scheduled_tasks")
        .select("*")
        .eq("enabled", true)
        .not("next_run_at", "is", null)
        .lte("next_run_at", nowIso)
        .order("next_run_at", { ascending: true })
        .limit(limit * 3);

    if (error) {
        console.error("[Tasks] Failed to read due tasks:", error.message);
        return [];
    }

    const claimed: ScheduledTask[] = [];
    let budget = limit;
    for (const row of data ?? []) {
        if (budget <= 0) break;
        const task = mapScheduledTask(row);
        const cost = task.agentMode ? 3 : 1;
        if (cost > budget && claimed.length > 0) continue;

        const next = task.scheduleType === "recurring" ? computeNextRun(scheduleFields(task)) : null;
        if (!task.userProfileId || !task.nextRunAt) continue;
        const { claimTaskRun } = await import("@/lib/tasks/run-store");
        const claim = await claimTaskRun(task.id, randomUUID(), "schedule", task.userProfileId, { dueAt: task.nextRunAt, nextRunAt: next });
        if (!claim || claim.status !== "accepted") continue;
        claimed.push({ ...claim.task, claimedRunId: claim.run.id });
        budget -= cost;
    }
    return claimed;
}

export async function recordTaskResult(
    id: string,
    status: "ok" | "error",
    result: string,
): Promise<void> {
    const { error } = await supabase
        .from("scheduled_tasks")
        .update({
            last_run_at: new Date().toISOString(),
            last_status: status,
            last_result: result.slice(0, 500),
        })
        .eq("id", id);
    if (error) console.warn("[Tasks] Failed to record result:", error.message);
}
