import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { killTree } from "./council-host-paths.mts";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const names = ["alpha-seat", "beta-seat"];
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|PROGRAMFILES|PROGRAMFILES\(X86\)|SYSTEMDRIVE)$/i.test(name)));
type Mode = "legacy" | "legacy-set" | "legacy-error" | "legacy-malformed" | "legacy-timeout" | "legacy-unadvertised" | "stable" | "wrong-model" | "missing-model" | "wrong-final";
type Rpc = { id?: unknown; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
type Trace = { pid?: number; cwd?: string; method?: string; configId?: string; value?: string; modelId?: string };
type HostMessage = { type: string; agent?: string; detail?: string; agents?: { name: string; state: string }[] };

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
    }
}

async function until(predicate: () => boolean, description: string, timeoutMs = 15_000, child?: ChildProcess): Promise<void> {
    const limit = Date.now() + timeoutMs;
    while (!predicate()) {
        if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`fixture host exited before ${description}`);
        if (Date.now() >= limit) throw new Error(`timed out waiting for ${description}`);
        await new Promise((settle) => setTimeout(settle, 25));
    }
}

async function bounded<T>(promise: Promise<T>, description: string, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), timeoutMs);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

async function scenario(mode: Mode) {
    const root = mkdtempSync(join(tmpdir(), "council-model-evidence-"));
    const repo = join(root, "repo");
    const home = join(root, "home");
    const traces = join(root, "traces");
    for (const path of [repo, home, traces]) mkdirSync(path);
    const env: NodeJS.ProcessEnv = { ...baseEnv, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home,
        CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
        MCP_COUNCIL_HOST_KEY: "fixture-only-host-key", ZUYCHIN_SUPERVISED: "1", NODE_ENV: "test" };
    const git = (...args: string[]) => {
        const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env, timeout: 10_000 });
        assert.equal(result.status, 0, result.error?.message ?? result.stderr);
        return result.stdout.trim();
    };
    const readTraces = (): Trace[][] => readdirSync(traces).map((name) => readFileSync(join(traces, name), "utf8")
        .split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line) as Trace));
    const calls: Rpc[] = [];
    const unexpected: string[] = [];
    let child: ChildProcess | undefined;
    let closed: Promise<unknown> | undefined;
    let socket: WebSocket | undefined;
    let baseSha = "";
    const mcp = createServer(async (request, response) => {
        try {
            assert.equal(request.url, "/mcp");
            assert.equal(request.method, "POST");
            assert.ok(["Bearer fixture-only-host-key", "Bearer fixture-only-seat-key"].includes(request.headers.authorization ?? ""));
            let raw = "";
            for await (const chunk of request) raw += chunk;
            const rpc = JSON.parse(raw) as Rpc;
            calls.push(rpc);
            let payload: unknown = { ok: true };
            if (rpc.method === "tools/list") {
                payload = { tools: [
                    { name: "council_convene", inputSchema: { properties: { requestedCode: { type: "string" } } } },
                    { name: "council_dispatch", inputSchema: { properties: { statusOnly: { type: "boolean" } } } },
                    { name: "council_host_issue_seat", inputSchema: { properties: { bindExecution: { type: "boolean" } } } },
                    { name: "council_host_claim", inputSchema: { properties: { policyVersion: { type: "string", const: "typescript-node-v3-2026-09-30" } } } },
                    { name: "council_execution_start", inputSchema: { properties: { seatTokenHash: { type: "string" }, policyVersion: { type: "string", const: "typescript-node-v3-2026-09-30" } } } },
                ] };
            } else if (rpc.method === "tools/call") {
                const args = rpc.params?.arguments ?? {};
                switch (rpc.params?.name) {
                    case "council_convene":
                        payload = `COUNCIL OPENED - code ${args.requestedCode}\n${names.map((name) => `--- PASTE INTO ${name} ---\nSynthetic fixture prompt`).join("\n")}`;
                        break;
                    case "council_host_claim":
                        payload = { ok: true, leaseEpoch: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                            hostGeneration: null, policyVersion: null, hasExecutionHistory: false,
                            session: { id: "11111111-1111-4111-8111-111111111111", protocolVersion: 3, baseSha,
                                repoPath: repo, baseBranch: "main", topic: "fixture", status: "open" } };
                        break;
                    case "council_host_issue_seat":
                        assert.equal(args.bindExecution, true);
                        payload = { ok: true, token: "fixture-only-seat-key", executionBindingRequired: true }; break;
                    case "council_execution_start":
                        assert.match(String(args.seatTokenHash), /^[0-9a-f]{64}$/);
                        payload = { ok: true, executionId: `fixture-${args.agentName}`, seatBound: true,
                            hostGeneration: "typescript-node", policyVersion: "typescript-node-v3-2026-09-30" }; break;
                    case "council_dispatch":
                        if (args.statusOnly === true) assert.equal(args.ackDeliveryIds, undefined);
                        payload = { status: "open", pausedAt: null, round: 1, maxRounds: 3, floorHolder: null, agents: {},
                            ...(args.statusOnly === true ? { statusOnly: true } : {}) };
                        break;
                    case "council_join":
                    case "council_execution_stop":
                    case "council_host_release": break;
                    case "council_host_renew": payload = { ok: true, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }; break;
                    default: throw new Error(`unexpected fixture tool: ${rpc.params?.name}`);
                }
                payload = { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }] };
            } else throw new Error(`unexpected fixture method: ${rpc.method}`);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: payload }));
        } catch (error) {
            unexpected.push(error instanceof Error ? error.message : String(error));
            response.writeHead(500);
            response.end("fixture request rejected");
        }
    });
    try {
        git("init", "-b", "main");
        git("config", "core.fsmonitor", "false");
        git("-c", "user.name=Council fixture", "-c", "user.email=council-fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
        baseSha = git("rev-parse", "HEAD");
        mcp.listen(0, "127.0.0.1");
        await bounded(once(mcp, "listening"), "fixture MCP listener", 5_000);
        const address = mcp.address();
        assert.ok(address && typeof address === "object");
        const configPath = join(root, "agents.json");
        writeFileSync(configPath, JSON.stringify({
            mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
            host: { port: 0, autoAdopt: false },
            agents: Object.fromEntries(names.map((name, index) => [name, {
                command: process.execPath, mode: "acp", version: "wrong-configured-version",
                args: [join(source, "scripts/fixtures/council-model-evidence-agent.mjs"), traces,
                    mode === "legacy-timeout" && index === 1 ? "legacy-error" : mode],
            }])),
            instances: Object.fromEntries(names.map((name) => [name, { provider: name,
                allowedModels: mode.startsWith("legacy") ? ["default", "sonnet", "unadvertised"] : ["alpha", "beta"], allowedReasoningEfforts: ["medium", "high"],
            }])),
        }));
        child = spawn(process.execPath, ["--import", "tsx", join(source, "scripts/council-host.mts"), "--repo", repo, "--config", configPath], {
            cwd: source, env, stdio: ["pipe", "pipe", "pipe"],
        });
        closed = once(child, "close");
        child.stdout!.resume();
        child.stderr!.resume();
        // The host writes this file in place, so it can exist before it holds JSON.
        const identityPath = join(root, ".council-host", "host-repo.json");
        const readIdentity = () => { try { return JSON.parse(readFileSync(identityPath, "utf8")) as { port: number; token: string }; } catch { return null; } };
        await until(() => readIdentity() !== null, "fixture host identity", 15_000, child);
        const identity = readIdentity()!;
        socket = new WebSocket(`ws://127.0.0.1:${identity.port}/ws`, identity.token);
        const messages: HostMessage[] = [];
        socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as HostMessage));
        await bounded(once(socket, "open"), "fixture host control channel", 5_000);
        socket.send(JSON.stringify({ type: "convene", topic: "fixture", brief: "fixture", agents: names, closer: names[0], councilType: "code",
            ...(mode === "legacy" ? {} : { selections: Object.fromEntries(names.map((name) => [name,
                mode.startsWith("legacy") ? { modelId: mode === "legacy-unadvertised" ? "unadvertised" : "sonnet" }
                    : { modelId: "beta", reasoningEffort: "high" }])) }),
        }));
        const success = mode === "legacy" || mode === "legacy-set" || mode === "stable";
        await until(() => success
            ? calls.filter((call) => call.params?.name === "council_execution_start").length === names.length
                && readTraces().filter((records) => records.some((record) => record.method === "session/prompt")).length === names.length
            : messages.some((message) => message.type === "state" && message.agents?.length === names.length
                && message.agents.every((agent) => agent.state === "failed")), "model negotiation outcome", mode === "legacy-timeout" ? 40_000 : 15_000, child);
        socket.terminate();
        socket = undefined;
        child.stdin!.end();
        await bounded(closed, "fixture host shutdown", 7_000);
        assert.equal(child.exitCode, 0, "fixture host must stop normally");
        assert.deepEqual(unexpected, []);
        const result = { calls, traces: readTraces(), errors: messages.filter((message) => message.type === "error") };
        assert.equal(result.traces.length, names.length);
        assert.ok(result.traces.every((records) => records[0].cwd?.startsWith(root)));
        return result;
    } finally {
        socket?.terminate();
        if (child && child.exitCode === null && child.signalCode === null) {
            child.stdin?.end();
            try { await bounded(closed!, "fixture host cleanup", 5_000); }
            catch { killTree(child); await bounded(closed!, "forced fixture host cleanup", 5_000); }
        }
        const adapterPids = readTraces().flatMap((records) => records[0]?.pid ? [records[0].pid] : []);
        await until(() => adapterPids.every((pid) => !alive(pid)), "fixture adapter exit deadline", 65_000);
        mcp.closeAllConnections();
        if (mcp.listening) await bounded(new Promise<void>((settle) => mcp.close(() => settle())), "fixture MCP shutdown", 5_000);
        assert.ok(resolve(root).startsWith(join(resolve(tmpdir()), "council-model-evidence-")));
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

await test("actual host records the legacy default alias and observed adapter version", async () => {
    const result = await scenario("legacy");
    const executions = result.calls.filter((call) => call.params?.name === "council_execution_start");
    assert.equal(executions.length, names.length);
    assert.deepEqual(result.errors, []);
    for (const call of executions) {
        const args = call.params!.arguments!;
        assert.equal(args.effectiveModel, "default");
        assert.equal(args.requestedModel, undefined);
        assert.equal(args.adapterVersion, "observed-1.2.3");
        assert.equal(args.modelSource, "adapter_legacy_models");
        assert.equal((args.capabilities as { modelSelection: boolean }).modelSelection, true);
    }
    for (const records of result.traces) {
        assert.deepEqual(records.filter((record) => record.method).map((record) => record.method), ["initialize", "session/new", "session/prompt"]);
    }
});

for (const mode of ["wrong-model", "missing-model", "wrong-final"] as const) {
    await test(`actual host rejects ${mode} readback before execution recording or prompts`, async () => {
        const result = await scenario(mode);
        assert.equal(result.calls.filter((call) => call.params?.name === "council_execution_start").length, 0);
        assert.equal(result.calls.filter((call) => call.params?.name === "council_join").length, 0);
        assert.equal(result.errors.filter((message) => message.agent && names.includes(message.agent)).length, names.length);
        for (const message of result.errors) {
            assert.match(message.detail ?? "", mode === "wrong-final" ? /changed or omitted the model/ : /did not confirm the requested model/);
        }
        for (const records of result.traces) {
            assert.equal(records.some((record) => record.method === "session/prompt"), false);
            assert.equal(records.filter((record) => record.method === "session/set_config_option").length, mode === "wrong-final" ? 2 : 1);
        }
    });
}

await test("actual host records the final stable model and reasoning readback", async () => {
    const result = await scenario("stable");
    const executions = result.calls.filter((call) => call.params?.name === "council_execution_start");
    assert.equal(executions.length, names.length);
    assert.deepEqual(result.errors, []);
    for (const call of executions) {
        const args = call.params!.arguments!;
        assert.equal(args.requestedModel, "beta");
        assert.equal(args.effectiveModel, "beta");
        assert.equal(args.requestedReasoningEffort, "high");
        assert.equal(args.effectiveReasoningEffort, "high");
        assert.equal(args.adapterVersion, "observed-1.2.3");
        assert.equal(args.modelSource, "adapter_config");
        assert.equal((args.capabilities as { modelSelection: boolean }).modelSelection, true);
    }
    for (const records of result.traces) {
        assert.deepEqual(records.filter((record) => record.method === "session/set_config_option"), [
            { method: "session/set_config_option", configId: "fixture-model", value: "beta" },
            { method: "session/set_config_option", configId: "fixture-effort", value: "high" },
        ]);
        assert.equal(records.filter((record) => record.method === "session/prompt").length, 1);
    }
});

await test("actual host records successful legacy negotiation before joining and prompting", async () => {
    const result = await scenario("legacy-set");
    const executions = result.calls.filter((call) => call.params?.name === "council_execution_start");
    assert.equal(executions.length, names.length);
    assert.deepEqual(result.errors, []);
    for (const call of executions) {
        const args = call.params!.arguments!;
        assert.equal(args.requestedModel, "sonnet");
        assert.equal(args.effectiveModel, "sonnet");
        assert.equal(args.effectiveReasoningEffort, undefined);
        assert.equal(args.adapterVersion, "observed-1.2.3");
        assert.equal(args.modelSource, "adapter_legacy_set_model");
        assert.equal((args.capabilities as { modelSelection: boolean }).modelSelection, true);
    }
    for (const records of result.traces) {
        assert.deepEqual(records.filter((record) => record.method).map((record) => record.method), [
            "initialize", "session/new", "session/set_model", "session/prompt",
        ]);
        assert.deepEqual(records.find((record) => record.method === "session/set_model"), { method: "session/set_model", modelId: "sonnet" });
    }
});

for (const mode of ["legacy-error", "legacy-malformed", "legacy-unadvertised", "legacy-timeout"] as const) {
    await test("actual host rejects " + mode + " before execution recording, join or prompt", async () => {
        const result = await scenario(mode);
        assert.equal(result.calls.filter((call) => call.params?.name === "council_execution_start").length, 0);
        assert.equal(result.calls.filter((call) => call.params?.name === "council_join").length, 0);
        assert.equal(result.errors.filter((message) => message.agent && names.includes(message.agent)).length, names.length);
        const expectedError = mode === "legacy-error" ? /Legacy fixture rejected model/
            : mode === "legacy-malformed" ? /acknowledg/
            : mode === "legacy-unadvertised" ? /did not advertise model/
            : /time.?out|timed out|deadline|aborted|Legacy fixture rejected model/i;
        for (const message of result.errors) assert.match(message.detail ?? "", expectedError);
        if (mode === "legacy-timeout") {
            assert.equal(result.errors.filter((message) => /time.?out|timed out|deadline|aborted/i.test(message.detail ?? "")).length, 1);
        }
        for (const records of result.traces) {
            assert.equal(records.some((record) => record.method === "session/prompt"), false);
            assert.equal(records.some((record) => record.method === "session/set_config_option"), false);
            assert.equal(records.filter((record) => record.method === "session/set_model").length, mode === "legacy-unadvertised" ? 0 : 1);
        }
    });
}
