import assert from "node:assert/strict";
import { test } from "node:test";
import {
    MIGRATION_TABLES, applyMigration, migrationText, planMigration, prepareMigration, sameSource, validVector, verifyMigration,
    type MigrationItem, type MigrationRow, type MigrationStore, type MigrationTable,
} from "../src/lib/ai/embedding-migration.ts";
import { createMigrationStore } from "../src/lib/ai/embedding-migration-store.ts";

const target = "replacement", dimension = 3, vector = [0.1, 0.2, 0.3];
function row(table: MigrationTable, id = "0001", extra: Partial<MigrationRow> = {}): MigrationRow {
    return {
        id, content: "A source passage", fact: "A saved fact", assertion: "An assertion", title: "Title",
        heading_path: ["Chapter", "Section"], content_hash: "source-hash", document: { title: "Document" },
        ...(table === "embeddings" ? {} : { updated_at: "2026-09-23T00:00:00Z" }),
        embedding_model: "retired", embedding: "[1,2]", ...extra,
    };
}

function fixture(initial: Partial<Record<MigrationTable, MigrationRow[]>> = {}) {
    const tables = Object.fromEntries(MIGRATION_TABLES.map((table) => [table, structuredClone(initial[table] ?? [])])) as Record<MigrationTable, MigrationRow[]>;
    let updates = 0, activations = 0;
    let beforeUpdate: ((item: MigrationItem) => void) | undefined;
    const store: MigrationStore = {
        async scan(table, afterId, limit) {
            return structuredClone(tables[table].filter((r) => !afterId || r.id > afterId).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit));
        },
        async read(table, id) { return structuredClone(tables[table].find((r) => r.id === id) ?? null); },
        async update(item, nextVector, model) {
            beforeUpdate?.(item);
            const current = tables[item.table].find((r) => r.id === item.row.id);
            if (!current || !sameSource(item, current)) return false;
            current.embedding_model = model;
            current.embedding = JSON.stringify(nextVector);
            updates++;
            return true;
        },
        async activate(model) { assert.equal(model, target); activations++; },
    };
    return { tables, store, counts: () => ({ updates, activations }), beforeUpdate: (callback: typeof beforeUpdate) => { beforeUpdate = callback; } };
}

test("all five tables and more than 1000 rows are planned without writes", async () => {
    const f = fixture(Object.fromEntries(MIGRATION_TABLES.map((table) => [table,
        Array.from({ length: table === "knowledge_chunks" ? 1201 : 1 }, (_, i) => row(table, String(i).padStart(5, "0"))),
    ])));
    const plan = await planMigration(f.store, target, dimension);
    assert.equal(plan.items.length, 1205);
    assert.equal(plan.counts.knowledge_chunks.total, 1201);
    assert.deepEqual(f.counts(), { updates: 0, activations: 0 });
});

test("null vectors, null models, wrong dimensions and zero vectors remain pending", async () => {
    const f = fixture({ memories: [
        row("memories", "1", { embedding_model: target, embedding: null }),
        row("memories", "2", { embedding_model: null, embedding: vector }),
        row("memories", "3", { embedding_model: target, embedding: [1, 2] }),
        row("memories", "4", { embedding_model: target, embedding: [0, 0, 0] }),
        row("memories", "5", { embedding_model: target, embedding: vector }),
    ] });
    const plan = await planMigration(f.store, target, dimension);
    assert.equal(plan.items.length, 4);
    assert.deepEqual(plan.counts.memories, { total: 5, pending: 4 });
});

test("source text reproduces page and chunk indexing context", () => {
    assert.equal(migrationText("knowledge_chunks", row("knowledge_chunks")), "Document\n\nChapter > Section\n\nA source passage");
    assert.equal(migrationText("vault_pages", row("vault_pages", "1", { content: "x".repeat(9000) })).length, 8000);
    assert.equal(migrationText("memories", row("memories")), "A saved fact");
    assert.equal(migrationText("knowledge_assertions", row("knowledge_assertions")), "An assertion");
});

