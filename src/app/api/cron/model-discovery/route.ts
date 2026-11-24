import { NextRequest, NextResponse, after } from "next/server";
import { requireCron } from "@/lib/auth/guard";
import { discoveryEnabled, executeDiscovery, liveDiscoveryDeps, startFailure } from "@/lib/ai/catalogue/run";

// Probes run for minutes, past cron-job.org's 30-second wait and Cloudflare's 100-second cut, so the work goes in after().
export async function POST(req: NextRequest) {
    const denied = requireCron(req);
    if (denied) return denied;
    if (!discoveryEnabled()) return new NextResponse(null, { status: 204 });
    try {
        const deps = await liveDiscoveryDeps();
        const started = await deps.startRun("cron");
        if (!started.ok) {
            const failure = startFailure(started.reason);
            return NextResponse.json({ error: failure.error }, { status: failure.status });
        }
        after(async () => {
            // A knowledge model switch paused on a daily quota, or cut off by a restart, picks up alongside the run.
            const resumed = import("@/lib/ai/embedding-switch-live").then(async ({ runSwitchLive, switchToResume }) => {
                const resume = await switchToResume();
                if (resume) await runSwitchLive(resume);
            }).catch((error) => console.error("[EmbeddingSwitch] Resume failed:", error instanceof Error ? error.message : error));
            const summary = await executeDiscovery(started.runId, "cron", deps);
            await resumed;
            if (summary) console.log(`[ModelDiscovery] Done in ${summary.durationMs} ms: added ${summary.added.length}, passed ${summary.passed.length}, newly missing ${summary.newlyMissing.length}, notified ${summary.notified}`);
        });
        return NextResponse.json({ accepted: true, runId: started.runId }, { status: 202 });
    } catch (error) {
        console.error("[ModelDiscovery] Could not start:", error instanceof Error ? error.message : error);
        return NextResponse.json({ error: "Model discovery could not start." }, { status: 500 });
    }
}
