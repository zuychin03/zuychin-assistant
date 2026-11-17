import { NextRequest, NextResponse, after } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { executeDiscovery, liveDiscoveryDeps, startFailure } from "@/lib/ai/catalogue/run";

export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    try {
        const deps = await liveDiscoveryDeps();
        const started = await deps.startRun("manual");
        if (!started.ok) {
            const failure = startFailure(started.reason);
            return NextResponse.json({ error: failure.error }, { status: failure.status });
        }
        after(async () => { await executeDiscovery(started.runId, "manual", deps); });
        return NextResponse.json({ accepted: true, runId: started.runId }, { status: 202 });
    } catch (error) {
        console.error("[ModelDiscovery] Could not start:", error instanceof Error ? error.message : error);
        return NextResponse.json({ error: "The model check could not start." }, { status: 500 });
    }
}
