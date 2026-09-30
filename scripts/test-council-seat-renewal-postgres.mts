import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === "--container", "Usage: tsx scripts/test-council-seat-renewal-postgres.mts --container council-seat-test-<suffix>");
const container = args[1];
assert.match(container, /^council-seat-test-[a-z0-9-]+$/, "Use an owned disposable seat-test container");
const database = `council_seat_${randomUUID().replaceAll("-", "")}`;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const digest = () => createHash("sha256").update(randomUUID()).digest("hex");
let passed = 0, failed = 0;

function command(argv: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn("docker", argv, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        let stdout = "", stderr = "";
        child.stdout.on("data", chunk => { stdout += String(chunk); });
        child.stderr.on("data", chunk => { stderr += String(chunk); });
        child.stdin.on("error", () => {});
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `docker exited ${code}`)));
        child.stdin.end(input);
    });
}
function psqlArgs(name = database): string[] {
    return ["exec", "-i", container, "psql", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", name];
}
const sql = (statement: string, name = database) => command(psqlArgs(name), `set statement_timeout='12s';\n${statement}\n`);
const json = async <T,>(statement: string): Promise<T> => JSON.parse(await sql(statement)) as T;
const service = (statement: string) => `set role service_role; ${statement}`;
async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]);
    } finally { clearTimeout(timer); }
}
async function check(name: string, run: () => Promise<void>) {
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unexpected failure"}`); }
}
async function waitFor(predicate: string) {
    const deadline = Date.now() + 6_000;
    while (await sql(predicate) !== "t") {
        assert(Date.now() < deadline, "Timed out waiting for the database clock or lock state");
        await delay(25);
    }
}
async function locked<T>(first: string, run: (release: () => Promise<void>) => Promise<T>): Promise<T> {
    const holder = spawn("docker", psqlArgs(), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "", errors = "", released = false;
    let readyResolve!: () => void;
    const ready = new Promise<void>(resolve => { readyResolve = resolve; });
    holder.stdout.on("data", chunk => { output += String(chunk); if (output.includes("holder_ready")) readyResolve(); });
    holder.stderr.on("data", chunk => { errors += String(chunk); });
    holder.stdin.on("error", () => {});
    const finished = new Promise<void>((resolve, reject) => {
        holder.on("error", reject);
        holder.on("close", code => code === 0 ? resolve() : reject(new Error(errors || `holder exited ${code}`)));
    });
    void finished.catch(() => {});
    const release = async () => {
        if (!released) { released = true; holder.stdin.end("commit;\n\\q\n"); }
        await finished;
    };
    holder.stdin.write(`set statement_timeout='12s'; set idle_in_transaction_session_timeout='15s'; begin; set local role service_role; ${first}\n\\echo holder_ready\n`);
    try {
        await bounded(Promise.race([ready, finished.then(() => { throw new Error("Lock holder exited before it was ready"); })]), 10_000, "Lock holder did not become ready");
        const result = await run(release);
        await release();
        return result;
    } finally {
        if (!released) holder.stdin.end("rollback;\n\\q\n");
        await finished;
    }
}
async function overlap(first: string, second: string, whileBlocked?: () => Promise<void>): Promise<string> {
    const tag = `seat_${randomUUID().replaceAll("-", "")}`;
    let waiter: Promise<string> | undefined;
    try {
        return await locked(first, async release => {
            waiter = sql(`set application_name=${quote(tag)}; ${service(second)}`);
            void waiter.catch(() => {});
            await waitFor(`select exists(select 1 from pg_stat_activity where datname=current_database() and application_name=${quote(tag)} and wait_event_type='Lock');`);
            if (whileBlocked) await whileBlocked();
            await release();
            return await waiter;
        });
    } finally { if (waiter) await Promise.allSettled([waiter]); }
}
async function fixture() {
    const session = randomUUID(), host = randomUUID(), token = digest();
    const whereSession = `session_id=${quote(session)}`;
    await sql(`insert into council_sessions(id,code,topic,closer_name,status,protocol_version) values(${quote(session)},${quote(session)},'Fixture','seat','closed',3);
        insert into council_participants(session_id,name,kind) values(${quote(session)},'seat','agent');
        insert into council_campaigns(session_id,repo_path,status) values(${quote(session)},'/fixture','running');
        insert into council_host_leases values(${quote(session)},${quote(host)},7,clock_timestamp()+interval '45 seconds',clock_timestamp(),clock_timestamp(),null);
        insert into council_seat_keys(session_id,seat_name,token_hash,expires_at,issued_by,host_id,lease_epoch) values(${quote(session)},'seat',${quote(token)},clock_timestamp()+interval '30 minutes','host',${quote(host)},7);`);
    return {
        session, host, token, whereSession,
        renew: `select public.renew_council_host_lease(${quote(session)},${quote(host)},7,45);`,
        resolve: (value = token) => `select public.resolve_council_seat_key(${quote(value)});`,
        replace: (value: string) => `select public.issue_council_seat_key(${quote(session)},'seat',${quote(value)},clock_timestamp()+interval '24 hours');`,
        revoke: `update council_seat_keys set revoked_at=clock_timestamp() where ${whereSession};`,
        lockKey: `select id from council_seat_keys where ${whereSession} for update;`,
        expiry: () => sql(`select extract(epoch from expires_at) from council_seat_keys where ${whereSession};`),
        leaseExpiry: () => sql(`select extract(epoch from lease_expires_at) from council_host_leases where ${whereSession};`),
    };
}

assert.equal(await command(["inspect", "--format", "{{.HostConfig.NetworkMode}}", container]), "none", "Test container must have no network");
const ports = await command(["inspect", "--format", "{{json .NetworkSettings.Ports}}", container]);
assert(ports === "{}" || ports === "null", "Test container must publish no ports");
await sql(`create database ${database};`, "postgres");
try {
    await sql(`do $$ begin
        if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
        if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
        if not exists(select from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
    end $$;
    create table user_profiles(id uuid primary key);`);
    const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
    for (const table of ["council_sessions", "council_participants", "council_campaigns", "council_host_leases", "council_seat_keys"]) {
        const ddl = setup.match(new RegExp(`create table if not exists ${table} \\([\\s\\S]*?\\n\\);`));
        assert(ddl, `Missing ${table}`);
        await sql(ddl[0]);
    }
    await sql(`alter table council_sessions add column protocol_version integer default 3, add column paused_at timestamptz;
        alter table council_campaigns add column integration_status text;
        alter table council_seat_keys add column issued_by text default 'owner', add column host_id uuid, add column lease_epoch bigint,
            add column execution_id uuid, add column execution_binding_required boolean not null default false;
        grant usage on schema public to anon,authenticated,service_role;
        grant all on all tables in schema public to service_role;`);
    for (const name of ["renew_council_host_lease", "resolve_council_seat_key", "issue_council_seat_key"]) {
        const functions = [...setup.matchAll(new RegExp(`create or replace function (?:public\\.)?${name}\\([\\s\\S]*?\\$\\$;`, "g"))];
        assert(functions.length, `Missing ${name}`);
        await sql(functions.at(-1)![0]);
    }
    const signatures = ["renew_council_host_lease(uuid,uuid,bigint,integer)", "issue_council_seat_key(uuid,text,text,timestamp with time zone)", "resolve_council_seat_key(text)"];
    const setupDefinitions = new Map<string, string>();
    for (const signature of signatures) setupDefinitions.set(signature, await sql(`select pg_get_functiondef(${quote(signature)}::regprocedure);`));
    const migration = await readFile(new URL("./migrations/council-seat-renewal.sql", import.meta.url), "utf8");
    await sql(migration);
    const renewalDefinitions = new Map<string, string>();
    for (const signature of signatures) renewalDefinitions.set(signature, await sql(`select pg_get_functiondef(${quote(signature)}::regprocedure);`));
    await sql(migration);
    await check("standalone renewal migration is mirrored and remains idempotent", async () => {
        assert(setup.includes(migration.trim()), "Setup must retain the standalone renewal migration");
        for (const signature of signatures) assert.equal(await sql(`select pg_get_functiondef(${quote(signature)}::regprocedure);`), renewalDefinitions.get(signature), signature);
    });
    const attribution = await readFile(new URL("./migrations/council-execution-attribution.sql", import.meta.url), "utf8");
    for (const name of ["resolve_council_seat_key", "issue_council_seat_key"]) {
        const functions = [...attribution.matchAll(new RegExp(`create or replace function (?:public\\.)?${name}\\([\\s\\S]*?\\$\\$;`, "g"))];
        assert.equal(functions.length, 1, `Expected one attribution override for ${name}`);
        await sql(functions[0][0]);
        await sql(functions[0][0]);
    }
    await check("ordered credential migrations match the final setup definitions", async () => {
        for (const signature of signatures) assert.equal(await sql(`select pg_get_functiondef(${quote(signature)}::regprocedure);`), setupDefinitions.get(signature), signature);
    });
    await check("repeat migration keeps renewal, reissue and resolution restricted to service role", async () => {
        for (const signature of signatures) {
            assert.equal(await sql(`select has_function_privilege('service_role',${quote(signature)},'EXECUTE');`), "t");
            for (const role of ["anon", "authenticated"]) assert.equal(await sql(`select has_function_privilege(${quote(role)},${quote(signature)},'EXECUTE');`), "f");
        }
    });
    await check("service-role heartbeat extends eligible identity with a bounded expiry", async () => {
        const f = await fixture();
        const before = await sql(`select to_jsonb(k)-'expires_at' from council_seat_keys k where ${f.whereSession};`);
        assert.equal((await json<{ ok: boolean }>(service(f.renew))).ok, true);
        assert.equal(await sql(`select to_jsonb(k)-'expires_at' from council_seat_keys k where ${f.whereSession};`), before);
        assert.equal(await sql(`select expires_at > clock_timestamp()+interval '23 hours 59 minutes' and expires_at <= clock_timestamp()+interval '24 hours' from council_seat_keys where ${f.whereSession};`), "t");
        assert.equal((await json<{ session_id: string }>(service(f.resolve()))).session_id, f.session);
    });
    await check("locked credential does not stall heartbeat and is eligible on the next heartbeat", async () => {
        const f = await fixture(), expiry = await f.expiry();
        await locked(f.lockKey, async () => {
            assert.equal((await json<{ ok: boolean }>(service(`set statement_timeout='1s'; ${f.renew}`))).ok, true);
            assert.equal(await f.expiry(), expiry);
        });
        await sql(service(f.renew));
        assert.notEqual(await f.expiry(), expiry);
    });
    await check("revocation holding a key lock cannot stall heartbeat or be undone by renewal", async () => {
        const f = await fixture(), expiry = await f.expiry();
        await locked(f.revoke, async () => {
            assert.equal((await json<{ ok: boolean }>(service(`set statement_timeout='1s'; ${f.renew}`))).ok, true);
        });
        assert.equal(await f.expiry(), expiry);
        assert.equal(await sql(service(f.resolve())), "");
        await sql(service(f.renew));
        assert.equal(await f.expiry(), expiry);
    });
    await check("owner replacement holding a key lock is never renewed as the previous host key", async () => {
        const f = await fixture(), replacement = digest();
        await locked(f.replace(replacement), async () => {
            assert.equal((await json<{ ok: boolean }>(service(`set statement_timeout='1s'; ${f.renew}`))).ok, true);
        });
        const expiry = await f.expiry();
        await sql(service(f.renew));
        assert.equal(await f.expiry(), expiry);
        assert.equal(await sql(service(f.resolve())), "");
        assert.equal((await json<{ session_id: string; issuer: string }>(service(f.resolve(replacement)))).issuer, "owner");
    });
    await check("key expiring while skipped remains expired on subsequent heartbeats", async () => {
        const f = await fixture();
        await sql(`update council_seat_keys set expires_at=clock_timestamp()+interval '2 seconds' where ${f.whereSession};`);
        const expiry = await f.expiry();
        await locked(f.lockKey, async () => {
            assert.equal((await json<{ ok: boolean }>(service(`set statement_timeout='1s'; ${f.renew}`))).ok, true);
            await waitFor(`select expires_at <= clock_timestamp() from council_seat_keys where ${f.whereSession};`);
        });
        await sql(service(f.renew));
        assert.equal(await f.expiry(), expiry);
        assert.equal(await sql(service(f.resolve())), "");
    });
    for (const row of ["session", "lease", "campaign"] as const) {
        await check(`lease expiring behind the ${row} lock cannot be revived`, async () => {
            const f = await fixture();
            await sql(`update council_host_leases set lease_expires_at=clock_timestamp()+interval '2 seconds' where ${f.whereSession};`);
            const expiry = await f.expiry(), leaseExpiry = await f.leaseExpiry();
            const lock = row === "session" ? `select id from council_sessions where id=${quote(f.session)} for update;`
                : `select session_id from council_${row === "lease" ? "host_leases" : "campaigns"} where ${f.whereSession} for update;`;
            const result = JSON.parse(await overlap(lock, f.renew, () => waitFor(`select lease_expires_at <= clock_timestamp() from council_host_leases where ${f.whereSession};`))) as { ok: boolean; reason: string };
            assert.equal(result.ok, false);
            assert.equal(result.reason, "lease_expired");
            assert.equal(await f.expiry(), expiry);
            assert.equal(await f.leaseExpiry(), leaseExpiry);
        });
    }
    await check("host takeover winning the lease lock fences the waiting heartbeat", async () => {
        const f = await fixture(), nextHost = randomUUID(), expiry = await f.expiry();
        const result = JSON.parse(await overlap(`update council_host_leases set host_id=${quote(nextHost)},lease_epoch=8 where ${f.whereSession};`, f.renew)) as { ok: boolean; reason: string };
        assert.equal(result.ok, false);
        assert.equal(result.reason, "stale_epoch");
        assert.equal(await f.expiry(), expiry);
        assert.equal(await sql(service(f.resolve())), "");
    });
    for (const transition of ["pause", "complete", "cancel"] as const) {
        await check(`${transition} committing before the heartbeat prevents credential extension`, async () => {
            const f = await fixture(), expiry = await f.expiry();
            const update = transition === "pause" ? `update council_sessions set paused_at=clock_timestamp() where id=${quote(f.session)};`
                : `update council_campaigns set status=${quote(transition === "cancel" ? "cancelled" : "complete")},integration_status='verified' where ${f.whereSession};`;
            assert.equal((JSON.parse(await overlap(update, f.renew)) as { ok: boolean }).ok, true);
            assert.equal(await f.expiry(), expiry);
            assert.equal((await json<{ ok: boolean }>(service(f.replace(digest())))).ok, false);
        });
    }
    await check("resolver waiting behind revocation cannot return the revoked identity", async () => {
        const f = await fixture();
        assert.equal(await overlap(f.revoke, f.resolve()), "");
        assert.equal(await sql(service(f.resolve())), "");
    });
    await check("resolver waiting behind replacement cannot return the previous identity", async () => {
        const f = await fixture(), replacement = digest();
        assert.equal(await overlap(f.replace(replacement), f.resolve()), "");
        assert.equal((await json<{ session_id: string }>(service(f.resolve(replacement)))).session_id, f.session);
    });
    for (const expiring of ["key", "lease"] as const) {
        await check(`resolver rechecks ${expiring} expiry after waiting for the credential lock`, async () => {
            const f = await fixture();
            const table = expiring === "key" ? "council_seat_keys" : "council_host_leases";
            const column = expiring === "key" ? "expires_at" : "lease_expires_at";
            await sql(`update ${table} set ${column}=clock_timestamp()+interval '2 seconds' where ${f.whereSession};`);
            assert.equal(await overlap(f.lockKey, f.resolve(), () => waitFor(`select ${column} <= clock_timestamp() from ${table} where ${f.whereSession};`)), "");
        });
    }
    for (const targetIssuer of ["owner", "host"] as const) {
        await check(`resolver refuses principal drift to ${targetIssuer} while waiting for the credential`, async () => {
            const f = await fixture();
            if (targetIssuer === "host") await sql(`update council_seat_keys set issued_by='owner',host_id=null,lease_epoch=null where ${f.whereSession};`);
            const identity = targetIssuer === "owner" ? "issued_by='owner',host_id=null,lease_epoch=null"
                : `issued_by='host',host_id=${quote(f.host)},lease_epoch=7`;
            assert.equal(await overlap(`update council_seat_keys set ${identity} where ${f.whereSession};`, f.resolve()), "");
            assert.equal((await json<{ issuer: string }>(service(f.resolve()))).issuer, targetIssuer);
        });
    }
    for (const transition of ["takeover", "release"] as const) {
        await check(`resolver waiting behind lease ${transition} cannot return the fenced identity`, async () => {
            const f = await fixture();
            const update = transition === "takeover" ? `host_id=${quote(randomUUID())},lease_epoch=8` : "released_at=clock_timestamp()";
            assert.equal(await overlap(`update council_host_leases set ${update} where ${f.whereSession};`, f.resolve()), "");
        });
    }
    await check("resolver waiting behind session expiry cannot return the expired identity", async () => {
        const f = await fixture();
        assert.equal(await overlap(`update council_sessions set status='expired' where id=${quote(f.session)};`, f.resolve()), "");
    });
    const version = await sql("show server_version;");
    console.log(`\n${passed} passed, ${failed} failed on disposable PostgreSQL ${version}; overlapping transactions, no hosted database.`);
    if (failed) process.exitCode = 1;
} finally {
    await sql(`drop database ${database} with (force);`, "postgres");
}
