import { NextRequest, NextResponse } from "next/server";
import { listUpcomingEvents, formatEventsSummary } from "@/lib/integrations/calendar-service";
import { sendDiscordMessage } from "@/lib/messaging/discord-service";

const CRON_SECRET = process.env.CRON_SECRET;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const LOOKAHEAD_MINUTES = 15;

// POST /api/cron/reminders — sends Discord reminders for imminent calendar events
export async function POST(req: NextRequest) {
    try {
        const authHeader = req.headers.get("authorization");
        if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        if (!DISCORD_CHANNEL_ID) {
            return NextResponse.json({ error: "DISCORD_CHANNEL_ID not configured." }, { status: 500 });
        }

        const hoursAhead = LOOKAHEAD_MINUTES / 60;
        const events = await listUpcomingEvents(hoursAhead, 5);

        if (events.length === 0) {
            return NextResponse.json({ message: "No upcoming events.", reminded: 0 });
        }

        const now = Date.now();
        const cutoff = now + LOOKAHEAD_MINUTES * 60 * 1000;

        const imminentEvents = events.filter((e) => {
            const startMs = new Date(e.start).getTime();
            return startMs >= now && startMs <= cutoff;
        });

        if (imminentEvents.length === 0) {
            return NextResponse.json({ message: "No imminent events.", reminded: 0 });
        }

        const summary = formatEventsSummary(imminentEvents);
        const msg = `⏰ **Upcoming in the next ${LOOKAHEAD_MINUTES} minutes:**\n\n${summary}`;

        await sendDiscordMessage(DISCORD_CHANNEL_ID, msg);
        console.log(`[Reminders] Sent reminder for ${imminentEvents.length} event(s).`);

        return NextResponse.json({
            message: "Reminders sent.",
            reminded: imminentEvents.length,
        });
    } catch (error) {
        console.error("[Reminders] Error:", error);
        return NextResponse.json({ error: "Reminder check failed." }, { status: 500 });
    }
}
