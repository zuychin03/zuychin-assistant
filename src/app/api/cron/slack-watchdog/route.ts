import { NextRequest, NextResponse } from "next/server";
import { listStalledThreads, markEscalated, handleStalledThread } from "@/lib/messaging/slack-orchestrator";
import { sendTelegramMessage } from "@/lib/messaging/telegram-service";

const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STALE_MINUTES = 30;

// A co-working thread where an agent was addressed but never replied is a stall.
// Escalate once, to Telegram (the quick/urgent channel), so you can step in.
export async function POST(req: NextRequest) {
    try {
        const authHeader = req.headers.get("authorization");
        if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const stalled = await listStalledThreads(STALE_MINUTES);
        let escalated = 0;
        const outcomes: Record<string, number> = { advanced: 0, closed: 0, skipped: 0 };

        for (const t of stalled) {
            if (TELEGRAM_CHAT_ID) {
                const ok = await sendTelegramMessage(
                    TELEGRAM_CHAT_ID,
                    `⚠️ Co-working stalled: "${t.task.slice(0, 100)}" — ${t.awaiting ?? "an agent"} hasn't replied in ~${t.staleMinutes}m. Check Slack.`,
                );
                if (ok) escalated++;
            }
            // Notifying isn't enough: unstick the thread itself, or it dies silently.
            await markEscalated(t.threadTs);
            const outcome = await handleStalledThread(t.threadTs, t.staleMinutes)
                .catch((e) => { console.error("[SlackWatchdog] Unstick failed:", e); return "skipped" as const; });
            outcomes[outcome] += 1;
        }

        return NextResponse.json({ stalled: stalled.length, escalated, ...outcomes });
    } catch (error) {
        console.error("[SlackWatchdog] Error:", error);
        return NextResponse.json({ error: "Watchdog failed." }, { status: 500 });
    }
}
