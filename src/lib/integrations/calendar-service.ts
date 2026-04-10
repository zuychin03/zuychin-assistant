import { google } from "googleapis";
import { getOAuth2Client } from "@/lib/google-auth";

function getCalendar() {
    return google.calendar({ version: "v3", auth: getOAuth2Client() });
}

export interface CalendarEvent {
    id?: string;
    summary: string;
    description?: string;
    start: string;
    end?: string;
    location?: string;
}

export async function listUpcomingEvents(
    hoursAhead: number = 24,
    maxResults: number = 10
): Promise<CalendarEvent[]> {
    const cal = getCalendar();
    const now = new Date();
    const future = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

    const res = await cal.events.list({
        calendarId: "primary",
        timeMin: now.toISOString(),
        timeMax: future.toISOString(),
        maxResults,
        singleEvents: true,
        orderBy: "startTime",
    });

    return (res.data.items ?? []).map((e) => ({
        id: e.id ?? undefined,
        summary: e.summary ?? "(No title)",
        description: e.description ?? undefined,
        start: e.start?.dateTime ?? e.start?.date ?? "",
        end: e.end?.dateTime ?? e.end?.date ?? undefined,
        location: e.location ?? undefined,
    }));
}

export async function createCalendarEvent(event: CalendarEvent): Promise<CalendarEvent> {
    const cal = getCalendar();

    const isAllDay = event.start.length === 10;

    const requestBody: Record<string, unknown> = {
        summary: event.summary,
        description: event.description,
        location: event.location,
    };

    if (isAllDay) {
        requestBody.start = { date: event.start };
        requestBody.end = { date: event.end ?? event.start };
    } else {
        requestBody.start = { dateTime: event.start, timeZone: "Australia/Sydney" };
        requestBody.end = {
            dateTime: event.end ?? new Date(new Date(event.start).getTime() + 60 * 60 * 1000).toISOString(),
            timeZone: "Australia/Sydney",
        };
    }

    const res = await cal.events.insert({
        calendarId: "primary",
        requestBody,
    });

    return {
        id: res.data.id ?? undefined,
        summary: res.data.summary ?? event.summary,
        description: res.data.description ?? undefined,
        start: (res.data.start?.dateTime ?? res.data.start?.date) ?? event.start,
        end: (res.data.end?.dateTime ?? res.data.end?.date) ?? undefined,
        location: res.data.location ?? undefined,
    };
}

export async function deleteCalendarEvent(eventId: string): Promise<boolean> {
    const cal = getCalendar();
    try {
        await cal.events.delete({ calendarId: "primary", eventId });
        return true;
    } catch (error) {
        console.error("[Calendar] Delete failed:", error);
        return false;
    }
}

export function formatEventsSummary(events: CalendarEvent[]): string {
    if (events.length === 0) return "No upcoming events.";

    return events.map((e) => {
        const time = e.start.includes("T")
            ? new Date(e.start).toLocaleString("en-AU", {
                timeZone: "Australia/Sydney",
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
            })
            : new Date(e.start + "T00:00:00").toLocaleDateString("en-AU", {
                timeZone: "Australia/Sydney",
                weekday: "short",
                month: "short",
                day: "numeric",
            }) + " (all day)";

        return `• **${e.summary}** — ${time}${e.location ? ` 📍 ${e.location}` : ""}\n  _Event ID: ${e.id}_`;
    }).join("\n");
}
