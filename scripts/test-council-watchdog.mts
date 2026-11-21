import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createLivenessServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { killTree } from "./council-host-paths.mts";
import { NODE_POLICY_VERSION } from "../src/lib/council/policy-versions.ts";
import { COUNCIL_HOST_GENERATION } from "../src/lib/council/v3.ts";

// The real host against a fixture MCP server and the fake ACP agent, with
// watchdog limits in seconds instead of minutes.

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fakeAgent = join(source, "scripts", "council-fake-agent.mjs");
const seat = "watch-seat";
const code = "CN-WTCH";
const deliveryId = "66666666-6666-4666-8666-666666666666";
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|PROGRAMFILES|PROGRAMFILES\(X86\)|SYSTEMDRIVE)$/i.test(key)));

type AgentMode = "hang" | "hang-first" | "speak" | "chatter" | "terminal" | "fail";
type Call = { name: string; arguments: Record<string, unknown>; adapterRunning: boolean };
type Trace = { pid: number; event: "start" | "prompt" | "cancel" | "end"; prompt?: string };

interface Scenario {
    mode: AgentMode;
    status: "open" | "closed";
    turnIdleMs: number;
    turnMaxMs: number;
    watchdogRestarts?: number;
    deliveryMaxAttempts?: number;
    terminalMs?: number;
    offerDelivery?: boolean;
    until: (seen: { calls: Call[]; trace: Trace[] }) => boolean;
    timeoutMs: number;
    settleMs?: number;
    stopHostFirst?: boolean;
    /** Rendered owner notes the server hands out, one per take. */
    notes?: string[];
    /** The owner requeues the stalled task as soon as the stall is reported. */
    requeueAfterStall?: boolean;
}

