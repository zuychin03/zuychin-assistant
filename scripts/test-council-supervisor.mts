// Council V4.1 supervision contract and machine-level host singleton.
//
//   npx tsx scripts/test-council-supervisor.mts
//
// No database and no network: the launch parser is pure, and the lock runs
// against a temporary directory rather than the real ~/.zuychin, so this is safe
// to run while a host is up.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
    SUPERVISION_SCHEMA_VERSION, formatSupervisionLine, isValidBranchName, isValidWorkspaceName,
    parseControl, parseLaunch, parseSupervisionLine, safeToRestart, type HostHealthV1,
} from "../src/lib/council/supervisor.ts";
import { acquireHostLockAt, releaseHostLockAt } from "./council-host-lock.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures", "council", "supervisor-v1.json");

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
    if (ok) {
        passed++;
        console.log(`  ok    ${name}`);
    } else {
        failed++;
        console.log(`  FAIL  ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    }
}

interface Corpus {
    schemaVersion: number;
    launchValid: { name: string; line: string; expect: Record<string, unknown> }[];
    launchInvalid: { name: string; line: string; code: string }[];
    controlValid: { name: string; line: string; expect: Record<string, unknown> }[];
    controlInvalid: { name: string; line: string; code: string }[];
    controlIgnored: { name: string; line: string }[];
    supervisionValid: { name: string; line: string; type: string }[];
    supervisionInvalid: { name: string; line: string; code: string }[];
    supervisionIgnored: { name: string; line: string }[];
}

const corpus: Corpus = JSON.parse(readFileSync(FIXTURES, "utf8"));

function fixtureChecks(): void {
    console.log("\nfixture corpus");
    check("the corpus targets the implemented version",
        corpus.schemaVersion === SUPERVISION_SCHEMA_VERSION, corpus.schemaVersion);

    for (const item of corpus.launchValid) {
        const result = parseLaunch(item.line);
        check(`launch: ${item.name}`,
            result.ok && JSON.stringify(result.value) === JSON.stringify(item.expect),
            result.ok ? result.value : result);
    }
    for (const item of corpus.launchInvalid) {
        const result = parseLaunch(item.line);
        check(`launch refused: ${item.name}`,
            !result.ok && result.code === item.code,
            result.ok ? result.value : result);
    }
    for (const item of corpus.controlValid) {
        const result = parseControl(item.line);
        check(`control: ${item.name}`,
            result !== null && result.ok && JSON.stringify(result.value) === JSON.stringify(item.expect), result);
    }
    for (const item of corpus.controlInvalid) {
        const result = parseControl(item.line);
        check(`control refused: ${item.name}`,
            result !== null && !result.ok && result.code === item.code, result);
    }
    for (const item of corpus.controlIgnored) {
        check(`control ignored: ${item.name}`, parseControl(item.line) === null);
    }
    for (const item of corpus.supervisionValid) {
        const result = parseSupervisionLine(item.line);
        check(`supervision: ${item.name}`,
            result !== null && result.ok && result.value.type === item.type, result);
    }
    for (const item of corpus.supervisionInvalid) {
        const result = parseSupervisionLine(item.line);
        check(`supervision refused: ${item.name}`,
            result !== null && !result.ok && result.code === item.code, result);
    }
    for (const item of corpus.supervisionIgnored) {
        check(`supervision ignored: ${item.name}`, parseSupervisionLine(item.line) === null);
    }
}

function contractChecks(): void {
    console.log("\ncontract properties");

    // The point of the whole message: a supervisor names a repo it was allowed
    // to name, and cannot describe one any other way.
    const escapes = ["../x", "..\\x", "C:/repos/x", "/etc", "a/b", "a\\b", ".", "..", "", " x"];
    check("no path shape passes as a workspace name",
        escapes.every((candidate) => !isValidWorkspaceName(candidate)), escapes.filter(isValidWorkspaceName));

    const branchTraps = ["-x", "--upload-pack=calc", "a..b", "a//b", "main/", "main.lock", "main.", " main", "\tmain"];
    check("no git flag or traversal passes as a branch",
        branchTraps.every((candidate) => !isValidBranchName(candidate)), branchTraps.filter(isValidBranchName));
    check("ordinary branch names still pass",
        ["main", "develop", "release/2026-08", "fix_1.2"].every(isValidBranchName));

    // Fail closed on anything this version does not model, so a field added by a
    // newer shell cannot be silently dropped and act as a permission grant.
    const unknown = parseLaunch('{"v":1,"type":"launch","cwd":"C:/"}');
    check("an unknown field is refused rather than ignored", !unknown.ok && unknown.code === "unknown_field");

    const health: HostHealthV1 = {
        v: 1, type: "health", at: new Date().toISOString(), hostVersion: "3.1.0",
        hostGeneration: "typescript-node", hostId: "h", pid: 1, port: 8787,
        lifecycle: "ready", draining: false, leaseHealthy: false, councilCode: null,
        agents: 0, uptimeMs: 0,
    };
    check("an idle host is safe to restart", safeToRestart(health));
    check("a draining host is not", !safeToRestart({ ...health, draining: true, lifecycle: "draining" }));

    const round = parseSupervisionLine(formatSupervisionLine(health));
    check("a health message survives a round trip",
        round !== null && round.ok && JSON.stringify(round.value) === JSON.stringify(health), round);
    check("a supervision line is exactly one line",
        formatSupervisionLine(health).split("\n").length === 2);
}

function lockChecks(): void {
    console.log("\nmachine-level singleton");
    const dir = mkdtempSync(join(tmpdir(), "zch-lock-"));
    const path = join(dir, "council-host.lock");
    try {
        const first = acquireHostLockAt(path, { pid: process.pid, hostId: "host-a", port: 8787, repo: "R" });
        check("the first host takes the lock", first.ok && !first.tookOverStale, first);

        // A live pid the caller is not: the whole point of the file.
        const second = acquireHostLockAt(path, { pid: process.pid + 1, hostId: "host-b", port: 8788, repo: "R" });
        check("a second host is refused", !second.ok, second);
        check("the refusal names the holder", !second.ok && second.holder.hostId === "host-a", second);

        releaseHostLockAt(path, "host-b");
        const stillHeld = acquireHostLockAt(path, { pid: process.pid + 1, hostId: "host-c", port: 8788, repo: "R" });
        check("a loser cannot release the winner's lock", !stillHeld.ok, stillHeld);

        releaseHostLockAt(path, "host-a");
        const afterRelease = acquireHostLockAt(path, { pid: process.pid, hostId: "host-d", port: 8787, repo: "R" });
        check("the owner can release it", afterRelease.ok && !afterRelease.tookOverStale, afterRelease);
        releaseHostLockAt(path, "host-d");

        // pid 0x7FFFFFFE is above the Windows and Linux pid ceilings in practice,
        // which is what a lock left by a host that died looks like.
        writeFileSync(path, JSON.stringify({ pid: 0x7ffffffe, hostId: "ghost", port: 8787, repo: "R", startedAt: "" }));
        const reclaimed = acquireHostLockAt(path, { pid: process.pid, hostId: "host-e", port: 8787, repo: "R" });
        check("a dead holder's lock is reclaimed", reclaimed.ok && reclaimed.tookOverStale, reclaimed);
        releaseHostLockAt(path, "host-e");

        writeFileSync(path, "{ truncated");
        const corrupt = acquireHostLockAt(path, { pid: process.pid, hostId: "host-f", port: 8787, repo: "R" });
        check("a corrupt lock does not wedge the host forever", corrupt.ok, corrupt);
        releaseHostLockAt(path, "host-f");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

fixtureChecks();
contractChecks();
lockChecks();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
