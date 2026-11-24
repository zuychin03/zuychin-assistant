import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

let passed = 0;
async function check(name: string, test: () => Promise<void>) { await test(); passed++; console.log(`PASS ${name}`); }

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const migration = await read("./migrations/v7-model-types.sql");
const setup = await read("../supabase-setup.sql");

async function database(): Promise<PGlite> {
    const db = new PGlite();
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
        create table user_profiles (id uuid primary key); create table conversations (id uuid primary key);
        create table messages (id uuid primary key); create table agent_runs (id uuid primary key default gen_random_uuid());`);
    await db.exec(await read("./migrations/v6-model-health.sql"));
    await db.exec(await read("./migrations/v7-model-catalogue.sql"));
    return db;
}

await check("the migration is embedded in setup verbatim with LF endings", async () => {
    assert.ok(!migration.includes("\r"), "LF line endings");
    assert.ok(setup.includes(`-- ===== V7 model types =====\n-- v7-model-types.sql\n${migration.trimEnd()}`), "supabase-setup.sql must embed v7-model-types.sql verbatim");
    assert.ok(!/create table/i.test(migration), "no new tables, so server-only-tables.sql needs no entry");
});

await check("the migration refuses to run before the model catalogue", async () => {
    const bare = new PGlite();
    try { await assert.rejects(bare.exec(migration), /Apply v7-model-catalogue\.sql before v7-model-types\.sql/); }
    finally { await bare.close(); }
});

const db = await database();
try {
    await check("applying twice keeps chat rows as chat and adds the four typed seeds once", async () => {
        const before = (await db.query<{ count: number }>("select count(*)::int as count from model_catalogue")).rows[0].count;
        await db.exec(migration);
        await db.exec(migration);
        const kinds = (await db.query<{ kind: string; count: number }>("select kind, count(*)::int as count from model_catalogue group by kind order by kind")).rows;
        assert.deepEqual(kinds, [{ kind: "chat", count: before }, { kind: "embedding", count: 2 }, { kind: "speech", count: 2 }]);
        const nim = (await db.query<{ dimension: number; approved: boolean; traits: unknown }>("select dimension, approved_at is not null as approved, traits from model_catalogue where provider_id = 'nvidia-nim' and model_id = 'nvidia/nemotron-3.5-embed-1b'")).rows[0];
        assert.deepEqual(nim, { dimension: 2048, approved: true, traits: {} });
        const constraints = (await db.query<{ count: number }>("select count(*)::int as count from pg_constraint where conname like 'model_catalogue_%_check' and conname in ('model_catalogue_kind_check', 'model_catalogue_dimension_check', 'model_catalogue_traits_check')")).rows[0].count;
        assert.equal(constraints, 3);
    });

    await check("bad kinds, dimensions, sources, partition ids and traits are refused", async () => {
        const where = "where provider_id = 'nvidia-nim' and model_id = 'nvidia/nemotron-3.5-embed-1b'";
        await assert.rejects(db.query(`update model_catalogue set kind = 'rerank' ${where}`), /check/i);
        await assert.rejects(db.query(`update model_catalogue set dimension = 16001 ${where}`), /check/i);
        await assert.rejects(db.query(`update model_catalogue set expires_source = 'rumour' ${where}`), /check/i);
        await assert.rejects(db.query(`update model_catalogue set space_of = ' bad id' ${where}`), /check/i);
        await assert.rejects(db.query(`update model_catalogue set traits = '[]'::jsonb ${where}`), /check/i);
        await db.query(`update model_catalogue set space_of = 'nvidia/nemotron-3.5-embed-1b@512', expires_source = 'gone' ${where}`);
    });

    await check("a transcription observation is accepted and an unknown purpose is not", async () => {
        const insert = (purpose: string) => db.query(`insert into model_call_observations (id, provider_id, model_id, purpose, started_at, duration_ms, status, usage_completeness)
            values ($1, 'groq', 'whisper-large-v3-turbo', $2, now(), 900, 'success', 'unavailable')`, [randomUUID(), purpose]);
        await insert("transcription");
        await assert.rejects(insert("dictation"), /check/i);
    });
} finally {
    await db.close();
}

console.log(`${passed} model types SQL checks passed`);