async function until(check: () => boolean, description: string, timeoutMs: number): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${description}`);
        await new Promise((settle) => setTimeout(settle, 50));
    }
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("fixture deadline exceeded")), timeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}

async function run(scenario: Scenario) {
    const root = mkdtempSync(join(tmpdir(), "council-watchdog-"));
    const repo = join(root, "repo");
    const home = join(root, "home");
    const tracePath = join(root, "agent.jsonl");
    for (const path of [repo, home]) mkdirSync(path);
    const env: NodeJS.ProcessEnv = { ...baseEnv, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
        MCP_COUNCIL_HOST_KEY: "fixture-host-key", ZUYCHIN_SUPERVISED: "1", NODE_ENV: "test" };
    const git = (...args: string[]) => {
        const result = spawnSync("git", ["-C", repo, ...args], { env, encoding: "utf8", timeout: 10_000 });
        assert.equal(result.status, 0, result.error?.message ?? result.stderr);
        return result.stdout.trim();
    };
    const trace = (): Trace[] => existsSync(tracePath)
        ? readFileSync(tracePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

    // An adapter connects this socket before it records its start, so a start
    // with no accepted connection still counts as running.
    const adapters = new Set<Socket>();
    let connections = 0;
    const liveness = createLivenessServer((socket) => {
        connections++;
        adapters.add(socket);
        // The adapter writes its pid. On Linux a killed adapter closes with a FIN, and a paused
        // socket holding unread data never emits "close" (Windows resets instead).
        socket.resume();
        socket.on("error", () => {});
        socket.on("close", () => adapters.delete(socket));
    });
    const adapterRunning = () => adapters.size > 0 || connections < trace().filter((record) => record.event === "start").length;

    const calls: Call[] = [];
    const errors: string[] = [];
    let baseSha = "";
    let issued = 0;
    let attempt = 1;
    const mcp = createServer(async (request, response) => {
        try {
            assert.equal(request.headers.authorization?.startsWith("Bearer fixture-"), true);
            let raw = "";
            for await (const chunk of request) raw += chunk;
            const rpc = JSON.parse(raw);
            const reply = (result: unknown) => {
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
            };
            if (rpc.method === "tools/list") {
                reply({ tools: [
                    { name: "council_dispatch", inputSchema: { properties: { statusOnly: { type: "boolean" } } } },
                    { name: "council_host_issue_seat", inputSchema: { properties: { bindExecution: { type: "boolean" } } } },
                    { name: "council_host_claim", inputSchema: { properties: { policyVersion: { type: "string", const: NODE_POLICY_VERSION } } } },
                    { name: "council_execution_start", inputSchema: { properties: {
                        seatTokenHash: { type: "string" }, policyVersion: { type: "string", enum: [NODE_POLICY_VERSION] } } } },
                    { name: "council_work_status", inputSchema: { properties: { json: { type: "boolean" } } } },
                ] });
                return;
            }
            const params = rpc.params as { name: string; arguments: Record<string, unknown> };
            // Sampled a moment into the call, so a socket closing just before it
            // is seen; a host that stops before closing holds the adapter open
            // for the whole call.
            if (params.name === "council_execution_stop") await new Promise((settle) => setTimeout(settle, 300));
            const call = { ...params, adapterRunning: adapterRunning() };
            calls.push(call);
            let result: unknown = { ok: true };
            switch (call.name) {
                case "council_host_claim":
                    result = { ok: true, leaseEpoch: 2, leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
                        hostGeneration: null, policyVersion: null, hasExecutionHistory: false,
                        session: { id: "11111111-1111-4111-8111-111111111111", protocolVersion: 3, baseSha,
                            repoPath: repo, baseBranch: "main", topic: "watchdog fixture", status: scenario.status } };
                    break;
                case "council_dispatch":
                    result = { topic: "watchdog fixture", statusOnly: call.arguments.statusOnly === true, status: scenario.status,
                        pausedAt: null, round: 1, maxRounds: 3, floorHolder: null,
                        participants: [{ name: seat, status: "invited", dispatchMode: false }],
                        agents: scenario.offerDelivery && call.arguments.statusOnly !== true
                            ? { [seat]: { status: "joined", prompt: "Fixture delivery", deliveryId, attempt } } : {} };
                    break;
                case "council_host_issue_seat":
                    issued++;
                    result = { ok: true, token: `fixture-seat-${issued}`, executionBindingRequired: true };
                    break;
                case "council_execution_start":
                    result = { ok: true, executionId: `fixture-execution-${issued}`, seatBound: true,
                        hostGeneration: COUNCIL_HOST_GENERATION, policyVersion: NODE_POLICY_VERSION };
                    break;
                case "council_delivery_state":
                    if (call.arguments.state === "failed") attempt++;
                    break;
                case "council_host_renew": result = { ok: true, leaseExpiresAt: new Date(Date.now() + 90_000).toISOString() }; break;
                case "council_work_unverified": result = { items: [] }; break;
                case "council_work_status":
                    result = { state: "active", ...(call.arguments.agentName ? {
                        runnable: scenario.requeueAfterStall && calls.some((seen) => seen.name === "council_work_stall") ? ["fixture-item"] : [],
                    } : {}) };
                    break;
                case "council_owner_notes_take": {
                    const text = scenario.notes?.shift();
                    result = { ok: true, count: text ? 1 : 0, text: text ?? "" };
                    break;
                }
                case "council_work_stall": result = { ok: true, itemId: "fixture-item" }; break;
                case "council_join": case "council_execution_stop": case "council_host_release": break;
                default: throw new Error(`unexpected tool ${call.name}`);
            }
            reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
        } catch (error) {
            errors.push(String(error)); response.writeHead(500); response.end("fixture error");
        }
    });

    let child: ChildProcess | undefined;
    let closed: Promise<unknown> | undefined;
    let socket: WebSocket | undefined;
    try {
        git("init", "-b", "main"); git("config", "core.fsmonitor", "false");
        git("-c", "user.name=Council fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
        baseSha = git("rev-parse", "HEAD");
        mcp.listen(0, "127.0.0.1"); await bounded(once(mcp, "listening"), 5_000);
        liveness.listen(0, "127.0.0.1"); await bounded(once(liveness, "listening"), 5_000);
        const mcpAddress = mcp.address(); const livenessAddress = liveness.address();
        assert.ok(mcpAddress && typeof mcpAddress === "object" && livenessAddress && typeof livenessAddress === "object");
        const configPath = join(root, "agents.json");
        writeFileSync(configPath, JSON.stringify({
            mcpUrl: `http://127.0.0.1:${mcpAddress.port}/mcp`, host: { port: 0, autoAdopt: false },
            watchdogRestarts: scenario.watchdogRestarts ?? 2, deliveryMaxAttempts: scenario.deliveryMaxAttempts ?? 3,
            turnCancelGraceMs: 300,
            agents: { fake: { mode: "acp", command: process.execPath, turnIdleMs: scenario.turnIdleMs, turnMaxMs: scenario.turnMaxMs,
                args: [fakeAgent, "--mode", scenario.mode, "--trace", tracePath, "--liveness", String(livenessAddress.port),
                    "--terminal-ms", String(scenario.terminalMs ?? 3_000)] } },
            instances: { [seat]: { provider: "fake" } },
        }));
        child = spawn(process.execPath, ["--import", "tsx", join(source, "scripts/council-host.mts"), "--repo", repo, "--config", configPath],
            { cwd: source, env, stdio: ["pipe", "pipe", "pipe"] });
        closed = once(child, "close"); child.stdout!.resume(); child.stderr!.resume();
        const identityPath = join(root, ".council-host", "host-repo.json");
        const readIdentity = () => { try { return JSON.parse(readFileSync(identityPath, "utf8")) as { port: number; token: string }; } catch { return null; } };
        await until(() => readIdentity() !== null, "host identity", 20_000);
        const identity = readIdentity()!;
        socket = new WebSocket(`ws://127.0.0.1:${identity.port}/ws`, identity.token);
        await bounded(once(socket, "open"), 5_000);
        socket.send(JSON.stringify({ type: "attach", code }));
        await until(() => scenario.until({ calls, trace: trace() }), "scenario outcome", scenario.timeoutMs);
        await new Promise((settle) => setTimeout(settle, scenario.settleMs ?? 0));

        const health = await fetch(`http://127.0.0.1:${identity.port}/health`, {
            headers: { Authorization: `Bearer ${identity.token}` }, signal: AbortSignal.timeout(3_000),
        }).then((response) => response.json()) as { agents: { state: string; detail: string }[] };
        const adapterAliveBeforeStop = adapterRunning();
        let exitCode: number | null = null;
        let adapterAliveAfterExit: boolean | null = null;
        if (scenario.stopHostFirst) {
            child.stdin!.end();
            [exitCode] = await bounded(closed, 15_000) as [number | null];
            await new Promise((settle) => setTimeout(settle, 500));
            adapterAliveAfterExit = adapterRunning();
        }
        const journalPath = join(root, `.council-run-${code.toLowerCase()}`, "campaign-run.json");
        return {
            calls: structuredClone(calls), trace: trace(), errors: [...errors], health, adapterAliveBeforeStop, exitCode,
            adapterAliveAfterExit,
            journal: existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, "utf8")) as { agents: { restarts: number }[] } : null,
        };
    } finally {
        // Close both listeners even when a check failed, or the open handles keep
        // the runner alive and it never prints which assertion failed.
        let cleanupError: unknown;
        try {
            socket?.terminate();
            if (child && child.exitCode === null && child.signalCode === null) {
                child.stdin?.end();
                try { await bounded(closed!, 10_000); }
                catch { killTree(child); await bounded(closed!, 5_000); }
            }
            await until(() => !adapterRunning(), "adapter cleanup", 20_000);
        } catch (error) { cleanupError = error; }
        try {
            mcp.closeAllConnections();
            if (mcp.listening) await bounded(new Promise<void>((settle) => mcp.close(() => settle())), 5_000);
        } catch (error) { cleanupError ??= error; }
        for (const adapter of adapters) adapter.destroy();
        if (liveness.listening) await new Promise<void>((settle) => liveness.close(() => settle()));
        assert.ok(resolve(root).startsWith(join(resolve(tmpdir()), "council-watchdog-")));
        try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (error) { cleanupError ??= error; }
        if (cleanupError) throw cleanupError;
    }
}

