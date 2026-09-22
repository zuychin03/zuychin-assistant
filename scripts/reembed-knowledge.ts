import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { embedText, getEmbeddingRef } from "../src/lib/ai/embeddings";
import { applyMigration, planMigration, prepareMigration } from "../src/lib/ai/embedding-migration";
import { createMigrationStore } from "../src/lib/ai/embedding-migration-store";

function options(args: string[]) {
    let model = "", concurrency = 2, apply = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--apply" && !apply) apply = true;
        else if (args[i] === "--model" && !model && args[i + 1] && !args[i + 1].startsWith("--")) model = args[++i];
        else if (args[i] === "--concurrency" && args[i + 1]) concurrency = Number(args[++i]);
        else throw new Error("Usage: reembed-knowledge.ts --model <registered-id> [--concurrency 1-8] [--apply]");
    }
    if (!model || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
        throw new Error("An explicit --model and concurrency between 1 and 8 are required.");
    }
    return { model, concurrency, apply };
}

async function main() {
    const opts = options(process.argv.slice(2));
    const ref = getEmbeddingRef(opts.model);
    if (ref.model.id !== opts.model) throw new Error("The target embedding model is not registered.");
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("The Supabase URL and service-role key are required.");
    }
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
    });
    const store = createMigrationStore(sb);
    const plan = await planMigration(store, ref.model.id, ref.model.dimension);
    console.log(JSON.stringify({ mode: opts.apply ? "apply" : "dry-run", target: plan.target, dimension: plan.dimension, counts: plan.counts }));
    if (!opts.apply) return;

    const prepared = await prepareMigration(plan, async (text) => {
        for (let attempt = 0; attempt < 3; attempt++) {
            try { return await embedText(ref, text, "passage"); }
            catch {
                if (attempt === 2) throw new Error("Embedding preparation failed after three attempts; no migration writes started.");
                await delay(500 * 2 ** attempt);
            }
        }
        throw new Error("Embedding preparation failed.");
    }, opts.concurrency, (completed, total) => {
        if (completed % 50 === 0 || completed === total) console.log(JSON.stringify({ phase: "prepare", completed, total }));
    });
    console.log(JSON.stringify({ phase: "apply", prepared: prepared.length }));
    const result = await applyMigration(store, plan, prepared, opts.concurrency);
    console.log(JSON.stringify({ phase: "verify", ...result }));
    if (!result.complete) process.exitCode = 1;
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Embedding migration failed.");
    process.exitCode = 1;
});
