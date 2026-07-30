import { NextRequest, NextResponse } from "next/server";
import { searchVaultPages, vaultEmbeddingRef } from "@/lib/vault/store";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
    const query = req.nextUrl.searchParams.get("q")?.trim();
    if (!query) return NextResponse.json({ hits: [] });

    try {
        const embRef = await vaultEmbeddingRef();
        const hits = await searchVaultPages({ query, embRef, hybrid: true, matchCount: 30 });

        // Hybrid recall is chunk-level, so one page can hit several times; keep its
        // best score. score.final carries the blended rank, and keyword-only hits
        // score 0 on the semantic component alone.
        const best = new Map<string, { path: string; title: string; similarity: number }>();
        for (const hit of hits) {
            const similarity = Math.max(0, Math.min(1, hit.score?.final ?? hit.similarity));
            const current = best.get(hit.path);
            if (!current || similarity > current.similarity) {
                best.set(hit.path, { path: hit.path, title: hit.title, similarity });
            }
        }

        return NextResponse.json({
            hits: [...best.values()].sort((a, b) => b.similarity - a.similarity),
        });
    } catch (error: unknown) {
        console.error("[Vault Search API Error]", error);
        const message = error instanceof Error ? error.message : "Vault search failed.";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
