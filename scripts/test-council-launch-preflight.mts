import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { councilWorktreeDir } from "../src/lib/council/protocol.ts";
import { parseSupervisionLine } from "../src/lib/council/supervisor.ts";
import { configuredSelection, preflightCouncilPaths, requireLaunchPreflightProtocol } from "./council-launch-preflight.mts";

let passed = 0;
function check(name: string, action: () => void): void {
    action();
    passed++;
    console.log(`  ok    ${name}`);
}
async function rejects(name: string, action: () => Promise<unknown>, match: RegExp): Promise<void> {
    await assert.rejects(action, match);
    passed++;
    console.log(`  ok    ${name}`);
}

const root = mkdtempSync(join(tmpdir(), "council-preflight-"));
const repo = join(root, "repo");
const otherRepo = join(root, "other");
const sourceRepo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const code = "CN-2222";
const names = ["alpha", "beta"];
function git(at: string, args: string[]): { ok: boolean; out: string } {
    const result = spawnSync("git", ["-C", at, ...args], { encoding: "utf8" });
    return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}
function gitOk(at: string, args: string[]): void {
    const result = git(at, args);
    assert.ok(result.ok, result.out);
}
const inspectPaths = (plannedNames = names) => preflightCouncilPaths(repo, code, plannedNames, async (at, args) => git(at, args));
const selectionDefaults = {
    name: "alpha", defaultModel: "supported", defaultReasoningEffort: "high",
    allowedModels: ["supported"], allowedReasoningEfforts: ["high"], selection: {},
};

