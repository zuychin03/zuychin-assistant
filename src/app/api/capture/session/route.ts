import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { captureProfile } from "@/lib/capture/store";
export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    try { return NextResponse.json({ profileId: (await captureProfile()).id }, { headers: { "Cache-Control": "private, no-store" } }); }
    catch { return NextResponse.json({ error: "The current profile is unavailable." }, { status: 503 }); }
}
