import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

let passed = 0;
async function check(name: string, test: () => Promise<void>) { await test(); passed++; console.log(`PASS ${name}`); }

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const migration = await read("./migrations/v7-model-awareness.sql");
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

await check("the migration is embedded in setup verbatim with LF endings and lists its tables as server-only", async () => {
    assert.ok(!migration.includes("\r"), "LF line endings");
    assert.ok(setup.includes(`-- ===== V7 model awareness =====\n-- v7-model-awareness.sql\n${migration.trimEnd()}`), "supabase-setup.sql must embed v7-model-awareness.sql verbatim");
    const serverOnly = await read("./migrations/server-only-tables.sql");
    for (const table of ["model_profiles", "model_feedback"]) assert.ok(serverOnly.includes(`('${table}')`), table);
});

await check("the migration refuses to run before the model catalogue", async () => {
    const bare = new PGlite();
    try { await assert.rejects(bare.exec(migration), /Apply v7-model-catalogue\.sql before v7-model-awareness\.sql/); }
    finally { await bare.close(); }
});

const db = await database();
try {
    await check("applying twice keeps one seeded profile per seed model and the widened purposes", async () => {
        await db.exec(migration);
        await db.exec(migration);
        const seeds = (await db.query<{ count: number }>("select count(*)::int as count from model_catalogue where origin = 'seed'")).rows[0].count;
        const profiles = (await db.query<{ count: number; sources: string[] }>("select count(*)::int as count, array_agg(distinct tags_source) as sources from model_profiles")).rows[0];
        assert.equal(profiles.count, seeds);
        assert.deepEqual(profiles.sources, ["seed"]);
        const kilo = (await db.query<{ tags: string[] }>("select tags from model_profiles where provider_id = 'kilo' and model_id = 'nvidia/nemotron-3.5-lightning:free'")).rows[0].tags;
        assert.deepEqual(kilo, ["research", "coding", "reasoning", "long-context", "agentic"]);
        const constraints = (await db.query<{ count: number }>("select count(*)::int as count from pg_constraint where conname = 'model_call_observations_purpose_check'")).rows[0].count;
        assert.equal(constraints, 1);
    });

    await check("unknown tags, sources and draft states are refused", async () => {
        await assert.rejects(db.query("update model_profiles set tags = array['general'] where provider_id = 'gemini'"), /check/i);
        await assert.rejects(db.query("update model_profiles set tags_source = 'guess' where provider_id = 'gemini'"), /check/i);
        await assert.rejects(db.query("update model_profiles set draft_status = 'approved' where provider_id = 'gemini'"), /check/i);
        await assert.rejects(db.query("insert into model_profiles (provider_id, model_id) values ('gemini', 'not-in-catalogue')"), /foreign key/i);
        await assert.rejects(db.query("insert into model_feedback (provider_id, model_id, source, useful, purpose) values ('gemini', 'x', 'lead', true, 'general')"), /check/i);
    });

    const insertCall = async (fields: { provider?: string; model: string; purpose?: string; status?: string; firstMs: number | null; durationMs: number; daysAgo?: number; outputTokens?: number | null; httpStatus?: number | null }) => {
        const complete = fields.outputTokens !== undefined && fields.outputTokens !== null;
        await db.query(`insert into model_call_observations (id, provider_id, model_id, purpose, started_at, duration_ms, first_answer_ms, status, http_status,
            prompt_tokens, output_tokens, total_tokens, usage_completeness) values ($1, $2, $3, $4, now() - make_interval(days => $5), $6, $7, $8, $9, $10, $11, $12, $13)`, [
            randomUUID(), fields.provider ?? "nvidia-nim", fields.model, fields.purpose ?? "worker", fields.daysAgo ?? 0, fields.durationMs, fields.firstMs,
            fields.status ?? "success", fields.httpStatus ?? null, complete ? 10 : null, complete ? fields.outputTokens : null, complete ? 10 + fields.outputTokens! : null,
            complete ? "complete" : "unavailable",
        ]);
    };

    await check("the speed function gives medians, the slowest tenth, tokens per second and success counts inside the window", async () => {
        for (const first of [1000, 2000, 3000, 4000]) await insertCall({ model: "fast-model", firstMs: first, durationMs: first + 2000, outputTokens: 100 });
        await insertCall({ model: "fast-model", firstMs: null, durationMs: 60_000, status: "transient" });
        await insertCall({ model: "fast-model", firstMs: null, durationMs: 10, status: "aborted" });
        await insertCall({ model: "fast-model", firstMs: 90_000, durationMs: 95_000, daysAgo: 20 });
        await insertCall({ model: "fast-model", firstMs: 50_000, durationMs: 60_000, purpose: "embedding" });
        await insertCall({ model: "fast-model", firstMs: 500, durationMs: 600, purpose: "lookup" });
        await insertCall({ model: "probe-only", firstMs: 7000, durationMs: 7200, purpose: "probe", outputTokens: 3 });
        const rows = (await db.query<Record<string, number | string | null>>("select * from assistant_model_speed(14) order by model_id")).rows;
        const fast = rows.find((row) => row.model_id === "fast-model")!;
        assert.equal(Number(fast.timed_calls), 5);
        assert.equal(fast.median_first_answer_ms, 2000);
        assert.equal(Math.round(Number(fast.p90_first_answer_ms)), 3600);
        assert.equal(fast.median_duration_ms, 4000);
        assert.equal(fast.median_tokens_per_second, 50);
        assert.equal(Number(fast.succeeded), 5);
        assert.equal(Number(fast.failed), 1);
        const probe = rows.find((row) => row.model_id === "probe-only")!;
        assert.equal(probe.median_tokens_per_second, null, "an answer under 250 ms after the first token gives no rate");
        const wide = (await db.query<{ timed: number }>("select timed_calls::int as timed from assistant_model_speed(30) where model_id = 'fast-model'")).rows[0].timed;
        assert.equal(wide, 6);
    });

    await check("the feedback function counts useful and not useful ratings per purpose", async () => {
        const run = (await db.query<{ id: string }>("insert into agent_runs default values returning id")).rows[0].id;
        const rate = (purpose: string | null, useful: boolean, source = "lead") => db.query("insert into model_feedback (provider_id, model_id, purpose, source, useful, agent_run_id) values ('nvidia-nim', 'fast-model', $1, $2, $3, $4)", [purpose, source, useful, run]);
        await rate("research", true); await rate("research", true); await rate("research", false, "auto"); await rate(null, true);
        const rows = (await db.query<{ purpose: string | null; useful: number; not_useful: number }>("select purpose, useful::int, not_useful::int from assistant_model_feedback(30) order by purpose nulls last")).rows;
        assert.deepEqual(rows.map((row) => [row.purpose, row.useful, row.not_useful]), [["research", 2, 1], [null, 1, 0]]);
        await db.query("delete from agent_runs where id = $1", [run]);
        const kept = (await db.query<{ count: number }>("select count(*)::int as count from model_feedback where agent_run_id is null")).rows[0].count;
        assert.equal(kept, 4, "deleting a run keeps its ratings");
    });

    await check("approval sets the profile and tags together, and can approve the model in the same statement", async () => {
        await db.query(`insert into model_catalogue (provider_id, model_id, origin, label, short_name, free, metered, probe_status)
            values ('openrouter', 'cohere/north-mini-code:free', 'discovered', 'North Mini Code (free)', 'north-mini-code', true, false, 'passed')`);
        assert.equal((await db.query<{ result: string }>("select model_profile_approve('openrouter', 'nope', array['coding'], null, false) as result")).rows[0].result, "not_found");
        const profile = JSON.stringify({ description: "Small coding model.", strengths: ["Code edits"], weaknesses: [], sources: [] });
        const result = (await db.query<{ result: string }>("select model_profile_approve('openrouter', 'cohere/north-mini-code:free', array['coding', 'agentic'], $1::jsonb, true) as result", [profile])).rows[0].result;
        assert.equal(result, "ok");
        const row = (await db.query<{ tags: string[]; tags_source: string; approved: boolean; model_approved: boolean }>(`select p.tags, p.tags_source, p.approved_at is not null as approved, c.approved_at is not null as model_approved
            from model_profiles p join model_catalogue c using (provider_id, model_id) where p.model_id = 'cohere/north-mini-code:free'`)).rows[0];
        assert.deepEqual(row, { tags: ["coding", "agentic"], tags_source: "owner", approved: true, model_approved: true });
    });

    await check("saving tags alone keeps the approved profile, and a new approval clears a ready draft", async () => {
        const key = ["openrouter", "cohere/north-mini-code:free"];
        const before = (await db.query<{ approved_at: string }>("select approved_at from model_profiles where provider_id = $1 and model_id = $2", key)).rows[0].approved_at;
        await db.query("select model_profile_approve($1, $2, array['coding'], null, false)", key);
        const kept = (await db.query<{ tags: string[]; approved_at: string; description: string }>("select tags, approved_at, profile->>'description' as description from model_profiles where provider_id = $1 and model_id = $2", key)).rows[0];
        assert.deepEqual(kept.tags, ["coding"]);
        assert.equal(String(kept.approved_at), String(before));
        assert.equal(kept.description, "Small coding model.");
        await db.query("update model_profiles set draft = '{\"description\":\"New draft\"}'::jsonb, draft_status = 'ready' where provider_id = $1 and model_id = $2", key);
        await db.query("select model_profile_approve($1, $2, null, '{\"description\":\"New draft\"}'::jsonb, false)", key);
        const after = (await db.query<{ draft_status: string; tags: string[] }>("select draft_status, tags from model_profiles where provider_id = $1 and model_id = $2", key)).rows[0];
        assert.deepEqual(after, { draft_status: "none", tags: ["coding"] });
    });

    await check("Unapprove clears only the model approval and keeps the profile and tags", async () => {
        const key = ["openrouter", "cohere/north-mini-code:free"];
        await db.query("update model_catalogue set approved_at = null where provider_id = $1 and model_id = $2", key);
        const row = (await db.query<{ tags: string[]; approved: boolean; model_approved: boolean }>(`select p.tags, p.approved_at is not null as approved, c.approved_at is not null as model_approved
            from model_profiles p join model_catalogue c using (provider_id, model_id) where p.provider_id = $1 and p.model_id = $2`, key)).rows[0];
        assert.deepEqual(row, { tags: ["coding"], approved: true, model_approved: false });
    });

    await check("the new lookup and consult purposes are accepted", async () => {
        await insertCall({ model: "fast-model", purpose: "consult", firstMs: 100, durationMs: 200 });
        await assert.rejects(insertCall({ model: "fast-model", purpose: "unknown", firstMs: 100, durationMs: 200 }), /purpose_check/);
    });
} finally {
    await db.close();
}

console.log(`\nModel awareness SQL: ${passed} checks passed (migration order, seeds, constraints, speed and feedback functions, profile approval). Ran in PGlite; no live database was used.`);
