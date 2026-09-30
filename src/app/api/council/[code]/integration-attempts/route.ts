import { NextRequest, NextResponse } from "next/server";
import { getSessionByCode } from "@/lib/council/store";
import { listOwnerAttempts } from "@/lib/council/owner-evidence-reader";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
    const raw = req.nextUrl.searchParams.get("cursor");
    const cursor = raw === null ? null : Number(raw);
    if (raw !== null && (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(cursor))) return NextResponse.json({ error: "Invalid attempt cursor." }, { status: 400, headers });
    try {
        const session = await getSessionByCode((await params).code);
        if (!session) return NextResponse.json({ error: "Council not found." }, { status: 404, headers });
        const page = await listOwnerAttempts(session.id, cursor);
        return NextResponse.json(page, { status: page.status === "available" ? 200 : 503, headers });
    } catch { return NextResponse.json({ error: "Attempt history is unavailable." }, { status: 503, headers }); }
}
