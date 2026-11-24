// Offline checks for the knowledge model switch job: batching, quota pause and resume, stale jobs,
// partition ids with a size, and the target checks. An in-memory store stands in for Supabase.
import assert from "node:assert/strict";
Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://switch-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    NVIDIA_NIM_API_KEY: "fixture-nim", OPENROUTER_API_KEY: "fixture-or", GEMINI_API_KEY: "fixture-gemini", GEMINI_FREE_API_KEY: "fixture-free",
});

const { MIGRATION_TABLES } = await import("../src/lib/ai/embedding-migration");
const { PHOTO_MS, dailyQuota, estimateSeconds, isPhotoItem, parseSwitchState, runSwitch, shouldResume, switchBusy } = await import("../src/lib/ai/embedding-switch");
const { parseEmbeddingSetting } = await import("../src/lib/ai/embedding-override");
const { parsePartitionId, partitionIdFor, resolveEmbedding } = await import("../src/lib/ai/providers");
const { setCatalogueSnapshotForTests } = await import("../src/lib/ai/catalogue/snapshot");
const { switchEstimate, switchTargetFor } = await import("../src/lib/ai/embedding-switch-live");
type MigrationStore = import("../src/lib/ai/embedding-migration").MigrationStore;
type MigrationTable = import("../src/lib/ai/embedding-migration").MigrationTable;
type MigrationRow = import("../src/lib/ai/embedding-migration").MigrationRow;
type SwitchState = import("../src/lib/ai/embedding-switch").SwitchState;
type SwitchDeps = import("../src/lib/ai/embedding-switch").SwitchDeps;
type CatalogueRow = import("../src/lib/ai/catalogue/snapshot").CatalogueRow;

