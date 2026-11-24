import { NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getEmbeddingRef } from "@/lib/ai/embeddings";
import { refreshEmbeddingOverride } from "@/lib/ai/embedding-override";
import { countPendingRows } from "@/lib/ai/embedding-migration-store";

export const maxDuration = 60;

export async function GET() {
    try {
        const signal = AbortSignal.timeout(40_000);
        await refreshEmbeddingOverride(signal);
        const active = getEmbeddingRef().model.id;
        const counts = await countPendingRows(supabase, active, signal);
        return NextResponse.json({ active, remaining: Object.values(counts).reduce((total, count) => total + count, 0) });
    } catch {
        return NextResponse.json({ error: "Embedding migration status is unavailable. Please retry." }, { status: 503 });
    }
}

// The browser re-embed loop was replaced by the server job on /admin#models.
export async function POST() {
    return NextResponse.json({ error: "Re-embedding moved to the dashboard: open /admin#models and use Switch knowledge to this.", moved: "/admin#models" }, { status: 410 });
}
