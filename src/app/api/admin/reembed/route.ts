import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { embedText, getEmbeddingRef, type ResolvedEmbedding } from "@/lib/ai/embeddings";
import { refreshEmbeddingOverride, setEmbeddingOverride } from "@/lib/ai/embedding-override";
import {
    MIGRATION_TABLES, applyMigration, planMigration, prepareMigration, verifyMigration, type MigrationTable,
} from "@/lib/ai/embedding-migration";
import { createMigrationStore } from "@/lib/ai/embedding-migration-store";

export const maxDuration = 60;

const CHUNK = 20;
const CONCURRENCY = 4;

async function countRemaining(target: string, signal: AbortSignal): Promise<Record<MigrationTable, number>> {
    const counts = await Promise.all(MIGRATION_TABLES.map(async (table) => {
        const { count, error } = await supabase
            .from(table)
            .select("id", { count: "exact", head: true })
            .or(`embedding.is.null,embedding_model.is.null,embedding_model.neq.${target}`)
            .abortSignal(signal);
        if (error || count === null) throw new Error("Embedding migration status is unavailable.");
        return [table, count] as const;
    }));
    return Object.fromEntries(counts) as Record<MigrationTable, number>;
}

const totalRemaining = (counts: Record<MigrationTable, number>) => Object.values(counts).reduce((total, count) => total + count, 0);

export async function GET() {
    try {
        const signal = AbortSignal.timeout(40_000);
        await refreshEmbeddingOverride(signal);
        const active = getEmbeddingRef().model.id;
        return NextResponse.json({ active, remaining: totalRemaining(await countRemaining(active, signal)) });
    } catch {
        return NextResponse.json({ error: "Embedding migration status is unavailable. Please retry." }, { status: 503 });
    }
}

export async function POST(req: NextRequest) {
    let targetRef: ResolvedEmbedding;
    try {
        const body = await req.json() as { target?: unknown } | null;
        const target = typeof body?.target === "string" ? body.target.trim() : "";
        if (!target) throw new Error("Missing target.");
        targetRef = getEmbeddingRef(target);
    } catch {
        return NextResponse.json({ error: "A supported target model id is required." }, { status: 400 });
    }

    try {
        const signal = AbortSignal.timeout(40_000);
        const pending = await countRemaining(targetRef.model.id, signal);
        const hasPending = totalRemaining(pending) > 0;
        const store = createMigrationStore(supabase, setEmbeddingOverride, { signal });
        const source = hasPending
            ? createMigrationStore(supabase, undefined, { signal, pendingModel: targetRef.model.id })
            : store;
        const plan = await planMigration(source, targetRef.model.id, targetRef.model.dimension, {
            maxItems: CHUNK, stopAfterMaxItems: hasPending,
        });
        const prepared = await prepareMigration(plan, (text) => embedText(targetRef, text, "passage", signal), CONCURRENCY);
        const result = await applyMigration(store, plan, prepared, CONCURRENCY, async (current, target, dimension) => {
            const remaining = await countRemaining(target, signal);
            return totalRemaining(remaining) ? remaining : verifyMigration(current, target, dimension);
        });
        const progress = {
            done: result.complete,
            migrated: result.updated,
            remaining: totalRemaining(result.remaining),
        };
        if (result.conflicts.length || result.failures.length) {
            return NextResponse.json({
                ...progress,
                error: "Some rows changed or could not be saved. Retry to continue the migration.",
                retryable: true,
            }, { status: 409 });
        }
        return NextResponse.json(progress);
    } catch {
        return NextResponse.json({ error: "Re-embedding could not finish this batch. Please retry." }, { status: 502 });
    }
}