test("oversized unversioned sources and missing versions fail before embedding", async () => {
    const tooLong = fixture({ embeddings: [row("embeddings", "1", { content: "x".repeat(12001) })] });
    await assert.rejects(planMigration(tooLong.store, target, dimension), /safe conditional-update/);
    const unversioned = fixture({ memories: [row("memories", "1", { updated_at: null })] });
    await assert.rejects(planMigration(unversioned.store, target, dimension), /updated_at/);
});

test("preparation is bounded, preserves order and never writes", async () => {
    const f = fixture({ memories: Array.from({ length: 9 }, (_, i) => row("memories", String(i))) });
    const plan = await planMigration(f.store, target, dimension);
    let active = 0, peak = 0;
    const prepared = await prepareMigration(plan, async () => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return vector;
    }, 3);
    assert.equal(peak, 3);
    assert.deepEqual(prepared.map((i) => i.row.id), plan.items.map((i) => i.row.id));
    assert.deepEqual(f.counts(), { updates: 0, activations: 0 });
});

test("provider failure and invalid vectors cannot start writes", async () => {
    const f = fixture({ memories: [row("memories")] });
    const plan = await planMigration(f.store, target, dimension);
    for (const value of [[], [1, 2], [1, NaN, 3], [1, Infinity, 3], [0, 0, 0]]) {
        assert.equal(validVector(value, dimension), false);
        await assert.rejects(prepareMigration(plan, async () => value), /invalid/);
    }
    await assert.rejects(prepareMigration(plan, async () => { throw new Error("provider unavailable"); }), /provider unavailable/);
    assert.deepEqual(f.counts(), { updates: 0, activations: 0 });
});

test("a complete migration activates only after every table passes verification", async () => {
    const f = fixture(Object.fromEntries(MIGRATION_TABLES.map((table) => [table, [row(table)]])));
    const plan = await planMigration(f.store, target, dimension);
    const prepared = await prepareMigration(plan, async () => vector);
    const result = await applyMigration(f.store, plan, prepared);
    assert.equal(result.complete, true);
    assert.deepEqual(f.counts(), { updates: 5, activations: 1 });
    assert(Object.values(result.remaining).every((value) => value === 0));
    assert.equal((await planMigration(f.store, target, dimension)).items.length, 0);
});

test("concurrent source edits are preserved and block activation", async () => {
    const f = fixture({ memories: [row("memories")] });
    const plan = await planMigration(f.store, target, dimension);
    const prepared = await prepareMigration(plan, async () => vector);
    f.tables.memories[0].fact = "Edited while vectors were prepared";
    const result = await applyMigration(f.store, plan, prepared);
    assert.equal(result.complete, false);
    assert.equal(result.conflicts.length, 1);
    assert.deepEqual(f.counts(), { updates: 0, activations: 0 });
});

test("a conditional update race blocks activation without overwriting", async () => {
    const f = fixture({ memories: [row("memories")] });
    const plan = await planMigration(f.store, target, dimension);
    const prepared = await prepareMigration(plan, async () => vector);
    f.beforeUpdate(() => { f.tables.memories[0].updated_at = "2026-09-23T00:01:00Z"; });
    const result = await applyMigration(f.store, plan, prepared);
    assert.equal(result.conflicts.length, 1);
    assert.equal(f.tables.memories[0].embedding_model, "retired");
    assert.deepEqual(f.counts(), { updates: 0, activations: 0 });
});

test("new rows appearing during apply are caught by the final full scan", async () => {
    const f = fixture({ memories: [row("memories")] });
    const plan = await planMigration(f.store, target, dimension);
    const prepared = await prepareMigration(plan, async () => vector);
    f.beforeUpdate(() => { f.tables.embeddings.push(row("embeddings")); });
    const result = await applyMigration(f.store, plan, prepared);
    assert.equal(result.remaining.embeddings, 1);
    assert.equal(result.complete, false);
    assert.equal(f.counts().activations, 0);
});