const named = (calls: Call[], name: string) => calls.filter((call) => call.name === name);
const starts = (trace: Trace[]) => [...new Set(trace.filter((record) => record.event === "start").map((record) => record.pid))];

await test("an idle turn is cancelled, closed and restarted, and the campaign resumes the seat", async () => {
    const result = await run({
        mode: "hang-first", status: "closed", turnIdleMs: 1_500, turnMaxMs: 60_000,
        // The campaign supervisor ticks every 30s, so the resumed prompt comes after that.
        until: ({ trace }) => trace.some((record) => record.event === "prompt" && record.pid !== trace[0]?.pid
            && record.prompt?.includes("Resume Zuychin work campaign")),
        timeoutMs: 60_000, settleMs: 1_000,
    });
    assert.deepEqual(result.errors, []);
    const [first, second] = starts(result.trace);
    assert.ok(first && second, "the seat must have been started twice");
    assert.ok(result.trace.some((record) => record.pid === first && record.event === "cancel"), "the hung turn gets session/cancel");
    const stops = named(result.calls, "council_execution_stop");
    assert.equal(stops.length, 1);
    assert.equal(stops[0].arguments.executionId, "fixture-execution-1");
    assert.match(String(stops[0].arguments.stopReason), /^watchdog: no activity for 1\.5s$/);
    assert.equal(stops[0].adapterRunning, false, "the adapter is closed before its execution is stopped");
    assert.equal(named(result.calls, "council_host_issue_seat").length, 2);
    assert.ok(result.trace.some((record) => record.pid === second && record.prompt?.includes("You are resuming council")));
    assert.equal(named(result.calls, "council_work_stall").length, 0);
    assert.equal(result.journal?.agents[0].restarts, 1);
    assert.equal(result.health.agents[0].state, "idle");
});

