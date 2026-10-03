import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { killTree } from "./council-host-paths.mts";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const name = "alpha-seat";
const code = "CN-ABCD";
const policyVersion = "typescript-node-v3-2026-09-30";
type PolicyCase = "claim-schema-missing" | "start-schema-missing" | "claim-schema-wrong" | "start-schema-wrong"
    | "start-schema-malformed"
    | "boundary-missing" | "boundary-unknown-history" | "boundary-partial" | "boundary-policy" | "boundary-generation"
    | "journal-policy" | "journal-generation" | "journal-missing-policy" | "journal-pending-ack" | "journal-pending-wrong-intent"
    | "fresh" | "ack-policy" | "ack-generation" | "ack-missing";
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|PROGRAMFILES|PROGRAMFILES\(X86\)|SYSTEMDRIVE)$/i.test(key)));
type Mode = "stable" | "reject" | "slow-execution" | "hang-initialize" | "hang-session" | "hang-selection" | "wrong-protocol"
    | "join-reject" | "late-execution" | "late-join" | "stop-reject" | "stop-error" | "stop-hang"
    | "expired-ready" | "expired-busy" | "expired-attach" | "expired-failed" | "expired-shell" | "expired-unhealthy" | "expired-unpaused"
    | "status-unsupported" | "status-schema-unsupported" | "binding-refused" | "binding-unconfirmed"
    | "binding-issue-unconfirmed" | "binding-old-issue" | "binding-old-start" | "binding-shell" | "binding-integration"
    | "binding-integration-unconfirmed" | "binding-integration-expired";
type Call = { name: string; arguments: Record<string, unknown> };
type Trace = { pid?: number; tokenHash?: string; method?: string; configId?: string; value?: string; prompt?: string };
type Message = { type: string; detail?: string; agents?: { state: string; executionId?: string | null; modelSource?: string; adapterVersion?: string | null }[] };