test("an identical concurrent migration is accepted without rewriting", async () => {
    const f = fixture({ memories: [row("memories")] });
    const plan = await planMigration(f.store, target, dimension);
    const prepared = await prepareMigration(plan, async () => vector);
    Object.assign(f.tables.memories[0], { embedding_model: target, embedding: vector });
    const result = await applyMigration(f.store, plan, prepared);
    assert.equal(result.alreadyCurrent, 1);
    assert.equal(result.complete, true);
    assert.deepEqual(f.counts(), { updates: 0, activations: 1 });
});

test("write failures and incomplete preparation cannot activate", async () => {
    const f = fixture({ memories: [row("memories")] });
    const plan = await planMigration(f.store, target, dimension);
    const prepared = await prepareMigration(plan, async () => vector);
    await assert.rejects(applyMigration(f.store, plan, []), /do not match/);
    f.store.update = async () => { throw new Error("write unavailable"); };
    const result = await applyMigration(f.store, plan, prepared);
    assert.equal(result.failures.length, 1);
    assert.equal(result.complete, false);
    assert.equal(f.counts().activations, 0);
});

test("admin-sized batches retain full counts and cannot activate a partial migration", async () => {
    const f = fixture({ memories: Array.from({ length: 25 }, (_, i) => row("memories", String(i).padStart(3, "0"))) });
    const plan = await planMigration(f.store, target, dimension, { maxItems: 20 });
    assert.equal(plan.items.length, 20);
    assert.equal(plan.counts.memories.pending, 25);
    const result = await applyMigration(f.store, plan, await prepareMigration(plan, async () => vector));
    assert.equal(result.remaining.memories, 5);
    assert.equal(result.complete, false);
    assert.equal(f.counts().activations, 0);
});

test("bounded admin planning reads only its pending batch", async () => {
    const f = fixture({ embeddings: Array.from({ length: 1205 }, (_, i) => row("embeddings", String(i).padStart(5, "0"))) });
    const scan = f.store.scan;
    let scans = 0, rowsRead = 0;
    f.store.scan = async (table, afterId, limit) => {
        scans++;
        assert.equal(limit, 20);
        const rows = await scan(table, afterId, limit);
        rowsRead += rows.length;
        return rows;
    };
    const plan = await planMigration(f.store, target, dimension, { maxItems: 20, stopAfterMaxItems: true });
    assert.equal(plan.items.length, 20);
    assert.equal(scans, 1);
    assert.equal(rowsRead, 20);
    assert.deepEqual(f.counts(), { updates: 0, activations: 0 });
});

test("partial admin verification uses counts without rereading vectors or activating", async () => {
    const f = fixture({ memories: Array.from({ length: 25 }, (_, i) => row("memories", String(i).padStart(3, "0"))) });
    const plan = await planMigration(f.store, target, dimension, { maxItems: 20, stopAfterMaxItems: true });
    const prepared = await prepareMigration(plan, async () => vector);
    f.store.scan = async () => { throw new Error("A partial batch must not rescan vectors"); };
    const remaining = Object.fromEntries(MIGRATION_TABLES.map((table) => [table, table === "memories" ? 5 : 0])) as Record<MigrationTable, number>;
    const result = await applyMigration(f.store, plan, prepared, 4, async () => remaining);
    assert.equal(result.remaining.memories, 5);
    assert.equal(result.complete, false);
    assert.deepEqual(f.counts(), { updates: 20, activations: 0 });
});

