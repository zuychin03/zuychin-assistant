import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { sttAvailable } from "@/lib/voice/stt-client";

const CACHE_MS = 30_000;
let cached: { at: number; available: boolean } | null = null;

export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    if (!cached || Date.now() - cached.at > CACHE_MS) cached = { at: Date.now(), available: await sttAvailable() };
    return NextResponse.json({ available: cached.available }, { headers: { "Cache-Control": "no-store" } });
}
