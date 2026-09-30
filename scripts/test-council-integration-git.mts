import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { exactIntegrationDiff, integrateAcceptedManifest, type IntegrationManifest } from "./council-git.mts";

async function fixture(run: (repo: string, baseSha: string, commitSha: string) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), "council-integration-git-"));
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
        git("init", "-b", "main");
        git("config", "core.autocrlf", "false");
        git("config", "core.fsmonitor", "false");
        git("config", "user.name", "Council fixture");
        git("config", "user.email", "fixture@example.invalid");
        writeFileSync(join(repo, "base.txt"), "base\n");
        git("add", "."); git("commit", "-m", "base");
        const baseSha = git("rev-parse", "HEAD");
        git("switch", "-c", "feature");
        mkdirSync(join(repo, "src"));
        writeFileSync(join(repo, "src", "space name.txt"), "added\n");
        git("add", "."); git("commit", "-m", "feature");
        await run(repo, baseSha, git("rev-parse", "HEAD"));
    } finally {
        assert.ok(resolve(root).startsWith(join(resolve(tmpdir()), "council-integration-git-")));
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

const manifest = (baseSha: string, commitSha: string): IntegrationManifest => ({ version: 1, campaignId: "fixture", baseSha,
    items: [{ itemId: "item-a", sequence: 1, agentName: "alpha", branch: "feature", commitSha, verificationRunId: "verification-a" }] });

await test("integration retains exact-tip relative paths, diff summary and structured command receipts", async () => {
    await fixture(async (repo, baseSha, commitSha) => {
        const result = await integrateAcceptedManifest({ repo, code: "CN-ABCD", manifest: manifest(baseSha, commitSha),
            profile: { commands: [{ command: [process.execPath, "-e", "console.log('fixture check')"] }] } });
        assert.equal(result.ok, true, result.lines.join("\n"));
        assert.deepEqual(result.files, ["src/space name.txt"]);
        assert.match((result as unknown as { diffSummary: string }).diffSummary, /1 file changed, 1 insertion/);
        assert.ok(result.receipts.some((receipt) => receipt.command[1] === "merge"));
        const check = result.receipts.find((receipt) => receipt.command[0] === process.execPath)!;
        assert.equal(check.exitCode, 0);
        assert.equal(check.outputTail.trim(), "fixture check");
        assert.match(check.outputDigest, /^[0-9a-f]{64}$/);
        assert.equal(result.tipSha, commitSha);
    });
});

await test("integration records an actual Git check when no profile commands are configured", async () => {
    await fixture(async (repo, baseSha) => {
        const result = await integrateAcceptedManifest({ repo, code: "CN-ABCD", manifest: { ...manifest(baseSha, baseSha), items: [] },
            profile: { commands: [] } });
        assert.equal(result.ok, true);
        assert.ok(result.receipts.some((receipt) => receipt.command[0] === "git" && receipt.command.includes("--check") && receipt.exitCode === 0));
    });
});

await test("integration refuses a check that mutates its exact tip", async () => {
    await fixture(async (repo, baseSha, commitSha) => {
        const mutate = "require('node:child_process').execFileSync('git',['commit','--allow-empty','-m','unexpected check commit'])";
        const result = await integrateAcceptedManifest({ repo, code: "CN-ABCD", manifest: manifest(baseSha, commitSha),
            profile: { commands: [{ command: [process.execPath, "-e", mutate] }] } });
        assert.equal(result.ok, false);
        assert.match(result.lines.join("\n"), /tip changed during verification/);
        assert.equal(result.tipSha, commitSha, "evidence must describe the exact tip checked at command start");
    });
});

await test("integration does not mutate the frozen manifest order", async () => {
    await fixture(async (repo, baseSha, commitSha) => {
        const frozen = manifest(baseSha, commitSha);
        frozen.items.push({ ...frozen.items[0], itemId: "item-b", sequence: 0 });
        const before = structuredClone(frozen);
        await integrateAcceptedManifest({ repo, code: "CN-ABCD", manifest: frozen, profile: { commands: [] } });
        assert.deepEqual(frozen, before);
    });
});

await test("exact integration paths preserve leading spaces in tracked filenames", async () => {
    await fixture(async (repo, baseSha) => {
        writeFileSync(join(repo, " leading space.txt"), "fixture\n");
        execFileSync("git", ["-C", repo, "add", "."]);
        execFileSync("git", ["-C", repo, "commit", "-m", "leading filename"]);
        const tipSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        assert.deepEqual(exactIntegrationDiff(repo, baseSha, tipSha).files, [" leading space.txt", "src/space name.txt"]);
    });
});
