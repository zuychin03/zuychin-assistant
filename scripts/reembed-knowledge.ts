// Re-embeds the knowledge store into the current default embedding partition.
// Run after changing DEFAULT_EMBEDDING (providers.ts) or the
// KNOWLEDGE_EMBEDDING_MODEL env override, otherwise recall misses everything
// stored under the previous model:
//   sed 's/\r$//' .env.local > /tmp/env.clean && npx tsx --env-file=/tmp/env.clean scripts/reembed-knowledge.ts
// Covers the embeddings and memories tables. Vault pages are intentionally
// excluded: vault search/writes resolve their own majority partition.
import { createClient } from "@supabase/supabase-js";
import { embedText, getEmbeddingRef } from "../src/lib/ai/embeddings";

const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

async function reembedTable(table: "embeddings" | "memories", contentColumn: "content" | "fact", targetModel: string) {
    const ref = getEmbeddingRef();
    const { data, error } = await sb
        .from(table)
        .select(`id, ${contentColumn}, embedding_model`)
        .neq("embedding_model", targetModel);
    if (error) throw new Error(`${table}: ${error.message}`);

    const rows = (data ?? []) as unknown as { id: string; content?: string; fact?: string }[];
    console.log(`${table}: ${rows.length} rows to migrate -> ${targetModel}`);
    let ok = 0, fail = 0;
    for (const row of rows) {
        try {
            const embedding = await embedText(ref, (row.content ?? row.fact)!);
            const { error: upErr } = await sb
                .from(table)
                .update({ embedding: JSON.stringify(embedding), embedding_model: targetModel })
                .eq("id", row.id);
            if (upErr) throw new Error(upErr.message);
            ok++;
        } catch (e) {
            fail++;
            console.error(`${table} row ${row.id}: ${e instanceof Error ? e.message : e}`);
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    console.log(`${table}: ${ok} migrated, ${fail} failed`);
    return fail;
}

async function main() {
    const target = getEmbeddingRef().model.id;
    console.log(`target partition: ${target}`);
    const failures = (await reembedTable("embeddings", "content", target)) + (await reembedTable("memories", "fact", target));
    process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