await test("a running host terminal pauses the idle clock", async () => {
    const result = await run({
        mode: "terminal", status: "open", turnIdleMs: 1_000, turnMaxMs: 60_000, terminalMs: 3_000,
        until: ({ trace }) => trace.some((record) => record.event === "end"),
        timeoutMs: 30_000, settleMs: 1_500,
    });
    assert.deepEqual(result.errors, []);
    assert.equal(starts(result.trace).length, 1);
    assert.equal(result.trace.some((record) => record.event === "cancel"), false);
    assert.equal(named(result.calls, "council_execution_stop").length, 0);
    assert.equal(result.health.agents[0].state, "idle");
    assert.match(result.health.agents[0].detail, /turn ended: end_turn/);
});

await test("the total cap ends a turn that never goes quiet", async () => {
    const result = await run({
        mode: "chatter", status: "closed", turnIdleMs: 1_000, turnMaxMs: 2_500, watchdogRestarts: 0,
        until: ({ calls }) => calls.some((call) => call.name === "council_work_stall"),
        timeoutMs: 30_000, settleMs: 1_000,
    });
    assert.deepEqual(result.errors, []);
    assert.equal(starts(result.trace).length, 1);
    assert.ok(result.trace.some((record) => record.event === "cancel"));
    const [stall] = named(result.calls, "council_work_stall");
    assert.equal(stall.arguments.reason, "watchdog: turn ran past 2.5s");
    assert.equal(named(result.calls, "council_host_issue_seat").length, 1);
    assert.equal(result.adapterAliveBeforeStop, false);
});

await test("after the allowed restarts the seat is reported stuck once", async () => {
    const result = await run({
        mode: "hang", status: "closed", turnIdleMs: 1_000, turnMaxMs: 60_000, watchdogRestarts: 2,
        until: ({ calls }) => calls.some((call) => call.name === "council_work_stall"),
        timeoutMs: 45_000, settleMs: 3_000,
    });
    assert.deepEqual(result.errors, []);
    assert.equal(starts(result.trace).length, 3);
    assert.equal(result.trace.filter((record) => record.event === "cancel").length, 3);
    assert.equal(named(result.calls, "council_host_issue_seat").length, 3);
    assert.equal(named(result.calls, "council_execution_stop").length, 3);
    const stalls = named(result.calls, "council_work_stall");
    assert.equal(stalls.length, 1);
    const claim = named(result.calls, "council_host_claim")[0];
    assert.deepEqual(stalls[0].arguments, {
        sessionCode: code, agentName: seat, hostId: claim.arguments.hostId, leaseEpoch: 2,
        reason: "watchdog: no activity for 1s",
    });
    assert.equal(result.journal?.agents[0].restarts, 2);
    assert.equal(result.adapterAliveBeforeStop, false);
    assert.equal(result.health.agents[0].state, "failed");
    assert.match(result.health.agents[0].detail, /^stuck after 2 restarts: watchdog: no activity for 1s$/);
});

