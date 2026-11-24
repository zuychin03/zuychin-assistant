import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

let passed = 0;
async function check(name: string, test: () => Promise<void>) { await test(); passed++; console.log(`PASS ${name}`); }

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const migration = await read("./migrations/v8-media.sql");
const setup = await read("../supabase-setup.sql");

async function database(): Promise<PGlite> {
    const db = new PGlite();
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
        create table user_profiles (id uuid primary key); create table conversations (id uuid primary key);
        create table messages (id uuid primary key); create table agent_runs (id uuid primary key default gen_random_uuid());
        create table knowledge_chunks (id uuid primary key default gen_random_uuid(), content text not null);`);
    await db.exec(await read("./migrations/v6-model-health.sql"));
    await db.exec(await read("./migrations/v7-model-catalogue.sql"));
    return db;
}

await check("the migration is embedded in setup verbatim with LF endings", async () => {
    assert.ok(!migration.includes("\r"), "LF line endings");
    assert.ok(setup.includes(`-- ===== V8 media =====\n-- v8-media.sql\n${migration.trimEnd()}`), "supabase-setup.sql must embed v8-media.sql verbatim");
    assert.ok(!/create table (?!temporary)/i.test(migration), "no new tables, so server-only-tables.sql needs no entry");
    assert.ok(!/council/i.test(migration.split("\n")[0]), "no council wording in the header");
});

await check("the migration refuses to run before v7-model-types.sql", async () => {
    const db = await database();
    try { await assert.rejects(db.exec(migration), /Apply v7-model-types\.sql before v8-media\.sql/); }
    finally { await db.close(); }
});

const db = await database();
try {
    await db.exec(await read("./migrations/v7-model-types.sql"));
    // A chat row discovery stored for the translation model before V8.
    await db.query(`insert into model_catalogue (provider_id, model_id, label, short_name, free, metered, origin, probe_status, approved_at)
        values ('nvidia-nim', 'nvidia/riva-translate-4b-instruct-v2', 'Riva Translate', 'riva-translate-4b-instruct-v2', true, false, 'discovered', 'passed', now())`);

    await check("applying twice adds the seven seeds once and moves the stored translation row to its kind", async () => {
        await db.exec(migration);
        await db.query("update model_catalogue set approved_at = now() where model_id = 'nvidia/nemotron-3.5-parse'");
        await db.exec(migration);
        const media = (await db.query<{ provider_id: string; model_id: string; kind: string; approved: boolean; origin: string }>(
            `select provider_id, model_id, kind, approved_at is not null as approved, origin from model_catalogue
             where kind in ('rerank', 'parse', 'image', 'decision', 'live', 'translate') order by provider_id, model_id`)).rows;
        assert.deepEqual(media.map((entry) => `${entry.provider_id}::${entry.model_id}:${entry.kind}:${entry.approved}`), [
            "gemini::gemini-decision-1:decision:true",
            "gemini-free::gemini-3.8-live:live:true",
            "gemini-free::gemini-decision-1:decision:true",
            "nvidia-nim::black-forest-labs/flux.2-klein-4b:image:true",
            "nvidia-nim::nvidia/nemotron-3.5-parse:parse:true",
            "nvidia-nim::nvidia/nemotron-3.5-rerank-8b:rerank:true",
            "nvidia-nim::nvidia/riva-translate-4b-instruct-v2:translate:false",
        ]);
        assert.equal(media.find((entry) => entry.kind === "translate")!.origin, "discovered", "the moved row keeps its history");
        const riva = (await db.query<{ traits: { promptTemplate: string; languages: string[] } }>("select traits from model_catalogue where model_id = 'nvidia/riva-translate-4b-instruct-v2'")).rows[0];
        assert.equal(riva.traits.promptTemplate, "Translate the following text from {source} to {target}:\n{text}");
        assert.ok(riva.traits.languages.includes("vi") && riva.traits.languages.includes("fr"));
        const free = (await db.query<{ free: boolean; metered: boolean }>("select free, metered from model_catalogue where provider_id = 'gemini' and model_id = 'gemini-decision-1'")).rows[0];
        assert.deepEqual(free, { free: false, metered: true });
    });

    await check("an approval given after the first run survives a re-run", async () => {
        await db.query("update model_catalogue set approved_at = now() where model_id = 'nvidia/riva-translate-4b-instruct-v2'");
        await db.exec(migration);
        const approved = (await db.query<{ approved: boolean }>("select approved_at is not null as approved from model_catalogue where model_id = 'nvidia/riva-translate-4b-instruct-v2'")).rows[0].approved;
        assert.equal(approved, true);
    });

    await check("unknown kinds are refused and media purposes are accepted", async () => {
        await assert.rejects(db.query("update model_catalogue set kind = 'video' where model_id = 'nvidia/nemotron-3.5-parse'"), /check/i);
        const insert = (purpose: string) => db.query(`insert into model_call_observations (id, provider_id, model_id, purpose, started_at, duration_ms, status, usage_completeness)
            values ($1, 'nvidia-nim', 'nvidia/nemotron-3.5-rerank-8b', $2, now(), 400, 'success', 'unavailable')`, [randomUUID(), purpose]);
        for (const purpose of ["rerank", "parse", "image", "decision", "live", "translate", "transcription"]) await insert(purpose);
        await assert.rejects(insert("dictation"), /check/i);
    });

    await check("knowledge chunks gain a modality and a vault asset path, both checked", async () => {
        await db.query("insert into knowledge_chunks (content) values ('a text chunk')");
        assert.equal((await db.query<{ modality: string }>("select modality from knowledge_chunks")).rows[0].modality, "text");
        await db.query("insert into knowledge_chunks (content, modality, asset_path) values ('caption', 'image', 'attachments/captures/abc-123.jpg')");
        await assert.rejects(db.query("insert into knowledge_chunks (content, modality) values ('x', 'video')"), /check/i);
        await assert.rejects(db.query("insert into knowledge_chunks (content, asset_path) values ('x', 'notes/secret.md')"), /check/i);
        await assert.rejects(db.query("insert into knowledge_chunks (content, asset_path) values ('x', 'attachments/../notes/secret.md')"), /check/i);
    });
} finally {
    await db.close();
}

console.log(`${passed} media kinds SQL checks passed`);
