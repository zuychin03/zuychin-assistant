import { NextRequest, NextResponse } from "next/server";
import { searchVaultPages, vaultEmbeddingRef } from "@/lib/vault/store";
import { graphSearchPages } from "@/lib/vault/page-hits";
import { getDefaultProfile } from "@/lib/db";
import { effectiveFreeOnly } from "@/lib/ai/model-policy";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
    const query = req.nextUrl.searchParams.get("q")?.trim();
    if (!query) return NextResponse.json({ hits: [] });

    try {
        const [embRef, profile] = await Promise.all([vaultEmbeddingRef(), getDefaultProfile().catch(() => null)]);
        // Unknown preferences rank with free models only.
        const freeOnly = profile ? effectiveFreeOnly(profile) : true;
        const hits = await searchVaultPages({ query, embRef, hybrid: true, matchCount: 30, rerank: { freeOnly, signal: req.signal } });

        // Hybrid recall is chunk-level, so one page can hit several times; its first
        // hit is its best. score.final carries the blended rank, and keyword-only hits
        // score 0 on the semantic component alone.
        return NextResponse.json({ hits: graphSearchPages(hits) });
    } catch (error: unknown) {
        console.error("[Vault Search API Error]", error);
        const message = error instanceof Error ? error.message : "Vault search failed.";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