await test("a turn the adapter keeps refusing is retried only up to the cap", async () => {
    const result = await run({
        mode: "fail", status: "open", turnIdleMs: 60_000, turnMaxMs: 60_000, watchdogRestarts: 0, deliveryMaxAttempts: 3,
        offerDelivery: true,
        until: ({ calls }) => calls.some((call) => call.name === "council_work_stall"),
        timeoutMs: 30_000, settleMs: 3_000,
    });
    assert.deepEqual(result.errors, []);
    const deliveries = result.trace.filter((record) => record.event === "prompt" && record.prompt === "Fixture delivery");
    assert.equal(deliveries.length, 3);
    assert.equal(named(result.calls, "council_delivery_state").filter((call) => call.arguments.state === "failed").length, 3);
    const stalls = named(result.calls, "council_work_stall");
    assert.equal(stalls.length, 1);
    assert.equal(stalls[0].arguments.reason, "delivery failed 3 times");
    assert.equal(result.adapterAliveBeforeStop, false);
});

await test("shutdown closes agents before it stops their executions", async () => {
    const result = await run({
        mode: "hang", status: "open", turnIdleMs: 60_000, turnMaxMs: 60_000,
        until: ({ trace }) => trace.some((record) => record.event === "prompt"),
        timeoutMs: 30_000, stopHostFirst: true,
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.exitCode, 0);
    const stops = named(result.calls, "council_execution_stop");
    assert.equal(stops.length, 1);
    assert.equal(stops[0].arguments.stopReason, "host shutdown");
    assert.equal(stops[0].adapterRunning, false);
    assert.equal(named(result.calls, "council_host_release").length, 1);
    assert.equal(result.adapterAliveAfterExit, false);
});

await test("owner notes ride on the next campaign prompt, taken under the host's lease", async () => {
    const note = "=== OWNER NOTE (from the owner, delivered by the Zuychin server) ===\nKeep the journal format.\n=== END OWNER NOTE ===";
    const result = await run({
        mode: "speak", status: "closed", turnIdleMs: 60_000, turnMaxMs: 60_000, notes: [note],
        until: ({ trace }) => trace.some((record) => record.event === "prompt" && record.prompt?.includes("Keep the journal format.")),
        timeoutMs: 60_000, settleMs: 500,
    });
    assert.deepEqual(result.errors, []);
    const prompt = result.trace.find((record) => record.prompt?.includes("Keep the journal format."))?.prompt ?? "";
    assert.ok(prompt.startsWith("Resume Zuychin work campaign"));
    assert.ok(prompt.endsWith(`\n\n${note}`));
    const takes = named(result.calls, "council_owner_notes_take");
    const claim = named(result.calls, "council_host_claim")[0];
    assert.ok(takes.length >= 1);
    assert.deepEqual(takes[0].arguments, { sessionCode: code, agentName: seat, hostId: claim.arguments.hostId, leaseEpoch: 2 });
});

await test("a requeue restarts a seat the watchdog gave up on, with a fresh allowance", async () => {
    const result = await run({
        mode: "hang", status: "closed", turnIdleMs: 1_000, turnMaxMs: 60_000, watchdogRestarts: 0, requeueAfterStall: true,
        // The supervisor finds the requeued task on its next 30s tick.
        until: ({ trace }) => starts(trace).length >= 2,
        timeoutMs: 60_000, settleMs: 500,
    });
    assert.deepEqual(result.errors, []);
    const stall = result.calls.findIndex((call) => call.name === "council_work_stall");
    assert.ok(stall >= 0);
    const statusRead = result.calls.findIndex((call, index) => index > stall && call.name === "council_work_status" && call.arguments.agentName === seat);
    assert.ok(statusRead > stall, "the host checks the stalled seat's runnable tasks");
    assert.equal(named(result.calls, "council_host_issue_seat").length, 2);
    const [, second] = starts(result.trace);
    assert.ok(result.trace.some((record) => record.pid === second && record.prompt?.includes("You are resuming council")));
    assert.equal(result.journal?.agents[0].restarts, 0);
});
