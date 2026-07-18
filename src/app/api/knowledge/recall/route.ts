import { NextRequest, NextResponse } from "next/server";
import { recallKnowledge } from "@/lib/knowledge/store";
import { groundRecall } from "@/lib/knowledge/recall";
import { vaultEmbeddingRef } from "@/lib/vault/store";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
    try {
        const body = await req.json() as { query?: string; projectId?: string; limit?: number };
        const query = body.query?.trim();
        if (!query) return NextResponse.json({ error: "A query is required." }, { status: 400 });
        const embRef = await vaultEmbeddingRef();
        const hits = await recallKnowledge({
            query,
            embRef,
            projectId: body.projectId,
            matchCount: Math.min(20, Math.max(1, body.limit ?? 8)),
        });
        if (hits === null) {
            return NextResponse.json({ error: "Run supabase-setup.sql before using unified recall." }, { status: 503 });
        }
        return NextResponse.json({ hits, grounded: groundRecall(query, hits) });
    } catch (error) {
        console.error("[Knowledge Recall]", error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Knowledge recall failed.",
        }, { status: 500 });
    }
}
