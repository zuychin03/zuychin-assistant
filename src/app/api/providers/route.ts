import { NextResponse } from "next/server";
import { listProvidersPublic, DEFAULT_CHAT, DEFAULT_EMBEDDING } from "@/lib/ai/providers";

// GET /api/providers - list of providers/models and which ones are available
export async function GET() {
    return NextResponse.json({
        providers: listProvidersPublic(),
        defaults: { chat: DEFAULT_CHAT, embedding: DEFAULT_EMBEDDING },
    });
}