async function until(check: () => boolean, description: string, timeoutMs = 15_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${description}`);
        await new Promise((settle) => setTimeout(settle, 25));
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

async function scenario(mode: Mode, savedModel: string | null = "beta",
    journalFault?: "code" | "base" | "path" | "duplicate" | "missing" | "empty-model" | "seat-missing",
    freshInvite = false, savedReasoning: string | null = null,
    releaseMode?: "reject" | "error" | "hang", policyCase?: PolicyCase) {
    const root = mkdtempSync(join(tmpdir(), "council-host-lifecycle-"));
    const repo = join(root, "repo");
    const home = join(root, "home");
    const trace = join(root, "adapter.jsonl");
    const runDir = join(root, ".council-run-cn-abcd");
    const integrationMode = mode.startsWith("binding-integration");
    for (const path of [repo, home, runDir]) mkdirSync(path);
    const env: NodeJS.ProcessEnv = { ...baseEnv, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home,
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"), MCP_COUNCIL_HOST_KEY: "fixture-host-key",
        ZUYCHIN_SUPERVISED: "1", NODE_ENV: "test" };
    const git = (...args: string[]) => {
        const result = spawnSync("git", ["-C", repo, ...args], { env, encoding: "utf8", timeout: 10_000 });
        assert.equal(result.status, 0, result.error?.message ?? result.stderr);
        return result.stdout.trim();
    };
    const records = (): Trace[] => existsSync(trace) ? readFileSync(trace, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const calls: Call[] = [];
    const errors: string[] = [];
    const messages: Message[] = [];
    let child: ChildProcess | undefined;
    let closed: Promise<unknown> | undefined;
    let socket: WebSocket | undefined;
    let baseSha = "";
    let executionRecorded = false;
    let executionStopped = false;
    let responseClosedBeforeAck = false;
    let promptedBeforeExecution = false;
    let aliveDuringExpiryCleanup = false;
    let renewalExpired = false;
    let expiryDispatched = false;
    let listRequests = 0;
    const issuedTokens: string[] = [];
    let spawnedBeforeBinding = false;
    let journalBeforeExecution: Record<string, unknown> | null = null;
    const mcp = createServer(async (request, response) => {
        try {
            assert.equal(request.headers.authorization?.startsWith("Bearer fixture-"), true);
            let raw = "";
            for await (const chunk of request) raw += chunk;
            const rpc = JSON.parse(raw);
            if (rpc.method === "tools/list") {
                listRequests++;
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: {
                    tools: [
                        { name: "council_dispatch", inputSchema: { properties:
                            mode === "status-schema-unsupported" ? {} : { statusOnly: { type: "boolean" } } } },
                        { name: "council_host_issue_seat", inputSchema: { properties:
                            mode === "binding-old-issue" ? {} : { bindExecution: { type: "boolean" } } } },
                        { name: "council_host_claim", inputSchema: { properties: { policyVersion: { type: "string",
                            ...(policyCase === "claim-schema-missing" ? {} : { const: policyCase === "claim-schema-wrong" ? "future-policy" : policyVersion }) } } } },
                        { name: "council_execution_start", inputSchema: { properties:
                            mode === "binding-old-start" ? {} : { seatTokenHash: { type: "string" }, policyVersion: { type: "string",
                                ...(policyCase === "start-schema-missing" ? {} : { enum: policyCase === "start-schema-malformed" ? policyVersion
                                    : [policyCase === "start-schema-wrong" ? "future-policy" : policyVersion] }) } } } },
                        { name: "council_integration_begin", inputSchema: { properties: { attemptId: { type: "string" } } } },
                        { name: "council_integration_finish", inputSchema: { properties: { evidence: { type: "object" } } } },
                    ],
                } }));
                return;
            }
            assert.equal(rpc.method, "tools/call");
            const call = rpc.params as Call;
            calls.push(call);
            let result: unknown = { ok: true };
            let toolError = false;
            switch (call.name) {
                case "council_host_claim": result = { ok: true, leaseEpoch: 2, leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
                    ...(policyCase === "boundary-missing" ? {} : {
                        hostGeneration: policyCase === "fresh" || policyCase === "boundary-unknown-history" ? null
                            : policyCase === "boundary-generation" ? "rust-native" : "typescript-node",
                        policyVersion: ["fresh", "boundary-unknown-history", "boundary-partial"].includes(policyCase ?? "") ? null
                            : policyCase === "boundary-policy" ? "future-policy" : policyVersion,
                        hasExecutionHistory: policyCase !== "fresh",
                    }),
                    session: { id: "11111111-1111-4111-8111-111111111111", protocolVersion: 3, baseSha,
                        repoPath: repo, baseBranch: "main", topic: "fixture", status: "open" } }; break;
                case "council_dispatch": result = { topic: "fixture", statusOnly: mode !== "status-unsupported" && call.arguments.statusOnly === true,
                    status: expiryDispatched || mode === "expired-attach" || mode === "expired-unpaused"
                        || (mode === "binding-integration-expired" && issuedTokens.length === 2)
                        || (mode === "expired-failed" && messages.some((message) => message.agents?.some((agent) => agent.state === "failed")))
                        || (mode === "expired-shell" && executionRecorded)
                        || (mode === "expired-unhealthy" && renewalExpired && (call.arguments.agentNames as string[]).includes("host-probe"))
                        || (["expired-ready", "expired-busy"].includes(mode) && !(call.arguments.agentNames as string[]).includes("host-probe")) ? "expired" : integrationMode ? "closed" : "open",
                    pausedAt: (mode.startsWith("expired-") && mode !== "expired-unpaused") || mode === "binding-integration-expired" ? "2026-09-01T00:00:00.000Z" : null,
                    round: 1, maxRounds: 3, floorHolder: name,
                    participants: [{ name, status: freshInvite ? "invited" : "joined", dispatchMode: !freshInvite }],
                    agents: { [name]: { status: "joined", prompt: "Synthetic pending delivery", deliveryId: "fixture-delivery" } } };
                    if ((result as { status: string }).status === "expired") expiryDispatched = true;
                    break;
                case "council_host_issue_seat":
                    issuedTokens.push(`fixture-seat-key-${issuedTokens.length + 1}`);
                    if (mode === "binding-integration-expired" && issuedTokens.length === 2) await new Promise((settle) => setTimeout(settle, 5_000));
                    result = { ok: true, token: issuedTokens.at(-1), executionBindingRequired: mode !== "binding-issue-unconfirmed" };
                    break;
                case "council_execution_start":
                    journalBeforeExecution ??= JSON.parse(readFileSync(join(runDir, "campaign-run.json"), "utf8"));
                    executionRecorded = true;
                    if (mode === "binding-shell") {
                        await new Promise((settle) => setTimeout(settle, 1_000));
                        spawnedBeforeBinding = records().some((record) => record.pid);
                    }
                    if (mode === "late-execution") {
                        await new Promise((settle) => setTimeout(settle, 32_000));
                        responseClosedBeforeAck = response.destroyed;
                    }
                    if (mode === "slow-execution") {
                        await new Promise((settle) => setTimeout(settle, 3_500));
                        promptedBeforeExecution = records().some((record) => record.method === "session/prompt");
                    }
                    result = mode === "binding-refused" ? { ok: false, reason: "fixture binding rejected" }
                        : { ok: true, executionId: integrationMode ? `fixture-execution-${issuedTokens.length}` : "fixture-execution",
                            seatBound: mode !== "binding-unconfirmed" && !(mode === "binding-integration-unconfirmed" && issuedTokens.length === 2),
                            ...(policyCase === "ack-missing" ? {} : {
                                hostGeneration: policyCase === "ack-generation" ? "rust-native" : "typescript-node",
                                policyVersion: policyCase === "ack-policy" ? "future-policy" : policyVersion,
                            }) };
                    break;
                case "council_delivery_state":
                    break;
                case "council_join":
                    if (mode === "late-join") await new Promise((settle) => setTimeout(settle, 32_000));
                    if (mode === "join-reject" || mode.startsWith("stop-")) toolError = true;
                    break;
                case "council_execution_stop":
                    if (mode.startsWith("expired-")) {
                        await new Promise((settle) => setTimeout(settle, mode === "expired-busy" ? 3_500 : 500));
                        aliveDuringExpiryCleanup = records().filter((record) => record.pid).some((record) => {
                            try { process.kill(record.pid!, 0); return true; } catch { return false; }
                        });
                        await new Promise((settle) => setTimeout(settle, 500));
                    }
                    if (mode === "stop-hang") return;
                    if (mode === "stop-error") { response.writeHead(503); response.end("fixture stop unavailable"); return; }
                    if (mode === "stop-reject") { result = { ok: false, reason: "fixture rejected stop" }; break; }
                    executionStopped = true;
                    break;
                case "council_host_release":
                    if (releaseMode === "hang") return;
                    if (releaseMode === "error") { response.writeHead(503); response.end("fixture release unavailable"); return; }
                    if (releaseMode === "reject") result = { ok: false, reason: "fixture rejected release" };
                    break;
                case "council_host_renew":
                    if (mode === "expired-unhealthy") { renewalExpired = true; result = { ok: false, reason: "expired" }; }
                    else result = { ok: true, leaseExpiresAt: new Date(Date.now() + 90_000).toISOString() };
                    break;
                case "council_work_unverified": result = { items: [] }; break;
                case "council_work_status": result = "SUPERVISE: complete"; break;
                case "council_integration_manifest":
                    result = { ok: true, integratorAgent: name, manifest: { baseSha, items: [] } }; break;
                case "council_integration_begin":
                    result = { ok: true, attempt: { id: call.arguments.attemptId, status: "running", mode: "agent", integratorAgent: name,
                        manifest: { baseSha, items: [] }, manifestHash: "a".repeat(64), baseBranch: "main", baseSha } }; break;
                case "council_integration_finish": result = { ok: true, attemptId: call.arguments.attemptId }; break;
                case "council_integration_report": break;
                default: throw new Error(`unexpected tool ${call.name}`);
            }
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id,
                result: { ...(toolError ? { isError: true } : {}), content: [{ type: "text", text: toolError ? "fixture join rejected" : typeof result === "string" ? result : JSON.stringify(result) }] } }));
        } catch (error) {
            errors.push(String(error)); response.writeHead(500); response.end("fixture error");
        }
    });
    try {
        git("init", "-b", "main"); git("config", "core.fsmonitor", "false");
        git("-c", "user.name=Council fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
        baseSha = git("rev-parse", "HEAD");
        const shell = mode === "expired-shell" || mode === "binding-shell";
        const savedSeat = { name, dir: join(root, "repo-cn-abcd-alpha-seat"), branch: "council/cn-abcd/alpha-seat", mode: shell ? "shell" : "acp",
            requestedModel: savedModel, requestedReasoningEffort: savedReasoning };
        const journal: Record<string, unknown> & { code: string; baseSha: string; agents: typeof savedSeat[] } = {
            code, baseSha, agents: [savedSeat],
            ...(policyCase === "fresh" || policyCase === "journal-missing-policy" ? {} : {
                hostGeneration: policyCase === "journal-generation" ? "rust-native" : "typescript-node",
                policyVersion: policyCase === "journal-policy" ? "future-policy" : policyVersion,
            }),
        };
        if (policyCase?.startsWith("journal-pending-")) Object.assign(journal, {
            sessionId: "11111111-1111-4111-8111-111111111111", repo,
            hostGeneration: null, policyVersion: null,
            executionBoundaryIntent: { hostGeneration: "typescript-node", policyVersion: policyCase === "journal-pending-wrong-intent" ? "future-policy" : policyVersion },
        });
        if (journalFault === "code") journal.code = "CN-WXYZ";
        if (journalFault === "base") journal.baseSha = "0".repeat(40);
        if (journalFault === "path") savedSeat.dir = join(root, "unrelated");
        if (journalFault === "duplicate") journal.agents.push({ ...savedSeat });
        if (journalFault === "empty-model") savedSeat.requestedModel = " ";
        if (journalFault === "seat-missing") journal.agents = [];
        const journalPath = join(runDir, "campaign-run.json");
        const originalJournal = JSON.stringify(journal);
        const transcriptPath = join(runDir, "transcript.txt");
        writeFileSync(transcriptPath, "Synthetic transcript retained after expiry.");
        if (journalFault !== "missing") writeFileSync(journalPath, originalJournal);
        mcp.listen(0, "127.0.0.1"); await bounded(once(mcp, "listening"), 5_000);
        const address = mcp.address(); assert.ok(address && typeof address === "object");
        const configPath = join(root, "agents.json");
        writeFileSync(configPath, JSON.stringify({ mcpUrl: `http://127.0.0.1:${address.port}/mcp`, host: { port: 0, autoAdopt: false },
            agents: { fixture: { mode: shell ? "shell" : "acp", command: process.execPath,
                ...(shell ? { version: "fixture-cli-1.0" } : {}),
                args: [join(source, "scripts/fixtures/council-lifecycle-agent.mjs"), trace, mode, ...(shell ? ["{model}", "{reasoningEffort}"] : [])] } },
            instances: { [name]: { provider: "fixture", allowedModels: ["alpha", "beta"],
                allowedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium",
                defaultModel: mode === "reject" || mode.startsWith("hang-") ? "beta" : "alpha" } } }));
        child = spawn(process.execPath, ["--import", "tsx", join(source, "scripts/council-host.mts"), "--repo", repo, "--config", configPath],
            { cwd: source, env, stdio: ["pipe", "pipe", "pipe"] });
        closed = once(child, "close"); child.stdout!.resume(); child.stderr!.resume();
        // The host writes this file in place, so it can exist before it holds JSON.
        const identityPath = join(root, ".council-host", "host-repo.json");
        const readIdentity = () => { try { return JSON.parse(readFileSync(identityPath, "utf8")) as { port: number; token: string }; } catch { return null; } };
        await until(() => readIdentity() !== null, "host identity");
        const identity = readIdentity()!;
        socket = new WebSocket(`ws://127.0.0.1:${identity.port}/ws`, identity.token);
        socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
        await bounded(once(socket, "open"), 5_000);
        socket.send(JSON.stringify({ type: "attach", code }));
        if (mode === "binding-integration-expired") {
            await until(() => issuedTokens.length === 2, "integration issuance", 40_000);
            await new Promise((settle) => setTimeout(settle, 6_000));
        } else if (mode === "binding-integration-unconfirmed") {
            await until(() => calls.some((call) => call.name === "council_integration_finish" && call.arguments.status === "failed"), "integration binding rejection", 40_000);
        } else if (mode === "binding-integration") {
            await until(() => records().some((record) => record.prompt?.includes("You are the nominated integrator")), "integration prompt", 40_000);
        } else if (mode === "binding-shell") {
            await until(() => executionRecorded && records().some((record) => record.pid), "bound shell spawn");
            await new Promise((settle) => setTimeout(settle, 1_200));
        } else if (policyCase && policyCase !== "fresh") {
            await until(() => messages.some((message) => message.type === "error")
                || (policyCase === "journal-pending-ack" ? records().some((record) => record.method === "session/prompt") : executionRecorded), "policy outcome");
            if (policyCase.startsWith("ack-")) await new Promise((settle) => setTimeout(settle, 3_500));
        } else if (mode.startsWith("binding-")) {
            await until(() => messages.some((message) => message.type === "error") || executionRecorded, "binding outcome");
            await new Promise((settle) => setTimeout(settle, 3_500));
        } else if ((journalFault && !freshInvite) || mode === "expired-attach" || mode.startsWith("status-")) {
            await until(() => messages.some((message) => message.type === "error") || executionRecorded, "journal outcome");
        } else if (["expired-failed", "expired-shell", "expired-unhealthy"].includes(mode)) {
            if (mode === "expired-failed") {
                await until(() => messages.some((message) => message.agents?.some((agent) => agent.state === "failed")), "failed adapter");
            } else if (mode === "expired-unhealthy") {
                await until(() => renewalExpired, "expired lease renewal", 20_000);
            } else await until(() => executionRecorded, "shell execution recorded");
            await new Promise((settle) => setTimeout(settle, 4_500));
        } else if (mode.startsWith("expired-")) {
            await until(() => calls.some((call) => call.name === "council_dispatch"
                && !(call.arguments.agentNames as string[]).includes("host-probe")), "expiry dispatch");
            await new Promise((settle) => setTimeout(settle, mode === "expired-busy" ? 6_500 : 3_500));
        } else if (mode === "reject" || mode === "wrong-protocol" || mode === "join-reject" || mode.startsWith("hang-") || mode.startsWith("late-") || mode.startsWith("stop-")) {
            await until(() => messages.some((message) => message.type === "state" && message.agents?.some((agent) => agent.state === "failed")),
                "failed startup", mode.startsWith("hang-") || mode.startsWith("late-") ? 40_000 : 15_000);
            await new Promise((settle) => setTimeout(settle, 3_500));
        } else {
            await until(() => executionRecorded && records().some((record) => record.method === "session/prompt"), "ready prompt");
        }
        const health = await fetch(`http://127.0.0.1:${identity.port}/health`, {
            headers: { Authorization: `Bearer ${identity.token}` }, signal: AbortSignal.timeout(3_000),
        }).then((response) => response.json()) as { code: string | null; leaseEpoch: number | null; leaseHealthy: boolean; busy: boolean; agents: unknown[] };
        return { calls: structuredClone(calls), records: records(), messages: structuredClone(messages), errors: [...errors], promptedBeforeExecution,
            executionStopped, responseClosedBeforeAck, health, aliveDuringExpiryCleanup,
            worktreeRetained: existsSync(savedSeat.dir), transcript: readFileSync(transcriptPath, "utf8"), listRequests, spawnedBeforeBinding,
            issuedTokenHashes: issuedTokens.map((token) => createHash("sha256").update(token).digest("hex")),
            originalJournal, journalBeforeExecution: journalBeforeExecution as Record<string, unknown> | null,
            journalText: existsSync(journalPath) ? readFileSync(journalPath, "utf8") : null,
            adapterAlive: records().filter((record) => record.pid).some((record) => {
                try { process.kill(record.pid!, 0); return true; } catch { return false; }
            }) };
    } finally {
        socket?.terminate();
        if (child && child.exitCode === null && child.signalCode === null) {
            child.stdin?.end();
            try { await bounded(closed!, 7_000); }
            catch { killTree(child); await bounded(closed!, 5_000); }
        }
        await until(() => records().filter((record) => record.pid).every((record) => {
            try { process.kill(record.pid!, 0); return false; } catch { return true; }
        }), "adapter cleanup", 47_000);
        mcp.closeAllConnections();
        if (mcp.listening) await bounded(new Promise<void>((settle) => mcp.close(() => settle())), 5_000);
        assert.ok(resolve(root).startsWith(join(resolve(tmpdir()), "council-host-lifecycle-")));
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

for (const policyCase of ["claim-schema-missing", "start-schema-missing", "claim-schema-wrong", "start-schema-wrong", "start-schema-malformed"] as const) {
    await test(`policy ${policyCase} is rejected before any lease mutation`, async () => {
        const result = await scenario("stable", "beta", undefined, false, null, undefined, policyCase);
        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.calls, []);
        assert.deepEqual(result.records, []);
        assert.equal(result.journalText, result.originalJournal);
    });
}

