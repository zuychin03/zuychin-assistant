import { NextResponse } from "next/server";
import { listProvidersPublic, DEFAULT_CHAT, DEFAULT_EMBEDDING } from "@/lib/ai/providers";

export async function GET() {
    return NextResponse.json({
        providers: listProvidersPublic(),
        defaults: { chat: DEFAULT_CHAT, embedding: DEFAULT_EMBEDDING },
    });
}
