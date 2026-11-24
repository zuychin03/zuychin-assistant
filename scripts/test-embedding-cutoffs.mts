// Offline checks that search cut-offs follow the embedding model: measured values per model, partitions
// at a reduced size, same-space routes, unmeasured models, and no fixed number left at a search site.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://cutoffs-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service" });

const { measuredCutoffs, similarityCutoffs, UNMEASURED_CUTOFFS } = await import("../src/lib/ai/embedding-cutoffs");
const { getEmbeddingRef } = await import("../src/lib/ai/embeddings");

let checks = 0;
function check(name: string, run: () => void) {
    run();
    checks++;
    console.log(`PASS ${name}`);
}

check("the knowledge model reads its measured cut-offs, by ref or by partition id", () => {
    const ref = getEmbeddingRef();
    assert.equal(ref.model.id, "nvidia/nemotron-3.5-embed-1b");
    const cutoffs = similarityCutoffs(ref.model);
    assert.deepEqual(cutoffs, measuredCutoffs("nvidia/nemotron-3.5-embed-1b"));
    assert.equal(cutoffs.chatNotes, 0.4);
    assert.equal(cutoffs.toolNotes, 0.4);
    assert.deepEqual(similarityCutoffs("nvidia/nemotron-3.5-embed-1b"), cutoffs);
    assert.deepEqual(similarityCutoffs("nvidia/nemotron-3.5-embed-1b@512"), cutoffs, "a reduced partition keeps its model's values");
});

check("the retired model keeps the values it was tuned with", () => {
    const legacy = similarityCutoffs("nvidia/nemotron-3-embed-1b");
    assert.deepEqual([legacy.chatNotes, legacy.toolNotes, legacy.toolHistory], [0.72, 0.6, 0.5]);
});

check("a same-space route shares its source's values; an unmeasured model gets the fallback", () => {
    assert.deepEqual(similarityCutoffs({ id: "nvidia/nemotron-3.5-embed-1b:free", spaceOf: "nvidia/nemotron-3.5-embed-1b" }), measuredCutoffs("nvidia/nemotron-3.5-embed-1b"));
    assert.deepEqual(similarityCutoffs({ id: "vendor/new-embed" }), UNMEASURED_CUTOFFS);
    assert.deepEqual(similarityCutoffs("vendor/never-seen"), UNMEASURED_CUTOFFS);
    assert.deepEqual(similarityCutoffs(undefined), UNMEASURED_CUTOFFS);
});

check("every value is a similarity, and a duplicate sits above every search cut-off", () => {
    for (const id of ["nvidia/nemotron-3.5-embed-1b", "nvidia/nemotron-3-embed-1b"]) {
        const cutoffs = measuredCutoffs(id)!;
        for (const [name, value] of Object.entries(cutoffs)) assert.ok(value > 0 && value < 1, `${id} ${name}`);
        assert.ok(Object.entries(cutoffs).every(([name, value]) => name === "duplicate" || value < cutoffs.duplicate), id);
    }
});

check("no search site keeps a fixed cut-off", () => {
    const files = [
        "src/lib/ai/rag-service.ts", "src/app/api/mcp/[transport]/route.ts", "src/lib/ai/mcp-service.ts", "src/lib/council/online/service.ts",
        "src/lib/db.ts", "src/lib/ai/memory/store.ts", "src/lib/ai/memory/extractor.ts", "src/lib/vault/store.ts", "src/lib/vault/ingest.ts", "src/lib/vault/graph.ts",
    ];
    for (const file of files) {
        const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
        assert.doesNotMatch(source, /match(?:_t|T)hreshold:\s*(?:[\w.]+\s*\?\?\s*)?0?\.\d/, `${file} passes a fixed number`);
        assert.doesNotMatch(source, /[A-Z_]*THRESHOLD\s*=\s*0?\.\d/, `${file} defines a fixed threshold`);
        assert.doesNotMatch(source, /similarity\s*>=\s*0?\.\d/, `${file} compares against a fixed number`);
    }
});

console.log(`${checks} embedding cut-off checks passed`);
