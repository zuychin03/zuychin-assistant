import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

// council-owner-notes.sql on PGlite, applied alone and as embedded in setup, each
// twice to prove a re-run is safe. No hosted database is used.

const marker = "-- ===== Council owner notes =====";
const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
const migration = await readFile(new URL("./migrations/council-owner-notes.sql", import.meta.url), "utf8");
const baseline = setup.split(marker)[0];
const section = setup.slice(setup.indexOf(marker)).split(/(?=^-- ===== )/m)[0];

function lastFunction(name: string) {
    const matches = [...baseline.matchAll(new RegExp(`create or replace function (?:public\\.)?${name}\\([\\s\\S]*?\\$\\$;`, "g"))];
    assert(matches.length, `Missing ${name}`);
    return matches.at(-1)![0];
}

await test("setup embeds council-owner-notes.sql verbatim under its marker", () => {
    assert.ok(setup.includes(`${marker}\n-- council-owner-notes.sql\n${migration.trimEnd()}`));
});

type Note = { id: string; agent_name: string | null; body: string };
type Result = { ok: boolean; reason?: string; note?: Note & { delivered: Record<string, string> }; item?: Record<string, unknown> };

for (const [source, sql] of [["migration", migration], ["setup", section]] as const) {
    await test(`${source}: owner notes and requeue`, async t => {
        const db = new PGlite();
        t.after(() => db.close());
        await db.exec("create role anon; create role authenticated; create role service_role; create table user_profiles(id uuid primary key); create table agent_clients(id uuid primary key)");
        for (const ddl of baseline.matchAll(/create table if not exists council_[a-z_]+ \([\s\S]*?\n\);/g)) await db.exec(ddl[0]);
        for (const ddl of baseline.matchAll(/alter table council_[a-z_]+\b[\s\S]*?;/g)) await db.exec(ddl[0]);
        await db.exec(lastFunction("claim_council_work_item"));
        await db.exec(sql);
        await db.exec(sql);

        const value = async <T,>(query: string, params: unknown[] = []): Promise<T> => (await db.query<{ value: T }>(query, params)).rows[0]?.value;
        const add = (session: string, agent: string | null, body: string) => value<Result>("select add_council_owner_note($1,$2,$3) as value", [session, agent, body]);
        const pending = async (session: string, agent: string) => (await db.query<Note>("select * from pending_council_owner_notes($1,$2)", [session, agent])).rows;
        const mark = async (ids: string[], agent: string) => (await db.query<{ id: string }>("select mark_council_owner_notes_delivered($1::uuid[],$2) as id", [ids, agent])).rows.map(row => row.id);
        const requeue = (item: string) => value<Result>("select requeue_council_work_item($1) as value", [item]);

        async function fixture(status = "closed", campaignStatus: string | null = "running") {
            const session = randomUUID(), campaign = randomUUID();
            await db.query("insert into council_sessions(id,code,topic,closer_name,status) values($1::uuid,$1::text,'Notes fixture','closer',$2)", [session, status]);
            await db.query("insert into council_participants(session_id,name,kind,status) values($1,'seat-a','agent','active'),($1,'seat-b','agent','active'),($1,'closer','agent','active'),($1,'zuychin','moderator','active')", [session]);
            if (campaignStatus) await db.query("insert into council_campaigns(id,session_id,status,repo_path) values($1,$2,$3,'synthetic')", [campaign, session, campaignStatus]);
            const item = async (agent: string, itemStatus: string, sequence: number, extra: Record<string, unknown> = {}) => {
                const id = randomUUID();
                await db.query(`insert into council_work_items(id,campaign_id,sequence,agent_name,title,instructions,status,attempts,rejections,progress,blocked_reason)
                    values($1,$2,$3,$4,'Task','Do it',$5,$6,$7,$8,$9)`, [id, campaign, sequence, agent, itemStatus, extra.attempts ?? 0, extra.rejections ?? 0, extra.progress ?? null, extra.blockedReason ?? null]);
                return id;
            };
            return { session, campaign, item };
        }

        await t.test("the table is server-only and the functions run for the service role only", async () => {
            assert.equal(await value("select relrowsecurity as value from pg_class where relname='council_owner_notes'"), true);
            for (const role of ["anon", "authenticated"]) {
                assert.equal(await value("select has_table_privilege($1,'council_owner_notes','select') as value", [role]), false);
                for (const fn of ["add_council_owner_note(uuid,text,text)", "pending_council_owner_notes(uuid,text)",
                    "mark_council_owner_notes_delivered(uuid[],text)", "requeue_council_work_item(uuid)"]) {
                    assert.equal(await value("select has_function_privilege($1,$2,'execute') as value", [role, fn]), false, `${role} ${fn}`);
                    assert.equal(await value("select has_function_privilege('service_role',$1,'execute') as value", [fn]), true, fn);
                }
            }
        });

        await t.test("a note needs a closed Council with a running or blocked campaign, a real seat and a body", async () => {
            assert.deepEqual(await add(randomUUID(), null, "Hello"), { ok: false, reason: "unknown_session" });
            assert.deepEqual(await add((await fixture("open", null)).session, null, "Hello"), { ok: false, reason: "not_closed" });
            assert.deepEqual(await add((await fixture("closed", null)).session, null, "Hello"), { ok: false, reason: "no_campaign" });
            for (const status of ["complete", "cancelled"]) {
                assert.deepEqual(await add((await fixture("closed", status)).session, null, "Hello"), { ok: false, reason: "campaign_finished" });
            }
            const frozen = await fixture();
            await db.query("update council_campaigns set integration_manifest='{}' where id=$1", [frozen.campaign]);
            assert.deepEqual(await add(frozen.session, null, "Hello"), { ok: false, reason: "campaign_finished" });

            const f = await fixture("closed", "blocked");
            for (const agent of ["nobody", "zuychin"]) assert.deepEqual(await add(f.session, agent, "Hello"), { ok: false, reason: "unknown_seat" });
            for (const body of ["", "   ", "x".repeat(4001)]) assert.deepEqual(await add(f.session, null, body), { ok: false, reason: "invalid_body" });
            const sent = await add(f.session, "seat-a", "  Keep the journal format.  ");
            assert.equal(sent.ok, true);
            assert.equal(sent.note?.body, "Keep the journal format.");
            assert.deepEqual(sent.note?.delivered, {});
            assert.equal((await add(f.session, null, "x".repeat(4000))).ok, true);
        });

        await t.test("each seat gets its own and all-seat notes once, in order", async () => {
            const f = await fixture();
            const all = (await add(f.session, null, "First, to everyone")).note!.id;
            const forA = (await add(f.session, "seat-a", "Second, to seat-a")).note!.id;
            const forB = (await add(f.session, "seat-b", "Third, to seat-b")).note!.id;
            // PGlite's clock can give all three the same millisecond.
            for (const [index, id] of [all, forA, forB].entries()) {
                await db.query("update council_owner_notes set created_at=timestamptz '2026-11-21 00:00:00+00' + $2 * interval '1 second' where id=$1", [id, index]);
            }
            assert.deepEqual((await pending(f.session, "seat-a")).map(note => note.id), [all, forA]);
            assert.deepEqual((await pending(f.session, "seat-b")).map(note => note.id), [all, forB]);

            assert.deepEqual((await mark([all, forA, forB], "seat-a")).sort(), [all, forA].sort(), "a seat cannot mark another seat's note");
            assert.deepEqual(await mark([all, forA], "seat-a"), [], "a second take delivers nothing");
            assert.deepEqual(await pending(f.session, "seat-a"), []);
            assert.deepEqual((await pending(f.session, "seat-b")).map(note => note.id), [all, forB]);
            assert.deepEqual(await mark([all], "seat-b"), [all]);
            const delivered = await value<Record<string, string>>("select delivered as value from council_owner_notes where id=$1", [all]);
            assert.deepEqual(Object.keys(delivered).sort(), ["seat-a", "seat-b"]);
            assert.equal((await pending((await fixture()).session, "seat-a")).length, 0, "notes stay in their own Council");
        });

        await t.test("a blocked task goes back to its seat with a fresh allowance and the campaign runs again", async () => {
            const f = await fixture("closed", "blocked");
            const stuck = await f.item("seat-a", "blocked", 1, { attempts: 3, rejections: 2, progress: "Review feedback: tests fail", blockedReason: "seat stuck: watchdog: no activity for 15 min" });
            const plain = await f.item("seat-b", "blocked", 2, { blockedReason: null });
            const done = await f.item("seat-b", "verified", 3);

            const result = await requeue(stuck);
            assert.equal(result.ok, true);
            const row = await value<Record<string, unknown>>("select to_jsonb(i) as value from council_work_items i where id=$1", [stuck]);
            assert.equal(row.status, "queued");
            assert.equal(row.attempts, 0);
            assert.equal(row.rejections, 0);
            assert.equal(row.blocked_reason, null);
            assert.equal(row.progress, "Review feedback: tests fail\nRequeued by the owner. It was blocked: seat stuck: watchdog: no activity for 15 min.");
            assert.equal(await value("select status as value from council_campaigns where id=$1", [f.campaign]), "running");

            assert.equal((await requeue(plain)).ok, true);
            assert.equal(await value("select progress as value from council_work_items where id=$1", [plain]), "Requeued by the owner.");
            assert.deepEqual(await requeue(stuck), { ok: false, reason: "not_blocked" });
            assert.deepEqual(await requeue(done), { ok: false, reason: "not_blocked" });
            assert.deepEqual(await requeue(randomUUID()), { ok: false, reason: "unknown_item" });

            const claimed = await value<Record<string, unknown>>("select claim_council_work_item($1,'seat-a') as value", [f.session]);
            assert.equal(claimed.id, stuck, "the seat can claim its requeued task");
            assert.equal(claimed.attempts, 1);
        });

        await t.test("requeue leaves a frozen or finished campaign alone", async () => {
            const frozen = await fixture("closed", "blocked");
            const item = await frozen.item("seat-a", "blocked", 1);
            await db.query("update council_campaigns set integration_manifest='{}' where id=$1", [frozen.campaign]);
            assert.deepEqual(await requeue(item), { ok: false, reason: "manifest_frozen" });
            const cancelled = await fixture("closed", "cancelled");
            const other = await cancelled.item("seat-a", "blocked", 1);
            assert.deepEqual(await requeue(other), { ok: false, reason: "campaign_finished" });
            assert.equal(await value("select status as value from council_work_items where id=$1", [item]), "blocked");
            assert.equal(await value("select status as value from council_work_items where id=$1", [other]), "blocked");
        });

        await t.test("notes go with their Council", async () => {
            const f = await fixture();
            await add(f.session, null, "Gone with the session");
            await db.query("delete from council_sessions where id=$1", [f.session]);
            assert.equal(await value("select count(*)::int as value from council_owner_notes where session_id=$1", [f.session]), 0);
        });
    });
}