let checks = 0;
async function check(name: string, run: () => void | Promise<void>) {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

const OLD = "vendor/old-embed", TARGET = "vendor/new-embed", DIM = 4;
const vector = (seed: number) => [1, seed % 7, 2, 3].map((value) => value / 10);

function memoryStore(counts: Partial<Record<MigrationTable, number>>) {
    const rows = new Map<MigrationTable, MigrationRow[]>(MIGRATION_TABLES.map((table) => [table, []]));
    let id = 0;
    for (const [table, count] of Object.entries(counts) as [MigrationTable, number][]) {
        for (let index = 0; index < count; index++) {
            const key = String(++id).padStart(6, "0");
            rows.get(table)!.push(table === "embeddings"
                ? { id: key, content: `text ${key}`, embedding_model: OLD, embedding: JSON.stringify(vector(id)) }
                : { id: key, fact: `fact ${key}`, updated_at: "2026-11-24T00:00:00Z", embedding_model: OLD, embedding: JSON.stringify(vector(id)) });
        }
    }
    const activated: string[] = [];
    const onTarget = (row: MigrationRow, target: string) => row.embedding_model === target;
    const base = (pending: boolean): MigrationStore => ({
        async scan(table, afterId, limit) {
            return rows.get(table)!.filter((row) => (!afterId || row.id > afterId) && (!pending || !onTarget(row, TARGET))).slice(0, limit).map((row) => ({ ...row }));
        },
        async read(table, rowId) { const row = rows.get(table)!.find((entry) => entry.id === rowId); return row ? { ...row } : null; },
        async update(item, next, target) {
            const row = rows.get(item.table)!.find((entry) => entry.id === item.row.id);
            if (!row || row.embedding_model !== item.row.embedding_model) return false;
            row.embedding_model = target;
            row.embedding = JSON.stringify(next);
            return true;
        },
        async activate(target) { activated.push(target); },
    });
    const remaining = async (target: string) => Object.fromEntries(MIGRATION_TABLES.map((table) => [table, rows.get(table)!.filter((row) => !onTarget(row, target)).length])) as Record<MigrationTable, number>;
    return { store: base(false), pending: base(true), remaining, activated, rows };
}

function deps(memory: ReturnType<typeof memoryStore>, embed: (texts: string[]) => Promise<number[][]>, extra: Partial<SwitchDeps> = {}) {
    const saved: SwitchState[] = [], notes: string[] = [], sleeps: number[] = [];
    let clock = Date.parse("2026-11-24T02:00:00Z");
    const value: SwitchDeps = {
        store: memory.store, pending: memory.pending, countRemaining: memory.remaining, embed, batchSize: 32, concurrency: 2,
        saveState: async (state) => { saved.push(state); }, notify: async (text) => { notes.push(text); },
        now: () => (clock += 1000), sleep: async (ms) => { sleeps.push(ms); }, ...extra,
    };
    return { value, saved, notes, sleeps };
}

const initial = (): SwitchState => ({
    target: TARGET, providerId: "vendor", modelId: TARGET, dimension: DIM, status: "running", done: 0, remaining: null,
    startedAt: "2026-11-24T02:00:00.000Z", updatedAt: "2026-11-24T02:00:00.000Z", error: null,
});
const okEmbed = (calls: number[]) => async (texts: string[]) => { calls.push(texts.length); return texts.map((_, index) => vector(index + 3)); };

await check("a switch embeds in batches of up to 32, activates once and reports done", async () => {
    const memory = memoryStore({ embeddings: 40, memories: 30 });
    const calls: number[] = [];
    const run = deps(memory, okEmbed(calls));
    const state = await runSwitch(initial(), run.value);
    assert.equal(state.status, "done");
    assert.equal(state.done, 70);
    assert.equal(state.remaining, 0);
    assert.deepEqual(calls.sort((a, b) => b - a), [32, 32, 6]);
    assert.deepEqual(memory.activated, [TARGET]);
    assert.equal(run.saved[0].status, "running");
    assert.equal(run.saved.at(-1)!.status, "done");
    assert.match(run.notes[0], /switch finished: 70 rows/);
});

await check("a daily quota pauses the job without activating, and the next run resumes it", async () => {
    const memory = memoryStore({ memories: 80 });
    let served = 0;
    const quota = async (texts: string[]) => {
        if (served >= 32) throw Object.assign(new Error("Embedding request failed (OpenRouter 429): free-models-per-day limit reached"), { status: 429 });
        served += texts.length;
        return texts.map(() => vector(5));
    };
    const first = deps(memory, quota, { concurrency: 1 });
    const paused = await runSwitch(initial(), first.value);
    assert.equal(paused.status, "paused");
    assert.match(paused.error!, /Daily quota/);
    assert.deepEqual(memory.activated, []);
    assert.match(first.notes[0], /paused/);
    const calls: number[] = [];
    const second = deps(memory, okEmbed(calls));
    const resumed = await runSwitch(paused, second.value);
    assert.equal(resumed.status, "done");
    assert.equal(resumed.done, 80, "progress carries over");
    assert.deepEqual(memory.activated, [TARGET]);
});

await check("a per-minute 429 backs off 2, 4 then 8 seconds; five failed batches in a row pause", async () => {
    const memory = memoryStore({ memories: 10 });
    let failures = 2;
    const flaky = async (texts: string[]) => {
        if (failures-- > 0) throw Object.assign(new Error("rate limited"), { status: 429 });
        return texts.map(() => vector(2));
    };
    const run = deps(memory, flaky);
    assert.equal((await runSwitch(initial(), run.value)).status, "done");
    assert.deepEqual(run.sleeps, [2000, 4000]);

    const broken = memoryStore({ memories: 200 });
    const failing = deps(broken, async () => { throw Object.assign(new Error("bad request"), { status: 400 }); }, { batchSize: 8, concurrency: 1 });
    const state = await runSwitch(initial(), failing.value);
    assert.equal(state.status, "paused");
    assert.match(state.error!, /Five batches failed in a row: bad request/);
    assert.deepEqual(broken.activated, []);
});

await check("stale running jobs and paused jobs resume after 10 minutes; a fresh running job blocks a new one", () => {
    const now = Date.parse("2026-11-24T03:00:00Z");
    const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    assert.equal(shouldResume({ ...initial(), updatedAt: at(11) }, now), true);
    assert.equal(shouldResume({ ...initial(), updatedAt: at(5) }, now), false);
    assert.equal(shouldResume({ ...initial(), status: "paused", updatedAt: at(30) }, now), true);
    assert.equal(shouldResume({ ...initial(), status: "done", updatedAt: at(60) }, now), false);
    assert.equal(shouldResume(null, now), false);
    assert.equal(switchBusy({ ...initial(), updatedAt: at(2) }, now), true);
    assert.equal(switchBusy({ ...initial(), updatedAt: at(20) }, now), false);
    assert.equal(parseSwitchState({ ...initial(), status: "exploded" }), null);
    assert.deepEqual(parseSwitchState({ ...initial() }), initial());
    assert.equal(dailyQuota(Object.assign(new Error("Quota exceeded: requests per day"), { status: 429 })), true);
    assert.equal(dailyQuota(Object.assign(new Error("Too many requests per minute"), { status: 429 })), false);
    assert.equal(estimateSeconds(2560, 460, 32), 19);
    assert.equal(estimateSeconds(0, null, 32), 0);
    assert.equal(estimateSeconds(10, null, 32), null);
    assert.equal(PHOTO_MS, 1_600);
    // 90 text rows in 3 batches at 460 ms, plus 10 photos at 1.6 s each, over 2 workers.
    assert.equal(estimateSeconds(100, 460, 32, 2, 10), Math.ceil((3 * 460 + 10 * PHOTO_MS) / 2 / 1000));
    assert.equal(estimateSeconds(10, null, 32, 2, 10), 8, "photos alone need no text timing");
    assert.equal(estimateSeconds(10, null, 32, 2, 4), null);
    assert.equal(estimateSeconds(5, 460, 32, 2, 50), 4, "photo rows never exceed the rows");
});

const photoChunk = (id: string, path: string): MigrationRow => ({
    id, content: `caption ${id}`, heading_path: [], content_hash: "c".repeat(64), updated_at: "2026-11-24T00:00:00Z",
    embedding_model: OLD, embedding: JSON.stringify(vector(1)), document: { title: `Title ${id}`, path },
});

await check("photo chunks are re-embedded one at a time with their image; text chunks keep batching", async () => {
    const memory = memoryStore({ memories: 3 });
    memory.rows.get("knowledge_chunks")!.push(photoChunk("900001", "attachments/captures/a.jpg"), photoChunk("900002", "notes/page.md"), photoChunk("900003", "attachments/b.png"));
    const texts: string[] = [], photos: string[] = [];
    const run = deps(memory, async (batch) => { texts.push(...batch); return batch.map(() => vector(5)); }, {
        embedPhoto: async (item) => { photos.push(item.text); return vector(6); },
    });
    const state = await runSwitch(initial(), run.value);
    assert.equal(state.status, "done");
    assert.equal(state.done, 6);
    assert.deepEqual(photos.sort(), ["Title 900001\n\ncaption 900001", "Title 900003\n\ncaption 900003"]);
    assert.ok(texts.includes("Title 900002\n\ncaption 900002"));
    assert.ok(!texts.some((text) => text.includes("900001") || text.includes("900003")));
    assert.equal(memory.rows.get("knowledge_chunks")![0].embedding, JSON.stringify(vector(6)));
    assert.equal(isPhotoItem({ table: "knowledge_chunks", row: photoChunk("1", "attachments/x.webp"), text: "" }), false, "WebP is not a photo the app indexes");
    assert.equal(isPhotoItem({ table: "memories", row: { id: "1", document: { path: "attachments/x.jpg" } }, text: "" }), false);
});

await check("without a photo embedder (the new model takes no images), photo chunks go by their text", async () => {
    const memory = memoryStore({});
    memory.rows.get("knowledge_chunks")!.push(photoChunk("900004", "attachments/c.jpg"));
    const sent: string[] = [];
    const state = await runSwitch(initial(), deps(memory, async (batch) => { sent.push(...batch); return batch.map(() => vector(5)); }).value);
    assert.equal(state.status, "done");
    assert.deepEqual(sent, ["Title 900004\n\ncaption 900004"]);
});

await check("partition ids carry a reduced size, and the saved setting keeps its route", () => {
    assert.equal(partitionIdFor("vendor/model", 512, 2048), "vendor/model@512");
    assert.equal(partitionIdFor("vendor/model", 2048, 2048), "vendor/model");
    assert.deepEqual(parsePartitionId("vendor/model@512"), { modelId: "vendor/model", dimension: 512 });
    assert.deepEqual(parsePartitionId("vendor/model"), { modelId: "vendor/model", dimension: null });
    const reduced = resolveEmbedding("nvidia/nemotron-3.5-embed-1b@512");
    assert.equal(reduced.model.id, "nvidia/nemotron-3.5-embed-1b@512");
    assert.equal(reduced.model.apiId, "nvidia/nemotron-3.5-embed-1b");
    assert.equal(reduced.model.dimension, 512);
    assert.equal(reduced.provider.id, "nvidia-nim");
    assert.equal(resolveEmbedding("nvidia/nemotron-3.5-embed-1b").model.dimension, 2048);
    assert.deepEqual(parseEmbeddingSetting({ model: "nvidia/nemotron-3.5-embed-1b" }), { model: "nvidia/nemotron-3.5-embed-1b" }, "the old saved shape still resolves");
    assert.deepEqual(parseEmbeddingSetting({ model: "x@512", providerId: "openrouter", dimension: 512 }), { model: "x@512", providerId: "openrouter", dimension: 512 });
    assert.equal(parseEmbeddingSetting({ providerId: "openrouter" }), null);
});

function embeddingRow(overrides: Partial<CatalogueRow> & Pick<CatalogueRow, "providerId" | "modelId">): CatalogueRow {
    return {
        origin: "discovered", label: overrides.modelId, shortName: overrides.modelId.replace(/^.*\//, ""), description: null, developer: null,
        free: true, metered: false, mayTrain: null, contextTokens: null, maxOutputTokens: null, inputs: ["text"],
        listedTools: null, listedStructured: null, listedThinking: null, probeStatus: "passed", probeAttempts: 0, probedAt: "2026-11-24T00:00:00.000Z", probeChatMs: 460,
        supportsTools: null, supportsSearch: null, supportsVision: null, supportsThinking: null, supportsStructured: null,
        firstSeenAt: "2026-11-24T00:00:00.000Z", lastSeenAt: "2026-11-24T00:00:00.000Z", missedChecks: 0, missingSince: null, notifiedMissingAt: null,
        approvedAt: "2026-11-24T00:00:00.000Z", kind: "embedding", dimension: 2048, traits: { truncatable: true, batch: true },
        ...overrides,
    };
}

await check("a switch target must be approved, passing, listed and the right size", () => {
    setCatalogueSnapshotForTests([
        embeddingRow({ providerId: "nvidia-nim", modelId: "nvidia/nemotron-3.5-embed-1b", origin: "seed", traits: { truncatable: true, batch: true, images: true } }),
        embeddingRow({ providerId: "openrouter", modelId: "vendor/candidate:free", approvedAt: null }),
        embeddingRow({ providerId: "openrouter", modelId: "vendor/failing:free", probeStatus: "failed" }),
        embeddingRow({ providerId: "openrouter", modelId: "vendor/fixed:free", traits: { batch: false } }),
        embeddingRow({ providerId: "gemini-free", modelId: "gemini-embedding-2", dimension: 3072, mayTrain: true }),
    ]);
    try {
        const good = switchTargetFor("nvidia-nim", "nvidia/nemotron-3.5-embed-1b");
        assert.ok(good.ok);
        assert.equal(good.target.partitionId, "nvidia/nemotron-3.5-embed-1b");
        assert.equal(good.target.batch, true);
        assert.equal(good.target.images, true);
        assert.equal(switchEstimate(good.target, 100, 10).photoRows, 10);
        assert.equal(switchEstimate({ ...good.target, images: false }, 100, 10).photoRows, 0, "without the photo step, photos are text rows");
        assert.equal(switchEstimate({ ...good.target, images: false }, 100, 10).seconds, estimateSeconds(100, 460, 32));
        const reduced = switchTargetFor("nvidia-nim", "nvidia/nemotron-3.5-embed-1b", 512);
        assert.ok(reduced.ok);
        assert.equal(reduced.target.partitionId, "nvidia/nemotron-3.5-embed-1b@512");
        assert.match((switchTargetFor("openrouter", "vendor/candidate:free") as { error: string }).error, /Approve the model first/);
        assert.match((switchTargetFor("openrouter", "vendor/failing:free") as { error: string }).error, /last test passed/);
        assert.match((switchTargetFor("openrouter", "vendor/fixed:free", 4096) as { error: string }).error, /between 1 and 2048/);
        assert.match((switchTargetFor("openrouter", "vendor/fixed:free", 512) as { error: string }).error, /smaller size/);
        assert.match((switchTargetFor("openrouter", "vendor/unknown") as { error: string }).error, /not in the catalogue/);
        // The paid key holds gemini-embedding-2 at 768, so the free key's 3072 gets its own partition id.
        const gemini = switchTargetFor("gemini-free", "gemini-embedding-2");
        assert.ok(gemini.ok);
        assert.equal(gemini.target.partitionId, "gemini-embedding-2@3072");
        assert.equal(gemini.target.mayTrain, true);
        const geminiRef = resolveEmbedding(gemini.target.partitionId, "gemini-free");
        assert.equal(geminiRef.provider.id, "gemini-free");
        assert.equal(geminiRef.model.id, "gemini-embedding-2@3072", "rows are written under the partition id");
        assert.equal(geminiRef.model.apiId, "gemini-embedding-2");
        assert.equal(geminiRef.model.dimension, 3072);
    } finally {
        setCatalogueSnapshotForTests([]);
    }
});

console.log(`${checks} embedding switch checks passed`);
