// Measures similarity cut-offs for the active knowledge model on the live store, to fill in its
// `cutoffs` in providers.ts after a switch. Read only: it embeds probe text and reads rows.
//   npx tsx --env-file=.env.local scripts/measure-embedding-cutoffs.ts [--sample 40]
// A probe query is the first 6 to 12 words of a stored row (half the row at most). Real questions are
// paraphrased and score lower, so cut-offs should sit at the low end of the true-match scores.
import { createClient } from "@supabase/supabase-js";
import { cosine } from "../src/lib/ai/embedding-request";
import { embedTexts, getEmbeddingRef } from "../src/lib/ai/embeddings";
import { refreshEmbeddingOverride } from "../src/lib/ai/embedding-override";
import { refreshCatalogueSnapshot } from "../src/lib/ai/catalogue/snapshot";
import type { EmbedInputType } from "../src/lib/ai/embedding-request";
import { measuredCutoffs, similarityCutoffs, type SimilarityCutoffs } from "../src/lib/ai/embedding-cutoffs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Run with --env-file=.env.local.");
const sb = createClient(url, key, { auth: { persistSession: false } });
const sampleArg = process.argv.indexOf("--sample");
const SAMPLE = sampleArg > 0 ? Number(process.argv[sampleArg + 1]) : 40;

type Row = { id: string; text: string };
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);
const prefix = (text: string) => { const all = words(text); return all.slice(0, Math.min(12, Math.max(6, Math.floor(all.length / 2)))).join(" "); };
const vectorOf = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as number[];

function quantiles(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : NaN;
    return { n: sorted.length, p05: at(0.05), p10: at(0.1), p25: at(0.25), p50: at(0.5), p75: at(0.75), p90: at(0.9), p95: at(0.95), max: at(1) };
}
// The fixed values used before cut-offs followed the model, for the before-and-after lines.
const LEGACY = measuredCutoffs("nvidia/nemotron-3-embed-1b")!;
const kept = (label: string, scores: number[], use: keyof SimilarityCutoffs, current: SimilarityCutoffs) => {
    const count = (cut: number) => scores.filter((score) => score >= cut).length;
    console.log(`  ${label.padEnd(26)} ${use} ${current[use]}: ${count(current[use])}/${scores.length} kept; old fixed ${LEGACY[use]}: ${count(LEGACY[use])}/${scores.length}`);
};
const show = (label: string, values: number[]) => {
    const q = quantiles(values);
    console.log(`  ${label.padEnd(26)} n=${q.n} p05 ${q.p05.toFixed(2)} p10 ${q.p10.toFixed(2)} p25 ${q.p25.toFixed(2)} p50 ${q.p50.toFixed(2)} p75 ${q.p75.toFixed(2)} p90 ${q.p90.toFixed(2)} p95 ${q.p95.toFixed(2)} max ${q.max.toFixed(2)}`);
};

async function sample(table: string, columns: string, partition: string, text: (row: Record<string, unknown>) => string): Promise<Row[]> {
    const out: Row[] = [];
    for (let from = 0; out.length < SAMPLE; from += 500) {
        const { data, error } = await sb.from(table).select(columns).eq("embedding_model", partition).order("id").range(from, from + 499);
        if (error) throw new Error(`${table}: ${error.message}`);
        const rows = (data ?? []) as unknown as Record<string, unknown>[];
        for (const row of rows) if (words(text(row)).length >= 12 && out.length < SAMPLE) out.push({ id: String(row.id), text: text(row) });
        if (rows.length < 500) break;
    }
    return out;
}

async function storedVectors(table: string, idColumn: string, ids: string[]): Promise<Map<string, number[]>> {
    const { data, error } = await sb.from(table).select(`${idColumn}, embedding`).in(idColumn, ids);
    if (error) throw new Error(`${table} vectors: ${error.message}`);
    return new Map(((data ?? []) as unknown as Record<string, unknown>[]).map((row) => [String(row[idColumn]), vectorOf(row.embedding)]));
}

async function bestOthers(rpc: string, args: Record<string, unknown>, vector: number[], self: string, idOf: (row: Record<string, unknown>) => string) {
    const { data, error } = await sb.rpc(rpc, { ...args, query_embedding: JSON.stringify(vector), match_threshold: -1, match_count: 4 });
    if (error) throw new Error(`${rpc}: ${error.message}`);
    const rows = (data ?? []) as Record<string, unknown>[];
    const other = rows.find((row) => idOf(row) !== self);
    return { first: rows[0] ? idOf(rows[0]) === self : false, other: other ? Number(other.similarity) : NaN };
}

