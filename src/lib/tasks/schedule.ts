import { CronExpressionParser } from "cron-parser";
import { APP_TIMEZONE } from "@/lib/datetime";

export interface ScheduleFields {
    scheduleType: "once" | "recurring";
    cron: string | null;
    runAt: string | null;
    timezone: string;
}

/** Returns an error message, or null when the expression parses. */
export function validateCron(expr: string, timezone: string = APP_TIMEZONE): string | null {
    if (expr.trim().split(/\s+/).length !== 5) {
        return "Cron must be a 5-field expression: minute hour day-of-month month day-of-week (e.g. '0 8 * * 1-5').";
    }
    try {
        CronExpressionParser.parse(expr, { tz: timezone });
        return null;
    } catch (error) {
        return `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`;
    }
}

/** Next occurrence after `from` as ISO, or null when there is none (fired one-off). */
export function computeNextRun(fields: ScheduleFields, from: Date = new Date()): string | null {
    if (fields.scheduleType === "once") {
        if (!fields.runAt) return null;
        return new Date(fields.runAt) > from ? new Date(fields.runAt).toISOString() : null;
    }
    if (!fields.cron) return null;
    try {
        const it = CronExpressionParser.parse(fields.cron, { currentDate: from, tz: fields.timezone || APP_TIMEZONE });
        return it.next().toDate().toISOString();
    } catch (error) {
        console.warn("[Tasks] computeNextRun failed:", error);
        return null;
    }
}

export function describeNextRun(nextRunAt: string | null, timezone: string = APP_TIMEZONE): string {
    if (!nextRunAt) return "no further runs scheduled";
    const formatted = new Date(nextRunAt).toLocaleString("en-AU", {
        timeZone: timezone,
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    });
    return `next run ${formatted} (${timezone})`;
}
