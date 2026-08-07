import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

export interface VerificationCommand {
    command: string[];
    timeoutMs?: number;
}

export interface VerificationProfile {
    commands: VerificationCommand[];
    maxOutputChars?: number;
    rejectBinary?: boolean;
    rejectSymlinks?: boolean;
    rejectSubmodules?: boolean;
}

export interface VerificationReceipt {
    command: string[];
    exitCode: number | null;
    durationMs: number;
    outputDigest: string;
    outputTail: string;
    timedOut?: boolean;
}

export interface ExactVerificationResult {
    ok: boolean;
    commitSha: string;
    baseSha: string;
    files: string[];
    lines: string[];
    receipts: VerificationReceipt[];
    outputDigest: string;
}

export interface IntegrationManifest {
    version: number;
    campaignId: string;
    baseSha: string;
    items: { itemId: string; sequence: number; agentName: string; branch: string; commitSha: string; verificationRunId: string; dependencies?: string[] }[];
}

const SECRET_PATHS = /(^|\/)(\.env(\..+)?|.*\.pem|.*\.p12|id_rsa|.*\.keystore)$/i;
const SECRET_CONTENT = /(api[_-]?key|secret|password|BEGIN [A-Z ]*PRIVATE KEY)\s*[=:]\s*\S{12,}/i;

