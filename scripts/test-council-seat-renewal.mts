import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
let passed = 0, failed = 0;
async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
    return (await db.query<{ value: T }>(sql, params)).rows[0].value;
}
async function check(name: string, run: () => Promise<void>) {
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
}
async function fixture(status = "running", integration: string | null = null) {
    const session = randomUUID(), host = randomUUID();
    await db.query("insert into council_sessions(id,code,topic,closer_name,status,protocol_version) values($1,$2,'Fixture','seat','closed',3)", [session, session]);
    await db.query("insert into council_participants(session_id,name,kind) values($1,'seat','agent')", [session]);
    await db.query("insert into council_campaigns(session_id,repo_path,status,integration_status) values($1,'/fixture',$2,$3)", [session, status, integration]);
    await db.query("insert into council_host_leases values($1,$2,7,clock_timestamp()+interval '45 seconds',clock_timestamp(),clock_timestamp(),null)", [session, host]);
    await db.query("insert into council_seat_keys(session_id,seat_name,token_hash,expires_at,issued_by,host_id,lease_epoch) values($1,'seat',$2,clock_timestamp()+interval '30 minutes','host',$3,7)", [session, session, host]);
    return {
        session, host,
        renew: (hostId = host, epoch = 7) => scalar<{ ok: boolean }>("select renew_council_host_lease($1,$2,$3,45) as value", [session, hostId, epoch]),
        expiry: () => scalar<number>("select extract(epoch from expires_at)::float8 as value from council_seat_keys where session_id=$1", [session]),
        resolve: () => scalar<{ session_id: string } | null>("select resolve_council_seat_key($1) as value", [session]),
        issue: () => scalar<{ ok: boolean; reason?: string }>("select issue_council_seat_key($1,'seat',$2,clock_timestamp()+interval '24 hours') as value", [session, randomUUID()]),
    };
}

