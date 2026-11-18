import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { sttConfigured } from "@/lib/voice/stt-client";

// Config only: probing the service would start it through its socket on every page load. /api/voice/warm
// does the live check when the mic is tapped.
export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    return NextResponse.json({ available: sttConfigured() }, { headers: { "Cache-Control": "no-store" } });
}
