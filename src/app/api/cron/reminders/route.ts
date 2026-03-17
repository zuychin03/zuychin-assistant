import { NextRequest, NextResponse } from "next/server";
import { listUpcomingEvents, formatEventsSummary } from "@/lib/integrations/calendar-service";
import { sendDiscordMessage } from "@/lib/messaging/discord-service";

const CRON_SECRET = process.env.CRON_SECRET;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

// Reminder thresholds — send a reminder when an event is within this range.
// Runs every 15 mins, so check for events starting in the next 15 mins.
const LOOKAHEAD_MINUTES = 15;

/**
 * POST /api/cron/reminders
 * Checks Google Calendar for events starting within the next 15 minutes
 * and sends a Discord reminder. Called by an external cron scheduler.
 */
export async function POST(req: NextRequest) {
    try {
        const authHeader = req.headers.get("authorization");
        if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        if (!DISCORD_CHANNEL_ID) {
            return NextResponse.json({ error: "DISCORD_CHANNEL_ID not configured." }, { status: 500 });
        }

        // Fetch events in the next LOOKAHEAD_MINUTES
        const hoursAhead = LOOKAHEAD_MINUTES / 60;
        const events = await listUpcomingEvents(hoursAhead, 5);

        if (events.length === 0) {
            return NextResponse.json({ message: "No upcoming events.", reminded: 0 });
        }

        // Filter to events actually starting within the window
        const now = Date.now();
        const cutoff = now + LOOKAHEAD_MINUTES * 60 * 1000;

        const imminentEvents = events.filter((e) => {
            const startMs = new Date(e.start).getTime();
            return startMs >= now && startMs <= cutoff;
        });

        if (imminentEvents.length === 0) {
            return NextResponse.json({ message: "No imminent events.", reminded: 0 });
        }

        // Build and send the reminder message
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
