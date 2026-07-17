import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { embedText, getEmbeddingRef } from "@/lib/ai/embeddings";
import { refreshEmbeddingOverride, setEmbeddingOverride } from "@/lib/ai/embedding-override";

export const maxDuration = 60;

// Rows per call: each needs one embedding API round trip (~0.3s), so a chunk
// stays well inside maxDuration. The client keeps POSTing until done:true —
// an interrupted migration resumes exactly where it stopped because progress
// is the rows themselves (embedding_model != target).
const CHUNK = 20;

// The vault is deliberately excluded: its pages resolve their own majority
// partition (see vault/store.ts) and are re-embedded by vault lint flows.
const TABLES = [
    { table: "embeddings", textColumn: "content" },
    { table: "memories", textColumn: "fact" },
] as const;

async function countRemaining(target: string): Promise<number> {
    let total = 0;
    for (const { table } of TABLES) {
        // .neq alone would skip NULL rows (SQL three-valued logic), stranding
        // any legacy row without a recorded model.
        const { count, error } = await supabase
            .from(table)
            .select("id", { count: "exact", head: true })
            .or(`embedding_model.is.null,embedding_model.neq.${target}`);
        if (error) throw new Error(`${table} count failed: ${error.message}`);
        total += count ?? 0;
    }
    return total;
}

export async function GET() {
    await refreshEmbeddingOverride();
    const active = getEmbeddingRef().model.id;
    try {
        return NextResponse.json({ active, remaining: await countRemaining(active) });
    } catch {
        // Pre-DDL or transient: the selector still needs to know the model.
        return NextResponse.json({ active, remaining: 0 });
    }
}

export async function POST(req: NextRequest) {
    let target = "";
    try {
        const body = await req.json();
        if (typeof body.target === "string") target = body.target.trim();
    } catch { }
    if (!target) {
        return NextResponse.json({ error: "target model id is required" }, { status: 400 });
    }

    const targetRef = getEmbeddingRef(target);
    if (targetRef.model.id !== target) {
        return NextResponse.json({ error: `Unknown embedding model "${target}"` }, { status: 400 });
    }

    try {
        let migrated = 0;
        for (const { table, textColumn } of TABLES) {
            if (migrated >= CHUNK) break;
            const { data, error } = await supabase
                .from(table)
                .select(`id, ${textColumn}`)
                .or(`embedding_model.is.null,embedding_model.neq.${target}`)
                .limit(CHUNK - migrated);
            if (error) throw new Error(`${table} read failed: ${error.message}`);

            for (const row of (data ?? []) as unknown as Record<string, string>[]) {
                const embedding = await embedText(targetRef, row[textColumn]);
                const { error: upErr } = await supabase
                    .from(table)
                    .update({ embedding: JSON.stringify(embedding), embedding_model: target })
                    .eq("id", row.id);
                if (upErr) throw new Error(`${table} update failed: ${upErr.message}`);
                migrated++;
            }
        }

        const remaining = await countRemaining(target);
        if (remaining === 0) {
            // Flip only after every row is in the new partition, so searches
            // stay consistent throughout the migration.
            await setEmbeddingOverride(target);
            console.log(`[Reembed] Store migrated to ${target}.`);
            return NextResponse.json({ done: true, migrated, remaining: 0 });
        }
        return NextResponse.json({ done: false, migrated, remaining });
    } catch (err) {
        console.error("[Reembed] Chunk failed:", err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "Re-embed chunk failed" },
            { status: 502 }
        );
    }
}
