export const APP_TIMEZONE = process.env.APP_TIMEZONE || "Australia/Sydney";

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

export function currentDateTimeContext(timezone: string = APP_TIMEZONE): string {
    return `The current date and time is ${formatNow(timezone)} (${timezone}). Treat this as the source of truth for "today", "now" and any date math - do not guess the date.`;
}
