import { NextRequest, NextResponse } from "next/server";
import { listUpcomingEvents, formatEventsSummary } from "@/lib/integrations/calendar-service";
import { notify } from "@/lib/messaging/router";
import { hasAnyDiscordChannel } from "@/lib/messaging/channels";
import { listDueTodos, markTodosReminded } from "@/lib/db";
import { APP_TIMEZONE } from "@/lib/datetime";

const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LOOKAHEAD_MINUTES = 15;

function formatDue(dueDate: string): string {
    const hasTime = dueDate.includes("T");
    return new Date(dueDate).toLocaleString("en-AU", {
        timeZone: APP_TIMEZONE,
        weekday: "short",
        day: "numeric",
        month: "short",
        ...(hasTime && { hour: "numeric", minute: "2-digit", hour12: true }),
    });
}

export async function POST(req: NextRequest) {
    try {
        const authHeader = req.headers.get("authorization");
        if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        if (!hasAnyDiscordChannel() && !TELEGRAM_CHAT_ID) {
            return NextResponse.json({ error: "No messaging channel configured." }, { status: 500 });
        }

        // Imminent calendar events.
        const hoursAhead = LOOKAHEAD_MINUTES / 60;
        const events = await listUpcomingEvents(hoursAhead, 5);
        const now = Date.now();
        const cutoff = now + LOOKAHEAD_MINUTES * 60 * 1000;
        const imminentEvents = events.filter((e) => {
            const startMs = new Date(e.start).getTime();
            return startMs >= now && startMs <= cutoff;
        });

        if (imminentEvents.length > 0) {
            const summary = formatEventsSummary(imminentEvents);
            await notify("event_reminder", `⏰ **Upcoming in the next ${LOOKAHEAD_MINUTES} minutes:**\n\n${summary}`, {
                pushTitle: "Zuychin reminder",
            });
            console.log(`[Reminders] Sent reminder for ${imminentEvents.length} event(s).`);
        }

        // Todos due within 24h (re-nags roughly daily while overdue).
        const dueTodos = await listDueTodos();
        if (dueTodos.length > 0) {
            const lines = dueTodos.map((t) => {
                const overdue = t.dueDate && new Date(t.dueDate).getTime() < now;
                return `- ${t.title} (${overdue ? "OVERDUE — was due" : "due"} ${formatDue(t.dueDate!)})`;
            });
            await notify("todo_due", `⏰ **Tasks due soon:**\n\n${lines.join("\n")}\n\nTick them off in the Notes panel when done.`);
            await markTodosReminded(dueTodos.map((t) => t.id));
            console.log(`[Reminders] Nagged about ${dueTodos.length} due todo(s).`);
        }

        return NextResponse.json({
            message: imminentEvents.length || dueTodos.length ? "Reminders sent." : "Nothing to remind.",
            reminded: imminentEvents.length,
            todosNagged: dueTodos.length,
        });
    } catch (error) {
        console.error("[Reminders] Error:", error);
        return NextResponse.json({ error: "Reminder check failed." }, { status: 500 });
    }
}