test("final vector verification catches malformed target rows and permits a repair pass", async () => {
    const f = fixture({ memories: [
        row("memories", "1"),
        row("memories", "2", { embedding_model: target, embedding: [1, 2] }),
    ] });
    const filtered: MigrationStore = {
        ...f.store,
        async scan(table, afterId, limit) {
            return (await f.store.scan(table, afterId, limit)).filter((item) => item.embedding_model !== target || item.embedding == null);
        },
    };
    const plan = await planMigration(filtered, target, dimension, { maxItems: 20, stopAfterMaxItems: true });
    assert.equal(plan.items.length, 1);
    const partial = await applyMigration(f.store, plan, await prepareMigration(plan, async () => vector), 4, verifyMigration);
    assert.equal(partial.remaining.memories, 1);
    assert.equal(partial.complete, false);
    assert.equal(f.counts().activations, 0);
    const repair = await planMigration(f.store, target, dimension, { maxItems: 20 });
    assert.equal(repair.items[0].row.id, "2");
    assert.equal((await applyMigration(f.store, repair, await prepareMigration(repair, async () => vector))).complete, true);
    assert.deepEqual(f.counts(), { updates: 2, activations: 1 });
});

test("pending scans filter in PostgREST and use the shared cancellation signal", async () => {
    const calls: unknown[][] = [];
    const signal = new AbortController().signal;
    const query = {
        select(value: unknown) { calls.push(["select", value]); return this; },
        order(column: string) { calls.push(["order", column]); return this; },
        limit(value: number) { calls.push(["limit", value]); return this; },
        gt(column: string, value: string) { calls.push(["gt", column, value]); return this; },
        or(value: string) { calls.push(["or", value]); return this; },
        abortSignal(value: AbortSignal) { calls.push(["abortSignal", value]); return this; },
        then(resolve: (value: { data: MigrationRow[]; error: null }) => unknown) { return Promise.resolve(resolve({ data: [], error: null })); },
    };
    const client = { from(table: string) { calls.push(["from", table]); return query; } };
    const store = createMigrationStore(client as unknown as Parameters<typeof createMigrationStore>[0], undefined, { pendingModel: target, signal });
    await store.scan("knowledge_chunks", "0010", 20);
    assert(calls.some((call) => call[0] === "limit" && call[1] === 20));
    assert(calls.some((call) => call[0] === "gt" && call[2] === "0010"));
    assert(calls.some((call) => call[0] === "or" && call[1] === `embedding.is.null,embedding_model.is.null,embedding_model.neq.${target}`));
    assert(calls.some((call) => call[0] === "abortSignal" && call[1] === signal));
    const stopped = createMigrationStore(client as unknown as Parameters<typeof createMigrationStore>[0], async () => {
        assert.fail("An aborted request must not activate");
    }, { signal: AbortSignal.abort() });
    await assert.rejects(stopped.activate(target), { name: "AbortError" });
});

test("PostgREST updates guard the source version and prior partition without vectors in the URL", async () => {
    const calls: unknown[][] = [];
    const query = {
        update(value: unknown) { calls.push(["update", value]); return this; },
        eq(column: string, value: unknown) { calls.push(["eq", column, value]); return this; },
        is(column: string, value: unknown) { calls.push(["is", column, value]); return this; },
        not(column: string, operator: string, value: unknown) { calls.push(["not", column, operator, value]); return this; },
        select(column: string) { calls.push(["select", column]); return this; },
        async maybeSingle() { return { data: { id: "1" }, error: null }; },
    };
    const client = { from(table: string) { calls.push(["from", table]); return query; } };
    const store = createMigrationStore(client as unknown as Parameters<typeof createMigrationStore>[0]);
    for (const table of MIGRATION_TABLES) {
        calls.length = 0;
        const source = row(table, "1", { embedding: null });
        assert.equal(await store.update({ table, row: source, text: migrationText(table, source) }, vector, target), true);
        assert(calls.some((call) => call[0] === "eq" && call[1] === "embedding_model" && call[2] === "retired"));
        assert(calls.some((call) => call[0] === "is" && call[1] === "embedding" && call[2] === null));
        assert(!calls.some((call) => call[0] === "eq" && call[1] === "embedding"));
        const guard = table === "embeddings" ? "content" : "updated_at";
        assert(calls.some((call) => call[0] === "eq" && call[1] === guard && call[2] === source[guard]));
        if (table === "knowledge_chunks") assert(calls.some((call) => call[0] === "eq" && call[1] === "content_hash"));
    }
});