try {
    for (const at of [repo, otherRepo]) {
        mkdirSync(at);
        gitOk(at, ["init", "-b", "main"]);
        gitOk(at, ["-c", "user.name=Council test", "-c", "user.email=council-test@localhost", "commit", "--allow-empty", "-m", "fixture"]);
    }
    check("effective defaults are validated", () => assert.deepEqual(configuredSelection(selectionDefaults), {
        requestedModel: "supported", requestedReasoningEffort: "high",
    }));
    for (const [name, patch, match] of [
        ["invalid explicit model", { selection: { modelId: "missing" } }, /allowedModels/],
        ["invalid default model", { defaultModel: "missing" }, /allowedModels/],
        ["invalid explicit reasoning", { selection: { reasoningEffort: "low" } }, /not allowed/],
        ["invalid default reasoning", { defaultReasoningEffort: "low" }, /not allowed/],
        ["non-string model", { selection: { modelId: 42 } }, /allowedModels/],
        ["empty explicit model", { selection: { modelId: "" } }, /allowedModels/],
    ] as const) {
        check(name, () => assert.throws(() => configuredSelection({ ...selectionDefaults, ...patch }), match));
    }
    await inspectPaths();
    check("fresh launch leaves planned paths absent", () => assert.equal(existsSync(resolve(repo, councilWorktreeDir(repo, code, names[0]))), false));
    await rejects("normalised names cannot share a branch", () => inspectPaths(["alpha-one", "alpha_one"]), /colliding/);

    const tree = resolve(repo, councilWorktreeDir(repo, code, names[0]));
    mkdirSync(tree);
    await rejects("existing directory is rejected", () => inspectPaths(), /already exists/);
    rmSync(tree, { recursive: true });
    writeFileSync(tree, "occupied\n");
    await rejects("existing file is rejected", () => inspectPaths(), /already exists/);
    rmSync(tree);
    const runDir = join(root, ".council-run-cn-2222");
    mkdirSync(runDir);
    await rejects("existing run journal is rejected", () => inspectPaths(), /already exists/);
    rmSync(runDir, { recursive: true });
    gitOk(repo, ["branch", "council/cn-2222/alpha"]);
    await rejects("existing branch is rejected", () => inspectPaths(), /collides with existing branch/);
    gitOk(repo, ["tag", "council/cn-2222/alpha"]);
    await rejects("tag ambiguity cannot disguise a branch collision", () => inspectPaths(), /collides with existing branch/);
    gitOk(repo, ["tag", "-d", "council/cn-2222/alpha"]);
    gitOk(repo, ["branch", "-D", "council/cn-2222/alpha"]);
    gitOk(repo, ["config", "core.ignorecase", "true"]);
    gitOk(repo, ["branch", "Council/CN-2222/Alpha"]);
    await rejects("case-insensitive branch collision is rejected", () => inspectPaths(), /collides with existing branch/);
    gitOk(repo, ["branch", "-D", "Council/CN-2222/Alpha"]);
    gitOk(repo, ["branch", "council"]);
    await rejects("branch namespace conflict is rejected", () => inspectPaths(), /collides with existing branch/);
    gitOk(repo, ["branch", "-D", "council"]);
    gitOk(repo, ["worktree", "add", "--detach", tree, "HEAD"]);
    rmSync(tree, { recursive: true, force: true });
    await rejects("missing but registered worktree is rejected", () => inspectPaths(), /already registered/);
    gitOk(repo, ["worktree", "prune"]);

    await rejects("older server is rejected before convene", () => requireLaunchPreflightProtocol(async () => ({
        tools: [{ name: "council_convene", inputSchema: { properties: {} } }],
    })), /does not support/);
    let listPages = 0;
    await requireLaunchPreflightProtocol(async (cursor) => {
        listPages++;
        return cursor ? { tools: [{ name: "council_convene", inputSchema: { properties: { requestedCode: { type: "string" } } } }] }
            : { tools: [], nextCursor: "page2" };
    });
    check("tools/list pagination finds the contract", () => assert.equal(listPages, 2));

    const calls: { method: string; params?: { name?: string; arguments?: Record<string, unknown> } }[] = [];
    let oldServer = false;
    let wrongCode = false;
    const mcp = createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const rpc = JSON.parse(raw) as typeof calls[number];
        calls.push(rpc);
        let result: unknown;
        if (rpc.method === "tools/list") {
            result = { tools: [{ name: "council_convene", inputSchema: { properties: oldServer ? {} : { requestedCode: { type: "string" } } } }] };
        } else if (rpc.params?.name === "council_convene") {
            const createdCode = wrongCode ? "CN-3333" : rpc.params.arguments?.requestedCode;
            result = { content: [{ type: "text", text: `COUNCIL OPENED - code ${createdCode}\n--- PASTE INTO alpha ---\nfixture\n--- PASTE INTO beta ---\nfixture` }] };
        } else {
            result = { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "fixture lease rejection" }) }] };
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
    mcp.listen(0, "127.0.0.1");
    await once(mcp, "listening");
    const address = mcp.address();
    assert.ok(address && typeof address === "object");
    const home = join(root, "home");
    mkdirSync(home);
    const configPath = join(root, "agents.json");
    writeFileSync(configPath, JSON.stringify({
        mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
        host: { port: 0, repos: { primary: { path: repo }, alternate: { path: otherRepo } } },
        agents: { fixture: { command: process.execPath, args: [], mode: "shell" } },
        instances: Object.fromEntries([...names, "alpha-one", "alpha_one", "bad-default", "bad-reasoning"].map((name) => [name, {
            provider: "fixture", defaultModel: name === "bad-default" ? "missing" : "supported", allowedModels: ["supported"],
            defaultReasoningEffort: name === "bad-reasoning" ? "low" : "high", allowedReasoningEfforts: ["high"],
        }])),
    }));
    const preload = join(root, "fixed-code.cjs");
    writeFileSync(preload, "Math.random = () => 0;\n");
    const child = spawn(process.execPath, ["--require", preload, "--import", "tsx", join(sourceRepo, "scripts", "council-host.mts"), "--repo", repo, "--config", configPath], {
        cwd: sourceRepo,
        env: { ...process.env, HOME: home, USERPROFILE: home, MCP_COUNCIL_HOST_KEY: "fixture-only", ZUYCHIN_SUPERVISED: "1", ZUYCHIN_HOST_LAUNCH: "" },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    const healthEvents: { type: string; councilCode?: string | null; draining?: boolean; lifecycle?: string }[] = [];
    let buffered = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        buffered += chunk;
        for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
            const parsed = parseSupervisionLine(buffered.slice(0, end));
            buffered = buffered.slice(end + 1);
            if (parsed?.ok && parsed.value.type === "health") healthEvents.push(parsed.value);
        }
    });
    child.stderr.resume();
    let socket: WebSocket | undefined;
    try {
        const identityPath = join(root, ".council-host", "host-repo.json");
        const deadline = Date.now() + 15_000;
        while (!existsSync(identityPath)) {
            if (child.exitCode !== null || Date.now() > deadline) throw new Error("fixture host failed to start");
            await new Promise((resume) => setTimeout(resume, 25));
        }
        const identity = JSON.parse(readFileSync(identityPath, "utf8")) as { port: number; token: string };
        socket = new WebSocket(`ws://127.0.0.1:${identity.port}/ws`, identity.token);
        await once(socket, "open");
        const launch = { type: "convene", topic: "fixture", brief: "fixture", agents: names, closer: names[0], councilType: "code" };
        async function launchError(patch: Record<string, unknown> = {}): Promise<string> {
            return new Promise((settle, reject) => {
                const timer = setTimeout(() => { socket!.off("message", onMessage); reject(new Error("fixture launch timed out")); }, 10_000);
                const onMessage = (raw: WebSocket.RawData) => {
                    const message = JSON.parse(raw.toString()) as { type: string; detail?: string };
                    if (message.type !== "error") return;
                    clearTimeout(timer);
                    socket!.off("message", onMessage);
                    settle(message.detail ?? "");
                };
                socket!.on("message", onMessage);
                socket!.send(JSON.stringify({ ...launch, ...patch }));
            });
        }
        for (const [label, patch, match] of [
            ["explicit model", { workspace: "alternate", selections: { alpha: { modelId: "missing" } } }, /allowedModels/],
            ["default model", { agents: ["bad-default", "beta"], closer: "beta" }, /allowedModels/],
            ["explicit reasoning", { selections: { alpha: { reasoningEffort: "low" } } }, /not allowed/],
            ["default reasoning", { agents: ["bad-reasoning", "beta"], closer: "beta" }, /not allowed/],
            ["unknown adapter", { agents: ["unknown", "beta"], closer: "beta" }, /no provider adapter/],
            ["slug collision", { agents: ["alpha-one", "alpha_one"], closer: "alpha-one" }, /colliding/],
        ] as const) {
            const error = await launchError(patch);
            check(`real host rejects ${label} before any MCP call`, () => {
                assert.match(error, match);
                assert.equal(calls.length, 0);
            });
        }
        mkdirSync(tree);
        const occupiedError = await launchError();
        check("real host rejects occupied worktree before convene, lease or seats", () => {
            assert.match(occupiedError, /already exists/);
            assert.equal(calls.length, 0);
        });
        rmSync(tree, { recursive: true });
        oldServer = true;
        const oldError = await launchError();
        check("real host refuses old server without creating a council", () => {
            assert.match(oldError, /does not support/);
            assert.deepEqual(calls.map((call) => call.method), ["tools/list"]);
        });
        calls.length = 0;
        oldServer = false;
        wrongCode = true;
        const mismatchError = await launchError();
        check("mismatched server code cannot claim a lease", () => {
            assert.match(mismatchError, /instead of preflighted code/);
            assert.deepEqual(calls.map((call) => call.params?.name ?? call.method), ["tools/list", "council_convene"]);
        });
        calls.length = 0;
        wrongCode = false;
        const leaseError = await launchError();
        check("valid retry uses preflighted code and claims only after creation", () => {
            assert.match(leaseError, /fixture lease rejection/);
            assert.deepEqual(calls.map((call) => call.params?.name ?? call.method), ["tools/list", "council_convene", "council_host_claim"]);
            assert.equal(calls[1].params?.arguments?.requestedCode, code);
            const workspace = calls[1].params?.arguments?.workspace as { repoPath?: string };
            assert.equal(workspace.repoPath, repo);
        });
        const response = await fetch(`http://127.0.0.1:${identity.port}/health`, { headers: { Authorization: `Bearer ${identity.token}` } });
        const health = await response.json() as { code: string | null; repo: string; runDir: string | null; busy: boolean; agents: unknown[] };
        check("failed preflight retains idle workspace and permits retry", () => {
            assert.equal(health.code, null);
            assert.equal(health.repo, repo);
            assert.equal(health.runDir, null);
            assert.equal(health.busy, false);
            assert.deepEqual(health.agents, []);
            assert.equal(existsSync(runDir), false);
        });
        check("supervisor sees pending launch as draining before code allocation", () => {
            assert.ok(healthEvents.some((event) => event.councilCode === null && event.draining && event.lifecycle === "draining"));
            assert.equal(healthEvents.at(-1)?.draining, false);
        });
    } finally {
        socket?.close();
        child.stdin.end();
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        await closed;
        clearTimeout(killTimer);
        mcp.closeAllConnections();
        await new Promise<void>((settle) => mcp.close(() => settle()));
    }
    console.log(`\n${passed} launch preflight checks passed.`);
} finally {
    assert.ok(root.startsWith(join(tmpdir(), "council-preflight-")));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
