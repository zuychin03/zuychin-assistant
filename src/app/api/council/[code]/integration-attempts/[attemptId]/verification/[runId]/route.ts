import { NextRequest, NextResponse } from "next/server";
import { getSessionByCode } from "@/lib/council/store";
import { readOwnerVerification } from "@/lib/council/owner-evidence-reader";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string; attemptId: string; runId: string }> }) {
    try {
        const { code, attemptId, runId } = await params;
        const session = await getSessionByCode(code);
        if (!session) return NextResponse.json({ error: "Council not found." }, { status: 404, headers });
        const result = await readOwnerVerification(session.id, attemptId, runId);
        return NextResponse.json(result, { status: result.status === "available" ? 200 : result.status === "not_found" ? 404 : 503, headers });
    } catch { return NextResponse.json({ error: "Verification evidence is unavailable." }, { status: 503, headers }); }
}
