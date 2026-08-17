// Council host process-fault tests (V3.5.5).
//
//   npx tsx scripts/test-council-fault.mts
//
// Two phases. Phase A kills real host processes and needs nothing configured:
// no database, no MCP endpoint, its own throwaway git repo, and its own HOME so
// the machine-level lock it exercises is not the one a real host is holding.
//
// Phase B is the mid-turn kill the plan asked for and needs the whole stack -
// Supabase credentials in .env.local and a reachable MCP endpoint, which means
// `npm run dev`. It skips with a reason when either is missing rather than
// failing, so phase A stays useful in CI.
//
// Every process it starts is killed, and every directory and council row it
// creates is removed, including on failure.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    parseSupervisionLine, type HostExitV1, type HostHealthV1, type HostSupervisionMessage,
} from "../src/lib/council/supervisor.ts";
import { CODE_ALPHABET } from "../src/lib/council/protocol.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const HOST_ENTRY = join(HERE, "council-host.mts");
const FAKE_AGENT = join(HERE, "council-fake-agent.mjs");

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
    if (ok) {
        passed++;
        console.log(`  ok    ${name}`);
    } else {
        failed++;
        console.log(`  FAIL  ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    }
}

function skip(name: string, why: string): void {
    skipped++;
    console.log(`  skip  ${name} (${why})`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// .env.local is read here rather than through node --env-file because the
// harness needs the values for its own database client as well as the child's.
function readEnvFile(): Record<string, string> {
    const out: Record<string, string> = {};
    try {
        for (const line of readFileSync(join(REPO, ".env.local"), "utf8").split(/\r?\n/)) {
            const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
            if (!match) continue;
            out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
        }
    } catch { /* absent is a legitimate state; phase B reports the skip */ }
    return out;
}

const fileEnv = readEnvFile();

// Windows keeps a handle on a directory for a while after the process that used
// it dies, and rmSync's own retries are not always long enough. A scratch tree
// that outlives the run is untidy, never a failed assertion, so this warns and
// moves on rather than throwing out of a finally block.
async function removeTree(dir: string): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt++) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            return;
        } catch {
            await sleep(1_000);
        }
    }
    console.warn(`  note  could not remove ${dir}; delete it by hand`);
}

/** SIGKILL equivalent: no handler runs, so the host gets no chance to tidy up. */
function hardKill(pid: number): void {
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        return;
    }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

interface Host {
    child: ChildProcess;
    pid: number;
    messages: HostSupervisionMessage[];
    stderr: string[];
    exitCode: number | null;
    closed: boolean;
    send(line: string): void;
    waitForHealth(match?: (h: HostHealthV1) => boolean, timeoutMs?: number): Promise<HostHealthV1 | null>;
    waitForExitReport(timeoutMs?: number): Promise<HostExitV1 | null>;
    waitForClose(timeoutMs?: number): Promise<boolean>;
    exitReport(): HostExitV1 | undefined;
}

function startHost(options: {
    repo: string; configPath: string; home: string;
    launch?: Record<string, unknown>;
    env?: Record<string, string>;
}): Host {
    const child = spawn(process.execPath, [
        "--no-warnings", "--import", "tsx", HOST_ENTRY,
        "--config", options.configPath, "--repo", options.repo,
    ], {
        cwd: REPO,
        env: {
            ...process.env,
            ...fileEnv,
            ...options.env,
            ZUYCHIN_SUPERVISED: "1",
            ...(options.launch ? { ZUYCHIN_HOST_LAUNCH: JSON.stringify({ v: 1, type: "launch", ...options.launch }) } : {}),
            // os.homedir() reads these, and the singleton lock lives under it.
            // Pointing them at a scratch directory isolates the test from the
            // lock a real host on this machine may already be holding.
            HOME: options.home,
            USERPROFILE: options.home,
        },
        stdio: ["pipe", "pipe", "pipe"],
    });

    const host: Host = {
        child,
        pid: child.pid ?? -1,
        messages: [],
        stderr: [],
        exitCode: null,
        closed: false,
        send(line) { child.stdin?.write(`${line}\n`); },
        async waitForHealth(match, timeoutMs = 30_000) {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                const found = host.messages.find(
                    (m): m is HostHealthV1 => m.type === "health" && (!match || match(m)),
                );
                if (found) return found;
                if (host.closed || Date.now() > deadline) return null;
                await sleep(100);
            }
        },
        async waitForExitReport(timeoutMs = 30_000) {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                const found = host.exitReport();
                if (found) return found;
                if (Date.now() > deadline) return null;
                await sleep(100);
            }
        },
        async waitForClose(timeoutMs = 30_000) {
            const deadline = Date.now() + timeoutMs;
            while (!host.closed && Date.now() < deadline) await sleep(100);
            return host.closed;
        },
        exitReport() {
            return host.messages.find((m): m is HostExitV1 => m.type === "exit");
        },
    };

    let buffered = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        buffered += chunk;
        for (let cut = buffered.indexOf("\n"); cut >= 0; cut = buffered.indexOf("\n")) {
            const line = buffered.slice(0, cut);
            buffered = buffered.slice(cut + 1);
            const parsed = parseSupervisionLine(line);
            if (parsed?.ok) host.messages.push(parsed.value);
        }
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) if (line.trim()) host.stderr.push(line.trim());
    });
    child.on("close", (code) => { host.exitCode = code; host.closed = true; });
    return host;
}

// Ask before killing: a graceful stop reaps the agent processes, and those are
// what hold the worktrees open.
async function stopHost(host: Host): Promise<void> {
    if (host.closed) return;
    host.child.stdin?.end();
    if (await host.waitForClose(10_000)) return;
    hardKill(host.pid);
    await host.waitForClose(10_000);
}

function randomCodeChar(): string {
    return CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
}

function lockPath(home: string): string {
    return join(home, ".zuychin", "council-host.lock");
}

/**
 * A throwaway HOME, at a stable path rather than inside the scratch tree.
 * Windows holds a handle on it well past the last child's death and a per-run
 * copy would pile up; one directory holding one lock file does not. Only the
 * lock is cleared, which is the state the suite actually depends on.
 */
function stableHome(name: string): string {
    const home = join(tmpdir(), name);
    mkdirSync(join(home, ".zuychin"), { recursive: true });
    rmSync(lockPath(home), { force: true });
    return home;
}

function readLock(home: string): { pid?: number; hostId?: string } | null {
    try { return JSON.parse(readFileSync(lockPath(home), "utf8")); } catch { return null; }
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/** A repo of its own, so a worktree the host leaves behind is inside the scratch tree. */
function makeRepo(dir: string): string {
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "fault-test@example.invalid"]);
    git(dir, ["config", "user.name", "Fault Test"]);
    writeFileSync(join(dir, "README.md"), "fault test\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "base"]);
    return git(dir, ["rev-parse", "HEAD"]).out;
}

async function makeDirs(...dirs: string[]): Promise<void> {
    for (const dir of dirs) {
        await removeTree(dir);
        mkdirSync(dir, { recursive: true });
    }
}

// The endpoint the real launcher config points at, so the test talks to
// whatever this machine is actually running.
function mcpUrl(): string {
    try {
        const real = JSON.parse(readFileSync(join(HERE, "council-agents.json"), "utf8")) as { mcpUrl?: string };
        if (real.mcpUrl) return real.mcpUrl;
    } catch { /* no launcher config on this machine */ }
    return "http://localhost:3000/api/mcp/mcp";
}

// A port each. Two hosts must never contend for one, or the loser is refused by
// the port rather than by the lock and the singleton check proves nothing:
// anything above HOST_PORT_LAST leaves the host exactly one candidate.
function writeConfig(path: string, port: number, extra: Record<string, unknown>): void {
    writeFileSync(path, JSON.stringify({
        mcpUrl: mcpUrl(),
        host: { port, origins: [], autoAdopt: false },
        agents: {
            fake: {
                mode: "acp",
                command: process.execPath,
                args: [FAKE_AGENT],
                capabilities: { filesystemMediated: true, terminalMediated: true, permissionCallbacks: true },
            },
        },
        ...extra,
    }, null, 2));
}

// ---------------------------------------------------------------- phase A

async function phaseA(): Promise<void> {
    console.log("\nphase A: host process faults");
    const scratch = mkdtempSync(join(tmpdir(), "zch-fault-a-"));
    const repo = join(scratch, "repo");
    const home = stableHome("zch-fault-home-a");
    const configs = [1, 2, 3].map((n) => join(scratch, `council-agents-${n}.json`));
    const running: Host[] = [];
    try {
        await makeDirs(repo, home);
        makeRepo(repo);
        configs.forEach((path, index) => writeConfig(path, 8894 + index, { instances: {} }));
        const env = { MCP_COUNCIL_HOST_KEY: "fault-test-key-not-used-in-phase-a" };

        const first = startHost({ repo, configPath: configs[0], home, env });
        running.push(first);
        const ready = await first.waitForHealth((h) => h.lifecycle === "ready");
        check("a supervised host reports ready", ready !== null, first.stderr.slice(-4));
        if (!ready) return;
        check("an idle host is not draining", ready.draining === false, ready);
        check("it takes the machine lock", readLock(home)?.pid === first.pid, readLock(home));

        // Garbage on the control pipe must be refused, not obeyed and not fatal.
        first.send("{ not json");
        first.send(JSON.stringify({ v: 1, type: "stop", signal: "SIGKILL" }));
        await sleep(500);
        const warned = first.messages.filter((m) => m.type === "log" && m.level === "warn");
        check("an unparseable control line is refused", warned.length === 2, warned);
        check("a refused control line does not stop the host", !first.closed);

        // The fault itself: no signal handler runs, so nothing is released.
        hardKill(first.pid);
        check("a killed host is gone", await first.waitForClose(15_000), first.exitCode);
        check("a killed host files no exit report", first.exitReport() === undefined, first.exitReport());
        check("a killed host leaves its lock behind", readLock(home)?.pid === first.pid, readLock(home));

        const second = startHost({ repo, configPath: configs[1], home, env });
        running.push(second);
        const secondReady = await second.waitForHealth((h) => h.lifecycle === "ready");
        check("a successor starts over the dead host's lock", secondReady !== null, second.stderr.slice(-4));
        check("the successor owns the lock", readLock(home)?.pid === second.pid, readLock(home));
        check("the successor reports taking a stale lock",
            second.stderr.some((l) => l.includes("reclaimed a stale lock")), second.stderr.slice(-6));

        const third = startHost({ repo, configPath: configs[2], home, env });
        running.push(third);
        const refused = await third.waitForExitReport(30_000);
        check("a third host is refused while the successor lives",
            refused?.reason === "singleton", refused ?? third.stderr.slice(-4));
        check("the refusal exits non-zero", (await third.waitForClose()) && third.exitCode === 1, third.exitCode);
        check("the refusal does not disturb the holder's lock", readLock(home)?.pid === second.pid, readLock(home));

        // A supervisor that goes away is a stop request: the host it was
        // launched to serve has nobody left to serve.
        second.child.stdin?.end();
        const report = await second.waitForExitReport(30_000);
        check("closing the control pipe stops the host", report?.reason === "requested", report);
        check("the clean stop exits zero", (await second.waitForClose()) && second.exitCode === 0, second.exitCode);
        check("a clean stop releases the lock", !existsSync(lockPath(home)), readLock(home));
    } finally {
        for (const host of running) await stopHost(host);
        await removeTree(scratch);
    }
}

// ---------------------------------------------------------------- phase B

async function phaseB(): Promise<void> {
    console.log("\nphase B: killed mid-turn");

    const url = fileEnv.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = fileEnv.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
    const hostKey = fileEnv.MCP_COUNCIL_HOST_KEY ?? process.env.MCP_COUNCIL_HOST_KEY;
    if (!url || !serviceKey || !hostKey) {
        skip("mid-turn kill", "no .env.local with Supabase and MCP_COUNCIL_HOST_KEY");
        return;
    }

    const endpoint = mcpUrl();
    const reachable = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then((r) => r.status < 500).catch(() => false);
    if (!reachable) {
        skip("mid-turn kill", `${endpoint} is not answering - start the app with npm run dev`);
        return;
    }

    const db = makeDb(url, serviceKey);
    const scratch = mkdtempSync(join(tmpdir(), "zch-fault-b-"));
    const repo = join(scratch, "repo");
    const home = stableHome("zch-fault-home-b");
    const configPath = join(scratch, "council-agents.json");
    const running: Host[] = [];
    let sessionId: string | null = null;

    try {
        await makeDirs(repo);
        const baseSha = makeRepo(repo);
        writeConfig(configPath, 8899, {
            host: { port: 8899, origins: [], autoAdopt: false, repos: { faultrepo: { path: repo, baseBranch: "main" } } },
            instances: { "fault-a": { provider: "fake", expertise: "fault testing" } },
        });

        // Built from CODE_ALPHABET, not base36: the alphabet drops 0/O/1/I and a
        // code carrying one is refused by the launch parser, correctly.
        const code = `CN-F${Array.from({ length: 3 }, randomCodeChar).join("")}`;
        const { data: session, error } = await db.from("council_sessions").insert({
            code, topic: "host fault test", brief: "host fault test",
            closer_name: "fault-a", max_messages: 60,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            repo_path: repo, base_branch: "main", protocol_version: 3, base_sha: baseSha,
        }).select("id").single();
        if (error) throw new Error(`session insert failed: ${error.message}`);
        sessionId = session.id as string;
        const { error: rosterError } = await db.from("council_participants").insert({
            session_id: sessionId, name: "fault-a", kind: "agent",
            expertise: "fault testing", joined_seq: 1,
        });
        if (rosterError) throw new Error(`roster insert failed: ${rosterError.message}`);

        const env = { MCP_COUNCIL_HOST_KEY: hostKey };
        const first = startHost({ repo, configPath, home, env, launch: { attach: code } });
        running.push(first);
        const started = await first.waitForHealth();
        if (!started) {
            check("the host attaches to the council", false, first.stderr.slice(-6));
            return;
        }

        const lease = await waitForLease(db, sessionId, started.hostId, 60_000);
        check("the host attaches and claims the lease", lease !== null,
            lease ?? first.stderr.slice(-6).concat(first.exitReport() ? [JSON.stringify(first.exitReport())] : []));
        if (!lease) return;

        // dispatch_mode is set by the host through council_join once the agent's
        // session exists, and prepare_council_delivery refuses a seat without
        // it. Waiting on it is also how we know the fake agent is up and sitting
        // in its kickoff prompt: genuinely mid-turn, not merely attached.
        const driven = await waitForDispatchMode(db, sessionId, "fault-a", 60_000);
        check("the host starts the agent and takes its seat", driven,
            (await participantRow(db, sessionId, "fault-a")) ?? first.stderr.slice(-6));
        if (!driven) return;

        // The delivery the host would have written when it dispatched the turn,
        // through the same function the MCP route calls. What is being tested is
        // the recovery, not the writing.
        const prepared = await rpc(db, "prepare_council_delivery", {
            p_session_id: sessionId, p_agent_name: "fault-a",
            p_host_id: started.hostId, p_lease_epoch: lease.epoch,
            p_from_seq: 0, p_through_seq: 2, p_prompt_hash: "fault-hash", p_prompt_body: "your turn",
        }) as { ok?: boolean; delivery?: { id?: string } };
        const deliveryId = prepared?.delivery?.id;
        check("a turn is in the ledger", prepared?.ok === true && !!deliveryId, prepared);
        if (!deliveryId) return;
        const inFlight = await rpc(db, "mark_council_delivery_in_flight", {
            p_delivery_id: deliveryId, p_host_id: started.hostId, p_lease_epoch: lease.epoch,
        });
        check("the turn is in flight", inFlight === true, inFlight);

        // --- the fault ---
        hardKill(first.pid);
        check("the host dies mid-turn", await first.waitForClose(15_000), first.exitCode);
        check("it files no exit report", first.exitReport() === undefined, first.exitReport());

        const afterKill = await deliveryRow(db, deliveryId);
        check("the turn is neither acknowledged nor failed", afterKill?.status === "in_flight", afterKill);
        const participant = await participantRow(db, sessionId, "fault-a");
        check("nothing was acknowledged on the way down",
            participant?.cursor_seq === 0 && participant?.pending_ack_seq === 0, participant);

        const leaseAfterKill = await leaseRow(db, sessionId);
        check("a killed host does not release its lease",
            leaseAfterKill?.released_at === null && leaseAfterKill?.host_id === started.hostId, leaseAfterKill);

        // Until it expires, the dead host's lease still fences a successor -
        // which is the correct answer, not a bug: the machine cannot tell a dead
        // host from a partitioned one.
        const early = await rpc(db, "claim_council_host_lease", {
            p_session_id: sessionId, p_host_id: "00000000-0000-4000-8000-000000000001", p_duration_seconds: 60,
        }) as { ok?: boolean; reason?: string };
        check("a successor cannot jump a lease that has not expired",
            early?.ok === false && early?.reason === "lease_held", early);

        // Stand in for the 45 seconds the lease has left.
        await db.from("council_host_leases")
            .update({ lease_expires_at: new Date(Date.now() - 1000).toISOString() })
            .eq("session_id", sessionId);

        const second = startHost({ repo, configPath, home, env, launch: { attach: code } });
        running.push(second);
        const secondStarted = await second.waitForHealth();
        check("a successor host starts over the stale lock", secondStarted !== null, second.stderr.slice(-6));
        if (!secondStarted) return;

        const secondLease = await waitForLease(db, sessionId, secondStarted.hostId, 60_000);
        check("the successor attaches to the same council", secondLease !== null,
            secondLease ?? second.stderr.slice(-6));
        if (!secondLease) return;
        check("the successor holds a higher epoch", secondLease.epoch > lease.epoch,
            { was: lease.epoch, now: secondLease.epoch });

        const takeover = await rpc(db, "prepare_council_delivery", {
            p_session_id: sessionId, p_agent_name: "fault-a",
            p_host_id: secondStarted.hostId, p_lease_epoch: secondLease.epoch,
            p_from_seq: 0, p_through_seq: 2, p_prompt_hash: "fault-hash", p_prompt_body: "your turn",
        }) as { delivery?: { id?: string; redelivered?: boolean; attempt?: number } };
        check("the successor inherits the same turn rather than a new one",
            takeover?.delivery?.id === deliveryId, takeover);
        check("it is marked a redelivery on a fresh attempt",
            takeover?.delivery?.redelivered === true && (takeover?.delivery?.attempt ?? 0) > 1, takeover);

        const { count } = await db.from("council_deliveries")
            .select("id", { count: "exact", head: true }).eq("session_id", sessionId);
        check("the crash produced no duplicate delivery", count === 1, count);

        const staleAck = await rpc(db, "ack_council_delivery", {
            p_delivery_id: deliveryId, p_host_id: started.hostId, p_lease_epoch: lease.epoch,
        }) as { ok?: boolean; reason?: string };
        check("the dead host's epoch can never acknowledge the turn",
            staleAck?.ok === false && staleAck?.reason === "stale_epoch", staleAck);

        const finalParticipant = await participantRow(db, sessionId, "fault-a");
        check("the read cursor never moved across the whole fault",
            finalParticipant?.cursor_seq === 0, finalParticipant);
    } finally {
        for (const host of running) await stopHost(host);
        if (sessionId) {
            const { error } = await db.from("council_sessions").delete().eq("id", sessionId);
            if (error) console.warn(`cleanup failed for the test council: ${error.message}`);
        }
        await removeTree(scratch);
    }
}

// Inferred from the call rather than written out: createClient's default type
// arguments are not the ones it returns here.
function makeDb(url: string, key: string) {
    return createClient(url, key, { auth: { persistSession: false } });
}
type Db = ReturnType<typeof makeDb>;

async function rpc(db: Db, fn: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await db.rpc(fn, args);
    return error ? { __error: error.message } : data;
}

async function waitForLease(
    db: Db, sessionId: string, hostId: string, timeoutMs: number,
): Promise<{ epoch: number } | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const row = await leaseRow(db, sessionId);
        if (row && row.host_id === hostId && row.released_at === null) {
            return { epoch: Number(row.lease_epoch) };
        }
        if (Date.now() > deadline) return null;
        await sleep(500);
    }
}

async function waitForDispatchMode(
    db: Db, sessionId: string, name: string, timeoutMs: number,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if ((await participantRow(db, sessionId, name))?.dispatch_mode === true) return true;
        if (Date.now() > deadline) return false;
        await sleep(500);
    }
}

async function leaseRow(db: Db, sessionId: string) {
    const { data } = await db.from("council_host_leases")
        .select("host_id, lease_epoch, released_at, lease_expires_at").eq("session_id", sessionId).maybeSingle();
    return data as { host_id: string; lease_epoch: number; released_at: string | null } | null;
}

async function deliveryRow(db: Db, deliveryId: string) {
    const { data } = await db.from("council_deliveries")
        .select("status, attempt").eq("id", deliveryId).maybeSingle();
    return data as { status: string; attempt: number } | null;
}

async function participantRow(db: Db, sessionId: string, name: string) {
    const { data } = await db.from("council_participants")
        .select("cursor_seq, pending_ack_seq, dispatch_mode").eq("session_id", sessionId).eq("name", name).maybeSingle();
    return data as { cursor_seq: number; pending_ack_seq: number; dispatch_mode: boolean } | null;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
    try {
        await phaseA();
        await phaseB();
    } catch (err) {
        failed++;
        console.error("\naborted:", err instanceof Error ? err.message : err);
    }
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
    process.exit(failed === 0 ? 0 : 1);
}

await main();
