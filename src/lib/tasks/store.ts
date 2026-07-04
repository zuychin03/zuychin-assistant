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
}

function mapRow(row: TaskRow): ScheduledTask {
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
            next_run_at: nextRunAt,
            user_profile_id: params.userProfileId ?? null,
        })
        .select("*")
        .single();

    if (error) {
        console.error("[Tasks] Failed to create task:", error.message);
        throw new Error("Failed to create the scheduled task.");
    }
    return mapRow(data);
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
    return (data ?? []).map(mapRow);
}

export async function getScheduledTask(id: string): Promise<ScheduledTask | null> {
    const { data, error } = await supabase
        .from("scheduled_tasks")
        .select("*")
        .eq("id", id)
        .single();

    if (error || !data) return null;
    return mapRow(data);
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
    return mapRow(data);
}

export async function deleteScheduledTask(id: string): Promise<boolean> {
    const { error } = await supabase.from("scheduled_tasks").delete().eq("id", id);
    if (error) {
        console.error("[Tasks] Failed to delete task:", error.message);
        return false;
    }
    return true;
}

/**
 * Claim due tasks for this dispatcher invocation. The claim bumps next_run_at
 * (and disables fired one-offs) BEFORE the task runs, guarded by
 * `eq(next_run_at, <read value>)` so an overlapping invocation claims nothing:
 * a crashed run skips one occurrence rather than double-firing.
 * Agent-mode tasks count triple toward the limit (they dominate wall time).
 */
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
        const task = mapRow(row);
        const cost = task.agentMode ? 3 : 1;
        if (cost > budget && claimed.length > 0) continue;

        const next = task.scheduleType === "recurring" ? computeNextRun(scheduleFields(task)) : null;
        const { data: updated, error: claimError } = await supabase
            .from("scheduled_tasks")
            .update({
                next_run_at: next,
                enabled: task.scheduleType === "once" ? false : task.enabled,
            })
            .eq("id", task.id)
            .eq("next_run_at", task.nextRunAt)
            .select("id");

        if (claimError || !updated || updated.length === 0) continue; // claimed elsewhere
        claimed.push(task);
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
