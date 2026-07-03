import { NextRequest, NextResponse } from "next/server";
import { buildVaultGraph } from "@/lib/vault/graph";

// Reads every wiki page from GitHub; can exceed the default budget on big vaults.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
    try {
        const withSuggestions = req.nextUrl.searchParams.get("suggestions") === "1";
        const graph = await buildVaultGraph(withSuggestions);
        return NextResponse.json(graph);
    } catch (error: unknown) {
        console.error("[Vault Graph API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
