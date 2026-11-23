import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

// P6 of the local council retirement, against the council schema rebuilt from supabase-setup.sql.

const HEADER = "-- ===== V7 local Council cleanup =====";
const setup = readFileSync(new URL("../supabase-setup.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("./migrations/v7-council-local-cleanup.sql", import.meta.url), "utf8");
const before = setup.slice(0, setup.indexOf(HEADER));
const after = setup.slice(setup.indexOf(HEADER));

const DROPPED_TABLES = ["council_verification_runs", "council_integration_attempts", "council_work_items", "council_campaigns", "council_owner_notes", "council_deliveries"];
const DROPPED_FUNCTIONS = [...(/proname = any \(array\[([\s\S]*?)\]\)/.exec(migration)?.[1] ?? "").matchAll(/'([a-z_0-9]+)'/g)].map((match) => match[1]);
const KEPT_FUNCTIONS = [
    "accept_council_verdict", "append_council_message", "append_council_message_attributed", "claim_council_host_lease",
    "continue_council", "get_council_execution_boundary", "issue_council_bound_host_seat_key", "issue_council_host_seat_key",
    "join_council", "pause_council", "propose_council_verdict", "release_council_host_lease", "renew_council_host_lease",
    "resume_council", "start_council_agent_execution", "start_council_bound_agent_execution",
    "start_council_versioned_bound_execution", "stop_council_agent_execution",
];
const INTERNAL_FUNCTIONS = [
    "council_start_execution_record", "council_start_policy_execution_record", "council_start_bound_policy_execution",
    "council_validate_execution_write", "council_execution_facts_immutable", "council_session_policy_immutable",
];

let passed = 0;
let failed = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
}

function lastDefinition(name: string): string {
    const all = [...before.matchAll(new RegExp(`create or replace function (?:public\\.)?${name}\\s*\\([\\s\\S]*?\\bas\\s+(\\$[a-z_]*\\$)[\\s\\S]*?\\1;`, "g"))];
    assert(all.length, `setup defines ${name}`);
    return all.at(-1)![0];
}

await check("the migration drops 34 functions and the setup ends the council schema with it", () => {
    assert.equal(DROPPED_FUNCTIONS.length, 34);
    assert.equal(new Set(DROPPED_FUNCTIONS).size, 34);
    assert(after.includes(migration.trim()), "setup must carry the exact migration");
    for (const name of DROPPED_FUNCTIONS) {
        assert(!new RegExp(`create or replace function (?:public\\.)?${name}\\s*\\(`).test(after.replace(migration, "")), `${name} is recreated after the cleanup`);
    }
    for (const table of DROPPED_TABLES) assert(!after.replace(migration, "").includes(`create table if not exists ${table}`), `${table} is recreated after the cleanup`);
});

await check("no application code calls a dropped function or reads a dropped table", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) walk(path);
            else if (/\.(ts|tsx)$/.test(entry)) files.push(path);
        }
    };
    walk(new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    assert(files.length > 100, "the source walk must see the app");
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const name of [...DROPPED_FUNCTIONS, ...DROPPED_TABLES]) {
        assert(!new RegExp(`["'\`]${name}["'\`]`).test(source), `src still names ${name}`);
    }
});