for (const policyCase of ["boundary-missing", "boundary-unknown-history", "boundary-partial", "boundary-policy", "boundary-generation",
    "journal-policy", "journal-generation", "journal-missing-policy", "journal-pending-wrong-intent"] as const) {
    await test(`policy ${policyCase} releases the captured lease without changing the journal or starting a seat`, async () => {
        const result = await scenario("stable", "beta", undefined, false, null, undefined, policyCase);
        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.records, []);
        assert.equal(result.journalText, result.originalJournal);
        assert.equal(result.calls.some((call) => call.name === "council_host_issue_seat"), false);
        const claim = result.calls.find((call) => call.name === "council_host_claim")!;
        assert.equal(claim.arguments.policyVersion, policyVersion);
        assert.deepEqual(result.calls.filter((call) => call.name === "council_host_release").map((call) => call.arguments), [
            { sessionCode: code, hostId: claim.arguments.hostId, leaseEpoch: 2 },
        ]);
        assert.equal(result.health.leaseEpoch, null);
    });
}

for (const policyCase of ["ack-policy", "ack-generation", "ack-missing"] as const) {
    await test(`policy ${policyCase} stops the exact execution without joining or prompting`, async () => {
        const result = await scenario("stable", "beta", undefined, false, null, undefined, policyCase);
        assert.deepEqual(result.errors, []);
        assert.equal(result.calls.some((call) => call.name === "council_join"), false);
        assert.equal(result.records.some((record) => record.method === "session/prompt"), false);
        assert.equal(result.executionStopped, true);
        assert.equal(result.adapterAlive, false);
        assert.equal((result.health.agents[0] as Record<string, unknown>).policyVersion, null);
    });
}

