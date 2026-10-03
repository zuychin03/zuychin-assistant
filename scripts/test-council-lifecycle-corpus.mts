import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import corpus from "../fixtures/council/lifecycle-v1.json" with { type: "json" };
import { configureAcpSession } from "./council-models.mts";
import { integrateAcceptedManifest, verifyExactCommit } from "./council-git.mts";

assert.equal(corpus.schemaVersion, 1);
const setup = readFileSync(new URL("../supabase-setup.sql", import.meta.url), "utf8");
type Result = { ok: boolean; reason?: string; leaseEpoch?: number; delivery?: { id: string; redelivered: boolean; attempt: number } };

await test("neutral lifecycle SQL replays", async (suite) => {
    const db = new PGlite();
    suite.after(() => db.close());
    await db.exec("create table user_profiles(id uuid primary key); create table agent_clients(id uuid primary key)");
    for (const ddl of setup.matchAll(/create table if not exists council_[a-z_]+ \([\s\S]*?\n\);/g)) await db.exec(ddl[0]);
    for (const ddl of setup.matchAll(/alter table council_[a-z_]+\b[\s\S]*?;/g)) await db.exec(ddl[0]);
    for (const name of ["claim_council_host_lease", "renew_council_host_lease", "release_council_host_lease", "prepare_council_delivery", "mark_council_delivery_in_flight", "ack_council_delivery"]) {
        const definitions = [...setup.matchAll(new RegExp(`create or replace function (?:public\\.)?${name}\\([\\s\\S]*?\\$\\$;`, "g"))];
        assert.ok(definitions.length, name);
        await db.exec(definitions.at(-1)![0]);
    }
    const value = async <T,>(sql: string, args: unknown[] = []): Promise<T> => (await db.query<{ value: T }>(sql, args)).rows[0].value;
    for (const scenario of corpus.scenarios.filter((entry) => ["lease", "crash", "redelivery"].includes(entry.category))) {
        await suite.test(scenario.id, async () => {
            const session = randomUUID(), original = randomUUID(), successor = randomUUID();
            await db.query("insert into council_sessions(id,code,topic,closer_name,protocol_version) values($1,$2,'Synthetic lifecycle','seat',3)", [session, session]);
            await db.query("insert into council_participants(session_id,name,status,dispatch_mode) values($1,'seat','active',true)", [session]);
            const claim = await value<Result>("select claim_council_host_lease($1,$2,300) as value", [session, original]);
            assert.equal(claim.leaseEpoch, scenario.initial.leaseEpoch);
            let delivery: Result | undefined;
            const prepare = (host: string, epoch: number) => value<Result>("select prepare_council_delivery($1,'seat',$2,$3,$4,$5,'fixture-hash',$6) as value",
                [session, host, epoch, scenario.input.fromSeq, scenario.input.throughSeq, scenario.input.prompt]);
            if (scenario.category !== "lease") {
                delivery = await prepare(original, claim.leaseEpoch!);
                assert.equal(await value("select mark_council_delivery_in_flight($1,$2,$3) as value", [delivery.delivery!.id, original, claim.leaseEpoch]), true);
            }
            if (scenario.input.event === "release_then_successor_claims") {
                assert.equal(await value("select release_council_host_lease($1,$2,$3) as value", [session, original, claim.leaseEpoch]), true);
            } else {
                await db.query("update council_host_leases set lease_expires_at=clock_timestamp()-interval '1 second' where session_id=$1", [session]);
            }
            const takeover = await value<Result>("select claim_council_host_lease($1,$2,300) as value", [session, successor]);
            if (scenario.category === "lease") {
                assert.equal(takeover.leaseEpoch, scenario.expected.nextEpoch);
                const oldRenewal = await value<Result>("select renew_council_host_lease($1,$2,$3,300) as value", [session, original, claim.leaseEpoch]);
                assert.equal(oldRenewal.ok, scenario.expected.oldRenewalAllowed);
                assert.equal(oldRenewal.reason, scenario.expected.reason);
                return;
            }
            const replay = await prepare(successor, takeover.leaseEpoch!);
            assert.equal(replay.delivery!.id === delivery!.delivery!.id, scenario.expected.sameDelivery);
            assert.equal(replay.delivery!.redelivered, scenario.expected.redelivered);
            if (scenario.category === "crash") {
                assert.equal(replay.delivery!.attempt, scenario.expected.attempt);
                assert.equal(await value("select count(*)::int as value from council_deliveries where session_id=$1", [session]), scenario.expected.deliveryRows);
                const oldAck = await value<Result>("select ack_council_delivery($1,$2,$3) as value", [delivery!.delivery!.id, original, claim.leaseEpoch]);
                assert.equal(oldAck.ok, scenario.expected.oldAcknowledgementAllowed);
            } else {
                const args = [replay.delivery!.id, successor, takeover.leaseEpoch];
                const early = await value<Result>("select ack_council_delivery($1,$2,$3) as value", args);
                assert.equal(early.ok, scenario.expected.earlyAcknowledgementAllowed);
                assert.equal(early.reason, scenario.expected.earlyReason);
                assert.equal(await value("select mark_council_delivery_in_flight($1,$2,$3) as value", args), true);
                assert.equal((await value<Result>("select ack_council_delivery($1,$2,$3) as value", args)).ok, scenario.expected.sentAcknowledgementAllowed);
                assert.equal(await value("select cursor_seq as value from council_participants where session_id=$1", [session]), scenario.expected.cursor);
            }
        });
    }
});

