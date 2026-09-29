import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === "--container", "Usage: tsx scripts/test-agent-claim-postgres.mts --container council-claims-test-<suffix>");
const container = args[1];
assert.match(container, /^council-claims-test-[a-z0-9-]+$/, "Use an owned disposable claim-test container");
const database = `agent_claims_${randomUUID().replaceAll("-", "")}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
let passed = 0;
let failed = 0;

function command(argv: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn("docker", argv, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        let stdout = "", stderr = "";
        child.stdout.on("data", chunk => { stdout += String(chunk); });
        child.stderr.on("data", chunk => { stderr += String(chunk); });
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `docker exited ${code}`)));
        child.stdin.end(input);
    });
}
function psqlArgs(name = database): string[] {
    return ["exec", "-i", container, "psql", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", name];
}
const sql = (statement: string, name = database) => command(psqlArgs(name), `set statement_timeout='10s';\n${statement}\n`);
const json = async <T,>(statement: string): Promise<T> => JSON.parse(await sql(statement)) as T;
const mint = (id: string, digest: string) => `select public.mint_agent_claim(${quote(id)},${quote(digest)},array['knowledge:read'],'read',now()+interval '15 minutes');`;
const exchange = (digest: string) => `select public.exchange_agent_claim(${quote(digest)},${quote(hash(`key:${digest}`))},'zck_');`;
const revoke = (id: string) => `select public.revoke_agent_client(${quote(id)});`;
const resolve = (digest: string) => `select public.resolve_agent_client_key(${quote(hash(`key:${digest}`))});`;
const client = async () => sql(`insert into public.agent_clients(display_name) values (${quote(`zz-test-${randomUUID()}`)}) returning id;`);
async function check(name: string, run: () => Promise<void>) {
    try {
        await run();
        passed++;
        console.log(`PASS ${name}`);
    } catch (error) {
        failed++;
        console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unexpected failure"}`);
    }
}
async function overlap(first: string, second: string, holdMs = 0): Promise<string> {
    const tag = `claims_${randomUUID().replaceAll("-", "")}`;
    const holder = spawn("docker", psqlArgs(), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "", errors = "";
    let readyResolve!: () => void;
    const ready = new Promise<void>(resolveReady => { readyResolve = resolveReady; });
    holder.stdout.on("data", chunk => { output += String(chunk); if (output.includes("holder_ready")) readyResolve(); });
    holder.stderr.on("data", chunk => { errors += String(chunk); });
    const finished = new Promise<void>((resolveDone, reject) => {
        holder.on("error", reject);
        holder.on("close", code => code === 0 ? resolveDone() : reject(new Error(errors || `holder exited ${code}`)));
    });
    holder.stdin.write(`set statement_timeout='10s'; set idle_in_transaction_session_timeout='15s'; begin; set local role service_role; ${first}\n\\echo holder_ready\n`);
    const waiterResults: Promise<string>[] = [];
    try {
        await Promise.race([ready, finished.then(() => { throw new Error("Holder exited before acquiring its lock"); })]);
        const waiter = sql(`set application_name=${quote(tag)}; set role service_role; ${second}`);
        void waiter.catch(() => {});
        waiterResults.push(waiter);
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            const count = await sql(`select count(*) from pg_stat_activity where datname=current_database() and application_name=${quote(tag)} and wait_event_type='Lock';`);
            if (count === "1") { blocked = true; break; }
            await delay(20);
        }
        assert(blocked, "Second transaction must demonstrably block on the held client row");
        if (holdMs) await delay(holdMs);
        holder.stdin.end("commit;\n\\q\n");
        await finished;
        return await waiter;
    } finally {
        if (!holder.stdin.writableEnded) holder.stdin.end("rollback;\n\\q\n");
        await Promise.allSettled([finished, ...waiterResults]);
    }
}

