import assert from "node:assert/strict";
import { taskDraft, taskPayload, recurringScheduleLabel, localDateTime, scheduledTime, approvalActionable, runRequestKey } from "../src/app/tasks/task-form";
import type { ScheduledTask } from "../src/lib/tasks/store";

const task: ScheduledTask = { id: "task-1", title: "Morning", instruction: "Summarise saved priorities", scheduleType: "recurring", cron: "0 8 * * 1-5", runAt: null, timezone: "Australia/Sydney", channel: "web", conversationId: null, agentMode: false, enabled: true, nextRunAt: "2026-09-29T22:00:00Z", lastRunAt: null, lastStatus: null, lastResult: null, createdAt: "2026-09-28T00:00:00Z" };
const draft = taskDraft(task);
assert.equal(draft.recurrence, "weekdays");
assert.equal(draft.time, "08:00");
assert.equal(taskPayload(draft).cron, "0 8 * * 1-5");
assert.equal(taskPayload({ ...draft, recurrence: "weekly", weekday: "2", time: "09:45" }).cron, "45 9 * * 2");
assert.equal(taskPayload({ ...draft, recurrence: "daily", time: "07:05" }).cron, "5 7 * * *");
assert.equal(taskDraft({ ...task, cron: "*/20 7-9 * * 2,4" }).recurrence, "custom");
assert.equal(taskPayload({ ...draft, recurrence: "custom", cron: "*/20 7-9 * * 2,4" }).cron, "*/20 7-9 * * 2,4");
assert.equal(scheduledTime("2027-01-15T08:00", "Australia/Sydney"), "2027-01-14T21:00:00.000Z");
assert.equal(scheduledTime("2027-07-15T08:00", "Australia/Sydney"), "2027-07-14T22:00:00.000Z");
assert.equal(scheduledTime("2027-01-15T08:00", "Asia/Ho_Chi_Minh"), "2027-01-15T01:00:00.000Z");
assert.throws(() => scheduledTime("2026-10-04T02:30", "Australia/Sydney"), /does not exist/i);
assert.throws(() => scheduledTime("2027-04-04T02:30", "Australia/Sydney"), /occurs twice/i);
assert.throws(() => scheduledTime("2027-02-30T08:00", "Australia/Sydney"), /valid date/i);
assert.throws(() => scheduledTime("2027-01-15T08:00", "Invalid/Zone"), /timezone/i);
assert.equal(localDateTime("2027-01-14T21:00:00Z", "Australia/Sydney"), "2027-01-15T08:00");
const once = { ...task, scheduleType: "once" as const, cron: null, runAt: "2027-04-03T15:30:00.000Z" };
assert.equal(taskPayload({ ...taskDraft(once), title: "Edited title" }).runAt, once.runAt);
assert.throws(() => taskPayload({ ...draft, title: " " }), /title/i);
assert.throws(() => taskPayload({ ...draft, instruction: " " }), /instruction/i);
assert.throws(() => taskPayload({ ...draft, recurrence: "custom", cron: "0 8 * * * *" }), /five/i);
assert.throws(() => taskPayload({ ...draft, conversationId: "not-id" }), /conversation/i);
assert.equal(approvalActionable({ status: "pending", expiresAt: "2026-09-29T00:00:00Z" }, Date.parse("2026-09-28T00:00:00Z")), true);
assert.equal(approvalActionable({ status: "pending", expiresAt: "2026-09-27T00:00:00Z" }, Date.parse("2026-09-28T00:00:00Z")), false);
assert.equal(approvalActionable({ status: "outcome_unknown", expiresAt: "2026-09-29T00:00:00Z" }), false);
assert.equal(runRequestKey("task-1"), "zuychin-task-run:task-1");
const scheduleLabels = [
    ["0 8 * * 1-5", "Weekdays at 08:00"],
    ["0 17 * * 5", "Every Friday at 17:00"],
    ["3 9 * * 0", "Every Sunday at 09:03"],
    ["0 0 * * *", "Daily at 00:00"],
    ["59 23 * * *", "Daily at 23:59"],
    ["*/20 7-9 * * 2,4", "*/20 7-9 * * 2,4"],
    ["0 8 1 * *", "0 8 1 * *"],
    ["99 88 * * *", "99 88 * * *"],
    [null, "Schedule unavailable"],
] as const;
for (const [cron, expected] of scheduleLabels) assert.equal(recurringScheduleLabel({ ...task, cron }), expected);
console.log(`Tasks UI: 24 core assertions and ${scheduleLabels.length} schedule formatting cases passed.`);
