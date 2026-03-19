import { NextRequest, NextResponse } from "next/server";
import { listUnreadEmails, formatEmailSummary } from "@/lib/integrations/gmail-service";
import { listUpcomingEvents, formatEventsSummary } from "@/lib/integrations/calendar-service";
import { sendDiscordMessage } from "@/lib/messaging/discord-service";

const CRON_SECRET = process.env.CRON_SECRET;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

// POST /api/cron/daily-briefing — morning summary of emails + calendar to Discord
export async function POST(req: NextRequest) {
    try {
        const authHeader = req.headers.get("authorization");
        if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        if (!DISCORD_CHANNEL_ID) {
            return NextResponse.json({ error: "DISCORD_CHANNEL_ID not configured." }, { status: 500 });
        }

        const [emails, events] = await Promise.all([
            listUnreadEmails(10).catch((err) => {
                console.warn("[Briefing] Gmail fetch failed:", err);
                return [];
            }),
            listUpcomingEvents(12, 10).catch((err) => {
                console.warn("[Briefing] Calendar fetch failed:", err);
                return [];
            }),
        ]);

        const now = new Date();
        const dateStr = now.toLocaleDateString("en-AU", {
            timeZone: "Australia/Sydney",
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
        });

        const parts: string[] = [
            `☀️ **Good morning! Here's your briefing for ${dateStr}.**`,
        ];

        if (events.length > 0) {
            parts.push(`\n📅 **Today's Schedule (${events.length} event${events.length > 1 ? "s" : ""}):**\n${formatEventsSummary(events)}`);
        } else {
            parts.push("\n📅 **Calendar:** No events scheduled today.");
        }

        if (emails.length > 0) {
            parts.push(`\n📧 **Unread Emails (${emails.length}):**\n${formatEmailSummary(emails)}`);
        } else {
            parts.push("\n📧 **Inbox:** All clear — no unread emails!");
        }

        parts.push("\n_Reply here to ask about any email or manage the schedule._");

        const msg = parts.join("\n");
        await sendDiscordMessage(DISCORD_CHANNEL_ID, msg);

        console.log(`[Briefing] Sent daily briefing: ${emails.length} emails, ${events.length} events.`);

        return NextResponse.json({
            message: "Daily briefing sent.",
            emails: emails.length,
            events: events.length,
        });
    } catch (error) {
        console.error("[Briefing] Error:", error);
        return NextResponse.json({ error: "Daily briefing failed." }, { status: 500 });
    }
}
