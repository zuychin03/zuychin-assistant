import { NextRequest, NextResponse } from "next/server";
import { listRecentlyFinished, pruneOldThreads } from "@/lib/messaging/slack-orchestrator";
import { notify } from "@/lib/messaging/router";

const CRON_SECRET = process.env.CRON_SECRET;
const DAY_MS = 24 * 60 * 60 * 1000;

// Daily rollup of what the agents wrapped in the last 24h, to #coworking-log.
// Also prunes co-working thread state older than a week.
export async function POST(req: NextRequest) {
    try {
        const authHeader = req.headers.get("authorization");
        if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const finished = await listRecentlyFinished(DAY_MS);
        const pruned = await pruneOldThreads(7 * DAY_MS);

        if (finished.length === 0) {
            return NextResponse.json({ finished: 0, pruned });
        }

        const lines = finished.map(
            (f) => `- ${f.status === "done" ? "✅" : "⚠️"} ${f.task.slice(0, 100)} (${f.turns} turns)`,
        );
        const msg = `📊 **Agent standup — last 24h** (${finished.length} thread${finished.length > 1 ? "s" : ""})\n${lines.join("\n")}`;
        await notify("agent_run_complete", msg);

        return NextResponse.json({ finished: finished.length, pruned });
    } catch (error) {
        console.error("[AgentStandup] Error:", error);
        return NextResponse.json({ error: "Standup failed." }, { status: 500 });
    }
}
