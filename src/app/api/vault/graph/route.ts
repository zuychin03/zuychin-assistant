import { after, NextRequest, NextResponse } from "next/server";
import { rebuildVaultGraph } from "@/lib/vault/graph";
import { readGraphSnapshot } from "@/lib/vault/graph-store";

// A cold build reads every wiki page from GitHub; the snapshot path is a single row.
export const maxDuration = 60;

const SNAPSHOT_TTL_MS = 15 * 60 * 1000;

export async function GET(req: NextRequest) {
    try {
        const force = req.nextUrl.searchParams.get("refresh") === "1";
        if (!force) {
            const snapshot = await readGraphSnapshot();
            if (snapshot) {
                const stale = Date.now() - Date.parse(snapshot.builtAt) > SNAPSHOT_TTL_MS;
                // Serve the stale payload now and rebuild behind the response, so a
                // cold cache is the only time anyone waits for a GitHub crawl.
                if (stale) {
                    after(async () => {
                        try {
                            await rebuildVaultGraph();
                        } catch (error) {
                            console.error("[Vault Graph] Background rebuild failed:", error);
                        }
                    });
                }
                return NextResponse.json({ ...snapshot.graph, builtAt: snapshot.builtAt, stale });
            }
        }
        const graph = await rebuildVaultGraph();
        return NextResponse.json({ ...graph, stale: false });
    } catch (error: unknown) {
        console.error("[Vault Graph API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
