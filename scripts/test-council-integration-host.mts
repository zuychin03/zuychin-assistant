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

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostSource = process.env.COUNCIL_TEST_HOST_SOURCE ?? source;
const code = "CN-ABCD";
const seat = "alpha-seat";
type Call = { name: string; arguments: Record<string, unknown> };
type Mode = "host" | "agent" | "protected" | "failed" | "conflict" | "begin-retry" | "finish-retry" | "late-begin" | "late-finish" | "old-schema" | "overflow" | "retry-protected" | "private" | "nomination-changed" | "renominate-same" | "renominate-agent";
const wait = (ms: number) => new Promise((settle) => setTimeout(settle, ms));
async function until(check: () => boolean, detail: string, timeout = 45_000) {
    const end = Date.now() + timeout;
    while (!check()) { if (Date.now() > end) throw new Error(`timed out: ${detail}`); await wait(40); }
}

async function scenario(mode: Mode) {
    const root = mkdtempSync(join(tmpdir(), "council-integration-host-"));
    const repo = join(root, "repo");
    const home = join(root, "home");
    const runDir = join(root, ".council-run-cn-abcd");
    const trace = join(root, "adapter.jsonl");
    for (const dir of [repo, home, runDir, join(repo, ".zuychin")]) mkdirSync(dir, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|PROGRAMFILES|SYSTEMDRIVE)$/i.test(key))),
        HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home,
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"), MCP_COUNCIL_HOST_KEY: "fixture-private-host-secret",
        ZUYCHIN_SUPERVISED: "1", NODE_ENV: "test" };
    const git = (...args: string[]) => {
        const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env, timeout: 10_000 });
        assert.equal(result.status, 0, result.stderr || String(result.error)); return result.stdout.trim();
    };
    const calls: Call[] = [];
    const errors: string[] = [];
    const adapters = new Map<Socket, string>();
    const liveness = createLivenessServer((adapter) => {
        adapters.set(adapter, ""); adapter.setEncoding("utf8"); adapter.on("error", () => {});
        adapter.on("data", (pid: string) => adapters.set(adapter, adapters.get(adapter) + pid));
        adapter.on("close", () => adapters.delete(adapter));
    });
    const states: { type: string; detail?: string; code?: string | null }[] = [];
    let child: ChildProcess | undefined;
    let socket: WebSocket | undefined;
    let expired = false;
    let releases = 0;
    let executions = 0;
    let baseSha = "";
    let acceptedSha = "";
    let conflictingSha = "";
    const attempts = new Map<unknown, Record<string, unknown>>();
    const acceptedResults = new Map<unknown, Record<string, unknown>>();
    let integrationStatus = "pending";
    let agentMode = mode === "agent" || mode === "renominate-same";
    const manifest = () => ({ version: 1, campaignId: "11111111-1111-4111-8111-111111111111", baseSha,
        items: [{ itemId: "22222222-2222-4222-8222-222222222222", sequence: 1, agentName: seat, branch: "feature", commitSha: acceptedSha,
            verificationRunId: "33333333-3333-4333-8333-333333333333" },
        ...(mode === "conflict" ? [{ itemId: "44444444-4444-4444-8444-444444444444", sequence: 2, agentName: seat, branch: "conflict", commitSha: conflictingSha,
            verificationRunId: "55555555-5555-4555-8555-555555555555" }] : [])] });
    const mcp = createServer(async (request, response) => {
        try {
            let raw = ""; for await (const chunk of request) raw += chunk;
            const rpc = JSON.parse(raw);
            if (rpc.method === "tools/list") {
                const tools = [
                    { name: "council_dispatch", inputSchema: { properties: { statusOnly: { type: "boolean" } } } },
                    { name: "council_host_issue_seat", inputSchema: { properties: { bindExecution: { type: "boolean" } } } },
                    { name: "council_host_claim", inputSchema: { properties: { policyVersion: { type: "string", const: "typescript-node-v3-2026-09-30" } } } },
                    { name: "council_execution_start", inputSchema: { properties: { seatTokenHash: { type: "string" }, policyVersion: { type: "string", const: "typescript-node-v3-2026-09-30" } } } },
                    { name: "council_work_status", inputSchema: { properties: { json: { type: "boolean" } } } },
                    ...(mode === "old-schema" ? [] : [
                        { name: "council_integration_begin", inputSchema: { properties: { attemptId: { type: "string" }, expectedIntegrator: { type: ["string", "null"] } } } },
                        { name: "council_integration_finish", inputSchema: { properties: { attemptId: { type: "string" }, evidence: { type: "object" } } } },
                    ]),
                ];
                response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools } })); return;
            }
            const call = rpc.params as Call; calls.push(call);
            let result: unknown = { ok: true };
            switch (call.name) {
                case "council_host_claim": result = { ok: true, leaseEpoch: 2, leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
                    hostGeneration: "typescript-node", policyVersion: "typescript-node-v3-2026-09-30", hasExecutionHistory: true,
                    session: { id: "66666666-6666-4666-8666-666666666666", protocolVersion: 3, baseSha, repoPath: repo, baseBranch: "main", topic: "fixture", status: "closed" } }; break;
                case "council_dispatch": result = { topic: "fixture", statusOnly: call.arguments.statusOnly === true, status: expired ? "expired" : "closed",
                    pausedAt: expired ? "2026-09-01T00:00:00.000Z" : null, round: 1, maxRounds: 3, floorHolder: seat,
                    participants: [{ name: seat, status: "joined", dispatchMode: true }], agents: {} }; break;
                case "council_host_issue_seat": result = { ok: true, token: `fixture-seat-${executions + 1}`, executionBindingRequired: true }; break;
                case "council_execution_start": result = { ok: true, executionId: `execution-${++executions}`, seatBound: true,
                    hostGeneration: "typescript-node", policyVersion: "typescript-node-v3-2026-09-30" }; break;
                case "council_execution_stop": case "council_join": case "council_delivery_state": break;
                case "council_host_release": releases++; break;
                case "council_host_renew": result = { ok: !expired, leaseExpiresAt: new Date(Date.now() + 90_000).toISOString() }; break;
                case "council_work_unverified": result = { items: [] }; break;
                case "council_work_status": assert.equal(call.arguments.json, true); result = { state: "complete" }; break;
                case "council_integration_manifest": result = { ok: true, integratorAgent: agentMode ? seat : null,
                    integrationStatus, manifest: { ...manifest(), items: [] } }; break;
                case "council_integration_begin":
                    if (mode === "nomination-changed" && calls.filter((entry) => entry.name === call.name).length === 1) {
                        agentMode = true; result = { ok: false, reason: "integrator_changed" }; break;
                    }
                    if (!attempts.has(call.arguments.attemptId)) attempts.set(call.arguments.attemptId, { id: call.arguments.attemptId, sessionId: "66666666-6666-4666-8666-666666666666", campaignId: manifest().campaignId,
                        attemptNumber: 1, status: "running", mode: agentMode ? "agent" : "host", integratorAgent: agentMode ? seat : null,
                        manifest: manifest(), manifestHash: "a".repeat(64), baseBranch: "main", baseSha, decision: null, openQuestions: [], startedAt: new Date().toISOString() });
                    integrationStatus = "running";
                    if (mode === "begin-retry" && calls.filter((entry) => entry.name === call.name).length === 1) { response.destroy(); return; }
                    if (mode === "late-begin") { expired = true; await wait(5_000); }
                    result = { ok: true, attempt: attempts.get(call.arguments.attemptId) }; break;
                case "council_integration_finish":
                    if (acceptedResults.has(call.arguments.attemptId)) assert.deepEqual(call.arguments, acceptedResults.get(call.arguments.attemptId), "retry must match committed result");
                    else acceptedResults.set(call.arguments.attemptId, structuredClone(call.arguments));
                    integrationStatus = "verified";
                    if (mode.startsWith("renominate-") && acceptedResults.size === 1) { integrationStatus = "pending"; agentMode = true; }
                    if (mode === "finish-retry" && calls.filter((entry) => entry.name === call.name).length === 1) { response.destroy(); return; }
                    if (mode === "retry-protected" && calls.filter((entry) => entry.name === call.name).length === 1) { git("update-ref", "refs/heads/main", acceptedSha); response.destroy(); return; }
                    if (mode === "late-finish") { expired = true; await wait(5_000); }
                    result = { ok: true, attemptId: call.arguments.attemptId }; break;
                case "council_integration_report": break;
                default: throw new Error(`unexpected tool ${call.name}`);
            }
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] } }));
        } catch (error) { errors.push(String(error)); response.writeHead(500); response.end("fixture error"); }
    });
    try {
        git("init", "-b", "main"); git("config", "core.fsmonitor", "false"); git("config", "user.name", "Council fixture"); git("config", "user.email", "fixture@example.invalid");
        writeFileSync(join(repo, "verify.mjs"), "import {execFileSync} from 'node:child_process'; console.log('fixture-private-host-secret'); console.log('arbitrary-private-value-123'); console.log(process.argv[2]); if(process.argv[3]==='protected') execFileSync('git',['-C',process.argv[2],'update-ref','refs/heads/main',execFileSync('git',['-C',process.argv[2],'rev-parse','feature'],{encoding:'utf8'}).trim()]); if(process.argv[3]==='failed') process.exit(9);");
        writeFileSync(join(repo, ".zuychin", "council-verification.json"), JSON.stringify({ version: 1, profiles: { standard: {
            commands: [{ command: [process.execPath, "verify.mjs", repo, mode] }],
        } } }));
        writeFileSync(join(repo, "content.txt"), "base\n"); git("add", "."); git("commit", "-m", "base"); baseSha = git("rev-parse", "HEAD");
        git("switch", "-c", "feature"); writeFileSync(join(repo, "content.txt"), "accepted\n");
        if (mode === "overflow") for (let index = 0; index < 500; index++) writeFileSync(join(repo, `added-${index}.txt`), "fixture\n");
        git("add", "."); git("commit", "-m", "accepted"); acceptedSha = git("rev-parse", "HEAD");
        if (mode === "conflict") { git("switch", "-c", "conflict", baseSha); writeFileSync(join(repo, "content.txt"), "conflicting\n"); git("add", "."); git("commit", "-m", "conflict"); conflictingSha = git("rev-parse", "HEAD"); }
        writeFileSync(join(runDir, "campaign-run.json"), JSON.stringify({ code, baseSha,
            hostGeneration: "typescript-node", policyVersion: "typescript-node-v3-2026-09-30", agents: [{ name: seat,
            dir: join(root, "repo-cn-abcd-alpha-seat"), branch: "council/cn-abcd/alpha-seat", mode: "acp", requestedModel: null, requestedReasoningEffort: null }] }));
        mcp.listen(0, "127.0.0.1"); await once(mcp, "listening"); const address = mcp.address(); assert.ok(address && typeof address === "object");
        liveness.listen(0, "127.0.0.1"); await once(liveness, "listening"); const livenessAddress = liveness.address(); assert.ok(livenessAddress && typeof livenessAddress === "object");
        const config = join(root, "agents.json"); writeFileSync(config, JSON.stringify({ mcpUrl: `http://127.0.0.1:${address.port}/mcp`, host: { port: 0, autoAdopt: false },
            agents: { fixture: { mode: "acp", command: process.execPath, args: [join(source, "scripts/fixtures/council-integration-agent.mjs"), trace, String(livenessAddress.port)], env: { VENDOR_API_KEY: "arbitrary-private-value-123" } } },
            instances: { [seat]: { provider: "fixture" } } }));
        child = spawn(process.execPath, ["--import", "tsx", join(hostSource, "scripts/council-host.mts"), "--repo", repo, "--config", config], { cwd: hostSource, env, stdio: ["pipe", "pipe", "pipe"] });
        child.stdout!.resume(); child.stderr!.resume();
        // The host writes this file in place, so it can exist before it holds JSON.
        const identityPath = join(root, ".council-host", "host-repo.json");
        const readIdentity = () => { try { return JSON.parse(readFileSync(identityPath, "utf8")) as { port: number; token: string }; } catch { return null; } };
        await until(() => readIdentity() !== null, "host identity", 10_000);
        const identity = readIdentity()!; socket = new WebSocket(`ws://127.0.0.1:${identity.port}/ws`, identity.token);
        socket.on("message", (raw) => states.push(JSON.parse(raw.toString()))); await once(socket, "open"); socket.send(JSON.stringify({ type: "attach", code }));
        await until(() => calls.filter((call) => call.name === "council_integration_finish").length >= (mode.startsWith("renominate-") ? 2 : 1)
            || calls.some((call) => call.name === "council_integration_report" && call.arguments.status !== "running")
            || (mode === "late-begin" && releases > 0) || ((mode === "old-schema" || mode === "overflow") && states.some((state) => state.type === "error")), "integration outcome", mode === "nomination-changed" || mode.startsWith("renominate-") ? 95_000 : 75_000);
        await wait(mode.startsWith("late-") ? 6_000 : mode.endsWith("retry") || mode === "retry-protected" ? 2_000 : 700);
        const health = await fetch(`http://127.0.0.1:${identity.port}/health`, { headers: { Authorization: `Bearer ${identity.token}` } }).then((response) => response.json());
        return { calls: structuredClone(calls), errors: [...errors], states: structuredClone(states), baseSha, acceptedSha, health,
            records: existsSync(trace) ? readFileSync(trace, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [],
            branches: git("for-each-ref", "--format=%(refname:short)", "refs/heads/council/cn-abcd/integration"), root };
    } finally {
        // A failed check must still close both listeners, or the open handles keep
        // the runner alive and it never prints which assertion failed.
        let cleanupError: unknown;
        try {
            socket?.terminate();
            if (child && child.exitCode === null && child.signalCode === null) {
                const closed = once(child, "close"); child.stdin?.end();
                await Promise.race([closed, wait(7_000)]); if (child.exitCode === null) killTree(child);
                await Promise.race([closed, wait(5_000)]);
            }
            await until(() => adapters.size === 0, "adapter cleanup", 10_000)
                .catch((error: Error) => { throw new Error(`${error.message}; adapter pid(s) still running: ${[...adapters.values()].join(", ")}`); });
        } catch (error) { cleanupError = error; }
        mcp.closeAllConnections(); if (mcp.listening) await new Promise<void>((settle) => mcp.close(() => settle()));
        for (const adapter of adapters.keys()) adapter.destroy();
        if (liveness.listening) await new Promise<void>((settle) => liveness.close(() => settle()));
        assert.ok(resolve(root).startsWith(join(resolve(tmpdir()), "council-integration-host-")));
        try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (error) { cleanupError ??= error; }
        if (cleanupError) throw cleanupError;
    }
}