const network = await command(["inspect", "--format", "{{.HostConfig.NetworkMode}}", container]);
assert.equal(network, "none", "Test container must have no network");
const ports = await command(["inspect", "--format", "{{json .NetworkSettings.Ports}}", container]);
assert(ports === "{}" || ports === "null", "Test container must publish no ports");
await sql(`create database ${database};`, "postgres");
try {
    await sql(`do $$ begin
        if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
        if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
        if not exists(select from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
    end $$;
    grant usage on schema public to anon,authenticated,service_role;
    create table council_sessions(id uuid primary key);
    create table council_seat_keys(id uuid primary key);`);
    const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
    const wave = setup.slice(setup.indexOf("-- ===== Council V3.5 wave:"), setup.indexOf("-- V6 assistant features"));
    assert(wave.startsWith("-- ===== Council V3.5 wave:"));
    const migration = await readFile(new URL("./migrations/council-agent-claims.sql", import.meta.url), "utf8");
    await sql(wave);
    await sql(migration);
    await check("fresh migration supports service-role lifecycle", async () => {
        const id = await client(), digest = hash(randomUUID());
        assert.equal((await json<{ ok: boolean }>(`set role service_role; ${mint(id, digest)}`)).ok, true);
        assert.equal((await json<{ ok: boolean }>(`set role service_role; ${exchange(digest)}`)).ok, true);
        assert.equal((await json<{ client_id: string }>(`set role service_role; ${resolve(digest)}`)).client_id, id);
        await sql(`set role service_role; ${revoke(id)}`);
    });
    await sql("grant all on all tables in schema public to anon,authenticated; grant all on all sequences in schema public to anon,authenticated; grant execute on all functions in schema public to public;");
    await sql(migration);
    await sql(migration);
    await check("repeat migration removes legacy grants, enables RLS and keeps RPCs invoker-only", async () => {
        const tables = "'agent_clients','agent_client_keys','agent_client_claims','agent_claim_attempts'";
        assert.equal(await sql(`select count(*) from pg_class where relnamespace='public'::regnamespace and relname in (${tables}) and relrowsecurity;`), "4");
        assert.equal(await sql("select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('mint_agent_claim','exchange_agent_claim','revoke_agent_client','resolve_agent_client_key','begin_agent_claim_attempt','finish_agent_claim_attempt') and not prosecdef and proconfig @> array['search_path=public, pg_temp'];"), "6");
        for (const role of ["anon", "authenticated"]) {
            for (const table of ["agent_clients", "agent_client_keys", "agent_client_claims", "agent_claim_attempts"]) {
                for (const statement of [`select * from ${table}`, `insert into ${table} default values`, `update ${table} set ${table === "agent_claim_attempts" ? "succeeded=false" : "revoked_at=now()"}`, `delete from ${table}`]) {
                    await assert.rejects(sql(`set role ${role}; ${statement};`), /permission denied/);
                }
            }
            const id = await client(), digest = hash(randomUUID());
            for (const statement of [mint(id, digest), exchange(digest), revoke(id), resolve(digest), "select begin_agent_claim_attempt('fixture');", "select finish_agent_claim_attempt(1,true);", "select nextval('agent_claim_attempts_id_seq');"]) {
                await assert.rejects(sql(`set role ${role}; ${statement}`), /permission denied/);
            }
        }
    });

    await check("two overlapping mints both finish and leave exactly one exchangeable pending claim", async () => {
        const id = await client(), prior = hash(randomUUID()), first = hash(randomUUID()), last = hash(randomUUID());
        await sql(mint(id, prior));
        assert.equal(JSON.parse(await overlap(mint(id, first), mint(id, last))).ok, true);
        assert.equal(await sql(`select count(*) from agent_client_claims where client_id=${quote(id)} and revoked_at is null and claimed_at is null;`), "1");
        assert.equal((await json<{ ok: boolean }>(exchange(prior))).ok, false);
        assert.equal((await json<{ ok: boolean }>(exchange(first))).ok, false);
        assert.equal((await json<{ ok: boolean }>(exchange(last))).ok, true);
    });

    for (const revokeFirst of [false, true]) {
        await check(`mint/revoke overlap with ${revokeFirst ? "revoke" : "mint"} holding the lock leaves no live claim`, async () => {
            const id = await client(), digest = hash(randomUUID());
            const outcome = JSON.parse(await overlap(revokeFirst ? revoke(id) : mint(id, digest), revokeFirst ? mint(id, digest) : revoke(id)));
            assert.equal(outcome.ok, !revokeFirst);
            assert.equal(await sql(`select count(*) from agent_client_claims where client_id=${quote(id)} and revoked_at is null;`), "0");
            assert.equal((await json<{ ok: boolean }>(exchange(digest))).ok, false);
        });
        await check(`exchange/revoke overlap with ${revokeFirst ? "revoke" : "exchange"} holding the lock leaves no live key`, async () => {
            const id = await client(), digest = hash(randomUUID());
            await sql(mint(id, digest));
            const outcome = JSON.parse(await overlap(revokeFirst ? revoke(id) : exchange(digest), revokeFirst ? exchange(digest) : revoke(id)));
            assert.equal(outcome.ok, !revokeFirst);
            assert.equal(await sql(`select count(*) from agent_client_keys where client_id=${quote(id)} and revoked_at is null;`), "0");
            assert.equal(await sql(resolve(digest)), "");
        });
        await check(`resolve/revoke overlap with ${revokeFirst ? "revoke" : "resolve"} holding the lock has no deadlock or surviving identity`, async () => {
            const id = await client(), digest = hash(randomUUID());
            await sql(mint(id, digest)); await sql(exchange(digest));
            const result = await overlap(revokeFirst ? revoke(id) : resolve(digest), revokeFirst ? resolve(digest) : revoke(id));
            if (revokeFirst) assert.equal(result, "");
            assert.equal(await sql(resolve(digest)), "");
        });
    }

    await check("exchange waiting behind claim replacement cannot exchange the retired claim", async () => {
        const id = await client(), old = hash(randomUUID()), next = hash(randomUUID());
        await sql(mint(id, old));
        assert.equal(JSON.parse(await overlap(mint(id, next), exchange(old))).ok, false);
        assert.equal((await json<{ ok: boolean }>(exchange(next))).ok, true);
    });
    await check("mint waiting behind exchange preserves the claimed retry until the next key is issued", async () => {
        const id = await client(), old = hash(randomUUID()), next = hash(randomUUID());
        await sql(mint(id, old));
        assert.equal(JSON.parse(await overlap(exchange(old), mint(id, next))).ok, true);
        assert.equal((await json<{ ok: boolean }>(exchange(old))).ok, true);
        assert.equal((await json<{ ok: boolean }>(exchange(next))).ok, true);
        assert.equal((await json<{ ok: boolean }>(exchange(old))).ok, false);
    });
    await check("a real insert constraint failure rolls back old-claim revocation", async () => {
        const id = await client(), digest = hash(randomUUID());
        await sql(mint(id, digest));
        await assert.rejects(sql(mint(id, digest)), /duplicate key/);
        assert.equal((await json<{ ok: boolean }>(exchange(digest))).ok, true);
    });
    await check("exchange refuses a claim that expires while waiting for its client lock", async () => {
        const id = await client(), digest = hash(randomUUID());
        await sql(mint(id, digest));
        await sql(`update agent_client_claims set expires_at=now()+interval '2 seconds' where client_id=${quote(id)};`);
        const result = await overlap(`select id from agent_clients where id=${quote(id)} for update;`, exchange(digest), 2_100);
        assert.equal(JSON.parse(result).ok, false);
    });
    await check("resolve refuses a key that expires while waiting for its client lock", async () => {
        const id = await client(), digest = hash(randomUUID());
        await sql(mint(id, digest)); await sql(exchange(digest));
        await sql(`update agent_client_keys set expires_at=now()+interval '2 seconds' where client_id=${quote(id)};`);
        const result = await overlap(`select id from agent_clients where id=${quote(id)} for update;`, resolve(digest), 2_100);
        assert.equal(result, "");
    });
    await check("mint refuses an expiry that elapses while waiting for its client lock", async () => {
        const id = await client(), digest = hash(randomUUID());
        const shortMint = mint(id, digest).replace("interval '15 minutes'", "interval '2 seconds'");
        const result = await overlap(`select id from agent_clients where id=${quote(id)} for update;`, shortMint, 2_100);
        assert.equal(JSON.parse(result).ok, false);
        assert.equal(await sql(`select count(*) from agent_client_claims where client_id=${quote(id)};`), "0");
    });
    await check("service-role direct CRUD and rate-limit sequence still work after upgrade", async () => {
        const id = randomUUID();
        await sql(`set role service_role; insert into agent_clients(id,display_name) values (${quote(id)},'service-fixture'); update agent_clients set note='fixture' where id=${quote(id)};`);
        assert.equal(await sql(`set role service_role; select note from agent_clients where id=${quote(id)};`), "fixture");
        const attempt = await json<{ attempt_id: number }>("set role service_role; select begin_agent_claim_attempt('fixture-ip');");
        await sql(`set role service_role; select finish_agent_claim_attempt(${attempt.attempt_id},true);`);
        assert.equal(await sql(`set role service_role; select succeeded from agent_claim_attempts where id=${attempt.attempt_id};`), "t");
        await sql(`set role service_role; delete from agent_clients where id=${quote(id)}; delete from agent_claim_attempts where id=${attempt.attempt_id};`);
    });
    const version = await sql("show server_version;");
    console.log(`\n${passed} passed, ${failed} failed on disposable PostgreSQL ${version}; genuine overlapping transactions, no hosted database.`);
    if (failed) process.exitCode = 1;
} finally {
    await sql(`drop database ${database} with (force);`, "postgres");
}
