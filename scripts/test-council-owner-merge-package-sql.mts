import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const marker = "-- ===== Council owner merge package =====";
const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
const baseline = setup.split(marker)[0];
const attribution = await readFile(new URL("./migrations/council-execution-attribution.sql", import.meta.url), "utf8");
const migration = await readFile(new URL("./migrations/council-owner-merge-package.sql", import.meta.url), "utf8").catch(() => "");
const baselineOnly = process.env.COUNCIL_OWNER_PACKAGE_BASELINE === "1";
const base = "b".repeat(40), tip = "a".repeat(40), branch = "council/synthetic/integration";
type Attempt = { id: string; sessionId: string; campaignId: string; attemptNumber: number; mode: string; integratorAgent: string | null; manifestHash: string; manifest: Record<string, unknown>; decision: string | null; openQuestions: string[]; status: string };
type Result = { ok: boolean; reason?: string; attempt?: Attempt; attemptId?: string; executionId?: string };

function lastFunction(name: string) {
    const matches = [...baseline.matchAll(new RegExp(`create or replace function (?:public\\.)?${name}\\([\\s\\S]*?\\$\\$;`, "g"))];
    assert(matches.length, `Missing ${name}`);
    return matches.at(-1)![0];
}

for (const [source, sql] of baselineOnly ? [["baseline", ""]] : [["migration", migration], ["setup", setup.includes(marker) ? setup.slice(setup.indexOf(marker)) : ""]]) {
    await test(`${source}: owner merge package`, async t => {
        const db = new PGlite(); t.after(() => db.close());
        await db.exec("create role anon; create role authenticated; create role service_role; create table user_profiles(id uuid primary key); create table agent_clients(id uuid primary key)");
        for (const ddl of baseline.matchAll(/create table if not exists council_[a-z_]+ \([\s\S]*?\n\);/g)) await db.exec(ddl[0]);
        for (const ddl of baseline.matchAll(/alter table council_[a-z_]+\b[\s\S]*?;/g)) await db.exec(ddl[0]);
        await db.exec(attribution);
        for (const name of ["record_council_integration_v3", "set_campaign_integrator"]) await db.exec(lastFunction(name));
        if (sql) await db.exec(sql);
        const value = async <T = unknown,>(query: string, params: unknown[] = []): Promise<T> => (await db.query<{ value: T }>(query, params)).rows[0]?.value;
        const row = (id: string) => value<Record<string, unknown>>("select to_jsonb(r) as value from council_integration_attempts r where id=$1", [id]);
        async function fixture(integrator: string | null = null) {
            const session = randomUUID(), host = randomUUID(), campaign = randomUUID(), item = randomUUID(), run = randomUUID();
            const manifest = { version: 1, campaignId: campaign, baseSha: base, items: [{ itemId: item, sequence: 1, agentName: "seat", branch: "council/synthetic/seat", commitSha: tip, verificationRunId: run, dependencies: [], acceptedExecutionId: null, executionEvidence: null }] };
            await db.query("insert into council_sessions(id,code,topic,closer_name,status,protocol_version,base_sha,verdict,open_questions) values($1::uuid,$1::text,'Synthetic package','seat','closed',3,$2,'Decision','[\"Still open\"]')", [session, base]);
            await db.query("insert into council_participants(session_id,name,status) values($1,'seat','active'),($1,'other','active')", [session]);
            await db.query("insert into council_host_leases values($1,$2,1,clock_timestamp()+interval '1 hour',clock_timestamp(),clock_timestamp(),null)", [session, host]);
            await db.query("insert into council_campaigns(id,session_id,status,repo_path,base_branch,base_sha,integration_manifest,integrator_agent) values($1,$2,'complete','synthetic','main',$3,$4,$5)", [campaign, session, base, manifest, integrator]);
            const begin = (id: string = randomUUID(), epoch = 1, expected = integrator, hostId = host) => value<Result>("select begin_council_integration_attempt($1,$2,$3,$4,$5) as value", [session, hostId, epoch, id, expected]);
            const finish = (id: string, evidence = goodEvidence(), status = "verified", execution: string | null = null, resultBranch: string | null = branch, resultTip: string | null = tip, epoch = 1, hostId = host) => value<Result>("select finalize_council_integration_attempt($1,$2,$3,$4,$5,$6,$7,$8) as value", [id, hostId, epoch, status, resultBranch, resultTip, execution, evidence]);
            const execute = async (seat = "seat", executionBranch = branch, bound = true) => {
                const hash = randomUUID().replaceAll("-", "").repeat(2);
                if (bound) assert.equal((await value<Result>("select issue_council_bound_host_seat_key($1,$2,$3,clock_timestamp()+interval '1 day',$4,1) as value", [session, seat, hash, host])).ok, true);
                const result = await value<Result>(`select ${bound ? "start_council_bound_agent_execution" : "start_council_agent_execution"}($1,$2,$3,1,'generation','acp','{}','probed','host_bound','provider','adapter','requested','effective',null,null,'adapter_config',$4,'private',$5${bound ? ",$6" : ""}) as value`, [session, seat, host, executionBranch, base, ...(bound ? [hash] : [])]);
                assert.equal(result.ok, true); assert(result.executionId); return result.executionId;
            };
            const legacy = () => value<Result>("select record_council_integration_v3($1,'host',$2,1,'verified','legacy',$3,'legacy report') as value", [session, host, tip]);
            return { session, host, campaign, manifest, begin, finish, execute, legacy };
        }
        function goodEvidence() {
            return { version: 1, redactionVersion: 1, receipts: [{ command: ["npm", "test"], exitCode: 0, durationMs: 10, outputDigest: "d".repeat(64), outputTail: "passed", timedOut: false }], changedPaths: ["src/file.ts"], diffSummary: "1 file changed", protectedRefs: { before: { main: base }, after: { main: base } }, conflictNotes: null, manualChecks: null };
        }
        await t.test("immutable integration history and RPCs exist", async () => {
            assert.equal(await value("select count(*)::int as value from pg_class where relname='council_integration_attempts'"), 1);
            for (const name of ["begin_council_integration_attempt", "finalize_council_integration_attempt"]) assert.equal(await value("select count(*)::int as value from pg_proc where proname=$1", [name]), 1);
        });
        if (!sql) return;
        await t.test("begin captures immutable manifest and decision with a database digest", async () => {
            const f = await fixture(), a = (await f.begin()).attempt!;
            assert.equal(a.attemptNumber, 1); assert.equal(a.mode, "host"); assert.equal(a.integratorAgent, null);
            assert.deepEqual(a.manifest, f.manifest); assert.equal(a.decision, "Decision"); assert.deepEqual(a.openQuestions, ["Still open"]);
            assert.equal(a.manifestHash, await value("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') as value", [f.manifest]));
            await db.query("update council_sessions set verdict='changed',open_questions='[]' where id=$1", [f.session]);
            assert.equal((await row(a.id)).decision, "Decision");
            assert.deepEqual((await f.begin(a.id)).attempt, a);
        });
        await t.test("same-fence concurrent attempt and reused foreign ID are rejected", async () => {
            const f = await fixture(), a = (await f.begin()).attempt!, other = await fixture();
            assert.equal((await f.begin()).ok, false); assert.equal((await other.begin(a.id)).ok, false);
            assert.equal(await value("select count(*)::int as value from council_integration_attempts where campaign_id=$1", [f.campaign]), 1);
        });
        for (const fault of ["host", "epoch", "expired", "released", "incomplete", "manifest", "nomination"]) await t.test(`begin rejects ${fault}`, async () => {
            const f = await fixture();
            if (fault === "expired") await db.query("update council_host_leases set lease_expires_at=clock_timestamp()-interval '1 second' where session_id=$1", [f.session]);
            if (fault === "released") await db.query("update council_host_leases set released_at=clock_timestamp() where session_id=$1", [f.session]);
            if (fault === "incomplete") await db.query("update council_campaigns set status='running' where id=$1", [f.campaign]);
            if (fault === "manifest") await db.query("update council_campaigns set integration_manifest=null where id=$1", [f.campaign]);
            assert.equal((await f.begin(randomUUID(), fault === "epoch" ? 2 : 1, fault === "nomination" ? "seat" : null, fault === "host" ? randomUUID() : f.host)).ok, false);
        });
        await t.test("verified finalisation is durable, idempotent and immutable", async () => {
            const f = await fixture(), a = (await f.begin()).attempt!, evidence = goodEvidence();
            assert.equal((await f.finish(a.id, evidence)).ok, true); const original = await row(a.id);
            assert.equal((await f.finish(a.id, evidence)).ok, true); assert.deepEqual(await row(a.id), original);
            evidence.diffSummary = "different"; assert.equal((await f.finish(a.id, evidence)).ok, false);
            await assert.rejects(db.query("update council_integration_attempts set tip_sha=$2 where id=$1", [a.id, base]), /immutable/i);
            await assert.rejects(db.query("delete from council_integration_attempts where id=$1", [a.id]), /immutable/i);
            assert.equal(original.status, "verified"); assert.equal(original.tip_sha, tip); assert.match(String(original.result_digest), /^[a-f0-9]{64}$/);
        });
        await t.test("running captured facts cannot be changed", async () => {
            const f = await fixture(), a = (await f.begin()).attempt!;
            await assert.rejects(db.query("update council_integration_attempts set manifest='{}' where id=$1", [a.id]), /immutable/i);
            await assert.rejects(db.query("update council_integration_attempts set started_at=clock_timestamp() where id=$1", [a.id]), /immutable/i);
        });
        await t.test("later attempts preserve all earlier terminal results", async () => {
            const f = await fixture(), first = (await f.begin()).attempt!; await f.finish(first.id); const original = await row(first.id);
            const second = (await f.begin()).attempt!; assert.equal(second.attemptNumber, 2); assert.equal((await f.finish(second.id, goodEvidence(), "failed", null, null, null)).ok, true);
            assert.deepEqual(await row(first.id), original);
        });
        await t.test("lost terminal acknowledgement can be retried after owner re-nomination", async () => {
            const f = await fixture(), a = (await f.begin()).attempt!, evidence = goodEvidence();
            assert.equal((await f.finish(a.id, evidence)).ok, true); const original = await row(a.id);
            assert.equal((await value<Result>("select set_campaign_integrator($1,'other') as value", [f.session])).ok, true);
            assert.equal((await f.finish(a.id, evidence)).ok, true);
            assert.deepEqual(await row(a.id), original);
            assert.equal(await value("select integration_status as value from council_campaigns where id=$1", [f.campaign]), "pending");
            assert.equal((await f.finish(a.id, { ...evidence, diffSummary: "different" })).ok, false);
            await db.query("update council_host_leases set lease_epoch=2 where session_id=$1", [f.session]);
            assert.equal((await f.finish(a.id, evidence)).ok, false);
            assert.equal((await f.finish(a.id, evidence, "verified", null, branch, tip, 2)).ok, false);
        });
        await t.test("new fence retires only the old running attempt", async () => {
            const f = await fixture(), first = (await f.begin()).attempt!;
            await db.query("update council_host_leases set lease_epoch=2 where session_id=$1", [f.session]);
            const second = await f.begin(randomUUID(), 2); assert.equal(second.ok, true); assert.equal((await row(first.id)).status, "failed");
            assert.equal((await f.finish(first.id)).ok, false); assert.equal((await row(first.id)).evidence, null);
        });
        for (const fault of ["host", "epoch", "expired", "manifest", "nomination", "tip", "branch", "failed-command", "timed-out", "refs", "missing-refs", "unknown-field", "unsafe-path"]) await t.test(`finalise rejects ${fault}`, async () => {
            const f = await fixture(), a = (await f.begin()).attempt!, evidence = goodEvidence();
            if (fault === "expired") await db.query("update council_host_leases set lease_expires_at=clock_timestamp()-interval '1 second' where session_id=$1", [f.session]);
            if (fault === "manifest") await db.query("update council_campaigns set integration_manifest=jsonb_set(integration_manifest,'{baseSha}',to_jsonb($2::text)) where id=$1", [f.campaign, tip]);
            if (fault === "nomination") await db.query("update council_campaigns set integrator_agent='seat' where id=$1", [f.campaign]);
            if (fault === "failed-command") evidence.receipts[0].exitCode = 1;
            if (fault === "timed-out") evidence.receipts[0].timedOut = true;
            if (fault === "refs") evidence.protectedRefs.after.main = tip;
            if (fault === "missing-refs") evidence.protectedRefs = { before: {}, after: {} } as typeof evidence.protectedRefs;
            if (fault === "unknown-field") Object.assign(evidence, { privateToken: "synthetic" });
            if (fault === "unsafe-path") evidence.changedPaths = ["../private.txt"];
            assert.equal((await f.finish(a.id, evidence, "verified", null, fault === "branch" ? null : branch, fault === "tip" ? "invalid" : tip, fault === "epoch" ? 2 : 1, fault === "host" ? randomUUID() : f.host)).ok, false);
            assert.equal((await row(a.id)).status, "running");
        });
        await t.test("fresh exact bound delegated runtime is captured even after it ends", async () => {
            const f = await fixture("seat"), a = (await f.begin()).attempt!, execution = await f.execute();
            await db.query("select stop_council_agent_execution($1,$2,1,'integration ended')", [execution, f.host]);
            assert.equal((await f.finish(a.id, goodEvidence(), "verified", execution)).ok, true);
            const saved = await row(a.id); assert.equal(saved.execution_id, execution);
            assert.equal((saved.execution_evidence as Record<string, unknown>).executionId, execution);
            assert(!JSON.stringify(saved.execution_evidence).includes("seat_token_hash"));
        });
        for (const fault of ["missing", "other-seat", "other-council", "old-runtime", "wrong-branch", "unbound", "host-mode"]) await t.test(`delegated runtime rejects ${fault}`, async () => {
            const f = await fixture(fault === "host-mode" ? null : "seat");
            let execution: string | null = fault === "old-runtime" ? await f.execute() : null;
            const a = (await f.begin()).attempt!;
            if (fault === "other-council") execution = await (await fixture("seat")).execute();
            else if (fault !== "missing" && fault !== "old-runtime") execution = await f.execute(fault === "other-seat" ? "other" : "seat", fault === "wrong-branch" ? "other-branch" : branch, fault !== "unbound");
            assert.equal((await f.finish(a.id, goodEvidence(), "verified", execution)).ok, false);
        });
        await t.test("early delegated failures need no fabricated runtime", async () => {
            const f = await fixture("seat"), a = (await f.begin()).attempt!;
            assert.equal((await f.finish(a.id, goodEvidence(), "failed", null, null, null)).ok, true);
            assert.equal((await row(a.id)).execution_evidence, null);
        });
        await t.test("nomination cannot strand an active immutable attempt", async () => {
            const f = await fixture("seat"), a = (await f.begin()).attempt!;
            assert.equal((await value<Result>("select set_campaign_integrator($1,'other') as value", [f.session])).ok, false);
            assert.equal((await value<Result>("select set_campaign_integrator($1,'seat') as value", [f.session])).ok, true);
            assert.equal(await value("select integration_status as value from council_campaigns where id=$1", [f.campaign]), "running");
            await f.finish(a.id, goodEvidence(), "failed", null, null, null);
            assert.equal((await value<Result>("select set_campaign_integrator($1,'other') as value", [f.session])).ok, true);
            assert.equal((await row(a.id)).integrator_agent, "seat");
        });
        await t.test("null metadata is accepted only for a terminal failure", async () => {
            const f = await fixture(), a = (await f.begin()).attempt!;
            const evidence = { ...goodEvidence(), receipts: [], changedPaths: null, diffSummary: null, protectedRefs: { before: null, after: null } };
            const finish = (status: string) => value<Result>("select finalize_council_integration_attempt($1,$2,1,$3,null,null,null,$4) as value", [a.id, f.host, status, evidence]);
            assert.equal((await finish("verified")).ok, false); assert.equal((await finish("conflict")).ok, true);
        });
        await t.test("evidence bounds and nested allowlists fail closed", async () => {
            const samples: Record<string, unknown>[] = [
                { ...goodEvidence(), redactionVersion: 0 }, { ...goodEvidence(), receipts: Array(65).fill(goodEvidence().receipts[0]) },
                { ...goodEvidence(), changedPaths: Array(501).fill("file") }, { ...goodEvidence(), diffSummary: "x".repeat(16001) },
                { ...goodEvidence(), conflictNotes: "x".repeat(8001) }, { ...goodEvidence(), manualChecks: Array(33).fill("check") },
                { ...goodEvidence(), receipts: [{ ...goodEvidence().receipts[0], command: Array(65).fill("arg") }] },
                { ...goodEvidence(), receipts: [{ ...goodEvidence().receipts[0], outputTail: "x".repeat(4001) }] },
                { ...goodEvidence(), receipts: [{ ...goodEvidence().receipts[0], privateField: "private" }] },
                { ...goodEvidence(), changedPaths: ["C:\\private\\file"] }, { ...goodEvidence(), changedPaths: ["/private/file"] },
            ];
            for (const evidence of samples) assert.equal(await value("select council_integration_evidence_valid($1) as value", [evidence]), false);
        });
        await t.test("begin samples lease time again after attempt locks", async () => {
            const definition = await value<string>("select pg_get_functiondef(oid) as value from pg_proc where proname='begin_council_integration_attempt'");
            for (const clause of ["where id = p_attempt_id and campaign_id = v_campaign.id for update;", "where campaign_id = v_campaign.id and status = 'running' for update;"]) {
                const lock = definition.indexOf(clause); assert(lock > 0);
                const after = definition.slice(lock + clause.length);
                const clock = after.indexOf("clock_timestamp()");
                assert(clock >= 0 && clock < after.indexOf("return jsonb_build_object('ok',true"), "return cannot authorise from pre-lock time");
            }
        });
        await t.test("legacy summary is retained only before the new protocol begins", async () => {
            const f = await fixture(); assert.equal((await f.legacy()).ok, true);
            const a = (await f.begin()).attempt!; assert.equal((await f.legacy()).ok, false);
            await f.finish(a.id); assert.equal((await f.legacy()).ok, false);
            assert.equal(await value("select integration_branch as value from council_campaigns where id=$1", [f.campaign]), branch);
        });
        await t.test("active-fence expiry is checked after locks rather than transaction start", async () => {
            const f = await fixture(); await db.exec("begin");
            try { await db.query("update council_host_leases set lease_expires_at=now()+interval '10 milliseconds' where session_id=$1", [f.session]); await db.exec("select pg_sleep(0.025)"); assert.equal((await f.begin()).ok, false); }
            finally { await db.exec("rollback"); }
        });
        await t.test("RPCs are service-only and lock session before dependent rows", async () => {
            for (const name of ["begin_council_integration_attempt", "finalize_council_integration_attempt", "record_council_integration_v3"]) {
                for (const role of ["anon", "authenticated"]) assert.equal(await value("select has_function_privilege($1,oid,'execute') as value from pg_proc where proname=$2", [role, name]), false);
                assert.equal(await value("select has_function_privilege('service_role',oid,'execute') as value from pg_proc where proname=$1", [name]), true);
                const definition = await value<string>("select pg_get_functiondef(oid) as value from pg_proc where proname=$1", [name]);
                const sessionLock = definition.indexOf("from council_sessions"), leaseLock = definition.indexOf("from council_host_leases"), campaignLock = definition.indexOf("from council_campaigns");
                assert(sessionLock >= 0 && sessionLock < leaseLock && leaseLock < campaignLock);
            }
            assert.equal(await value("select relrowsecurity as value from pg_class where relname='council_integration_attempts'"), true);
        });
        await t.test("reapplying migration preserves historical attempts without backfill", async () => {
            const f = await fixture(), a = (await f.begin()).attempt!; await f.finish(a.id); const original = await row(a.id);
            const old = await fixture(); await old.legacy(); await db.exec(sql);
            assert.deepEqual(await row(a.id), original); assert.equal(await value("select count(*)::int as value from council_integration_attempts where campaign_id=$1", [old.campaign]), 0);
        });
    });
}
if (!baselineOnly) test("setup includes the exact owner package migration", () => { assert(migration); assert.equal(setup.slice(setup.indexOf(marker)).trim(), migration.trim()); });
