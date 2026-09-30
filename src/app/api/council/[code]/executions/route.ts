import { NextRequest, NextResponse } from "next/server";
import { getSessionByCode } from "@/lib/council/store";
import { parseExecutionCursor, readExecutionEvidence } from "@/lib/council/execution-reader";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
    const cursor = req.nextUrl.searchParams.get("cursor");
    try { parseExecutionCursor(cursor); }
    catch { return NextResponse.json({ error: "Invalid execution cursor." }, { status: 400, headers }); }
    try {
        const { code } = await params;
        const session = await getSessionByCode(code);
        if (!session) return NextResponse.json({ error: "No council with that code." }, { status: 404, headers });
        const page = await readExecutionEvidence(session.id, { cursor });
        return NextResponse.json(page, { status: page.historyStatus === "available" ? 200 : 503, headers });
    } catch {
        return NextResponse.json({ error: "Could not load execution history." }, { status: 503, headers });
    }
}