function git(repo: string, args: string[]) {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", shell: false });
    return { ok: result.status === 0, status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

export function loadVerificationProfile(repo: string, profileId = "standard"): VerificationProfile {
    const path = join(repo, ".zuychin", "council-verification.json");
    if (!existsSync(path)) throw new Error(`missing repository verification policy ${path}`);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: number; profiles?: Record<string, VerificationProfile> };
    if (parsed.version !== 1) throw new Error("unsupported Council verification policy version");
    const profile = parsed.profiles?.[profileId];
    if (!profile) throw new Error(`verification profile \"${profileId}\" is not defined`);
    if (!Array.isArray(profile.commands) || profile.commands.some((entry) => !Array.isArray(entry.command) || entry.command.length === 0)) {
        throw new Error(`verification profile \"${profileId}\" contains an invalid command`);
    }
    return profile;
}

function runProfile(cwd: string, profile: VerificationProfile): VerificationReceipt[] {
    const limit = Math.max(2_000, Math.min(profile.maxOutputChars ?? 24_000, 200_000));
    return profile.commands.map((entry) => {
        const started = Date.now();
        const [command, ...args] = entry.command;
        const result = spawnSync(command, args, {
            cwd, encoding: "utf8", shell: false, timeout: Math.max(1_000, Math.min(entry.timeoutMs ?? 120_000, 900_000)),
            env: { ...process.env, CI: "1" }, maxBuffer: 2_000_000,
        });
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        return {
            command: entry.command,
            exitCode: result.status,
            durationMs: Date.now() - started,
            outputDigest: createHash("sha256").update(output).digest("hex"),
            outputTail: output.slice(-limit),
            timedOut: result.error?.name === "ETIMEDOUT" || result.signal === "SIGTERM",
        };
    });
}

function temporaryCheckout(repo: string, commit: string): { parent: string; dir: string } {
    const parent = join(tmpdir(), `zuychin-council-${randomBytes(8).toString("hex")}`);
    const dir = join(parent, "worktree");
    mkdirSync(parent, { recursive: true });
    const added = git(repo, ["worktree", "add", "--detach", dir, commit]);
    if (!added.ok) {
        rmSync(parent, { recursive: true, force: true });
        throw new Error(`could not create clean verification checkout: ${added.out}`);
    }
    return { parent, dir };
}

function removeTemporaryCheckout(repo: string, checkout: { parent: string; dir: string }): void {
    git(repo, ["worktree", "remove", "--force", checkout.dir]);
    rmSync(checkout.parent, { recursive: true, force: true });
}

export function snapshotProtectedRefs(repo: string, refs: string[]): Record<string, string | null> {
    return Object.fromEntries(refs.map((ref) => {
        const result = git(repo, ["rev-parse", "--verify", ref]);
        return [ref, result.ok ? result.out.split(/\s/)[0] : null];
    }));
}

export function protectedRefsUnchanged(repo: string, snapshot: Record<string, string | null>): boolean {
    return Object.entries(snapshot).every(([ref, sha]) => snapshotProtectedRefs(repo, [ref])[ref] === sha);
}

export function verifyExactCommit(params: {
    repo: string; commitSha: string; baseSha: string; branch: string;
    declaredPaths: string[]; profile: VerificationProfile;
}): ExactVerificationResult {
    const repo = resolve(params.repo);
    const lines: string[] = [];
    const fail = (message: string) => lines.push(`FAIL ${message}`);
    const pass = (message: string) => lines.push(`ok   ${message}`);
    const commit = git(repo, ["rev-parse", "--verify", `${params.commitSha}^{commit}`]);
    if (!commit.ok) {
        return { ok: false, commitSha: params.commitSha, baseSha: params.baseSha, files: [], lines: [`FAIL commit ${params.commitSha} does not exist`], receipts: [], outputDigest: createHash("sha256").update("missing").digest("hex") };
    }
    const commitSha = commit.out.split(/\s/)[0];
    if (commitSha.toLowerCase() !== params.commitSha.toLowerCase()) fail("submitted SHA does not resolve exactly");
    else pass(`exact commit ${commitSha.slice(0, 12)} exists`);
    if (git(repo, ["merge-base", "--is-ancestor", params.baseSha, commitSha]).ok) pass(`descends from frozen base ${params.baseSha.slice(0, 12)}`);
    else fail("commit does not descend from the frozen base");
    if (git(repo, ["merge-base", "--is-ancestor", commitSha, params.branch]).ok) pass(`reachable from ${params.branch}`);
    else fail(`not reachable from ${params.branch}`);

    const diff = git(repo, ["diff", "--name-only", `${params.baseSha}...${commitSha}`]);
    const files = diff.ok ? diff.out.split(/\r?\n/).map((file) => file.trim()).filter(Boolean) : [];
    if (!diff.ok) fail("could not read exact-commit diff"); else pass(`${files.length} file(s) changed`);
    const secretPaths = files.filter((file) => SECRET_PATHS.test(file));
    if (secretPaths.length) fail(`secret-looking files: ${secretPaths.join(", ")}`); else pass("no secret-looking filenames");
    if (params.declaredPaths.length) {
        const outside = files.filter((file) => !params.declaredPaths.some((scope) => file === scope || file.startsWith(scope.replace(/\/?$/, "/"))));
        if (outside.length) fail(`outside declared scope: ${outside.slice(0, 20).join(", ")}`); else pass("diff stays inside declared scope");
    }
    const raw = git(repo, ["diff", "--raw", `${params.baseSha}...${commitSha}`]).out;
    if (params.profile.rejectSymlinks !== false && /\b120000\b/.test(raw)) fail("diff contains a symbolic link");
    if (params.profile.rejectSubmodules !== false && /\b160000\b/.test(raw)) fail("diff contains a submodule/gitlink");
    const numstat = git(repo, ["diff", "--numstat", `${params.baseSha}...${commitSha}`]).out;
    if (params.profile.rejectBinary !== false && /^-\s+-\s+/m.test(numstat)) fail("diff contains a binary file");
    const patch = git(repo, ["diff", "-U0", `${params.baseSha}...${commitSha}`]);
    if (patch.ok && patch.out.split(/\r?\n/).some((line) => line.startsWith("+") && !line.startsWith("+++") && SECRET_CONTENT.test(line))) fail("added content resembles a credential");
    else pass("no credential-shaped additions");

    let receipts: VerificationReceipt[] = [];
    let checkout: { parent: string; dir: string } | null = null;
    try {
        checkout = temporaryCheckout(repo, commitSha);
        receipts = runProfile(checkout.dir, params.profile);
        for (const receipt of receipts) {
            if (receipt.exitCode === 0 && !receipt.timedOut) pass(`${receipt.command.join(" ")} exited 0`);
            else fail(`${receipt.command.join(" ")} ${receipt.timedOut ? "timed out" : `exited ${receipt.exitCode}`}`);
        }
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    } finally {
        if (checkout) removeTemporaryCheckout(repo, checkout);
    }
    const outputDigest = createHash("sha256").update(JSON.stringify({ commitSha, baseSha: params.baseSha, lines, receipts })).digest("hex");
    return { ok: !lines.some((line) => line.startsWith("FAIL ")), commitSha, baseSha: params.baseSha, files, lines, receipts, outputDigest };
}

export function integrateAcceptedManifest(params: {
    repo: string; code: string; manifest: IntegrationManifest; profile: VerificationProfile;
}): ExactVerificationResult & { branch: string; tipSha: string | null } {
    const repo = resolve(params.repo);
    const stem = `council/${params.code.toLowerCase()}/integration`;
    let branch = stem;
    for (let version = 2; git(repo, ["show-ref", "--verify", `refs/heads/${branch}`]).ok; version++) branch = `${stem}-v${version}`;
    const checkout = temporaryCheckout(repo, params.manifest.baseSha);
    const lines: string[] = [`ok   integration starts at frozen base ${params.manifest.baseSha.slice(0, 12)}`];
    let ok = true;
    try {
        const created = git(checkout.dir, ["switch", "-c", branch]);
        if (!created.ok) { ok = false; lines.push(`FAIL could not create ${branch}: ${created.out}`); }
        for (const item of params.manifest.items.sort((a, b) => a.sequence - b.sequence)) {
            if (!ok) break;
            const merged = git(checkout.dir, ["merge", "--no-edit", item.commitSha]);
            if (!merged.ok) { ok = false; lines.push(`FAIL conflict merging exact SHA ${item.commitSha}: ${merged.out.slice(-3000)}`); git(checkout.dir, ["merge", "--abort"]); }
            else lines.push(`ok   merged ${item.itemId} at ${item.commitSha.slice(0, 12)}`);
        }
        const receipts = ok ? runProfile(checkout.dir, params.profile) : [];
        for (const receipt of receipts) {
            if (receipt.exitCode !== 0 || receipt.timedOut) { ok = false; lines.push(`FAIL ${receipt.command.join(" ")} failed`); }
            else lines.push(`ok   ${receipt.command.join(" ")} exited 0`);
        }
        const tip = git(checkout.dir, ["rev-parse", "HEAD"]);
        const outputDigest = createHash("sha256").update(JSON.stringify({ branch, lines, receipts, tip: tip.out })).digest("hex");
        return { ok, branch, tipSha: tip.ok ? tip.out.split(/\s/)[0] : null, commitSha: tip.out, baseSha: params.manifest.baseSha, files: [], lines, receipts, outputDigest };
    } finally {
        removeTemporaryCheckout(repo, checkout);
    }
}
