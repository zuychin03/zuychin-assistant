import { NextRequest, NextResponse } from "next/server";
import { listAgentRuns, getAgentRun } from "@/lib/ai/agent/run-store";

export async function GET(req: NextRequest) {
    try {
        const id = req.nextUrl.searchParams.get("id");
        if (id) {
            const run = await getAgentRun(id);
            if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
            return NextResponse.json({ run });
        }
        const runs = await listAgentRuns(25);
        return NextResponse.json({ runs });
    } catch (err) {
        console.error("[Admin Runs] Failed:", err);
        return NextResponse.json({ error: "Failed to load runs." }, { status: 500 });
    }
}