await test("integration attempts", { concurrency: 4 }, async (suite) => {
    await Promise.all((["host", "agent", "protected", "failed", "conflict", "begin-retry", "finish-retry", "late-begin", "late-finish", "old-schema", "overflow", "retry-protected", "private", "nomination-changed", "renominate-same", "renominate-agent"] as const)
        .filter((mode) => !process.env.COUNCIL_TEST_INTEGRATION_MODES || process.env.COUNCIL_TEST_INTEGRATION_MODES.split(",").includes(mode))
        .map((mode) => suite.test(`integration attempt ${mode}`, async () => {
        const result = await scenario(mode);
        assert.deepEqual(result.errors, []);
        assert.equal(result.calls.some((call) => call.name === "council_integration_report"), false, "new host must never write legacy summaries");
        const begins = result.calls.filter((call) => call.name === "council_integration_begin");
        const finishes = result.calls.filter((call) => call.name === "council_integration_finish");
        if (mode === "old-schema") { assert.equal(begins.length, 0); assert.equal(result.branches, ""); return; }
        assert.ok(begins.length > 0);
        if (mode === "late-begin") { assert.equal(finishes.length, 0); assert.equal(result.branches, ""); assert.equal(result.health.code, null); return; }
        assert.ok(finishes.length > 0);
        const finish = finishes[0].arguments;
        assert.equal(finish.attemptId, begins[0].arguments.attemptId);
        assert.equal(finish.leaseEpoch, begins[0].arguments.leaseEpoch);
        assert.equal(finish.status, mode === "protected" || mode === "failed" || mode === "overflow" ? "failed" : mode === "conflict" ? "conflict" : "verified");
        assert.equal(finish.executionId, mode === "agent" || mode === "nomination-changed" || mode === "renominate-same" ? "execution-2" : null);
        const evidence = finish.evidence as { receipts: { outputTail: string; exitCode: number | null }[]; changedPaths: string[]; diffSummary: string; protectedRefs: { before: unknown; after: unknown } };
        if (mode === "overflow") { assert.equal(evidence.changedPaths, null); assert.equal(evidence.diffSummary, null); assert.equal(result.branches.split("\n").length, 1); return; }
        assert.ok(evidence.receipts.length > 0);
        assert.deepEqual(evidence.changedPaths, ["content.txt"]);
        assert.match(evidence.diffSummary, /content.txt/);
        if (mode === "protected") assert.notDeepEqual(evidence.protectedRefs.after, evidence.protectedRefs.before);
        else assert.deepEqual(evidence.protectedRefs.after, evidence.protectedRefs.before);
        assert.equal(JSON.stringify(evidence).includes("fixture-private-host-secret"), false);
        assert.equal(JSON.stringify(evidence).includes("arbitrary-private-value-123"), false);
        assert.equal(JSON.stringify(evidence).includes(result.root.replaceAll("\\", "\\\\")), false);
        if (mode === "host" || mode === "agent") assert.equal(finish.tipSha, result.acceptedSha, "begin response manifest is authoritative");
        if (mode === "begin-retry") { assert.equal(begins.length, 2); assert.deepEqual(begins[1].arguments, begins[0].arguments); }
        if (mode === "finish-retry") { assert.equal(finishes.length, 2); assert.deepEqual(finishes[1].arguments, finishes[0].arguments); assert.equal(result.branches.split("\n").length, 1); }
        if (mode === "retry-protected") { assert.equal(finishes.length, 2, "an accepted result with a lost reply must be confirmed by identical retry"); assert.deepEqual(finishes[1].arguments, finishes[0].arguments); assert.equal(result.branches.split("\n").length, 1); }
        if (mode === "late-finish") assert.equal(result.health.code, null);
        if (mode.startsWith("renominate-")) {
            assert.equal(begins.length, 2); assert.equal(finishes.length, 2);
            assert.notEqual(begins[1].arguments.attemptId, begins[0].arguments.attemptId);
            assert.equal(finishes[1].arguments.attemptId, begins[1].arguments.attemptId);
            assert.notEqual(finishes[1].arguments.branch, finishes[0].arguments.branch);
            assert.equal(finishes[1].arguments.executionId, mode === "renominate-same" ? "execution-3" : "execution-2");
        }
        if (mode === "agent") {
            assert.equal(result.calls.filter((call) => call.name === "council_execution_start").length, 2);
            const registration = result.calls.findLast((call) => call.name === "council_execution_start")!;
            assert.equal(registration.arguments.branch, finish.branch);
        }
    })));
});