const db = new PGlite();
try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create table user_profiles(id uuid primary key); create table agent_clients(id uuid primary key)");
    for (const ddl of before.matchAll(/create table if not exists council_[a-z_]+ \([\s\S]*?\n\);/g)) await db.exec(ddl[0]);
    for (const ddl of before.matchAll(/alter table (?:public\.)?council_[a-z_]+\b[\s\S]*?;/g)) {
        await db.exec(ddl[0]).catch(() => undefined);
    }
    // SQL-language bodies are checked when created, so a helper must exist first; retry until settled.
    let pending = [...KEPT_FUNCTIONS, ...INTERNAL_FUNCTIONS, ...DROPPED_FUNCTIONS]
        .filter((name) => new RegExp(`create or replace function (?:public\\.)?${name}\\s*\\(`).test(before));
    while (pending.length) {
        const next: string[] = [];
        for (const name of pending) await db.exec(lastDefinition(name)).catch(() => next.push(name));
        assert(next.length < pending.length, `could not create ${next.join(", ")}`);
        pending = next;
    }
    const trigger = /create trigger council_integration_attempt_immutable[\s\S]*?;/.exec(before);
    assert(trigger, "setup creates the integration attempt trigger");
    await db.exec(trigger[0]);

    const scalar = async <T,>(sql: string, params: unknown[] = []): Promise<T> => (await db.query<{ value: T }>(sql, params)).rows[0].value;
    const fixture = async () => {
        const session = randomUUID(), host = randomUUID();
        await db.query("insert into council_sessions(id,code,topic,closer_name,status,protocol_version) values($1,$2,'Fixture','seat','open',3)", [session, session]);
        await db.query("insert into council_participants(session_id,name,kind) values($1,'seat','agent')", [session]);
        await db.query("insert into council_host_leases(session_id,host_id,lease_epoch,lease_expires_at,claimed_at,last_heartbeat_at) values($1,$2,7,clock_timestamp()+interval '45 seconds',clock_timestamp(),clock_timestamp())", [session, host]);
        await db.query("insert into council_seat_keys(session_id,seat_name,token_hash,expires_at,issued_by,host_id,lease_epoch) values($1,'seat',$2,clock_timestamp()+interval '30 minutes','host',$3,7)", [session, randomUUID(), host]);
        return { session, host };
    };

    await check("the schema builds with the local-only tables and functions present", async () => {
        for (const table of DROPPED_TABLES) assert.notEqual(await scalar("select to_regclass($1)::text as value", [`public.${table}`]), null, table);
        assert(await scalar<number>("select count(*)::int as value from pg_proc where proname = any($1)", [DROPPED_FUNCTIONS]) >= 30);
        const f = await fixture();
        await db.query("insert into council_campaigns(session_id,repo_path,status) values($1,'/fixture','running')", [f.session]);
    });

    await db.exec(migration);
    await db.exec(migration);

    await check("the migration runs twice and removes the local-only tables and every overload", async () => {
        for (const table of DROPPED_TABLES) assert.equal(await scalar("select to_regclass($1)::text as value", [`public.${table}`]), null, table);
        assert.equal(await scalar<number>("select count(*)::int as value from pg_proc where proname = any($1)", [DROPPED_FUNCTIONS]), 0);
    });

    await check("the tables and functions online councils use stay", async () => {
        for (const table of ["council_sessions", "council_participants", "council_messages", "council_owner_messages", "council_host_leases", "council_seat_keys", "council_agent_executions"]) {
            assert.notEqual(await scalar("select to_regclass($1)::text as value", [`public.${table}`]), null, table);
        }
        for (const name of KEPT_FUNCTIONS) assert.equal(await scalar<number>("select count(*)::int as value from pg_proc where proname=$1", [name]) >= 1, true, name);
        assert.equal(await scalar<number>("select count(*)::int as value from council_sessions"), 1, "sessions survive with their history");
    });

    await check("lease renewal extends the lease and leaves seat keys alone", async () => {
        const f = await fixture();
        const key = () => scalar<string>("select expires_at::text as value from council_seat_keys where session_id=$1", [f.session]);
        const keyBefore = await key();
        const leaseBefore = await scalar<number>("select extract(epoch from lease_expires_at)::float8 as value from council_host_leases where session_id=$1", [f.session]);
        const renewed = await scalar<{ ok: boolean; leaseEpoch: number }>("select renew_council_host_lease($1,$2,7,120) as value", [f.session, f.host]);
        assert.equal(renewed.ok, true);
        assert.equal(renewed.leaseEpoch, 7);
        const leaseAfter = await scalar<number>("select extract(epoch from lease_expires_at)::float8 as value from council_host_leases where session_id=$1", [f.session]);
        assert(leaseAfter - leaseBefore > 60, "the lease is extended");
        assert.equal(await key(), keyBefore, "the seat key keeps its expiry");
    });

    await check("lease renewal still refuses stale, foreign, paused-out and missing cases", async () => {
        const f = await fixture();
        assert.deepEqual(await scalar("select renew_council_host_lease($1,$2,6,45) as value", [f.session, f.host]), { ok: false, reason: "stale_epoch" });
        assert.deepEqual(await scalar("select renew_council_host_lease($1,$2,7,45) as value", [f.session, randomUUID()]), { ok: false, reason: "stale_epoch" });
        assert.deepEqual(await scalar("select renew_council_host_lease($1,$2,7,45) as value", [randomUUID(), f.host]), { ok: false, reason: "no_session" });
        await db.query("update council_host_leases set released_at=clock_timestamp() where session_id=$1", [f.session]);
        assert.deepEqual(await scalar("select renew_council_host_lease($1,$2,7,45) as value", [f.session, f.host]), { ok: false, reason: "lease_expired" });
        await db.query("update council_sessions set status='expired' where id=$1", [f.session]);
        assert.deepEqual(await scalar("select renew_council_host_lease($1,$2,7,45) as value", [f.session, f.host]), { ok: false, reason: "expired" });
    });

    await check("only the service role can renew a lease", async () => {
        for (const role of ["anon", "authenticated", "service_role"]) {
            assert.equal(await scalar("select has_function_privilege($1,'renew_council_host_lease(uuid,uuid,bigint,integer)','EXECUTE') as value", [role]), role === "service_role", role);
        }
    });
} finally {
    await db.close();
}

console.log(`\n${passed} passed, ${failed} failed (offline PGlite)`);
if (failed) process.exitCode = 1;