await test("policy fresh execution-free Council records the acknowledged boundary before prompting", async () => {
    const result = await scenario("stable", "beta", undefined, false, null, undefined, "fresh");
    assert.deepEqual(result.errors, []);
    assert.equal(result.calls.find((call) => call.name === "council_host_claim")?.arguments.policyVersion, policyVersion);
    assert.equal(result.calls.find((call) => call.name === "council_execution_start")?.arguments.policyVersion, policyVersion);
    assert.equal(result.journalBeforeExecution?.policyVersion, null);
    assert.equal(result.journalBeforeExecution?.hostGeneration, null);
    assert.deepEqual(result.journalBeforeExecution?.executionBoundaryIntent, { hostGeneration: "typescript-node", policyVersion });
    assert.equal(JSON.parse(result.journalText!).policyVersion, policyVersion);
    assert.equal(JSON.parse(result.journalText!).hostGeneration, "typescript-node");
    assert.equal((result.health.agents[0] as Record<string, unknown>).policyVersion, policyVersion);
    assert.equal((result.health.agents[0] as Record<string, unknown>).hostGeneration, "typescript-node");
    assert.equal(result.records.some((record) => record.method === "session/prompt"), true);
});

await test("policy reconnect recovers a pinned execution whose first acknowledgement was lost", async () => {
    const result = await scenario("stable", "beta", undefined, false, null, undefined, "journal-pending-ack");
    assert.deepEqual(result.errors, []);
    assert.equal(result.records.some((record) => record.method === "session/prompt"), true);
    assert.equal(result.calls.find((call) => call.name === "council_execution_start")?.arguments.requestedModel, "beta");
    assert.equal(JSON.parse(result.journalText!).policyVersion, policyVersion);
    assert.equal(JSON.parse(result.journalText!).hostGeneration, "typescript-node");
});