for (const scenario of corpus.scenarios.filter((entry) => entry.category === "model_mismatch")) {
    await test(scenario.id, async () => {
        let setters = 0, accepted = false;
        const option = (currentValue: string) => ({ id: "model", category: "model", type: "select", currentValue,
            options: scenario.initial.availableModels!.map((value) => ({ value, name: value })) });
        try {
            await configureAcpSession({ initialized: { agentInfo: { name: "synthetic", version: "1" } },
                sessionResponse: { configOptions: [option(scenario.initial.currentModel!)] },
                selection: { modelId: scenario.input.requestedModel! }, allowedModels: scenario.initial.availableModels!, allowedReasoningEfforts: [],
                setConfigOption: async () => { setters++; return { configOptions: [option(scenario.input.acknowledgedModel!)] }; } });
            accepted = true;
        } catch { /* A mismatched adapter acknowledgement must fail. */ }
        assert.equal(accepted, scenario.expected.accepted);
        assert.equal(setters, scenario.expected.setterCalls);
    });
}

for (const scenario of corpus.scenarios.filter((entry) => ["exact_commit", "integration_conflict"].includes(entry.category))) {
    await test(scenario.id, async () => {
        const root = mkdtempSync(join(tmpdir(), "council-neutral-git-"));
        const repo = join(root, "repo"); mkdirSync(repo);
        const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
        try {
            git("init", "-b", "main"); git("config", "core.fsmonitor", "false"); git("config", "core.autocrlf", "false");
            git("config", "user.name", "Council fixture"); git("config", "user.email", "fixture@example.invalid");
            writeFileSync(join(repo, scenario.input.path!), scenario.initial.baseText!); git("add", "."); git("commit", "-m", "base");
            const baseSha = git("rev-parse", "HEAD");
            git("switch", "-c", "accepted");
            writeFileSync(join(repo, scenario.input.path!), scenario.initial.acceptedText!); git("add", "."); git("commit", "-m", "accepted");
            const acceptedSha = git("rev-parse", "HEAD");
            if (scenario.category === "exact_commit") {
                writeFileSync(join(repo, scenario.input.laterPath!), scenario.input.laterText!); git("add", "."); git("commit", "-m", "later");
                const result = await verifyExactCommit({ repo, baseSha, commitSha: acceptedSha, branch: "accepted", declaredPaths: [scenario.input.path!], profile: { commands: [] } });
                assert.equal(result.ok, scenario.expected.accepted);
                assert.deepEqual(result.files, scenario.expected.files);
                assert.equal(result.commitSha === acceptedSha, scenario.expected.verifiedOriginalSha);
            } else {
                git("switch", "-c", "conflicting", baseSha);
                writeFileSync(join(repo, scenario.input.path!), scenario.input.conflictingText!); git("add", "."); git("commit", "-m", "conflicting");
                const conflictSha = git("rev-parse", "HEAD");
                const result = await integrateAcceptedManifest({ repo, code: "CN-TEST", profile: { commands: [] }, manifest: {
                    version: 1, campaignId: "synthetic", baseSha, items: [acceptedSha, conflictSha].map((commitSha, index) => ({
                        itemId: `item-${index}`, sequence: index, agentName: "seat", branch: index === 0 ? "accepted" : "conflicting", commitSha, verificationRunId: `verification-${index}`,
                    })),
                } });
                assert.equal(result.ok, scenario.expected.accepted);
                assert.equal(git("rev-parse", "main") === baseSha, scenario.expected.protectedRefUnchanged);
                assert.equal(result.receipts.some((receipt) => receipt.command.includes("merge") && receipt.exitCode !== 0), scenario.expected.failedMergeReceipt);
            }
        } finally {
            assert.ok(resolve(root).startsWith(join(resolve(tmpdir()), "council-neutral-git-")));
            rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
    });
}
