import type { ScheduledTask } from "@/lib/tasks/store";
import type { ActionApproval } from "@/lib/tasks/types";

export interface TaskDraft {
    title: string; instruction: string; scheduleType: "once" | "recurring";
    timezone: string; channel: ScheduledTask["channel"]; conversationId: string; agentMode: boolean;
    recurrence: "daily" | "weekdays" | "weekly" | "custom"; time: string; weekday: string; cron: string;
    localRunAt: string; originalRunAt: string | null; originalLocalRunAt: string; originalTimezone: string;
}

function formatter(timezone: string) {
    try {
        return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    } catch { throw new Error("Enter a valid timezone, such as Australia/Sydney."); }
}

export function localDateTime(value: string, timezone: string): string {
    const parts = Object.fromEntries(formatter(timezone).formatToParts(new Date(value)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function scheduledTime(value: string, timezone: string): string {
    formatter(timezone);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("Enter a valid date and time.");
    const wall = Date.parse(`${value}:00Z`);
    if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== value) throw new Error("Enter a valid date and time.");
    const offsets = new Set([-36, 0, 36].map(hours => {
        const sample = wall + hours * 3_600_000;
        return Date.parse(`${localDateTime(new Date(sample).toISOString(), timezone)}:00Z`) - sample;
    }));
    const matches = [...offsets].map(offset => new Date(wall - offset).toISOString()).filter(instant => localDateTime(instant, timezone) === value);
    if (!matches.length) throw new Error("This time does not exist because daylight saving changes the clock. Choose another time.");
    if (matches.length > 1) throw new Error("This time occurs twice when daylight saving ends. Choose an unambiguous time.");
    return matches[0];
}

export function taskDraft(task?: ScheduledTask): TaskDraft {
    const cron = task?.cron || "0 8 * * *";
    const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(cron);
    const timezone = task?.timezone || "Australia/Sydney";
    let localRunAt = "";
    if (task?.runAt) {
        try { localRunAt = localDateTime(task.runAt, timezone); } catch { /* Keep legacy invalid values editable. */ }
    }
    return { title: task?.title || "", instruction: task?.instruction || "", scheduleType: task?.scheduleType || "recurring", timezone,
        channel: task?.channel || "web", conversationId: task?.conversationId || "", agentMode: task?.agentMode || false,
        recurrence: !match ? "custom" : match[3] === "*" ? "daily" : match[3] === "1-5" ? "weekdays" : "weekly",
        time: match ? `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}` : "08:00", weekday: match?.[3].match(/^[0-6]$/)?.[0] || "1", cron,
        localRunAt, originalRunAt: task?.runAt || null, originalLocalRunAt: localRunAt, originalTimezone: timezone };
}

export function recurringScheduleLabel(task: ScheduledTask): string {
    if (!task.cron) return "Schedule unavailable";
    const draft = taskDraft(task);
    if (draft.recurrence === "custom" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) return task.cron;
    if (draft.recurrence === "daily") return `Daily at ${draft.time}`;
    if (draft.recurrence === "weekdays") return `Weekdays at ${draft.time}`;
    const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Number(draft.weekday)];
    return `Every ${weekday} at ${draft.time}`;
}

export function taskPayload(draft: TaskDraft) {
    if (!draft.title.trim()) throw new Error("Enter a task title.");
    if (!draft.instruction.trim()) throw new Error("Enter an instruction for this task.");
    formatter(draft.timezone.trim());
    const conversationId = draft.conversationId.trim();
    if (conversationId && !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(conversationId)) throw new Error("Enter a valid conversation ID or leave it blank.");
    let cron: string | null = null;
    let runAt: string | null = null;
    if (draft.scheduleType === "once") {
        runAt = draft.originalRunAt && draft.localRunAt === draft.originalLocalRunAt && draft.timezone === draft.originalTimezone
            ? draft.originalRunAt : scheduledTime(draft.localRunAt, draft.timezone.trim());
    } else if (draft.recurrence === "custom") {
        cron = draft.cron.trim();
        if (cron.split(/\s+/).length !== 5) throw new Error("Use a five-field cron schedule: minute hour day month weekday.");
    } else {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) throw new Error("Enter a valid schedule time.");
        if (draft.recurrence === "weekly" && !/^[0-6]$/.test(draft.weekday)) throw new Error("Choose a weekday.");
        const [hour, minute] = draft.time.split(":").map(Number);
        cron = `${minute} ${hour} * * ${draft.recurrence === "daily" ? "*" : draft.recurrence === "weekdays" ? "1-5" : draft.weekday}`;
    }
    return { title: draft.title.trim(), instruction: draft.instruction.trim(), scheduleType: draft.scheduleType, cron, runAt,
        timezone: draft.timezone.trim(), channel: draft.channel, conversationId: conversationId || null, agentMode: draft.agentMode };
}

export function approvalActionable(approval: Pick<ActionApproval, "status" | "expiresAt">, now = Date.now()) {
    return approval.status === "pending" && Date.parse(approval.expiresAt) > now;
}

export function runRequestKey(taskId: string) { return `zuychin-task-run:${taskId}`; }