for (const mode of ["binding-refused", "binding-unconfirmed"] as const) {
    await test(`${mode} never joins or prompts and closes any acknowledged execution`, async () => {
        const result = await scenario(mode);
        assert.deepEqual(result.errors, []);
        assert.equal(result.calls.some((call) => call.name === "council_join"), false);
        assert.equal(result.records.some((record) => record.method === "session/prompt"), false);
        assert.equal(result.adapterAlive, false);
        assert.equal(result.executionStopped, mode === "binding-unconfirmed");
    });
}

for (const mode of ["binding-old-issue", "binding-old-start"] as const) {
    await test(`${mode} is rejected before a lease or adapter is created`, async () => {
        const result = await scenario(mode);
        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.calls, []);
        assert.deepEqual(result.records, []);
        assert.equal(result.health.code, null);
    });
}

await test("binding issuance acknowledgement is required before adapter launch", async () => {
    const result = await scenario("binding-issue-unconfirmed");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.records, []);
    assert.equal(result.calls.some((call) => call.name === "council_execution_start"), false);
});

await test("binding shell credentials are recorded before the process receives its prompt", async () => {
    const result = await scenario("binding-shell", "beta", undefined, false, "high");
    assert.deepEqual(result.errors, []);
    assert.equal(result.spawnedBeforeBinding, false);
    const issued = result.calls.find((call) => call.name === "council_host_issue_seat")!;
    const execution = result.calls.find((call) => call.name === "council_execution_start")!;
    assert.equal(issued.arguments.bindExecution, true);
    assert.equal(execution.arguments.seatTokenHash, result.issuedTokenHashes[0]);
    assert.equal(execution.arguments.effectiveModel, "beta");
    assert.equal(execution.arguments.effectiveReasoningEffort, "high");
    assert.equal(execution.arguments.adapterVersion, "fixture-cli-1.0");
    assert.equal(execution.arguments.modelSource, "configured_cli");
    assert.equal(result.records.find((record) => record.pid)?.tokenHash, result.issuedTokenHashes[0]);
});

