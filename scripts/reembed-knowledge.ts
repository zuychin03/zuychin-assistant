import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { embedText, getEmbeddingRef } from "../src/lib/ai/embeddings";
import { applyMigration, planMigration, prepareMigration } from "../src/lib/ai/embedding-migration";
import { embedPastScreen, isScreenRefusal } from "../src/lib/ai/embedding-screening";
import { createMigrationStore } from "../src/lib/ai/embedding-migration-store";
import { refreshCatalogueSnapshot } from "../src/lib/ai/catalogue/snapshot";

function options(args: string[]) {
    let model = "", provider = "", concurrency = 2, apply = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--apply" && !apply) apply = true;
        else if (args[i] === "--model" && !model && args[i + 1] && !args[i + 1].startsWith("--")) model = args[++i];
        else if (args[i] === "--provider" && !provider && args[i + 1] && !args[i + 1].startsWith("--")) provider = args[++i];
        else if (args[i] === "--concurrency" && args[i + 1]) concurrency = Number(args[++i]);
        else throw new Error("Usage: reembed-knowledge.ts --model <registered-id or id@dimension> [--provider <id>] [--concurrency 1-8] [--apply]");
    }
    if (!model || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
        throw new Error("An explicit --model and concurrency between 1 and 8 are required.");
    }
    return { model, provider: provider || undefined, concurrency, apply };
}

async function main() {
    const opts = options(process.argv.slice(2));
    // Discovered routes (an OpenRouter copy, a Gemini free-key model) exist only in the stored catalogue.
    await refreshCatalogueSnapshot();
    const ref = getEmbeddingRef(opts.model, opts.provider);
    if (ref.model.id !== opts.model || (opts.provider && ref.provider.id !== opts.provider)) throw new Error("The target embedding model is not registered on that provider.");
    if (ref.model.retired) throw new Error("The target embedding model is retired; pick a current one.");
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("The Supabase URL and service-role key are required.");
    }
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
    });
    // Saves the route with the partition, as the dashboard switch does.
    const store = createMigrationStore(sb, async (target) => {
        const { error } = await sb.from("cron_state").upsert({ key: "knowledge_embedding", value: { model: target, providerId: ref.provider.id, dimension: ref.model.dimension } }, { onConflict: "key" });
        if (error) throw new Error("Verified vectors are saved, but runtime activation failed. Rerun to retry activation.");
    });
    const plan = await planMigration(store, ref.model.id, ref.model.dimension);
    console.log(JSON.stringify({ mode: opts.apply ? "apply" : "dry-run", target: plan.target, dimension: plan.dimension, counts: plan.counts }));
    if (!opts.apply) return;

    const prepared = await prepareMigration(plan, async (text) => {
        for (let attempt = 0; attempt < 3; attempt++) {
            try { return await embedPastScreen(text, (input) => embedText(ref, input, "passage")); }
            catch (error) {
                if (attempt === 2 || isScreenRefusal(error)) {
                    const detail = error instanceof Error ? ` Last error: ${error.message.slice(0, 300)}` : "";
                    throw new Error(`Embedding preparation failed; no migration writes started.${detail}`);
                }
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