try {
    const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create table user_profiles(id uuid primary key)");
    for (const table of ["council_sessions", "council_participants", "council_campaigns", "council_host_leases", "council_seat_keys"]) {
        const ddl = setup.match(new RegExp(`create table if not exists ${table} \\([\\s\\S]*?\\n\\);`));
        assert(ddl, `Missing ${table}`);
        await db.exec(ddl[0]);
    }
    await db.exec(`alter table council_sessions add column protocol_version integer default 3, add column paused_at timestamptz;
        alter table council_sessions drop constraint council_sessions_status_check;
        alter table council_sessions add constraint council_sessions_status_check check(status in ('open','concluding','awaiting_owner','closed','expired'));
        alter table council_campaigns add column integration_status text;
        alter table council_seat_keys add column issued_by text default 'owner', add column host_id uuid, add column lease_epoch bigint,
            add column execution_id uuid, add column execution_binding_required boolean not null default false;`);
    for (const name of ["renew_council_host_lease", "resolve_council_seat_key", "issue_council_seat_key"]) {
        const functions = [...setup.matchAll(new RegExp(`create or replace function (?:public\\.)?${name}\\([\\s\\S]*?\\$\\$;`, "g"))];
        assert(functions.length, `Missing ${name}`);
        await db.exec(functions.at(-1)![0]);
    }
    for (const [status, integration] of [["running", null], ["blocked", null], ["complete", null], ["complete", "pending"], ["complete", "running"]] as const) {
        await check(`renews unfinished ${status}/${integration} without rotating identity`, async () => {
            const f = await fixture(status, integration);
            const before = await scalar<Record<string, unknown>>("select to_jsonb(k)-'expires_at' as value from council_seat_keys k where session_id=$1", [f.session]);
            assert.equal((await f.renew()).ok, true);
            const remaining = (await f.expiry()) - Date.now() / 1000;
            assert(remaining > 86_390 && remaining <= 86_401, "Eligible token must have a bounded 24-hour window");
            assert.deepEqual(await scalar("select to_jsonb(k)-'expires_at' as value from council_seat_keys k where session_id=$1", [f.session]), before);
            assert.equal((await f.resolve())?.session_id, f.session);
            const renewed = await f.expiry();
            await f.renew();
            assert.equal(await f.expiry(), renewed, "Heartbeat must not rewrite a token outside the renewal threshold");
        });
    }
    for (const [status, integration] of [["cancelled", null], ["complete", "verified"], ["complete", "conflict"], ["complete", "failed"]] as const) {
        await check(`does not renew or reissue terminal ${status}/${integration}`, async () => {
            const f = await fixture(status, integration), expiry = await f.expiry();
            await f.renew();
            assert.equal(await f.expiry(), expiry);
            assert.equal((await f.issue()).ok, false);
        });
    }
    for (const [name, sql] of [
        ["no campaign", "delete from council_campaigns where session_id=$1"],
        ["expired session", "update council_sessions set status='expired' where id=$1"],
        ["paused session", "update council_sessions set paused_at=clock_timestamp() where id=$1"],
    ]) {
        await check(`does not renew or reissue with ${name}`, async () => {
            const f = await fixture(); await db.query(sql, [f.session]);
            const expiry = await f.expiry(); await f.renew();
            assert.equal(await f.expiry(), expiry);
            assert.equal((await f.issue()).ok, false);
        });
    }
    for (const [name, sql] of [
        ["revoked token", "update council_seat_keys set revoked_at=clock_timestamp() where session_id=$1"],
        ["expired token", "update council_seat_keys set expires_at=clock_timestamp()-interval '1 second' where session_id=$1"],
        ["wrong host", "update council_seat_keys set host_id=gen_random_uuid() where session_id=$1"],
        ["stale epoch", "update council_seat_keys set lease_epoch=6 where session_id=$1"],
        ["owner guest", "update council_seat_keys set issued_by='owner',host_id=null,lease_epoch=null where session_id=$1"],
        ["removed roster", "delete from council_participants where session_id=$1"],
        ["non V3 session", "update council_sessions set protocol_version=2 where id=$1"],
        ["expired lease", "update council_host_leases set lease_expires_at=clock_timestamp()-interval '1 second' where session_id=$1"],
        ["released lease", "update council_host_leases set released_at=clock_timestamp() where session_id=$1"],
    ]) {
        await check(`does not renew ${name}`, async () => {
            const f = await fixture(); await db.query(sql, [f.session]);
            const expiry = await f.expiry(); await f.renew();
            assert.equal(await f.expiry(), expiry);
            if (["revoked token", "expired token", "wrong host", "stale epoch", "expired lease", "released lease"].includes(name)) assert.equal(await f.resolve(), null);
        });
    }
    await check("foreign caller and stale caller cannot extend lease or token", async () => {
        const f = await fixture(), expiry = await f.expiry();
        assert.equal((await f.renew(randomUUID())).ok, false);
        assert.equal((await f.renew(f.host, 6)).ok, false);
        assert.equal(await f.expiry(), expiry);
    });
    await check("owner reissue replaces an expired guest during unfinished campaign", async () => {
        const f = await fixture();
        await db.query("update council_seat_keys set expires_at=clock_timestamp()-interval '1 second',revoked_at=clock_timestamp() where session_id=$1", [f.session]);
        assert.equal((await f.issue()).ok, true);
        assert.equal(await f.resolve(), null, "Prior token must stay unusable after explicit reissue");
        const row = await scalar<{ issued_by: string; revoked_at: unknown; host_id: unknown }>("select to_jsonb(k) as value from council_seat_keys k where session_id=$1", [f.session]);
        assert.equal(row.issued_by, "owner"); assert.equal(row.revoked_at, null); assert.equal(row.host_id, null);
    });
    await check("open debate can issue without a campaign but cannot auto-renew", async () => {
        const f = await fixture();
        await db.query("delete from council_campaigns where session_id=$1", [f.session]);
        await db.query("update council_sessions set status='open' where id=$1", [f.session]);
        const expiry = await f.expiry(); await f.renew(); assert.equal(await f.expiry(), expiry);
        assert.equal((await f.issue()).ok, true);
    });
    await check("awaiting-owner Council cannot mint a guest credential", async () => {
        const f = await fixture();
        await db.query("update council_sessions set status='awaiting_owner' where id=$1", [f.session]);
        assert.equal((await f.issue()).ok, false);
    });
    await check("guest issuance rejects invalid expiry and caps a requested long lifetime", async () => {
        const f = await fixture();
        for (const expiry of [null, "2000-01-01T00:00:00Z", "infinity"]) {
            assert.equal((await scalar<{ ok: boolean }>("select issue_council_seat_key($1,'seat',$2,$3) as value", [f.session, randomUUID(), expiry])).ok, false);
        }
        assert.equal((await scalar<{ ok: boolean }>("select issue_council_seat_key($1,'seat',$2,clock_timestamp()+interval '7 days') as value", [f.session, randomUUID()])).ok, true);
        const remaining = await f.expiry() - Date.now() / 1000;
        assert(remaining > 86_390 && remaining <= 86_401);
    });
    await check("migration can be reapplied and only service role can renew or issue", async () => {
        const migration = await readFile(new URL("./migrations/council-seat-renewal.sql", import.meta.url), "utf8");
        assert(setup.includes(migration.trim()), "Setup must retain the exact renewal migration before later additions");
        await db.exec(migration); await db.exec(migration);
        for (const signature of ["renew_council_host_lease(uuid,uuid,bigint,integer)", "issue_council_seat_key(uuid,text,text,timestamptz)", "resolve_council_seat_key(text)"]) {
            for (const role of ["anon", "authenticated", "service_role"]) {
                assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE') as value", [role, signature]), role === "service_role");
            }
        }
        const f = await fixture(); assert.equal((await f.renew()).ok, true);
        assert((await f.expiry()) - Date.now() / 1000 > 86_390);
    });
} finally { await db.close(); }
console.log(`${passed} passed, ${failed} failed (offline PostgreSQL semantics; single connection).`);
if (failed) process.exitCode = 1;
