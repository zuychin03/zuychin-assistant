import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { getModelHealth } from "@/lib/ai/model-health";

export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    if (req.nextUrl.searchParams.size) return NextResponse.json({ error: "Model health reports assistant observations only; query parameters are not supported." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const report = await getModelHealth();
    return NextResponse.json(report, { status: report.storage.available ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