async function searchProbe(name: string, table: string, rows: Row[], rpc: string, args: Record<string, unknown>, types: [EmbedInputType, (keyof SimilarityCutoffs)[]][], ref: ReturnType<typeof getEmbeddingRef>) {
    const vectors = await storedVectors(table, "id", rows.map((row) => row.id));
    console.log(`\n${name} (${rows.length} rows; query = half-row prefix)`);
    for (const [type, uses] of types) {
        const queries = await embedTexts(ref, rows.map((row) => prefix(row.text)), type);
        const own: number[] = [], others: number[] = [];
        let first = 0;
        for (let index = 0; index < rows.length; index++) {
            const stored = vectors.get(rows[index].id);
            if (stored) own.push(cosine(queries[index], stored));
            const best = await bestOthers(rpc, args, queries[index], rows[index].id, (row) => String(row.id));
            if (best.first) first++;
            if (Number.isFinite(best.other)) others.push(best.other);
        }
        console.log(` as ${type}: source ranked first ${first}/${rows.length}`);
        show("source row", own);
        show("best other row", others);
        for (const use of uses) kept("true matches", own, use, similarityCutoffs(ref.model));
    }
}

async function main() {
    await Promise.all([refreshCatalogueSnapshot(), refreshEmbeddingOverride(undefined, true)]);
    const ref = getEmbeddingRef();
    const partition = ref.model.id;
    console.log(`Active knowledge model: ${ref.provider.label} ${ref.model.label} (partition ${partition}, ${ref.model.dimension} dimensions)`);

    const notes = await sample("embeddings", "id, content", partition, (row) => String(row.content ?? ""));
    await searchProbe("Notes and messages (match_embeddings)", "embeddings", notes, "match_embeddings", { filter_user_id: null, filter_model: partition }, [["passage", []], ["query", ["chatNotes", "toolNotes"]]], ref);

    const memories = await sample("memories", "id, fact", partition, (row) => String(row.fact ?? ""));
    if (memories.length) await searchProbe("Memories (match_memories)", "memories", memories, "match_memories", { filter_user_id: null, filter_model: partition, filter_project: null }, [["passage", []], ["query", ["chatMemories", "memoryMerge"]]], ref);

    // Duplicates: the stored text embedded again, and a light edit of it.
    const dupes = notes.slice(0, Math.min(20, notes.length));
    const stored = await storedVectors("embeddings", "id", dupes.map((row) => row.id));
    const exact = await embedTexts(ref, dupes.map((row) => row.text), "passage");
    const edited = await embedTexts(ref, dupes.map((row) => `${row.text.trim().replace(/[.!?]$/, "")}, thanks.`), "passage");
    console.log(`\nDuplicates (${dupes.length} rows, passage)`);
    show("same text again", dupes.map((row, index) => cosine(exact[index], stored.get(row.id) ?? exact[index])));
    const editedScores = dupes.map((row, index) => cosine(edited[index], stored.get(row.id) ?? edited[index]));
    show("lightly edited", editedScores);
    kept("edited duplicates", editedScores, "duplicate", similarityCutoffs(ref.model));

    // Vault: stored page vectors; linked pairs come from the graph snapshot.
    const { data: pages, error } = await sb.from("vault_pages").select("path, embedding").eq("embedding_model", partition);
    if (error) throw new Error(`vault_pages: ${error.message}`);
    const pageVectors = new Map(((pages ?? []) as { path: string; embedding: unknown }[]).map((page) => [page.path, vectorOf(page.embedding)]));
    const { data: snapshot } = await sb.from("vault_graph_snapshot").select("payload").limit(1).maybeSingle();
    const edges = ((snapshot as { payload?: { edges?: { source: string; target: string }[] } } | null)?.payload?.edges ?? [])
        .map((edge) => [edge.source, edge.target].map((path) => path.endsWith(".md") ? path : `${path}.md`))
        .filter(([a, b]) => pageVectors.has(a) && pageVectors.has(b));
    const linked = new Set(edges.map(([a, b]) => [a, b].sort().join("|")));
    const paths = [...pageVectors.keys()].sort();
    const unlinked: number[] = [];
    for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
        if (!linked.has([paths[i], paths[j]].sort().join("|"))) unlinked.push(cosine(pageVectors.get(paths[i])!, pageVectors.get(paths[j])!));
    }
    console.log(`\nVault pages (${pageVectors.size} pages, ${edges.length} linked pairs, page against page)`);
    const linkedScores = edges.map(([a, b]) => cosine(pageVectors.get(a)!, pageVectors.get(b)!));
    show("linked pairs", linkedScores);
    show("unlinked pairs", unlinked);
    kept("linked pairs", linkedScores, "vaultLink", similarityCutoffs(ref.model));
    kept("unlinked pairs", unlinked, "vaultSuggest", similarityCutoffs(ref.model));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
