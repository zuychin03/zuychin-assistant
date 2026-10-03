import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const marker = "-- ===== Council execution policy version =====";
const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
const baseline = setup.split("-- ===== Council execution attribution =====")[0];
const attribution = await readFile(new URL("./migrations/council-execution-attribution.sql", import.meta.url), "utf8");
const migration = await readFile(new URL("./migrations/council-execution-policy.sql", import.meta.url), "utf8").catch(() => "");
const policy = "typescript-node-v3-2026-09-30";
const base = "a".repeat(40);
type Result = { ok: boolean; reason?: string; executionId?: string; seatBound?: boolean; policyVersion?: string; hostGeneration?: string };

function baselineFunction(name: string): string {
    const entries = [...baseline.matchAll(new RegExp(`create or replace function (?:public\\.)?${name}\\([\\s\\S]*?\\$\\$;`, "g"))];
    assert(entries.length, name);
    return entries.at(-1)![0];
}

for (const [label, sql] of [["migration", migration], ["setup", setup.includes(marker) ? setup.slice(setup.indexOf(marker)) : ""]]) {
    await test(`${label}: execution policy boundary`, async t => {
        const db = new PGlite();
        t.after(() => db.close());
        await db.exec("create role anon; create role authenticated; create role service_role; create table user_profiles(id uuid primary key); create table agent_clients(id uuid primary key)");
        for (const ddl of baseline.matchAll(/create table if not exists council_[a-z_]+ \([\s\S]*?\n\);/g)) await db.exec(ddl[0]);
        for (const ddl of baseline.matchAll(/alter table council_[a-z_]+\b[\s\S]*?;/g)) await db.exec(ddl[0]);
        for (const name of ["append_council_message", "complete_council_work_item", "issue_council_seat_key", "issue_council_host_seat_key", "resolve_council_seat_key", "start_council_agent_execution", "stop_council_agent_execution", "record_council_verification", "review_council_work_item", "freeze_council_integration_manifest", "renew_council_host_lease", "join_council", "claim_council_work_item", "block_council_work_item"]) await db.exec(baselineFunction(name));
        await db.exec(attribution);
        if (sql) await db.exec(sql);
        const value = async <T,>(query: string, params: unknown[] = []): Promise<T> =>
            (await db.query<{ value: T }>(query, params)).rows[0]?.value;

        await t.test("versioned start exists with a single service-role-only signature", async () => {
            const name = "start_council_versioned_bound_execution";
            assert.equal(await value("select count(*)::int as value from pg_proc where proname=$1", [name]), 1);
            for (const role of ["anon", "authenticated"]) assert.equal(await value("select has_function_privilege($1,oid,'execute') as value from pg_proc where proname=$2", [role, name]), false);
            assert.equal(await value("select has_function_privilege('service_role',oid,'execute') as value from pg_proc where proname=$1", [name]), true);
        });
        if (!sql) return;

        async function fixture() {
            const session = randomUUID(), host = randomUUID();
            let token = randomUUID().replaceAll("-", "").repeat(2);
            await db.query("insert into council_sessions(id,code,topic,closer_name,protocol_version,base_sha,max_messages) values($1::uuid,$1::text,'Synthetic policy','closer',3,$2,1000)", [session, base]);
            await db.query("insert into council_participants(session_id,name,status) values($1,'seat','active'),($1,'other','active')", [session]);
            await db.query("insert into council_host_leases values($1,$2,1,clock_timestamp()+interval '1 hour',clock_timestamp(),clock_timestamp(),null)", [session, host]);
            const issue = async (seat = "seat") => {
                token = randomUUID().replaceAll("-", "").repeat(2);
                assert.equal((await value<Result>("select issue_council_bound_host_seat_key($1,$2,$3,clock_timestamp()+interval '1 day',$4,1) as value", [session, seat, token, host])).ok, true);
                return token;
            };
            const start = (options: { version?: string | null; generation?: string; seat?: string; epoch?: number; hash?: string } = {}) => {
                const { version = policy, generation = "typescript-node", seat = "seat", epoch = 1, hash = token } = options;
                const versioned = version !== null;
                return value<Result>(`select ${versioned ? "start_council_versioned_bound_execution" : "start_council_bound_agent_execution"}($1,$2,$3,$4,$5,'acp','{}','configured','verified_seat','fixture',null,null,null,null,null,'unknown','council/fixture','synthetic',$6,$7${versioned ? ",$8" : ""}) as value`, [session, seat, host, epoch, generation, base, hash, ...(versioned ? [version] : [])]);
            };
            const sessionRow = () => value<Record<string, unknown>>("select to_jsonb(s) as value from council_sessions s where id=$1", [session]);
            const executions = () => value<Record<string, unknown>[]>("select coalesce(jsonb_agg(e order by e.started_at,e.id),'[]') as value from council_agent_executions e where session_id=$1", [session]);
            await issue();
            return { session, host, issue, start, sessionRow, executions };
        }

        await t.test("first version-aware run pins session and exact execution facts", async () => {
            const f = await fixture(), result = await f.start();
            assert.equal(result.ok, true);
            assert.equal(result.seatBound, true);
            assert.equal(result.policyVersion, policy);
            assert.equal(result.hostGeneration, "typescript-node");
            const session = await f.sessionRow(), [execution] = await f.executions();
            assert.equal(session.policy_version, policy);
            assert.equal(session.host_generation, "typescript-node");
            assert.equal(execution.policy_version, policy);
            const evidence = await value<Record<string, unknown>>("select council_execution_evidence($1,$2,'seat') as value", [result.executionId, f.session]);
            assert.equal(evidence.policyVersion, policy);
            assert.equal(evidence.hostGeneration, "typescript-node");
        });
        await t.test("legacy runs remain explicitly unknown", async () => {
            const f = await fixture();
            assert.equal((await f.start({ version: null })).ok, true);
            assert.equal((await f.sessionRow()).policy_version, null);
            assert.equal((await f.executions())[0].policy_version, null);
        });
        await t.test("prior unversioned history cannot be adopted in place", async () => {
            const f = await fixture();
            const first = await f.start({ version: null });
            await db.query("select stop_council_agent_execution($1,$2,1,'fixture complete')", [first.executionId, f.host]);
            await f.issue();
            assert.equal((await f.start()).reason, "unknown_execution_policy");
            assert.equal((await f.executions()).length, 1);
            assert.equal((await f.sessionRow()).policy_version, null);
        });
        await t.test("matching replacement preserves immutable predecessor policy", async () => {
            const f = await fixture(), first = await f.start();
            await f.issue();
            const next = await f.start();
            assert.equal(next.ok, true);
            const records = await f.executions();
            assert.equal(records.length, 2);
            assert.equal(records[1].predecessor_execution_id, first.executionId);
            assert.equal(records[0].policy_version, policy);
            assert.equal(records[1].policy_version, policy);
            assert(records[0].ended_at);
        });
        await t.test("pinned session rejects legacy downgrade without ending the existing run", async () => {
            const f = await fixture(); await f.start(); await f.issue();
            assert.equal((await f.start({ version: null })).reason, "execution_policy_mismatch");
            const records = await f.executions();
            assert.equal(records.length, 1);
            assert.equal(records[0].ended_at, null);
        });
        await t.test("same-policy replacement cannot switch host generation", async () => {
            const f = await fixture(); await f.start(); await f.issue();
            assert.equal((await f.start({ generation: "rust" })).reason, "execution_policy_mismatch");
            assert.equal((await f.executions()).length, 1);
        });
        await t.test("unknown policy never pins or starts a run", async () => {
            const f = await fixture();
            assert.equal((await f.start({ version: "future-policy" })).reason, "unsupported_policy_version");
            assert.equal((await f.sessionRow()).policy_version, null);
            assert.equal((await f.executions()).length, 0);
        });
        await t.test("known Node policy rejects an incompatible first generation", async () => {
            const f = await fixture();
            assert.equal((await f.start({ generation: "rust" })).reason, "unsupported_policy_version");
            assert.equal((await f.executions()).length, 0);
        });
        await t.test("stale lease and invalid credentials cannot pin a session", async () => {
            const f = await fixture();
            assert.equal((await f.start({ epoch: 2 })).reason, "stale_host");
            assert.equal((await f.start({ hash: "f".repeat(64) })).reason, "invalid_credential");
            assert.equal((await f.sessionRow()).policy_version, null);
            assert.equal((await f.executions()).length, 0);
        });
        await t.test("session pin and execution policy cannot be rewritten or cleared", async () => {
            const f = await fixture(), result = await f.start();
            for (const field of ["policy_version", "host_generation"]) {
                await assert.rejects(db.query(`update council_sessions set ${field}=null where id=$1`, [f.session]));
                await assert.rejects(db.query(`update council_sessions set ${field}='different' where id=$1`, [f.session]));
            }
            await assert.rejects(db.query("update council_agent_executions set policy_version=null where id=$1", [result.executionId]));
            assert.equal(await value("select stop_council_agent_execution($1,$2,1,'normal end') as value", [result.executionId, f.host]), true);
        });
        await t.test("partial policy pins are rejected even before the first run", async () => {
            const f = await fixture();
            await assert.rejects(db.query("update council_sessions set host_generation='typescript-node' where id=$1", [f.session]));
            await assert.rejects(db.query("update council_sessions set policy_version=$2 where id=$1", [f.session, policy]));
            assert.equal((await f.sessionRow()).policy_version, null);
        });
        await t.test("other roster seats inherit the pinned version", async () => {
            const f = await fixture(); await f.start(); await f.issue("other");
            assert.equal((await f.start({ seat: "other" })).ok, true);
            assert.equal((await f.executions()).length, 2);
        });
        await t.test("duplicate binding cannot create another execution", async () => {
            const f = await fixture(); await f.start();
            assert.equal((await f.start()).reason, "execution_already_bound");
            assert.equal((await f.executions()).length, 1);
        });
        await t.test("legacy unbound RPC also refuses a pinned Council", async () => {
            const f = await fixture(); await f.start();
            const result = await value<Result>("select start_council_agent_execution($1,'other',$2,1,'typescript-node','acp','{}','configured','host_bound','fixture',null,null,null,null,null,'unknown','council/fixture','synthetic',$3) as value", [f.session, f.host, base]);
            assert.equal(result.reason, "execution_policy_mismatch");
            assert.equal((await f.executions()).length, 1);
        });
        await t.test("new internal helpers remain unavailable to public client roles", async () => {
            for (const name of ["council_start_policy_execution_record", "council_start_bound_policy_execution"]) {
                assert.equal(await value("select count(*)::int as value from pg_proc where proname=$1", [name]), 1);
                for (const role of ["anon", "authenticated"]) assert.equal(await value("select has_function_privilege($1,oid,'execute') as value from pg_proc where proname=$2", [role, name]), false);
            }
        });
        await t.test("fenced boundary distinguishes fresh, historical and pinned Councils", async () => {
            const f = await fixture();
            const boundary = () => value<Record<string, unknown>>("select get_council_execution_boundary($1,$2,1) as value", [f.session, f.host]);
            assert.deepEqual(await boundary(), { ok: true, hostGeneration: null, policyVersion: null, hasExecutionHistory: false });
            await f.start();
            assert.deepEqual(await boundary(), { ok: true, hostGeneration: "typescript-node", policyVersion: policy, hasExecutionHistory: true });
            const legacy = await fixture(); await legacy.start({ version: null });
            assert.deepEqual(await value("select get_council_execution_boundary($1,$2,1) as value", [legacy.session, legacy.host]), { ok: true, hostGeneration: null, policyVersion: null, hasExecutionHistory: true });
        });
        await t.test("boundary read refuses stale host without disclosing runtime facts", async () => {
            const f = await fixture(); await f.start();
            assert.deepEqual(await value("select get_council_execution_boundary($1,$2,2) as value", [f.session, f.host]), { ok: false, reason: "stale_host" });
            assert.deepEqual(await value("select get_council_execution_boundary($1,$2,1) as value", [f.session, randomUUID()]), { ok: false, reason: "stale_host" });
            for (const role of ["anon", "authenticated"]) assert.equal(await value("select has_function_privilege($1,oid,'execute') as value from pg_proc where proname='get_council_execution_boundary'", [role]), false);
        });
    });
}

test("incremental policy migration is mirrored exactly in setup SQL", () => {
    assert(migration.trim().length > 0);
    assert(setup.includes(migration.trim()));
});
