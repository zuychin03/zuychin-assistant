import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const marker = "-- ===== Council execution attribution =====";
const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
const baseline = setup.split(marker)[0];
const setupMigration = setup.slice(setup.indexOf(marker)).split("-- ===== Council owner merge package =====")[0];
const baselineOnly = process.env.COUNCIL_ATTRIBUTION_BASELINE === "1";
const migration = await readFile(new URL("./migrations/council-execution-attribution.sql", import.meta.url), "utf8").catch(() => "");
const sha = "a".repeat(40), base = "b".repeat(40);
type Result = { ok: boolean; reason?: string; executionId?: string | null; seatBound?: boolean; seq?: number; duplicate?: boolean; manifest?: Record<string, unknown> };

function lastFunction(name: string): string {
    const matches = [...baseline.matchAll(new RegExp(`create or replace function (?:public\\.)?${name}\\([\\s\\S]*?\\$\\$;`, "g"))];
    assert(matches.length, `Missing baseline ${name}`);
    return matches.at(-1)![0];
}

for (const [source, sql] of baselineOnly ? [["baseline", ""]] : [["migration", migration], ["setup", setup.includes(marker) ? setupMigration : ""]]) {
    await test(`${source}: execution attribution`, async t => {
        const db = new PGlite();
        t.after(() => db.close());
        await db.exec("create role anon; create role authenticated; create role service_role; create table user_profiles(id uuid primary key); create table agent_clients(id uuid primary key)");
        for (const ddl of baseline.matchAll(/create table if not exists council_[a-z_]+ \([\s\S]*?\n\);/g)) await db.exec(ddl[0]);
        for (const ddl of baseline.matchAll(/alter table council_[a-z_]+\b[\s\S]*?;/g)) await db.exec(ddl[0]);
        for (const name of ["append_council_message", "complete_council_work_item", "issue_council_seat_key", "issue_council_host_seat_key", "resolve_council_seat_key", "start_council_agent_execution", "stop_council_agent_execution", "record_council_verification", "review_council_work_item", "freeze_council_integration_manifest", "renew_council_host_lease", "join_council", "claim_council_work_item", "block_council_work_item"]) await db.exec(lastFunction(name));
        if (sql) await db.exec(sql);

        async function value<T>(query: string, params: unknown[] = []): Promise<T> {
            return (await db.query<{ value: T }>(query, params)).rows[0]?.value;
        }
        async function fixture() {
            const session = randomUUID(), host = randomUUID(), campaign = randomUUID(), item = randomUUID();
            const hash = randomUUID().replaceAll("-", "").repeat(2);
            await db.query("insert into council_sessions(id,code,topic,closer_name,protocol_version,base_sha,max_messages) values($1::uuid,$1::text,'Synthetic attribution','closer',3,$2,1000)", [session, base]);
            await db.query("insert into council_participants(session_id,name,status) values($1,'seat','active'),($1,'other','active'),($1,'closer','active')", [session]);
            await db.query("insert into council_host_leases values($1,$2,1,clock_timestamp()+interval '1 hour',clock_timestamp(),clock_timestamp(),null)", [session, host]);
            await db.query("insert into council_campaigns(id,session_id,repo_path,base_sha) values($1,$2,'synthetic',$3)", [campaign, session, base]);
            await db.query("insert into council_work_items(id,campaign_id,sequence,agent_name,title,instructions,status) values($1,$2,1,'seat','Synthetic','Synthetic','in_progress')", [item, campaign]);
            const row = (table: string, id: string) => value<Record<string, unknown>>(`select to_jsonb(r) as value from ${table} r where id=$1`, [id]);
            const issue = (token = hash, bound = true, seat = "seat") => value<Result>(`select ${bound ? "issue_council_bound_host_seat_key" : "issue_council_host_seat_key"}($1,$2,$3,clock_timestamp()+interval '1 day',$4,1) as value`, [session, seat, token, host]);
            const start = (token = hash, model = "model-a", seat = "seat", epoch = 1, bound = true) => value<Result>(`select ${bound ? "start_council_bound_agent_execution" : "start_council_agent_execution"}($1,$2,$3,$4,'generation','acp','{}','probed','host_bound','provider','adapter-1','requested',$5,'high','high','adapter_config','branch','private-path',$6${bound ? ",$7" : ""}) as value`, [session, seat, host, epoch, model, base, ...(bound ? [token] : [])]);
            const append = (execution: string | null, token = hash, key: string = randomUUID(), body = key, seat = "seat") => value<Result>("select append_council_message_attributed(p_session_id=>$1,p_speaker=>$2,p_role=>'agent',p_intent=>'propose',p_body=>$3,p_client_key=>$4,p_seat_token_hash=>$5,p_expected_execution_id=>$6,p_posts_per_round=>1000) as value", [session, seat, body, key, token, execution]);
            const complete = (execution: string | null, token = hash, commit = sha) => value<Result>("select complete_council_work_item_attributed($1,'seat',$2,'checked',$3,$4) as value", [item, commit, token, execution]);
            const verify = () => value<Result>("select record_council_verification($1,$2,1,$3,$4,'branch','standard','[]','digest',true,'passed') as value", [item, host, sha, base]);
            const accept = () => value<Result>("select review_council_work_item($1,'closer',true,'accepted') as value", [item]);
            const freeze = () => value<Result>("select freeze_council_integration_manifest($1,$2,1) as value", [session, host]);
            return { session, host, campaign, item, hash, row, issue, start, append, complete, verify, accept, freeze };
        }
        async function bound() {
            const f = await fixture();
            assert.equal((await f.issue()).ok, true);
            const result = await f.start();
            assert.equal(result.ok, true);
            assert.equal(result.seatBound, true);
            assert(result.executionId);
            return { ...f, execution: result.executionId };
        }

        await t.test("legacy resubmission clears stale exact verification", async () => {
            const f = await fixture();
            await db.query("update council_work_items set status='awaiting_review',commit_hash=$2 where id=$1", [f.item, sha]);
            assert.equal((await f.verify()).ok, true);
            await db.query("update council_work_items set status='in_progress' where id=$1", [f.item]);
            assert.equal(await value("select complete_council_work_item($1,'seat',$2,'retry') as value", [f.item, sha]), true);
            assert.equal((await f.row("council_work_items", f.item)).verification_run_id, null);
            assert.equal((await f.accept()).ok, false);
        });
        await t.test("new RPCs exist and have service-role-only privileges", async () => {
            for (const name of ["issue_council_bound_host_seat_key", "start_council_bound_agent_execution", "append_council_message_attributed", "complete_council_work_item_attributed"]) {
                const count = await value<number>("select count(*)::int as value from pg_proc where proname=$1", [name]);
                assert.equal(count, 1, `${name} must have one unambiguous signature`);
                for (const role of ["anon", "authenticated"]) assert.equal(await value("select has_function_privilege($1,oid,'execute') as value from pg_proc where proname=$2", [role, name]), false);
                assert.equal(await value("select has_function_privilege('service_role',oid,'execute') as value from pg_proc where proname=$1", [name]), true);
            }
        });
        if (!sql) return;
        await t.test("fresh key binds once and resolution exposes its exact execution", async () => {
            const f = await bound();
            assert.equal((await f.start()).ok, false);
            const key = await value<Record<string, unknown>>("select resolve_council_seat_key($1) as value", [f.hash]);
            assert.equal(key.execution_id, f.execution);
            assert.equal(key.execution_binding_required, true);
            assert.equal(key.host_id, f.host);
            assert.equal(key.lease_epoch, 1);
        });
        await t.test("pending binding cannot append or submit", async () => {
            const f = await fixture(); await f.issue();
            assert.equal((await f.append(null)).ok, false);
            assert.equal((await f.complete(null)).ok, false);
            assert.equal(await value("select count(*)::int as value from council_messages where session_id=$1", [f.session]), 0);
        });
        await t.test("join preserves quorum, dispatch and repeat-join semantics", async () => {
            const f = await fixture();
            assert.equal((await value<Result>("select join_council($1,'seat','expert',true) as value", [f.session])).ok, true);
            assert.equal(await value("select quorum_at as value from council_sessions where id=$1", [f.session]), null);
            await db.query("select join_council($1,'other','',false)", [f.session]);
            const quorum = await value("select quorum_at as value from council_sessions where id=$1", [f.session]);
            assert(quorum);
            await db.query("select join_council($1,'seat','',null)", [f.session]);
            assert.deepEqual(await value("select quorum_at as value from council_sessions where id=$1", [f.session]), quorum);
            assert.equal(await value("select dispatch_mode as value from council_participants where session_id=$1 and name='seat'", [f.session]), true);
        });
        await t.test("claim and block retain the existing work lifecycle", async () => {
            const f = await fixture();
            await db.query("update council_work_items set status='queued' where id=$1", [f.item]);
            const claimed = await value<Record<string, unknown>>("select claim_council_work_item($1,'seat') as value", [f.session]);
            assert.equal(claimed.id, f.item); assert.equal(claimed.status, "in_progress"); assert.equal(claimed.attempts, 1);
            assert.equal(await value("select block_council_work_item($1,'other','wrong seat') as value", [f.item]), false);
            assert.equal(await value("select block_council_work_item($1,'seat','needs owner') as value", [f.item]), true);
            assert.equal((await f.row("council_work_items", f.item)).status, "blocked");
            assert.equal((await f.row("council_campaigns", f.campaign)).status, "blocked");
        });
        await t.test("claim and block cannot mutate a frozen campaign", async () => {
            const f = await fixture();
            await db.query("update council_campaigns set integration_manifest='{}' where id=$1", [f.campaign]);
            assert.equal(await value("select claim_council_work_item($1,'seat') as value", [f.session]), null);
            assert.equal(await value("select block_council_work_item($1,'seat','late block') as value", [f.item]), false);
            assert.equal((await f.row("council_work_items", f.item)).status, "in_progress");
        });
        await t.test("join, claim and block acquire the session mutex before dependent row locks", async () => {
            for (const [name, dependent] of [["join_council", "update council_participants"], ["claim_council_work_item", "select * into v_campaign"], ["block_council_work_item", "update council_work_items"]]) {
                const definition = await value<string>("select pg_get_functiondef(oid) as value from pg_proc where proname=$1", [name]);
                const sessionLock = definition.indexOf("from council_sessions where id = " );
                assert(sessionLock >= 0 && definition.slice(sessionLock, definition.indexOf(";", sessionLock)).includes("for update"), `${name}: missing session lock`);
                assert(sessionLock < definition.indexOf(dependent), `${name}: dependent row locked before session`);
                assert.equal(await value("select has_function_privilege('anon',oid,'execute') as value from pg_proc where proname=$1", [name]), false);
                assert.equal(await value("select has_function_privilege('authenticated',oid,'execute') as value from pg_proc where proname=$1", [name]), false);
                assert.equal(await value("select has_function_privilege('service_role',oid,'execute') as value from pg_proc where proname=$1", [name]), true);
            }
        });
        await t.test("a recycled token hash cannot acquire another execution after rotation", async () => {
            const f = await bound(), nextHash = "3".repeat(64);
            await f.issue(nextHash); const next = await f.start(nextHash, "model-b");
            assert.equal((await f.issue(f.hash)).ok, false);
            assert.equal((await f.start(f.hash)).ok, false);
            assert.equal((await value<Record<string, unknown>>("select resolve_council_seat_key($1) as value", [nextHash])).execution_id, next.executionId);
            assert.equal(await value("select count(*)::int as value from council_agent_executions where seat_token_hash=$1", [f.hash]), 1);
        });
        await t.test("changed-model reconnect preserves predecessor and rejects delayed old hash", async () => {
            const f = await bound(), nextHash = "d".repeat(64);
            await f.issue(nextHash);
            assert.equal((await f.start(f.hash)).ok, false);
            const next = await f.start(nextHash, "model-b");
            assert.equal(next.ok, true);
            const prior = await f.row("council_agent_executions", f.execution);
            assert.equal(prior.effective_model, "model-a"); assert(prior.ended_at);
            assert.equal((await f.row("council_agent_executions", next.executionId!)).predecessor_execution_id, f.execution);
            assert.equal((await f.append(f.execution)).ok, false);
            assert.equal((await f.complete(f.execution)).ok, false);
            assert.equal((await f.append(next.executionId!, nextHash)).ok, true);
        });
        for (const fault of ["wrong-execution", "wrong-seat", "wrong-session", "wrong-epoch", "expired-lease", "revoked-key", "expired-key", "ended-execution"]) {
            await t.test(`${fault} fails without a producing write`, async () => {
                const f = await bound(); let token = f.hash, expected = f.execution;
                if (fault === "wrong-execution") expected = randomUUID();
                if (fault === "wrong-seat") { token = "e".repeat(64); await f.issue(token, true, "other"); expected = (await f.start(token, "other-model", "other")).executionId!; }
                if (fault === "wrong-session") { const other = await bound(); token = other.hash; expected = other.execution; }
                if (fault === "wrong-epoch") await db.query("update council_host_leases set lease_epoch=2 where session_id=$1", [f.session]);
                if (fault === "expired-lease") await db.query("update council_host_leases set lease_expires_at=clock_timestamp()-interval '1 second' where session_id=$1", [f.session]);
                if (fault === "revoked-key") await db.query("update council_seat_keys set revoked_at=clock_timestamp() where token_hash=$1", [f.hash]);
                if (fault === "expired-key") await db.query("update council_seat_keys set expires_at=clock_timestamp()-interval '1 second' where token_hash=$1", [f.hash]);
                if (fault === "ended-execution") assert.equal(await value("select stop_council_agent_execution($1,$2,1,'stopped') as value", [f.execution, f.host]), true);
                assert.equal((await f.append(expected, token)).ok, false);
                assert.equal((await f.complete(expected, token)).ok, false);
                assert.equal((await f.row("council_work_items", f.item)).status, "in_progress");
            });
        }
        await t.test("duplicate message keeps its original runtime after reconnect", async () => {
            const f = await bound(); const first = await f.append(f.execution, f.hash, "same-key", "same-body");
            assert.equal(first.ok, true);
            const nextHash = "f".repeat(64); await f.issue(nextHash);
            const next = await f.start(nextHash, "model-b");
            const duplicate = await f.append(next.executionId!, nextHash, "same-key", "same-body");
            assert.equal(duplicate.duplicate, true); assert.equal(duplicate.seq, first.seq);
            assert.equal(duplicate.executionId, f.execution);
            assert.equal(await value("select execution_id as value from council_messages where session_id=$1 and seq=$2", [f.session, first.seq]), f.execution);
        });
        await t.test("accepted exact SHA freezes its submitted runtime, never the replacement", async () => {
            const f = await bound(); assert.equal((await f.complete(f.execution)).ok, true);
            await f.issue("1".repeat(64)); await f.start("1".repeat(64), "model-b");
            assert.equal((await f.verify()).ok, true); assert.equal((await f.accept()).ok, true);
            assert.equal((await f.row("council_work_items", f.item)).accepted_execution_id, f.execution);
            const frozen = await f.freeze(); assert.equal(frozen.ok, true);
            const item = (frozen.manifest!.items as Record<string, unknown>[])[0];
            assert.equal(item.acceptedExecutionId, f.execution);
            assert.deepEqual(item.executionEvidence, { executionId: f.execution, agentName: "seat", connectorKind: "acp", identityAssurance: "host_bound", provider: "provider", adapterVersion: "adapter-1", requestedModel: "requested", effectiveModel: "model-a", requestedReasoningEffort: "high", effectiveReasoningEffort: "high", modelSource: "adapter_config" });
            assert.deepEqual((await f.freeze()).manifest, frozen.manifest);
        });
        await t.test("acceptance rejects a verified SHA from a different runtime", async () => {
            const f = await bound(); await f.complete(f.execution); await f.verify();
            const nextHash = "2".repeat(64); await f.issue(nextHash); const next = await f.start(nextHash, "model-b");
            await db.query("update council_work_items set submitted_execution_id=$2 where id=$1", [f.item, next.executionId]);
            assert.equal((await f.accept()).ok, false);
        });
        await t.test("freeze rejects a tampered accepted execution pair", async () => {
            const f = await bound(); await f.complete(f.execution); await f.verify(); await f.accept();
            await db.query("update council_work_items set accepted_execution_id=null where id=$1", [f.item]);
            assert.equal((await f.freeze()).ok, false);
        });
        await t.test("completion cannot change verified or frozen work", async () => {
            const f = await bound(); await f.complete(f.execution); await f.verify(); await f.accept();
            assert.equal((await f.complete(f.execution)).ok, false);
            const frozen = await f.freeze();
            await db.query("update council_work_items set status='in_progress' where id=$1", [f.item]);
            assert.equal((await f.complete(f.execution)).ok, false);
            assert.equal(await value("select complete_council_work_item($1,'seat',$2,'legacy') as value", [f.item, sha]), false);
            assert.deepEqual((await f.freeze()).manifest, frozen.manifest);
        });
        await t.test("legacy owner and host keys stay unbound and cannot borrow execution evidence", async () => {
            for (const owner of [false, true]) {
                const f = await bound();
                if (owner) await db.query("select issue_council_seat_key($1,'seat',$2,clock_timestamp()+interval '1 day')", [f.session, f.hash]);
                else await f.issue(f.hash, false);
                const key = await value<Record<string, unknown>>("select resolve_council_seat_key($1) as value", [f.hash]);
                assert.equal(key.execution_id, null); assert.equal(key.execution_binding_required, false);
                assert.equal((await f.append(f.execution)).ok, false);
                assert.equal((await f.complete(f.execution)).ok, false);
                assert.equal((await f.append(null)).executionId, null);
                assert.equal((await f.complete(null)).executionId, null);
                await f.verify(); await f.accept(); const frozen = await f.freeze();
                const item = (frozen.manifest!.items as Record<string, unknown>[])[0];
                assert.equal(item.acceptedExecutionId, null); assert.equal(item.executionEvidence, null);
            }
        });
        await t.test("legacy completion resets attribution from a rejected bound submission", async () => {
            const f = await bound(); await f.complete(f.execution); await f.verify();
            await db.query("update council_work_items set status='in_progress' where id=$1", [f.item]);
            assert.equal(await value("select complete_council_work_item($1,'seat',$2,'legacy') as value", [f.item, sha]), true);
            const row = await f.row("council_work_items", f.item);
            assert.equal(row.submitted_execution_id, null); assert.equal(row.verification_run_id, null); assert.equal(row.accepted_execution_id, null);
        });
        await t.test("existing frozen manifest is returned unchanged", async () => {
            const f = await fixture(), original = { version: 1, items: [{ commitSha: sha }] };
            await db.query("update council_campaigns set integration_manifest=$2 where id=$1", [f.campaign, JSON.stringify(original)]);
            assert.deepEqual((await f.freeze()).manifest, original);
        });
        await t.test("renewal changes expiry without rebinding a runtime", async () => {
            const f = await bound();
            await db.query("update council_seat_keys set expires_at=clock_timestamp()+interval '30 minutes' where token_hash=$1", [f.hash]);
            assert.equal((await value<Result>("select renew_council_host_lease($1,$2,1,45) as value", [f.session, f.host])).ok, true);
            const key = await value<Record<string, unknown>>("select resolve_council_seat_key($1) as value", [f.hash]);
            assert.equal(key.execution_id, f.execution); assert.equal(key.execution_binding_required, true);
        });
        await t.test("expired transaction-start clocks cannot authorise registration", async () => {
            const f = await fixture(); await f.issue(); await db.exec("begin");
            try {
                await db.query("update council_host_leases set lease_expires_at=now()+interval '100 milliseconds' where session_id=$1", [f.session]);
                await new Promise(resolve => setTimeout(resolve, 160));
                assert.equal((await f.start()).ok, false);
            } finally { await db.exec("rollback"); }
        });
        await t.test("execution model facts and predecessor cannot be rewritten", async () => {
            const f = await bound();
            await assert.rejects(db.query("update council_agent_executions set effective_model='fabricated' where id=$1", [f.execution]), /immutable/i);
            await assert.rejects(db.query("update council_agent_executions set predecessor_execution_id=$1 where id=$1", [f.execution]), /immutable/i);
            assert.equal((await f.row("council_agent_executions", f.execution)).effective_model, "model-a");
        });
        await t.test("migration is re-runnable without changing historical associations", async () => {
            const f = await bound(); await f.append(f.execution); await db.exec(sql);
            assert.equal(await value("select execution_id as value from council_messages where session_id=$1", [f.session]), f.execution);
        });
    });
}

if (!baselineOnly) test("setup mirrors the incremental migration exactly", () => {
    assert(migration, "Missing execution-attribution migration");
    assert.equal(setupMigration.trim(), migration.trim());
});
