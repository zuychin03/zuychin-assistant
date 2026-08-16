import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrateAcceptedManifest, protectedRefsUnchanged, snapshotProtectedRefs, verifyExactCommit, type VerificationProfile } from "./council-git.mts";
import { selectConfig, validateSelection } from "./council-models.mts";
import { V3_HOST_CAPABILITIES, isV3HostCapabilities, promptDigest } from "../src/lib/council/v3.ts";

function git(repo: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

const root = mkdtempSync(join(tmpdir(), "zuychin-v3-test-"));
const repo = join(root, "repo");
mkdirSync(repo);

try {
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "council-test@example.invalid");
    git(repo, "config", "user.name", "Council Test");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "base.txt"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");
    const baseSha = git(repo, "rev-parse", "HEAD");
    const protectedRefs = snapshotProtectedRefs(repo, ["main"]);

    git(repo, "switch", "-c", "council/cn-test/agent-a");
    writeFileSync(join(repo, "src", "feature.txt"), "feature\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "feature");
    const commitSha = git(repo, "rev-parse", "HEAD");
    const profile: VerificationProfile = {
        rejectBinary: true, rejectSubmodules: true, rejectSymlinks: true,
        commands: [{ command: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 10_000 }],
    };

    const exact = await verifyExactCommit({
        repo, commitSha, baseSha, branch: "council/cn-test/agent-a", declaredPaths: ["src"], profile,
    });
    assert.equal(exact.ok, true, exact.lines.join("\n"));
    assert.equal(exact.receipts.length, 1);
    assert.match(exact.outputDigest, /^[0-9a-f]{64}$/);

    const scoped = await verifyExactCommit({
        repo, commitSha, baseSha, branch: "council/cn-test/agent-a", declaredPaths: ["docs"], profile,
    });
    assert.equal(scoped.ok, false);
    assert.ok(scoped.lines.some((line) => line.includes("outside declared scope")));

    const integrated = await integrateAcceptedManifest({
        repo, code: "CN-TEST", profile,
        manifest: {
            version: 1, campaignId: "test", baseSha,
            items: [{ itemId: "item-a", sequence: 1, agentName: "agent-a", branch: "council/cn-test/agent-a", commitSha, verificationRunId: "verification-a" }],
        },
    });
    assert.equal(integrated.ok, true, integrated.lines.join("\n"));
    assert.ok(integrated.tipSha);
    assert.equal(git(repo, "merge-base", "--is-ancestor", commitSha, integrated.tipSha!), "");
    assert.equal(protectedRefsUnchanged(repo, protectedRefs), true, "integration changed main");

    // Defect 11: a synchronous runner starves the host's lease-renewal timer,
    // so the lease expires mid-build and the finished result is discarded.
    let ticks = 0;
    const heartbeat = setInterval(() => { ticks += 1; }, 100);
    const slow = await verifyExactCommit({
        repo, commitSha, baseSha, branch: "council/cn-test/agent-a", declaredPaths: ["src"],
        profile: { ...profile, commands: [{ command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 1500)"], timeoutMs: 30_000 }] },
    });
    clearInterval(heartbeat);
    assert.equal(slow.ok, true, slow.lines.join("\n"));
    assert.ok(ticks >= 5, `verification blocked the event loop: only ${ticks} timer ticks in ~1.5s`);

    const timedOut = await verifyExactCommit({
        repo, commitSha, baseSha, branch: "council/cn-test/agent-a", declaredPaths: ["src"],
        profile: { ...profile, commands: [{ command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 60000)"], timeoutMs: 1_000 }] },
    });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.receipts[0]?.timedOut, true);

    const attributed = git(repo, "rev-parse", "HEAD");
    git(repo, "commit", "--amend", "-m", "feature\n\nCo-authored-by: Someone <a@b.invalid>");
    const tainted = await verifyExactCommit({
        repo, commitSha: git(repo, "rev-parse", "HEAD"), baseSha,
        branch: "council/cn-test/agent-a", declaredPaths: ["src"], profile,
    });
    assert.equal(tainted.ok, false);
    assert.ok(tainted.lines.some((line) => line.includes("attribution trailer")));
    git(repo, "reset", "--hard", attributed);

    const configOptions = [{ id: "model", category: "model", type: "select", currentValue: "alpha", options: [{ value: "alpha" }, { value: "beta" }] }];
    assert.equal(selectConfig(configOptions, "model")?.id, "model");
    validateSelection({ selection: { modelId: "beta" }, allowedModels: ["beta"], allowedReasoningEfforts: [], configOptions });
    assert.throws(() => validateSelection({ selection: { modelId: "gamma" }, allowedModels: ["beta"], allowedReasoningEfforts: [], configOptions }));

    assert.equal(isV3HostCapabilities(V3_HOST_CAPABILITIES), true);
    assert.equal(promptDigest("stable"), promptDigest("stable"));
    assert.notEqual(promptDigest("stable"), promptDigest("changed"));

    // supabase-setup.sql is the authoritative schema and is tracked; the
    // supabase/migrations/ copy is gitignored, so reading it fails on a fresh
    // clone.
    const schema = readFileSync(join(process.cwd(), "supabase-setup.sql"), "utf8");
    for (const required of [
        "claim_council_host_lease", "prepare_council_delivery", "ack_council_delivery",
        "start_council_agent_execution", "record_council_verification", "freeze_council_integration_manifest",
        "resolve_agent_client_key", "exchange_agent_claim", "begin_agent_claim_attempt",
    ]) assert.ok(schema.includes(required), `supabase-setup.sql misses ${required}`);

    console.log("Council V3 contract, model, exact-commit, manifest and protected-ref tests passed.");
} finally {
    rmSync(root, { recursive: true, force: true });
}
