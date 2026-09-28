import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const owner = randomUUID(), project = randomUUID(), question = randomUUID(), source = randomUUID(), entry = randomUUID();
let passed = 0;
const run = async (action: string, payload: Record<string, unknown>) => (await db.query<Record<string, unknown>>("select assistant_research_mutate($1,$2,$3) as value", [owner, action, JSON.stringify(payload)])).rows[0].value as Record<string, unknown>;
async function check(name: string, test: () => Promise<void>) { await test(); passed++; console.log(`PASS ${name}`); }
const q = { id: question, projectId: project, title: "Capacity", question: "Which method?", status: "active" };
const s = { id: source, questionId: question, documentId: "fixture", path: "wiki/fixture.md", commitSha: "a".repeat(40), contentHash: "b".repeat(64), title: "Source" };
const e = { id: entry, questionId: question, kind: "interpretation", text: "Authored note" };
try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;");
    const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
    for (const table of ["user_profiles", "projects", "knowledge_documents"]) {
        const ddl = setup.match(new RegExp(String.raw`create table if not exists ${table} \([\s\S]*?\n\);`));
        assert.ok(ddl); await db.exec(ddl[0]);
    }
    const migration = await readFile(new URL("./migrations/v6-research-workbench.sql", import.meta.url), "utf8");
    await db.exec(migration); await db.exec(migration);
    await db.query("insert into user_profiles(id) values ($1)", [owner]);
    await db.query("insert into projects(id,user_profile_id,name) values ($1,$2,'Fixture')", [project, owner]);
    await db.query("insert into knowledge_documents(id,path,title,scope,status,content_hash) values ('fixture','wiki/fixture.md','Fixture','user','active',repeat('b',64))");
    await db.query("insert into research_questions(id,user_profile_id,project_id,title,question,status) select gen_random_uuid(),$1,$2,'Prior','Prior','archived' from generate_series(1,499)", [owner, project]);
    await check("question 500 succeeds; 501 fails without hiding archived records", async () => {
        assert.equal((await run("create_question", q)).id, question);
        assert.equal((await run("create_question", { ...q, id: randomUUID() })).capacity, "questions");
    });
    await check("question replay, conflict, edit and archive remain available at capacity", async () => {
        assert.equal((await run("create_question", q)).id, question);
        assert.equal((await run("create_question", { ...q, title: "Changed" })).conflict, true);
        assert.equal((await run("update_question", { ...q, version: 1, status: "archived" })).version, 2);
        assert.equal((await run("update_question", { ...q, version: 2 })).version, 3);
    });
    await db.query("insert into research_sources(id,user_profile_id,question_id,document_id,path,commit_sha,content_hash,title,removed_at) select gen_random_uuid(),$1,$2,'fixture','wiki/fixture.md',lpad(to_hex(n),40,'0'),repeat('b',64),'Prior',now() from generate_series(1,499) n", [owner, question]);
    await check("source 500 succeeds; 501 fails while removed snapshots count", async () => {
        assert.equal((await run("add_source", s)).id, source);
        assert.equal((await run("add_source", { ...s, id: randomUUID(), commitSha: "c".repeat(40) })).capacity, "sources");
    });
    await check("source replay, rename, remove and reselect work at capacity", async () => {
        assert.equal((await run("add_source", s)).id, source);
        assert.equal((await run("edit_source", { id: source, questionId: question, version: 1, title: "Renamed", remove: true })).version, 2);
        const restored = await run("add_source", { ...s, id: randomUUID() });
        assert.equal(restored.id, source); assert.equal(restored.removed_at, null); assert.equal(restored.version, 3);
        await assert.rejects(run("add_source", { ...s, contentHash: "d".repeat(64) }), /snapshot changed/);
    });
    await db.query("insert into research_entries(id,user_profile_id,question_id,kind,text) select gen_random_uuid(),$1,$2,'interpretation','Prior' from generate_series(1,1999)", [owner, question]);
    await check("entry 2000 succeeds; 2001 fails; replay and edits still work", async () => {
        assert.equal((await run("create_entry", e)).id, entry);
        assert.equal((await run("create_entry", { ...e, id: randomUUID() })).capacity, "entries");
        assert.equal((await run("create_entry", e)).id, entry);
        assert.equal((await run("create_entry", { ...e, text: "Changed" })).conflict, true);
        assert.equal((await run("update_entry", { ...e, text: "Edited", version: 1 })).version, 2);
    });
    await check("deleting an entry frees capacity without stale-version data loss", async () => {
        assert.equal((await run("delete_entry", { ...e, version: 1 })).conflict, true);
        assert.equal((await run("delete_entry", { ...e, version: 2 })).deleted, true);
        assert.equal((await run("create_entry", e)).id, entry);
    });
    await check("all capacity limits remain exact and migration stays rerunnable", async () => {
        await db.exec(migration);
        for (const [table, expected] of [["research_questions", 500], ["research_sources", 500], ["research_entries", 2000]] as const) {
            assert.equal((await db.query<{ count: number }>(`select count(*)::int as count from ${table}`)).rows[0].count, expected);
        }
    });
    console.log(`Research capacity: ${passed} local PostgreSQL checks passed (single connection).`);
} finally { await db.close(); }
