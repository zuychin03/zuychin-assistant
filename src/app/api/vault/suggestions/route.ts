import { NextRequest, NextResponse } from "next/server";
import { suggestLinksForPage } from "@/lib/vault/graph";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
    const path = req.nextUrl.searchParams.get("path")?.trim();
    if (!path) return NextResponse.json({ error: "A page path is required." }, { status: 400 });

    try {
        return NextResponse.json({ suggestions: await suggestLinksForPage(path) });
    } catch (error: unknown) {
        console.error("[Vault Suggestions API Error]", error);
        const message = error instanceof Error ? error.message : "Could not compute suggestions.";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
