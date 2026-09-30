import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
const migration = await readFile(new URL("./migrations/council-paused-expiry.sql", import.meta.url), "utf8");
const functions = ["pause_council", "resume_council"].map(name => {
    const definitions = [...setup.matchAll(new RegExp(`create or replace function (?:public\\.)?${name}\\([\\s\\S]*?\\$\\$;`, "g"))];
    assert(definitions.length, `Missing ${name}`);
    return definitions.at(-1)![0];
}).join("\n");

for (const [source, sql] of [["setup", functions], ["migration", migration]]) {
    await test(`${source}: paused Council expiry`, async t => {
        const db = new PGlite();
        t.after(() => db.close());
        await db.exec("create table user_profiles(id uuid primary key)");
        for (const table of ["council_sessions", "council_participants", "council_messages"]) {
            const ddl = setup.match(new RegExp(`create table if not exists ${table} \\([\\s\\S]*?\\n\\);`));
            assert(ddl, `Missing ${table}`);
            await db.exec(ddl[0]);
        }
        await db.exec(`alter table council_sessions add column paused_at timestamptz,
            add column paused_total_seconds integer not null default 0;
            alter table council_sessions drop constraint council_sessions_status_check;
            alter table council_sessions add check(status in ('open','concluding','awaiting_owner','closed','expired'));`);
        await db.exec(sql);
        async function scalar<T>(query: string, params: unknown[] = []): Promise<T> {
            return (await db.query<{ value: T }>(query, params)).rows[0].value;
        }
        async function fixture(age: string | null, status = "open") {
            const id = randomUUID();
            await db.query(`insert into council_sessions(id,code,topic,closer_name,status,paused_at,expires_at,last_seq)
                values($1::uuid,$1::text,'Saved debate','seat',$2,clock_timestamp()-$3::interval,clock_timestamp()+interval '30 days',1)`, [id, status, age]);
            await db.query("insert into council_participants(session_id,name,status) values($1,'seat','active')", [id]);
            await db.query(`insert into council_messages(session_id,seq,round,speaker,intent,body,client_key,body_hash)
                values($1,1,1,'seat','propose','Retain this transcript','fixture','fixture')`, [id]);
            return {
                id,
                row: () => scalar<Record<string, unknown>>("select to_jsonb(s) as value from council_sessions s where id=$1", [id]),
                resume: () => scalar<{ ok: boolean; already?: boolean; reason?: string; paused_seconds?: number }>("select resume_council($1) as value", [id]),
                pause: () => scalar<{ ok: boolean; reason?: string }>("select pause_council($1) as value", [id]),
            };
        }
        for (const age of ["7 days", "40 days"]) {
            await t.test(`resume expires a ${age} pause despite an unexpired normal TTL`, async () => {
                const f = await fixture(age), before = await f.row();
                assert.deepEqual(await f.resume(), { ok: false, reason: "pause_expired" });
                assert.deepEqual(await f.row(), { ...before, status: "expired" });
                assert.equal(await scalar("select body as value from council_messages where session_id=$1", [f.id]), "Retain this transcript");
                assert.equal((await f.resume()).ok, false);
                assert.equal((await f.pause()).ok, false);
            });
        }
        await t.test("resume below the ceiling restores clocks and a later pause starts a new interval", async () => {
            const f = await fixture("6 days 23 hours 59 minutes"), before = await f.row();
            const result = await f.resume(), after = await f.row();
            assert.equal(result.ok, true);
            assert.equal(after.paused_at, null);
            assert.equal(after.status, "open");
            assert.equal(Date.parse(String(after.expires_at)) - Date.parse(String(before.expires_at)), result.paused_seconds! * 1000);
            assert.equal(after.paused_total_seconds, result.paused_seconds);
            assert.equal((await f.pause()).ok, true);
            assert.equal((await f.resume()).ok, true, "Prior paused total must not count against a new pause");
        });
        for (const status of ["closed", "expired", "awaiting_owner"]) {
            await t.test(`resume cannot change a ${status} session with a retained pause`, async () => {
                const f = await fixture("1 hour", status), before = await f.row();
                assert.equal((await f.resume()).ok, false);
                assert.equal((await f.pause()).ok, false);
                assert.deepEqual(await f.row(), before);
            });
        }
        await t.test("a repeat pause does not reset its original ceiling", async () => {
            const f = await fixture("6 days"), before = await f.row();
            assert.equal((await f.pause()).ok, true);
            assert.deepEqual(await f.row(), before);
        });
        await t.test("an unpaused running session resumes idempotently", async () => {
            const f = await fixture(null), before = await f.row();
            assert.deepEqual(await f.resume(), { ok: true, already: true });
            assert.deepEqual(await f.row(), before);
        });
        await t.test("resume uses current time when a transaction began before the ceiling", async () => {
            const f = await fixture(null);
            await db.exec("begin");
            try {
                await db.query("update council_sessions set paused_at=now()-interval '7 days'+interval '100 milliseconds' where id=$1", [f.id]);
                await new Promise(resolve => setTimeout(resolve, 160));
                assert.deepEqual(await f.resume(), { ok: false, reason: "pause_expired" });
            } finally { await db.exec("rollback"); }
        });
    });
}
