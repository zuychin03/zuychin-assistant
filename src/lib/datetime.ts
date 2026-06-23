// Helpers for telling the model what "now" is. We inject the current date/time
// into the context on every request so the model never has to guess the date when
// talking about plans, schedules or anything time-sensitive.

// Timezone the assistant thinks in. Defaults to Australia/Sydney, override with
// APP_TIMEZONE (any IANA name, e.g. "America/New_York").
export const APP_TIMEZONE = process.env.APP_TIMEZONE || "Australia/Sydney";

// A readable "now" string for the given timezone.
export function formatNow(timezone: string = APP_TIMEZONE): string {
    return new Date().toLocaleString("en-AU", {
        timeZone: timezone,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    });
}

// One line to drop into the system context so the model anchors to the real date.
export function currentDateTimeContext(timezone: string = APP_TIMEZONE): string {
    return `The current date and time is ${formatNow(timezone)} (${timezone}). Treat this as the source of truth for "today", "now" and any date math - do not guess the date.`;
}