await test("binding shell adapter defaults remain unknown in immutable evidence", async () => {
    const result = await scenario("binding-shell", null);
    assert.deepEqual(result.errors, []);
    const execution = result.calls.find((call) => call.name === "council_execution_start")!;
    assert.equal(execution.arguments.effectiveModel, undefined);
    assert.equal(execution.arguments.effectiveReasoningEffort, undefined);
    assert.equal(execution.arguments.modelSource, "unknown");
    assert.equal(execution.arguments.adapterVersion, "fixture-cli-1.0");
});

await test("binding integration uses a fresh credential for its replacement runtime", async () => {
    const result = await scenario("binding-integration");
    assert.deepEqual(result.errors, []);
    assert.equal(result.issuedTokenHashes.length, 2);
    assert.notEqual(result.issuedTokenHashes[0], result.issuedTokenHashes[1]);
    const executions = result.calls.filter((call) => call.name === "council_execution_start");
    assert.deepEqual(executions.map((call) => call.arguments.seatTokenHash), result.issuedTokenHashes);
    assert.deepEqual(result.records.filter((record) => record.pid).map((record) => record.tokenHash), result.issuedTokenHashes);
    assert.equal(result.calls.filter((call) => call.name === "council_host_issue_seat").every((call) => call.arguments.bindExecution === true), true);
    const stopped = result.calls.findIndex((call) => call.name === "council_execution_stop" && call.arguments.executionId === "fixture-execution-1");
    const secondIssue = result.calls.findIndex((call, index) => call.name === "council_host_issue_seat"
        && result.calls.slice(0, index).some((prior) => prior.name === "council_host_issue_seat"));
    assert.ok(stopped >= 0 && stopped < secondIssue);
});

await test("binding integration rejection stops both displaced and unconfirmed executions", async () => {
    const result = await scenario("binding-integration-unconfirmed");
    assert.deepEqual(result.errors, []);
    assert.equal(result.records.some((record) => record.prompt?.includes("You are the nominated integrator")), false);
    assert.equal(result.adapterAlive, false);
    assert.deepEqual(result.calls.filter((call) => call.name === "council_execution_stop").map((call) => call.arguments.executionId),
        ["fixture-execution-1", "fixture-execution-2"]);
});

await test("binding integration does not launch after expiry during credential issuance", async () => {
    const result = await scenario("binding-integration-expired");
    assert.deepEqual(result.errors, []);
    assert.equal(result.records.filter((record) => record.pid).length, 1);
    assert.equal(result.calls.filter((call) => call.name === "council_execution_start").length, 1);
    assert.equal(result.records.some((record) => record.prompt?.includes("You are the nominated integrator")), false);
    assert.equal(result.adapterAlive, false);
    assert.equal(result.health.code, null);
});

for (const mode of ["expired-failed", "expired-shell", "expired-unhealthy"] as const) {
    await test(`${mode} observes paused expiry through a status-only probe and releases ownership`, async () => {
        const result = await scenario(mode);
        assert.deepEqual(result.errors, []);
        const probes = result.calls.filter((call) => call.name === "council_dispatch"
            && JSON.stringify(call.arguments.agentNames) === '["host-probe"]');
        assert.ok(probes.length >= 2);
        assert.ok(probes.every((call) => call.arguments.statusOnly === true));
        assert.ok(probes.every((call) => call.arguments.ackDeliveryIds === undefined));
        assert.equal(result.calls.some((call) => call.name === "council_delivery_state"), false);
        assert.equal(result.records.filter((record) => record.method === "session/prompt").length, mode === "expired-unhealthy" ? 1 : 0);
        assert.equal(result.adapterAlive, false);
        assert.equal(result.health.code, null);
        assert.equal(result.health.busy, false);
        assert.equal(result.calls.filter((call) => call.name === "council_host_release").length, 1);
        assert.equal(result.calls.filter((call) => call.name === "council_execution_stop").length, mode === "expired-failed" ? 0 : 1);
        assert.equal(result.calls.some((call) => /council_(work|integration)/.test(call.name)), false);
        assert.equal(result.worktreeRetained, true);
        assert.equal(result.transcript, "Synthetic transcript retained after expiry.");
    });
}

await test("ordinary unpaused expiry retains its concluding prompt flow", async () => {
    const result = await scenario("expired-unpaused");
    assert.deepEqual(result.errors, []);
    assert.ok(result.records.some((record) => record.method === "session/prompt" && record.prompt === "Synthetic pending delivery"));
    assert.equal(result.calls.some((call) => call.name === "council_host_release"), false);
    assert.equal(result.calls.some((call) => call.name === "council_execution_stop"), false);
    assert.equal(result.health.code, code);
    assert.equal(result.adapterAlive, true);
});

