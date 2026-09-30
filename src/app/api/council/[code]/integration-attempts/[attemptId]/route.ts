import { NextRequest, NextResponse } from "next/server";
import { getSessionByCode } from "@/lib/council/store";
import { readOwnerAttempt } from "@/lib/council/owner-evidence-reader";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string; attemptId: string }> }) {
    try {
        const { code, attemptId } = await params;
        const session = await getSessionByCode(code);
        if (!session) return NextResponse.json({ error: "Council not found." }, { status: 404, headers });
        const result = await readOwnerAttempt(session.id, attemptId);
        return NextResponse.json(result, { status: result.status === "available" ? 200 : result.status === "not_found" ? 404 : 503, headers });
    } catch { return NextResponse.json({ error: "Attempt evidence is unavailable." }, { status: 503, headers }); }
}