await test("expired attach releases its claim without creating seats, worktrees or prompts", async () => {
    const result = await scenario("expired-attach");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.calls.map((call) => call.name), ["council_host_claim", "council_dispatch", "council_host_release"]);
    assert.equal(result.health.code, null);
    assert.equal(result.health.leaseEpoch, null);
    assert.equal(result.health.busy, false);
    assert.equal(result.worktreeRetained, false);
    assert.equal(result.journalText, result.originalJournal);
    assert.equal(result.transcript, "Synthetic transcript retained after expiry.");
});

await test("attach fails closed when the server does not acknowledge status-only support", async () => {
    const result = await scenario("status-unsupported");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.calls.map((call) => call.name), ["council_host_claim", "council_dispatch", "council_host_release"]);
    assert.equal(result.calls[1].arguments.statusOnly, true);
    assert.ok(result.messages.some((message) => message.detail?.includes("does not support status-only")));
    assert.equal(result.health.code, null);
    assert.equal(result.health.leaseEpoch, null);
    assert.equal(result.worktreeRetained, false);
    assert.equal(result.journalText, result.originalJournal);
});

await test("attach checks advertised status-only schema before any mutating tool call", async () => {
    const result = await scenario("status-schema-unsupported");
    assert.deepEqual(result.errors, []);
    assert.equal(result.listRequests, 1);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.records, []);
    assert.ok(result.messages.some((message) => message.detail?.includes("does not support status-only")));
    assert.equal(result.health.code, null);
    assert.equal(result.health.leaseEpoch, null);
    assert.equal(result.worktreeRetained, false);
    assert.equal(result.journalText, result.originalJournal);
});

for (const mode of ["expired-ready", "expired-busy"] as const) {
    await test(`${mode} stops locally before cleanup and ignores leftover delivery prompts`, async () => {
        const result = await scenario(mode);
        assert.deepEqual(result.errors, []);
        assert.equal(result.records.filter((record) => record.method === "session/prompt").length, 1);
        assert.equal(result.calls.some((call) => call.name === "council_delivery_state"), false);
        assert.equal(result.aliveDuringExpiryCleanup, false);
        assert.equal(result.adapterAlive, false);
        assert.equal(result.executionStopped, true);
        assert.equal(result.calls.filter((call) => call.name === "council_execution_stop").length, 1);
        assert.equal(result.calls.filter((call) => call.name === "council_host_release").length, 1);
        assert.equal(result.calls.some((call) => /council_(work|integration)/.test(call.name)), false);
        assert.equal(result.health.code, null);
        assert.equal(result.health.busy, false);
        assert.deepEqual(result.health.agents, []);
        assert.equal(result.worktreeRetained, true);
        assert.equal(result.transcript, "Synthetic transcript retained after expiry.");
    });
}

await test("fresh invited adoption can start from configured defaults without a journal", async () => {
    const result = await scenario("stable", "beta", "missing", true);
    assert.deepEqual(result.errors, []);
    const execution = result.calls.find((call) => call.name === "council_execution_start")!;
    assert.equal(execution.arguments.requestedModel, "alpha");
    assert.equal(execution.arguments.requestedReasoningEffort, "medium");
    assert.equal(JSON.parse(result.journalText!).agents[0].requestedModel, "alpha");
});

await test("reconnect restores saved reasoning over a changed configured default", async () => {
    const result = await scenario("stable", "beta", undefined, false, "high");
    assert.deepEqual(result.errors, []);
    const execution = result.calls.find((call) => call.name === "council_execution_start")!;
    assert.equal(execution.arguments.requestedReasoningEffort, "high");
    assert.equal(execution.arguments.effectiveReasoningEffort, "high");
    assert.equal(JSON.parse(result.journalText!).agents[0].requestedReasoningEffort, "high");
    const view = result.messages.flatMap((message) => message.agents ?? []).find((agent) => agent.executionId === "fixture-execution");
    assert.equal(view?.modelSource, "adapter_config");
    assert.equal(view?.adapterVersion, "1.0.0");
    assert.equal(JSON.stringify(result.messages).includes("fixture-seat-key"), false);
    assert.equal(result.issuedTokenHashes.some((hash) => JSON.stringify(result.messages).includes(hash)), false);
});

await test("newly invited seat absent from an existing journal uses configured defaults", async () => {
    const result = await scenario("stable", "beta", "seat-missing", true);
    assert.deepEqual(result.errors, []);
    const execution = result.calls.find((call) => call.name === "council_execution_start")!;
    assert.equal(execution.arguments.requestedModel, "alpha");
    assert.equal(execution.arguments.requestedReasoningEffort, "medium");
});

await test("rejected reconnect remains unprompted across later dispatch polls", async () => {
    const result = await scenario("reject");
    assert.deepEqual(result.errors, []);
    assert.equal(result.records.some((record) => record.method === "session/prompt"), false);
    assert.equal(result.calls.some((call) => call.name === "council_delivery_state"), false);
    assert.equal(result.calls.some((call) => call.name === "council_execution_start"), false);
    assert.equal(result.adapterAlive, false);
});

await test("reconnect cannot prompt while execution evidence is still pending", async () => {
    const result = await scenario("slow-execution");
    assert.deepEqual(result.errors, []);
    assert.equal(result.promptedBeforeExecution, false);
});

for (const savedModel of ["beta", null]) {
    await test(`reconnect preserves saved ${savedModel ?? "adapter-default"} selection over changed host defaults`, async () => {
        const result = await scenario("stable", savedModel);
        assert.deepEqual(result.errors, []);
        const execution = result.calls.find((call) => call.name === "council_execution_start")!;
        assert.equal(execution.arguments.requestedModel, savedModel ?? undefined);
        assert.equal(JSON.parse(result.journalText!).agents[0].requestedModel, savedModel);
        assert.deepEqual(result.records.filter((record) => record.method === "session/set_config_option").map((record) => record.value),
            savedModel ? [savedModel] : []);
    });
}

for (const fault of ["code", "base", "path", "duplicate", "missing", "empty-model"] as const) {
    await test(`reconnect rejects ${fault} journal scope without overwriting it`, async () => {
        const result = await scenario("stable", "beta", fault);
        assert.deepEqual(result.errors, []);
        assert.equal(result.records.length, 0);
        assert.equal(result.journalText, fault === "missing" ? null : result.originalJournal);
        assert.equal(result.calls.some((call) => call.name === "council_host_issue_seat"), false);
        assert.ok(result.messages.some((message) => message.type === "error"));
        const claim = result.calls.find((call) => call.name === "council_host_claim")!;
        assert.deepEqual(result.calls.filter((call) => call.name === "council_host_release").map((call) => call.arguments), [
            { sessionCode: code, hostId: claim.arguments.hostId, leaseEpoch: 2 },
        ]);
        assert.equal(result.health.code, null);
        assert.equal(result.health.leaseEpoch, null);
        assert.equal(result.health.leaseHealthy, false);
        assert.equal(result.health.busy, false);
    });
}

for (const mode of ["join-reject", "late-execution", "late-join"] as const) {
    await test(`${mode} closes the recorded execution under its original fence without prompting`, async () => {
        const result = await scenario(mode);
        assert.deepEqual(result.errors, []);
        assert.equal(result.executionStopped, true);
        assert.equal(result.responseClosedBeforeAck, false);
        assert.equal(result.records.some((record) => record.method === "session/prompt"), false);
        const start = result.calls.find((call) => call.name === "council_execution_start")!;
        const stops = result.calls.filter((call) => call.name === "council_execution_stop");
        assert.equal(stops.length, 1);
        assert.equal(stops[0].arguments.executionId, "fixture-execution");
        assert.equal(stops[0].arguments.hostId, start.arguments.hostId);
        assert.equal(stops[0].arguments.leaseEpoch, start.arguments.leaseEpoch);
        assert.equal(result.adapterAlive, false);
        if (mode === "late-execution") assert.equal(result.calls.some((call) => call.name === "council_join"), false);
    });
}

for (const mode of ["stop-reject", "stop-error", "stop-hang"] as const) {
    await test(`${mode} reports unconfirmed bounded execution cleanup`, async () => {
        const result = await scenario(mode);
        assert.deepEqual(result.errors, []);
        assert.equal(result.executionStopped, false);
        assert.equal(result.records.some((record) => record.method === "session/prompt"), false);
        assert.equal(result.calls.filter((call) => call.name === "council_execution_stop").length, 1);
        assert.ok(result.messages.some((message) => message.type === "error" && /execution cleanup unconfirmed/.test(message.detail ?? "")));
    });
}

for (const mode of ["reject", "error", "hang"] as const) {
    await test(`journal rejection reports ${mode} lease cleanup without claiming release`, async () => {
        const result = await scenario("stable", "beta", "code", false, null, mode);
        assert.deepEqual(result.errors, []);
        assert.equal(result.records.length, 0);
        assert.equal(result.journalText, result.originalJournal);
        assert.equal(result.calls.filter((call) => call.name === "council_host_release").length, 1);
        assert.equal(result.calls.some((call) => call.name === "council_host_issue_seat"), false);
        assert.ok(result.messages.some((message) => message.type === "error" && /lease release unconfirmed/.test(message.detail ?? "")));
        assert.equal(result.health.leaseHealthy, false);
    });
}

await test("unsupported ACP protocol is rejected before creating a session", async () => {
    const result = await scenario("wrong-protocol");
    assert.deepEqual(result.errors, []);
    assert.equal(result.records.some((record) => record.method === "session/new"), false);
    assert.equal(result.adapterAlive, false);
});

for (const mode of ["hang-initialize", "hang-session", "hang-selection"] as const) {
    await test(`${mode} startup is bounded, cleaned up, and never dispatched`, async () => {
        const result = await scenario(mode);
        assert.deepEqual(result.errors, []);
        assert.equal(result.records.some((record) => record.method === "session/prompt"), false);
        assert.equal(result.calls.some((call) => call.name === "council_execution_start"), false);
        assert.equal(result.adapterAlive, false);
        assert.ok(result.messages.some((message) => message.type === "error" && /timed out/i.test(message.detail ?? "")));
    });
}
