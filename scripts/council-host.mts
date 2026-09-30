/**
 * Long-lived local host for a Zuychin council.
 *
 *   npx tsx --env-file=.env.local scripts/council-host.mts --repo C:/path/to/repo
 *   npx tsx --env-file=.env.local scripts/council-host.mts \
 *     --topic "..." --brief "..." --agents claude-a,codex-1 --closer claude-a
 *
 * Zuychin is serverless and cannot reach a process on this machine, and a
 * browser page has no child_process, so the ACP client has to live here. This
 * process owns one ACP session per agent for the whole council, mediates every
 * file and terminal call against that agent's worktree, pushes each turn with
 * session/prompt, and serves a loopback control channel to /council.
 *
 * Every ordering decision stays in Postgres behind council_dispatch: this host
 * reads a tick and relays, and computes no floor of its own.
 */
import { spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, type WriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import * as acp from "@agentclientprotocol/sdk";
import { insideWorktree, killTree, onPath, spawnResolved } from "./council-host-paths.mts";
import { buildCouncilAdapterEnv, credentialValues } from "./council-adapter-env.mts";
import { acquireHostLock, releaseHostLock } from "./council-host-lock.mts";
import {
    formatSupervisionLine, parseControl, parseLaunch,
    type HostExitReason, type HostHealthV1, type HostLaunchV1, type HostLifecycle, type HostLogLevel,
} from "../src/lib/council/supervisor.ts";
import {
    CODE_ALPHABET, COUNCIL_MCP_SERVER_NAME, DISPATCH_POLL_MS, HOST_PORT_FIRST, HOST_PORT_LAST,
    MODERATOR_NAME, PERMISSION_PROMPT_TIMEOUT_MS, councilBranch, councilWorktreeDir, generateCouncilCode,
} from "../src/lib/council/protocol.ts";
import { parseKickoffBlocks, renderDispatchKickoff } from "../src/lib/council/render.ts";
import { COUNCIL_TYPES } from "../src/lib/council/templates.ts";
import { COUNCIL_HOST_GENERATION, V3_HOST_CAPABILITIES, configuredCapabilities, type CouncilAgentSelection, type ConnectorCapabilitySnapshot } from "../src/lib/council/v3.ts";
import { exactIntegrationDiff, integrateAcceptedManifest, loadVerificationProfile, protectedRefsUnchanged, snapshotProtectedRefs, verifyExactCommit, type IntegrationManifest, type VerificationReceipt } from "./council-git.mts";
import { sanitiseIntegrationEvidence, sanitiseIntegrationText, sanitiseVerificationReceipts, type IntegrationEvidence, type IntegrationRedactionContext } from "../src/lib/council/integration-evidence.ts";
import { configureAcpSession } from "./council-models.mts";
import { configuredSelection, preflightCouncilPaths, requireLaunchPreflightProtocol } from "./council-launch-preflight.mts";

const HOST_VERSION = "3.1.0";
const CAMPAIGN_POLL_MS = 30_000;
const TERMINAL_OUTPUT_LIMIT = 1_000_000;
const MAX_PAIR_FAILURES = 10;
const HEALTH_BEAT_MS = 5_000;
const ACP_STARTUP_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------- supervision

/**
 * V4.1. A supervising shell starts this process with ZUYCHIN_SUPERVISED=1 and
 * reads NDJSON supervision lines from stdout; human output moves to stderr so
 * the two never interleave on one pipe. Launched from a terminal, nothing about
 * the host changes.
 *
 * The launch config arrives in the environment rather than over stdin because
 * every repo and branch decision below is made during module evaluation: a
 * startup handshake would have to block it to be read in time.
 */
const supervised = process.env.ZUYCHIN_SUPERVISED === "1";
const startedAtMs = Date.now();

const facts: {
    hostId: string; port: number | null; councilCode: string | null;
    lifecycle: HostLifecycle; workInFlight: boolean; exited: boolean;
} = { hostId: "", port: null, councilCode: null, lifecycle: "starting", workInFlight: false, exited: false };

function hostSay(line: string): void {
    (supervised ? process.stderr : process.stdout).write(`${line}\n`);
}

function emitLog(level: HostLogLevel, message: string): void {
    if (!supervised) return;
    process.stdout.write(formatSupervisionLine({
        v: 1, type: "log", at: new Date().toISOString(), level, message,
    }));
}

// Once only: a shell that has read an exit report treats the process as gone,
// and a second report after a failed clean shutdown would contradict the first.
function emitExit(code: number, reason: HostExitReason, detail: string | null): void {
    if (!supervised || facts.exited) return;
    facts.exited = true;
    // Not "was it shutting down" - it always is by now. This says whether work
    // was still in flight when it went, which is the only version of the bit a
    // supervisor can act on.
    process.stdout.write(formatSupervisionLine({
        v: 1, type: "exit", at: new Date().toISOString(), code, reason, detail,
        councilCode: facts.councilCode, draining: facts.workInFlight,
    }));
}

// ---------------------------------------------------------------- config

type AdapterMode = "acp" | "shell";

interface Adapter {
    mode?: AdapterMode;
    command: string;
    /** shell mode only: "{prompt}" and "{mcpConfigFile}" are substituted. */
    args: string[];
    /**
     * Extra environment for this agent's process, merged over the host's own.
     * An object value is stringified for a vendor that takes its whole config in
     * one variable; null REMOVES an inherited variable.
     */
    env?: Record<string, string | Record<string, unknown> | null>;
    mcpConfig?: "claude";
    warn?: string;
    version?: string;
    capabilities?: Partial<Pick<ConnectorCapabilitySnapshot, "filesystemMediated" | "terminalMediated" | "permissionCallbacks">>;
}
interface AgentInstance {
    provider: string;
    expertise?: string;
    defaultModel?: string;
    allowedModels?: string[];
    defaultReasoningEffort?: string;
    allowedReasoningEfforts?: string[];
}
interface HostConfig {
    mcpUrl: string;
    /**
     * autoAdopt lets an idle host claim a council convened elsewhere, which is
     * what makes "ask Zuychin from the phone" work. Off unless set: it starts
     * vendor processes with nobody at the keyboard, and a permission prompt
     * outside a worktree auto-denies after 120s unseen.
     */
    /**
     * repos is an ALLOWLIST, not a convenience. Convene names a key from it and
     * never a path, so the page cannot aim the host at a directory this file
     * did not nominate; the same check gates a council record on adopt.
     */
    host?: {
        port?: number; origins?: string[]; autoAdopt?: boolean;
        repos?: Record<string, { path: string; baseBranch?: string }>;
    };
    /**
     * Run on the assembled integration branch before a campaign is offered for
     * merge. Repository-controlled on purpose: an agent must not get to choose
     * the command that decides whether its own work passes. Unset means the
     * merge is checked but nothing is run.
     */
    verifyCommand?: string[];
    agents: Record<string, Adapter>;
    instances?: Record<string, AgentInstance>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

// facts.hostId is empty until the lock is ours, and releaseHostLock only ever
// removes its own, so dying before or instead of acquiring it is a no-op.
function die(message: string, reason: HostExitReason = "config"): never {
    console.error(`\n✗ ${message}\n`);
    emitExit(1, reason, message);
    releaseHostLock(facts.hostId);
    process.exit(1);
}

// Also broadcast, because stdout is only readable on the machine running the
// host. Everything the host narrates about a campaign - verifying, checked,
// assembling, integrated, released - was invisible to /council without this.
// Safe from here: no log() call runs before `sockets` is initialised.
function log(message: string): void {
    const at = new Date().toISOString();
    hostSay(`[${at.slice(11, 19)}] ${message}`);
    emitLog("info", message);
    broadcast({ type: "log", detail: message, at });
}

// ---------------------------------------------------------------- MCP

const mcpHostKey = process.env.MCP_COUNCIL_HOST_KEY;
if (!mcpHostKey) die("MCP_COUNCIL_HOST_KEY is not set (run the Council V3 setup, then restart the app)");

const configPath = arg("config") ?? join(HERE, "council-agents.json");
if (!existsSync(configPath)) {
    die(`missing ${configPath}\nCopy council-agents.example.json to council-agents.json and set the commands you actually run.`);
}
const config: HostConfig = JSON.parse(readFileSync(configPath, "utf8"));

// The endpoint answers a bare tools/call with no initialize handshake, and
// frames the reply as one SSE "data:" line.
async function callMcp(method: string, params: Record<string, unknown>, bearer = mcpHostKey, signal?: AbortSignal) {
    const res = await fetch(config.mcpUrl, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`${params.name ?? method} failed: HTTP ${res.status} ${raw.slice(0, 300)}`);
    const line = raw.split("\n").find((l) => l.startsWith("data:"));
    const payload = JSON.parse(line ? line.slice(5).trim() : raw);
    if (payload.error) throw new Error(`${params.name ?? method} failed: ${payload.error.message ?? JSON.stringify(payload.error)}`);
    return payload.result;
}

async function callTool(name: string, args: Record<string, unknown>, bearer = mcpHostKey, signal?: AbortSignal): Promise<string> {
    const result = await callMcp("tools/call", { name, arguments: args }, bearer, signal);
    const text = result?.content?.[0]?.text;
    // An unknown tool or a rejected key comes back as a RESULT carrying isError,
    // not as a JSON-RPC error. Returning that prose would hand a JSON caller a
    // parse failure instead of the reason, which is how "council_open not found"
    // reads as a syntax error.
    if (result?.isError) throw new Error(`${name} failed: ${typeof text === "string" ? text : "unknown error"}`);
    if (typeof text !== "string") throw new Error(`${name} returned no text`);
    return text;
}

async function requireHostRuntimeProtocol(): Promise<void> {
    await requireToolProperties(new Map([
        ["council_dispatch", { property: "statusOnly", type: "boolean", label: "status-only host probes" }],
        ["council_host_issue_seat", { property: "bindExecution", type: "boolean", label: "execution-bound seat issuance" }],
        ["council_execution_start", { property: "seatTokenHash", type: "string", label: "execution-bound registration" }],
    ]));
}

async function requireToolProperties(required: Map<string, { property: string; type: string; label: string }>): Promise<void> {
    let cursor: string | undefined;
    const visited = new Set<string>();
    const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
    do {
        const result = await callMcp("tools/list", cursor ? { cursor } : {}, mcpHostKey, signal) as {
            tools?: { name: string; inputSchema?: { properties?: Record<string, { type?: string }> } }[];
            nextCursor?: string;
        };
        for (const tool of result.tools ?? []) {
            const contract = required.get(tool.name);
            if (!contract) continue;
            if (tool.inputSchema?.properties?.[contract.property]?.type !== contract.type) {
                throw new Error(`Council server does not support ${contract.label}; update it before starting a Council`);
            }
            required.delete(tool.name);
        }
        if (required.size === 0) return;
        cursor = result.nextCursor;
        if (cursor && visited.has(cursor)) break;
        if (cursor) visited.add(cursor);
    } while (cursor);
    throw new Error(`Council server does not support ${[...required.values()].map((contract) => contract.label).join(", ")}; update it before starting a Council`);
}

/**
 * Only for calls whose result is expensive to recompute. callTool throws a
 * TypeError only when fetch itself failed, which means no response was seen;
 * an HTTP status or a tool-level rejection arrives as a plain Error and is not
 * retried. A duplicate verification run row costs nothing next to a repeated
 * four-minute build.
 */
async function callToolRetrying(name: string, args: Record<string, unknown>, attempts = 4): Promise<string> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await callTool(name, args);
        } catch (error) {
            if (!(error instanceof TypeError) || attempt >= attempts) throw error;
            log(`${name}: ${error.message}; retrying (${attempt}/${attempts - 1})`);
            await new Promise((resume) => setTimeout(resume, 750 * attempt));
        }
    }
}

interface DispatchSlice {
    fresh: unknown[];
    cursor: number;
    delivered: number;
    hasFloor: boolean;
    moreRemain: boolean;
    status: string;
    dispatchMode: boolean;
    prompt: string | null;
    deliveryId?: string;
    promptHash?: string;
    attempt?: number;
    redelivered?: boolean;
}
interface DispatchPayload {
    error?: string;
    statusOnly?: boolean;
    sessionCode: string;
    topic: string;
    status: string;
    pausedAt?: string | null;
    round: number;
    maxRounds: number;
    lastSeq: number;
    closerName: string;
    verdict: string | null;
    vaultPath: string | null;
    floorHolder: string | null;
    participants: { name: string; status: string; cursorSeq: number; dispatchMode: boolean }[];
    agents: Record<string, DispatchSlice>;
}

// ---------------------------------------------------------------- shell

function git(repo: string, args: string[]): { ok: boolean; out: string } {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: buildCouncilAdapterEnv(process.env) });
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

// Removing a worktree an agent has installed into is seconds of blocked thread,
// which is long enough for the server to drop the pooled socket and the very
// next report to die on it. Only the worktree calls need this.
function gitAsync(repo: string, args: string[]): Promise<{ ok: boolean; out: string }> {
    return new Promise((settle) => {
        const child = spawnResolved("git", ["-C", repo, ...args], {
            shell: false, stdio: ["ignore", "pipe", "pipe"], env: buildCouncilAdapterEnv(process.env),
        });
        let out = "";
        const absorb = (chunk: string) => { out += chunk; };
        child.stdout?.setEncoding("utf8").on("data", absorb);
        child.stderr?.setEncoding("utf8").on("data", absorb);
        child.on("error", (error) => settle({ ok: false, out: `${out}${error.message}`.trim() }));
        child.on("close", (code) => settle({ ok: code === 0, out: out.trim() }));
    });
}

// ---------------------------------------------------------------- runtime

type AgentState = "pending" | "starting" | "idle" | "busy" | "exited" | "failed";

interface AgentRuntime {
    name: string;
    provider: string;
    expertise: string;
    adapter: Adapter;
    mode: AdapterMode;
    branch: string;
    relDir: string;
    treeDir: string;
    logPath: string;
    mcpFile: string;
    state: AgentState;
    detail: string;
    inFlight: boolean;
    ready: boolean;
    startupController?: AbortController;
    /**
     * Last turn read to completion; an errored turn never lands here, so a
     * failed delivery redelivers while an identical clean one does not.
     */
    lastDelivered: string | null;
    seatToken: string | null;
    executionId: string | null;
    executionFence?: { sessionCode: string; hostId: string; leaseEpoch: number };
    executionCleanup?: Promise<void>;
    requestedModel: string | null;
    effectiveModel: string | null;
    adapterVersion: string | null;
    modelSource: string;
    requestedReasoningEffort: string | null;
    effectiveReasoningEffort: string | null;
    capabilities: ConnectorCapabilitySnapshot;
    lastActivity: string;
    child?: ChildProcess;
    connection?: acp.ClientConnection;
    session?: acp.ActiveSession;
    log?: WriteStream;
}

interface PendingPermission {
    id: string;
    agent: string;
    kind: string;
    title: string;
    path: string | null;
    reason: string;
    createdAt: string;
    settle: (allowed: boolean) => void;
}

interface HostState {
    hostId: string;
    sessionId: string | null;
    leaseEpoch: number | null;
    leaseExpiresAt: string | null;
    leaseHealthy: boolean;
    code: string | null;
    topic: string | null;
    status: string;
    // Distinct from status, which mirrors the *session* and stays "closed" for
    // the whole campaign. dispatchTick overwrites status every 1.5s, so a phase
    // kept there survives one poll at most.
    campaignComplete: boolean;
    // What the host is doing right now. A verification is minutes of silence
    // otherwise: the work item reads "host pending" and nothing says whether a
    // build is running or hung.
    busyWith: { label: string; since: string } | null;
    round: number;
    maxRounds: number;
    floorHolder: string | null;
    repo: string;
    baseBranch: string;
    verifyCommand: string[];
    runDir: string | null;
    agents: Map<string, AgentRuntime>;
    pending: Map<string, PendingPermission>;
    stopping: boolean;
    baseSha: string | null;
    protectedRefs: Record<string, string | null>;
}

/**
 * A supervisor names a WORKSPACE and the host resolves the path from
 * host.repos. That is the trust boundary of the launch message: a shell driven
 * by a webview chooses among the repos this config nominated and can never name
 * a directory it did not. Same rule convene already follows.
 */
const launch: HostLaunchV1 = (() => {
    const raw = process.env.ZUYCHIN_HOST_LAUNCH;
    if (!raw) return { v: 1, type: "launch" };
    const parsed = parseLaunch(raw);
    if (!parsed.ok) die(`launch config rejected: ${parsed.reason}`);
    return parsed.value;
})();

const launchTarget = (() => {
    if (!launch.workspace) return undefined;
    const entry = config.host?.repos?.[launch.workspace];
    if (!entry) die(`launch names workspace "${launch.workspace}", which is not in host.repos`);
    return { path: resolve(entry.path), baseBranch: entry.baseBranch };
})();

const repoArg = arg("repo");
const startupRepo = launchTarget?.path ?? (repoArg ? resolve(repoArg) : process.cwd());
const startupBase = launch.baseBranch ?? launchTarget?.baseBranch ?? arg("base") ?? "main";
const autoAdopt = launch.autoAdopt ?? config.host?.autoAdopt ?? false;

// --model / --reasoning set a default for seats that already allow the value,
// so one login-time launcher can pin a model without editing the config. A seat
// whose allowedModels does not list it is left alone rather than failed: one
// flag cannot name a valid model for every provider at once.
const startupModel = arg("model");
const startupReasoning = arg("reasoning");

interface Workspace { name: string; path: string; baseBranch: string }

const workspaces: Workspace[] = (() => {
    const configured = Object.entries(config.host?.repos ?? {}).map(([name, entry]) => ({
        name,
        path: resolve(entry.path),
        baseBranch: entry.baseBranch ?? startupBase,
    }));
    // The launched repo is always available, or --repo would silently stop
    // working the moment an allowlist appeared.
    if (!configured.some((w) => w.path === startupRepo)) {
        configured.unshift({ name: basename(startupRepo), path: startupRepo, baseBranch: startupBase });
    }
    return configured;
})();

function workspaceByName(name: string): Workspace | undefined {
    return workspaces.find((w) => w.name === name);
}

function workspaceByPath(path: string): Workspace | undefined {
    const wanted = resolve(path);
    return workspaces.find((w) => w.path === wanted);
}

// Local heads only. A remote-tracking ref is not something agents can branch
// from and commit to, so offering one would only produce a confusing failure
// later in the campaign. council/* is excluded because the host generates those
// itself, one per agent per council; basing a new council on one is never the
// intent, and left in they crowd out the real branches.
function listBranches(repo: string): string[] {
    const listed = git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    if (!listed.ok) return [];
    return listed.out.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((name) => name && !name.startsWith("council/"))
        .sort();
}

const state: HostState = {
    hostId: randomUUID(),
    sessionId: null,
    leaseEpoch: null,
    leaseExpiresAt: null,
    leaseHealthy: false,
    code: null,
    topic: null,
    status: "idle",
    campaignComplete: false,
    busyWith: null,
    round: 0,
    maxRounds: 0,
    floorHolder: null,
    repo: startupRepo,
    baseBranch: startupBase,
    verifyCommand: config.verifyCommand ?? [],
    runDir: null,
    agents: new Map(),
    pending: new Map(),
    stopping: false,
    baseSha: null,
    protectedRefs: {},
};

function seatExpertise(name: string, provider: string): string {
    return config.instances?.[name]?.expertise ?? `${provider} coding agent`;
}

function resolveAgent(name: string): { adapter: Adapter; provider: string; expertise: string } {
    const instance = config.instances?.[name];
    const provider = instance?.provider ?? name;
    const adapter = config.agents[provider];
    if (!adapter) throw new Error(`no provider adapter for "${name}" (provider "${provider}") in council-agents.json`);
    return { adapter, provider, expertise: seatExpertise(name, provider) };
}

/**
 * The seats this machine can actually fill, so the app proposes names that
 * exist instead of guessing. A seat whose provider has no adapter is omitted:
 * it could only fail at spawn.
 */
// Precedence is CLI over file: --model is the more specific statement of the
// two, and it is ignored where the seat does not allow it.
function seatDefaultModel(name: string): string | null {
    const instance = config.instances?.[name];
    if (startupModel && (instance?.allowedModels ?? []).includes(startupModel)) return startupModel;
    return instance?.defaultModel ?? null;
}

function seatDefaultReasoning(name: string): string | null {
    const instance = config.instances?.[name];
    if (startupReasoning && (instance?.allowedReasoningEfforts ?? []).includes(startupReasoning)) return startupReasoning;
    return instance?.defaultReasoningEffort ?? null;
}

const seats = (() => {
    const named = Object.keys(config.instances ?? {});
    return (named.length > 0 ? named : Object.keys(config.agents)).flatMap((name) => {
        const provider = config.instances?.[name]?.provider ?? name;
        const adapter = config.agents[provider];
        if (!adapter) return [];
        return [{
            name,
            provider,
            mode: adapter.mode ?? "acp",
            expertise: seatExpertise(name, provider),
            warn: adapter.warn ?? null,
            defaultModel: seatDefaultModel(name),
            allowedModels: config.instances?.[name]?.allowedModels ?? [],
            defaultReasoningEffort: seatDefaultReasoning(name),
            allowedReasoningEfforts: config.instances?.[name]?.allowedReasoningEfforts ?? [],
        }];
    });
})();

function agentView(agent: AgentRuntime) {
    return {
        name: agent.name,
        provider: agent.provider,
        mode: agent.mode,
        state: agent.state,
        detail: agent.detail,
        branch: agent.branch,
        worktree: agent.treeDir,
        inFlight: agent.inFlight,
        lastActivity: agent.lastActivity,
        warn: agent.adapter.warn ?? null,
        requestedModel: agent.requestedModel,
        effectiveModel: agent.effectiveModel,
        requestedReasoningEffort: agent.requestedReasoningEffort,
        effectiveReasoningEffort: agent.effectiveReasoningEffort,
        executionId: agent.executionId,
        modelSource: agent.modelSource,
        adapterVersion: agent.adapterVersion,
        identityAssurance: agent.seatToken ? "verified_seat" : "unverified_declaration",
        capabilities: agent.capabilities,
    };
}

function snapshot() {
    return {
        version: HOST_VERSION,
        capabilities: V3_HOST_CAPABILITIES,
        hostId: state.hostId,
        leaseEpoch: state.leaseEpoch,
        leaseExpiresAt: state.leaseExpiresAt,
        leaseHealthy: state.leaseHealthy,
        code: state.code,
        // Same rule convene() and attach() refuse on, so the app can grey out a
        // Launch button instead of learning by error.
        busy: state.code !== null || startingCouncil,
        instances: seats,
        topic: state.topic,
        status: state.campaignComplete ? "campaign_complete" : state.status,
        busyWith: state.busyWith,
        round: state.round,
        maxRounds: state.maxRounds,
        floorHolder: state.floorHolder,
        repo: state.repo,
        baseBranch: state.baseBranch,
        workspaces,
        runDir: state.runDir,
        agents: [...state.agents.values()].map(agentView),
        permissions: [...state.pending.values()].map((p) => ({
            id: p.id, agent: p.agent, kind: p.kind, title: p.title,
            path: p.path, reason: p.reason, createdAt: p.createdAt,
        })),
    };
}

/**
 * The supervision view of the same state. Deliberately narrow: liveness,
 * lifecycle and one restart bit, and not a single field a supervisor would have
 * to interpret as council content.
 *
 * `draining` covers a running council as well as a shutdown, because both mean
 * the same thing to the caller - restarting now loses work in flight.
 */
function healthMessage(): HostHealthV1 {
    const inFlight = startingCouncil || (state.code !== null && !state.campaignComplete);
    facts.councilCode = state.code;
    facts.workInFlight = inFlight;
    facts.lifecycle = state.stopping ? "stopping"
        : state.code !== null && !state.leaseHealthy ? "degraded"
            : inFlight ? "draining"
                : "ready";
    return {
        v: 1,
        type: "health",
        at: new Date().toISOString(),
        hostVersion: HOST_VERSION,
        hostGeneration: COUNCIL_HOST_GENERATION,
        hostId: state.hostId,
        pid: process.pid,
        port: facts.port,
        lifecycle: facts.lifecycle,
        draining: state.stopping || inFlight,
        leaseHealthy: state.leaseHealthy,
        councilCode: state.code,
        agents: state.agents.size,
        uptimeMs: Date.now() - startedAtMs,
    };
}

function emitHealth(): void {
    if (!supervised) return;
    process.stdout.write(formatSupervisionLine(healthMessage()));
}

// ---------------------------------------------------------------- control channel

// Minted eagerly so the control channel is never briefly tokenless, then
// replaced by adoptIdentity() once the port is known.
let token = randomBytes(32).toString("hex");
let pairingCode = Array.from(randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
let pairFailures = 0;

/**
 * Reuses the previous run's token and pairing code so a browser stays paired
 * across a restart. The host starts hidden at login, where a fresh code would
 * be one nobody can read. Same secret, same file, same 0600: only its lifetime
 * changes.
 */
function adoptIdentity(file: string): boolean {
    try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as { token?: unknown; pairingCode?: unknown };
        if (typeof saved.token !== "string" || !/^[0-9a-f]{64}$/.test(saved.token)) return false;
        if (typeof saved.pairingCode !== "string") return false;
        if (!new RegExp(`^[${CODE_ALPHABET}]{${pairingCode.length}}$`).test(saved.pairingCode)) return false;
        token = saved.token;
        pairingCode = saved.pairingCode;
        return true;
    } catch {
        return false;
    }
}

const allowedOrigins = new Set([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    ...(config.host?.origins ?? []),
]);

const sockets = new Set<WebSocket>();

function broadcast(message: Record<string, unknown>): void {
    const text = JSON.stringify(message);
    for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) socket.send(text);
    }
}

// `since` is kept from the previous label so the page can show one elapsed time
// for the whole operation rather than restarting it at every build step.
function setBusy(label: string | null): void {
    if (label === (state.busyWith?.label ?? null)) return;
    state.busyWith = label === null ? null : { label, since: state.busyWith?.since ?? new Date().toISOString() };
    broadcast({ type: "state", ...snapshot() });
}

function sameToken(candidate: string | undefined): boolean {
    if (!candidate || candidate.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}

function bearerOf(req: IncomingMessage): string | undefined {
    const header = req.headers.authorization;
    if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7);
    return undefined;
}

// Echoing an origin we were not configured for is the whole attack: any public
// page can reach a loopback port, and the user may grant the Local Network
// Access prompt without noticing which site asked.
function corsHeaders(req: IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !allowedOrigins.has(origin)) return {};
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "authorization, content-type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        Vary: "Origin",
    };
}

function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    // A non-browser caller (the CLI) sends no Origin at all; only a browser's
    // forged one has to be rejected.
    return typeof origin !== "string" || allowedOrigins.has(origin);
}

function send(res: ServerResponse, req: IncomingMessage, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders(req) });
    res.end(JSON.stringify(body));
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
    }

    if (url.pathname === "/health") {
        // Reachable without a token because it is what the PWA probes to find a
        // host at all, and what triggers the Local Network Access prompt. It
        // says only that a host exists; the state needs the token.
        if (!sameToken(bearerOf(req))) {
            send(res, req, 200, { ok: true, service: "zuychin-council-host", version: HOST_VERSION });
            return;
        }
        send(res, req, 200, { ok: true, service: "zuychin-council-host", ...snapshot() });
        return;
    }

    // Its own endpoint rather than a field on /health: /health is polled every
    // couple of seconds and this shells out to git per repo.
    if (url.pathname === "/branches") {
        if (!sameToken(bearerOf(req))) { send(res, req, 401, {}); return; }
        const name = url.searchParams.get("workspace");
        const chosen = name ? workspaceByName(name) : workspaceByPath(state.repo);
        if (!chosen) { send(res, req, 404, { error: "unknown workspace" }); return; }
        send(res, req, 200, {
            workspace: chosen.name,
            baseBranch: chosen.baseBranch,
            branches: listBranches(chosen.path),
        });
        return;
    }

    if (url.pathname === "/pair") {
        if (!originAllowed(req)) { send(res, req, 403, {}); return; }
        if (pairFailures >= MAX_PAIR_FAILURES) { send(res, req, 429, {}); return; }
        if (url.searchParams.get("code")?.toUpperCase() !== pairingCode) {
            pairFailures++;
            send(res, req, 401, {});
            return;
        }
        send(res, req, 200, { token });
        return;
    }

    send(res, req, 404, {});
}

async function replyToPermission(id: string, allowed: boolean): Promise<void> {
    const pending = state.pending.get(id);
    if (!pending) return;
    pending.settle(allowed);
}

function handleSocketMessage(raw: string): void {
    let message: { type?: string; [key: string]: unknown };
    try { message = JSON.parse(raw); } catch { return; }

    switch (message.type) {
        case "permission_reply":
            void replyToPermission(String(message.id), message.allowed === true);
            break;
        case "convene":
            void convene({
                topic: String(message.topic ?? ""),
                brief: String(message.brief ?? ""),
                names: Array.isArray(message.agents) ? message.agents.map(String) : [],
                closer: String(message.closer ?? ""),
                councilType: String(message.councilType ?? "debate"),
                workspace: message.workspace ? String(message.workspace) : undefined,
                baseBranch: message.baseBranch ? String(message.baseBranch) : undefined,
                selections: message.selections && typeof message.selections === "object"
                    ? message.selections as Record<string, CouncilAgentSelection> : {},
            }).catch((error) => broadcast({ type: "error", detail: String(error) }));
            break;
        case "attach":
            void attach(String(message.code ?? "")).catch((error) => broadcast({ type: "error", detail: String(error) }));
            break;
        case "interrupt": {
            const agent = state.agents.get(String(message.agent));
            if (agent?.ready && agent.session) void agent.session.prompt("").catch(() => {});
            break;
        }
        case "stop":
            void shutdown(0);
            break;
        default:
            break;
    }
}

function startControlChannel(): Promise<{ server: Server; port: number }> {
    const first = config.host?.port ?? HOST_PORT_FIRST;
    const ports: number[] = [];
    for (let p = first; p <= Math.max(first, HOST_PORT_LAST); p++) ports.push(p);

    return new Promise((resolvePort, rejectPort) => {
        const server = createServer(handleRequest);
        const wss = new WebSocketServer({ noServer: true });

        server.on("upgrade", (req, socket, head) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            // The token rides the subprotocol, never the query string: a URL is
            // logged and referred in places a header is not.
            const offered = (req.headers["sec-websocket-protocol"] ?? "")
                .toString().split(",").map((s) => s.trim());
            if (url.pathname !== "/ws" || !originAllowed(req) || !offered.some(sameToken)) {
                socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                socket.destroy();
                return;
            }
            wss.handleUpgrade(req, socket, head, (ws) => {
                sockets.add(ws);
                ws.on("message", (data) => handleSocketMessage(data.toString()));
                ws.on("close", () => sockets.delete(ws));
                ws.send(JSON.stringify({ type: "state", ...snapshot() }));
            });
        });

        let index = 0;
        const tryNext = () => {
            if (index >= ports.length) {
                rejectPort(new Error(`no free port in ${ports[0]}-${ports[ports.length - 1]}`));
                return;
            }
            const port = ports[index++];
            server.once("error", (error: NodeJS.ErrnoException) => {
                if (error.code === "EADDRINUSE") tryNext();
                else rejectPort(error);
            });
            server.listen(port, "127.0.0.1", () => {
                // Debug: report the bound port after a retry.
                const address = server.address();
                resolvePort({ server, port: typeof address === "object" && address ? address.port : port });
            });
        };
        tryNext();
    });
}

// ---------------------------------------------------------------- permission gate

async function askUser(agent: AgentRuntime, request: {
    kind: string; title: string; path: string | null; reason: string;
}): Promise<boolean> {
    const id = randomUUID();
    return new Promise<boolean>((settle) => {
        // Nobody watching means denied, not blocked forever: an unattended
        // council must not wedge on the user's attention.
        const timer = setTimeout(() => finish(false, "timeout"), PERMISSION_PROMPT_TIMEOUT_MS);
        const finish = (allowed: boolean, why: string) => {
            if (!state.pending.delete(id)) return;
            clearTimeout(timer);
            broadcast({ type: "permission_resolved", id, allowed, reason: why });
            log(`${agent.name}: ${request.kind} ${allowed ? "allowed" : "denied"} (${why}) ${request.path ?? ""}`);
            settle(allowed);
        };
        state.pending.set(id, {
            id, agent: agent.name, kind: request.kind, title: request.title,
            path: request.path, reason: request.reason, createdAt: new Date().toISOString(),
            settle: (allowed) => finish(allowed, allowed ? "allowed by user" : "denied by user"),
        });
        broadcast({
            type: "permission_request", id, agent: agent.name, kind: request.kind,
            title: request.title, path: request.path, reason: request.reason,
        });
        log(`${agent.name}: asking to ${request.kind} outside its worktree: ${request.path ?? request.title}`);
    });
}

async function gatePath(agent: AgentRuntime, kind: string, path: string): Promise<boolean> {
    if (await insideWorktree(path, agent.treeDir)) return true;
    return askUser(agent, {
        kind, title: `${kind} ${path}`, path,
        reason: `outside ${agent.name}'s worktree (${agent.treeDir})`,
    });
}

function denied(what: string): never {
    throw new acp.RequestError(-32000, `Denied by the council host: ${what}`);
}

// ---------------------------------------------------------------- terminals

interface HostTerminal {
    id: string;
    agent: string;
    child: ChildProcess;
    output: string;
    truncated: boolean;
    exit: { exitCode: number | null; signal: string | null } | null;
    waiters: ((status: { exitCode: number | null; signal: string | null }) => void)[];
}

const terminals = new Map<string, HostTerminal>();

function createTerminal(agent: AgentRuntime, params: acp.CreateTerminalRequest): acp.CreateTerminalResponse {
    const id = randomUUID();
    // cwd is FORCED, never taken from the request: the worktree boundary is the
    // whole point, and a terminal is the easiest way around a path check.
    const child = spawnResolved(params.command, params.args ?? [], {
        cwd: agent.treeDir,
        env: buildCouncilAdapterEnv(process.env, Object.fromEntries((params.env ?? []).map((e) => [e.name, e.value]))),
        stdio: ["ignore", "pipe", "pipe"],
    });
    const limit = params.outputByteLimit ?? TERMINAL_OUTPUT_LIMIT;
    const terminal: HostTerminal = { id, agent: agent.name, child, output: "", truncated: false, exit: null, waiters: [] };

    const append = (chunk: Buffer) => {
        terminal.output += chunk.toString();
        if (terminal.output.length > limit) {
            terminal.output = terminal.output.slice(terminal.output.length - limit);
            terminal.truncated = true;
        }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("exit", (code, signal) => {
        terminal.exit = { exitCode: code, signal: signal ?? null };
        for (const waiter of terminal.waiters.splice(0)) waiter(terminal.exit);
    });
    child.on("error", (error) => {
        terminal.output += `\n[host] ${error.message}`;
        terminal.exit = { exitCode: -1, signal: null };
        for (const waiter of terminal.waiters.splice(0)) waiter(terminal.exit);
    });

    terminals.set(id, terminal);
    agent.lastActivity = new Date().toISOString();
    broadcast({ type: "agent_update", agent: agent.name, kind: "terminal", detail: `${params.command} ${(params.args ?? []).join(" ")}`.trim() });
    return { terminalId: id };
}

function requireTerminal(id: string): HostTerminal {
    const terminal = terminals.get(id);
    if (!terminal) throw acp.RequestError.resourceNotFound(id);
    return terminal;
}

// ---------------------------------------------------------------- agents

function relayUpdate(agent: AgentRuntime, update: acp.SessionUpdate): void {
    agent.lastActivity = new Date().toISOString();
    let detail = "";
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
        detail = update.content.type === "text" ? update.content.text : `[${update.content.type}]`;
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        detail = "title" in update && update.title ? String(update.title) : String(update.toolCallId ?? "");
    }
    agent.log?.write(`${update.sessionUpdate}: ${detail}\n`);
    broadcast({ type: "agent_update", agent: agent.name, kind: update.sessionUpdate, detail: detail.slice(0, 2000) });
}

function adapterEnv(agent: AgentRuntime): NodeJS.ProcessEnv {
    const env = buildCouncilAdapterEnv(process.env, agent.adapter.env);
    if (agent.seatToken) env.MCP_API_KEY = agent.seatToken;
    return env;
}

function mcpServersFor(agent: AgentRuntime): acp.McpServer[] {
    // Passed over the stdio pipe, so the bearer token never lands on disk the
    // way the shell adapters' --mcp-config file has to.
    return [{
        type: "http",
        name: COUNCIL_MCP_SERVER_NAME,
        url: config.mcpUrl,
        headers: [{ name: "Authorization", value: `Bearer ${agent.seatToken}` }],
    }];
}

async function startAcpAgent(agent: AgentRuntime, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    agent.ready = false;
    agent.state = "starting";
    const child = spawnResolved(agent.adapter.command, agent.adapter.args, {
        cwd: agent.treeDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: adapterEnv(agent),
    });
    agent.child = child;
    agent.log = createWriteStream(agent.logPath, { flags: "a" });
    child.stderr?.on("data", (chunk: Buffer) => agent.log?.write(chunk.toString()));
    child.on("exit", (code) => {
        agent.ready = false;
        if (agent.state !== "failed") {
            agent.state = "exited";
            agent.detail = `process exited (${code})`;
        }
        agent.inFlight = false;
        broadcast({ type: "agent_exit", agent: agent.name, code });
        log(`${agent.name} exited (${code})`);
    });
    child.on("error", (error) => {
        agent.ready = false;
        agent.state = "failed";
        agent.detail = error.message;
        broadcast({ type: "error", agent: agent.name, detail: error.message });
    });

    const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    const connection = acp.client({ name: "zuychin-council-host" })
        .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
            if (!await gatePath(agent, "read", ctx.params.path)) denied(`read ${ctx.params.path}`);
            const text = await readFile(ctx.params.path, "utf8");
            const from = Math.max(0, (ctx.params.line ?? 1) - 1);
            const lines = text.split("\n");
            const slice = ctx.params.limit ? lines.slice(from, from + ctx.params.limit) : lines.slice(from);
            return { content: slice.join("\n") };
        })
        .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
            if (!await gatePath(agent, "write", ctx.params.path)) denied(`write ${ctx.params.path}`);
            await writeFile(ctx.params.path, ctx.params.content, "utf8");
            return {};
        })
        .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
            const locations = ctx.params.toolCall.locations ?? [];
            const outside: string[] = [];
            for (const location of locations) {
                if (!await insideWorktree(location.path, agent.treeDir)) outside.push(location.path);
            }
            // No locations means the call names no path at all, and every path
            // it could reach through us is already gated: terminals are pinned
            // to the worktree and fs/* goes through the checks above.
            const allowed = outside.length === 0 || await askUser(agent, {
                kind: "tool",
                title: ctx.params.toolCall.title ?? ctx.params.toolCall.toolCallId,
                path: outside[0] ?? null,
                reason: `touches ${outside.length} path${outside.length > 1 ? "s" : ""} outside ${agent.treeDir}`,
            });
            const pick = allowed
                ? ctx.params.options.find((o) => o.kind === "allow_once") ?? ctx.params.options.find((o) => o.kind.startsWith("allow"))
                : ctx.params.options.find((o) => o.kind === "reject_once") ?? ctx.params.options.find((o) => o.kind.startsWith("reject"));
            if (!pick) return { outcome: { outcome: "cancelled" } };
            return { outcome: { outcome: "selected", optionId: pick.optionId } };
        })
        .onRequest(acp.methods.client.terminal.create, (ctx) => createTerminal(agent, ctx.params))
        .onRequest(acp.methods.client.terminal.output, (ctx) => {
            const terminal = requireTerminal(ctx.params.terminalId);
            return { output: terminal.output, truncated: terminal.truncated, exitStatus: terminal.exit };
        })
        .onRequest(acp.methods.client.terminal.waitForExit, async (ctx) => {
            const terminal = requireTerminal(ctx.params.terminalId);
            if (terminal.exit) return terminal.exit;
            return new Promise((settle) => terminal.waiters.push(settle));
        })
        .onRequest(acp.methods.client.terminal.kill, (ctx) => {
            killTree(requireTerminal(ctx.params.terminalId).child);
            return {};
        })
        .onRequest(acp.methods.client.terminal.release, (ctx) => {
            const terminal = requireTerminal(ctx.params.terminalId);
            killTree(terminal.child);
            terminals.delete(terminal.id);
            return {};
        })
        .connect(stream);

    agent.connection = connection;

    const initialized = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: "zuychin-council-host", version: HOST_VERSION },
    }, { cancellationSignal: signal });
    signal.throwIfAborted();
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(`unsupported ACP protocol version ${initialized.protocolVersion}`);
    }

    const session = await connection.agent
        .buildSession({ cwd: agent.treeDir, mcpServers: mcpServersFor(agent) })
        .start({ cancellationSignal: signal });
    signal.throwIfAborted();
    agent.session = session;

    const instance = config.instances?.[agent.name];
    const evidence = await configureAcpSession({
        initialized,
        sessionResponse: session.newSessionResponse,
        selection: {
            modelId: agent.requestedModel ?? undefined,
            reasoningEffort: agent.requestedReasoningEffort ?? undefined,
        },
        allowedModels: instance?.allowedModels ?? [],
        allowedReasoningEfforts: instance?.allowedReasoningEfforts ?? [],
        setConfigOption: (configId, value) => connection.agent.request(acp.methods.agent.session.setConfigOption, {
            sessionId: session.sessionId, configId, value,
        }, { cancellationSignal: signal }),
        setLegacyModel: (modelId) => connection.agent.request("session/set_model", {
            sessionId: session.sessionId, modelId,
        }, { cancellationSignal: signal }),
    });
    signal.throwIfAborted();
    agent.effectiveModel = evidence.effectiveModel;
    agent.effectiveReasoningEffort = evidence.effectiveReasoningEffort;
    agent.adapterVersion = evidence.adapterVersion;
    agent.modelSource = evidence.modelSource;
    agent.capabilities = {
        ...agent.capabilities,
        source: "probed",
        modelSelection: evidence.modelSelection,
        cancellation: Boolean((initialized as { agentCapabilities?: { promptCapabilities?: unknown } }).agentCapabilities),
        observedAt: new Date().toISOString(),
    };

    // prompt() resolves with the turn's stop reason, so this loop only relays;
    // turn completion is handled where the prompt was sent.
    void (async () => {
        for (;;) {
            try {
                const message = await session.nextUpdate();
                if (message.kind === "session_update") relayUpdate(agent, message.update);
            } catch {
                return;
            }
        }
    })();

    agent.detail = "session negotiated; recording execution";
    log(`${agent.name}: ACP session ${session.sessionId}`);
}

function startShellAgent(agent: AgentRuntime, prompt: string): void {
    agent.state = "starting";
    if (agent.adapter.mcpConfig === "claude") {
        // Outside the worktree on purpose: it carries a bearer token and must
        // never be commitable from inside the repo.
        writeFileSync(agent.mcpFile, JSON.stringify({
            mcpServers: {
                "zuychin-knowledge": {
                    type: "http", url: config.mcpUrl,
                    headers: { Authorization: `Bearer ${agent.seatToken}` },
                },
            },
        }, null, 2));
    }
    const args = agent.adapter.args.map((a) => a
        .replace("{prompt}", prompt)
        .replace("{mcpConfigFile}", agent.mcpFile)
        .replace("{model}", agent.requestedModel ?? "")
        .replace("{reasoningEffort}", agent.requestedReasoningEffort ?? ""));
    const stream = createWriteStream(agent.logPath, { flags: "a" });
    const child = spawnResolved(agent.adapter.command, args, {
        cwd: agent.treeDir, stdio: ["ignore", "pipe", "pipe"], env: adapterEnv(agent),
    });
    child.stdout?.pipe(stream);
    child.stderr?.pipe(stream);
    child.on("exit", (code) => {
        agent.state = "exited";
        agent.detail = `process exited (${code})`;
        broadcast({ type: "agent_exit", agent: agent.name, code });
    });
    child.on("error", (error) => {
        agent.state = "failed";
        agent.detail = error.message;
    });
    agent.child = child;
    agent.state = "idle";
    agent.detail = "shell mode: long-polls its own turns";
}

// Stable identity, never an array handed to promptAgent: a turn outliving the
// tick that started it would ack into an array already sent, redelivering forever.
const delivered = new Map<string, string>();

function persistDeliveryJournal(): void {
    if (!state.runDir) return;
    writeFileSync(join(state.runDir, "delivery-state.json"), JSON.stringify({
        version: 1, hostId: state.hostId, leaseEpoch: state.leaseEpoch,
        pendingAcknowledgements: Object.fromEntries(delivered),
    }, null, 2));
}

// Delivery is at-least-once. The ack is deferred to the tick AFTER the turn
// completes, so a host that dies mid-turn redelivers the same batch rather than
// leaving a hole in what the agent read.
async function promptAgent(agent: AgentRuntime, prompt: string, deliveryId?: string): Promise<void> {
    if (!agent.ready || !agent.executionId || !agent.session || agent.inFlight || state.stopping || !state.leaseHealthy) return;
    agent.inFlight = true;
    if (deliveryId) {
        try {
            const result = JSON.parse(await callTool("council_delivery_state", {
                deliveryId, hostId: state.hostId, leaseEpoch: state.leaseEpoch, state: "in_flight",
            })) as { ok?: boolean };
            if (!result.ok) throw new Error(`delivery ${deliveryId} could not enter in_flight`);
        } catch (error) {
            agent.inFlight = false;
            agent.detail = error instanceof Error ? error.message : String(error);
            broadcast({ type: "error", agent: agent.name, detail: agent.detail });
            return;
        }
    }
    if (!agent.ready || !agent.session || state.stopping || !state.leaseHealthy) {
        agent.inFlight = false;
        return;
    }
    agent.state = "busy";
    broadcast({ type: "turn", agent: agent.name, chars: prompt.length });
    agent.log?.write(`\n--- TURN PUSHED ---\n${prompt}\n\n`);
    try {
        const response = await agent.session.prompt(prompt);
        agent.detail = `turn ended: ${response.stopReason}`;
        agent.lastDelivered = prompt;
        if (deliveryId) {
            delivered.set(agent.name, deliveryId);
            persistDeliveryJournal();
        }
    } catch (error) {
        agent.detail = `turn failed: ${error instanceof Error ? error.message : String(error)}`;
        if (deliveryId) {
            await callTool("council_delivery_state", {
                deliveryId, hostId: state.hostId, leaseEpoch: state.leaseEpoch,
                state: "failed", error: agent.detail,
            }).catch(() => {});
        }
        broadcast({ type: "error", agent: agent.name, detail: agent.detail });
    } finally {
        agent.inFlight = false;
        if (agent.state === "busy") agent.state = "idle";
        agent.lastActivity = new Date().toISOString();
    }
}

// ---------------------------------------------------------------- lifecycle

function makeRuntime(name: string, code: string, selection: CouncilAgentSelection = {}, repo = state.repo, restoreSelection = false): AgentRuntime {
    const { adapter, provider, expertise } = resolveAgent(name);
    const instance = config.instances?.[name];
    const { requestedModel, requestedReasoningEffort } = configuredSelection({
        name, selection, defaultModel: restoreSelection ? null : seatDefaultModel(name),
        defaultReasoningEffort: restoreSelection ? null : seatDefaultReasoning(name),
        allowedModels: instance?.allowedModels ?? [], allowedReasoningEfforts: instance?.allowedReasoningEfforts ?? [],
    });
    const relDir = councilWorktreeDir(repo, code, name);
    const runDir = join(repo, "..", `.council-run-${code.toLowerCase()}`);
    return {
        name, provider, expertise, adapter,
        mode: adapter.mode ?? "acp",
        branch: councilBranch(code, name),
        relDir,
        treeDir: resolve(repo, relDir),
        logPath: join(runDir, `${name}.log`),
        mcpFile: join(runDir, `${name}.mcp.json`),
        state: "pending",
        detail: "",
        inFlight: false,
        ready: false,
        lastDelivered: null,
        seatToken: null,
        executionId: null,
        requestedModel,
        effectiveModel: null,
        adapterVersion: null,
        modelSource: "unknown",
        requestedReasoningEffort,
        effectiveReasoningEffort: null,
        capabilities: configuredCapabilities({
            kind: (adapter.mode ?? "acp") === "acp" ? "acp" : "managed_cli",
            modelSelection: (instance?.allowedModels?.length ?? 0) > 0,
            filesystemMediated: adapter.capabilities?.filesystemMediated ?? (adapter.mode ?? "acp") === "acp",
            terminalMediated: adapter.capabilities?.terminalMediated ?? (adapter.mode ?? "acp") === "acp",
            permissionCallbacks: adapter.capabilities?.permissionCallbacks ?? (adapter.mode ?? "acp") === "acp",
        }),
        lastActivity: new Date().toISOString(),
    };
}

function addWorktree(agent: AgentRuntime): void {
    // Logged as well as thrown: the throw reaches the UI over the WebSocket, so
    // a log-only observer saw a healthy host and a Council that just stopped.
    if (existsSync(agent.treeDir)) {
        log(`${agent.name}: FAILED - worktree ${agent.relDir} already exists`);
        throw new Error(`${agent.treeDir} already exists; remove it or close the previous council first`);
    }
    // A resumed Council already has the agent's branch, and the commits on it
    // are the work. Check it out rather than trying to create it again, which
    // is what -b does and what a resume would die on.
    const existing = git(state.repo, ["show-ref", "--verify", `refs/heads/${agent.branch}`]).ok;
    const added = git(state.repo, existing
        ? ["worktree", "add", agent.relDir, agent.branch]
        : ["worktree", "add", agent.relDir, "-b", agent.branch, state.baseSha ?? state.baseBranch]);
    if (!added.ok) {
        log(`${agent.name}: FAILED - git worktree add ${agent.relDir}: ${added.out.split(/\r?\n/)[0] ?? ""}`);
        throw new Error(`git worktree add failed for ${agent.name}:\n${added.out}`);
    }
    log(`${agent.name}: worktree ${agent.relDir} on ${agent.branch}${existing ? " (existing branch)" : ""}`);
}

const RESUME_PREAMBLE = (code: string) =>
    `You are resuming council ${code}. Your previous session on this machine ended; this one has no
memory of it. Call council_join first - it returns the rules and the recent transcript - then
continue the protocol from there. Your worktree and branch are unchanged and your earlier commits
are still in it.`;

async function recordAgentExecution(agent: AgentRuntime, signal?: AbortSignal): Promise<void> {
    if (!state.code || state.leaseEpoch === null) throw new Error("cannot record execution without a host lease");
    if (!agent.seatToken) throw new Error("cannot record execution without a runtime seat credential");
    const fence = { sessionCode: state.code, hostId: state.hostId, leaseEpoch: state.leaseEpoch };
    // A cancelled startup still needs the eventual ID to close this write.
    const result = JSON.parse(await callTool("council_execution_start", {
        ...fence, agentName: agent.name, hostGeneration: COUNCIL_HOST_GENERATION,
        seatTokenHash: createHash("sha256").update(agent.seatToken).digest("hex"),
        capabilities: agent.capabilities, identityAssurance: "verified_seat",
        provider: agent.provider, adapterVersion: agent.adapterVersion ?? undefined,
        requestedModel: agent.requestedModel ?? undefined, effectiveModel: agent.effectiveModel ?? undefined,
        requestedReasoningEffort: agent.requestedReasoningEffort ?? undefined,
        effectiveReasoningEffort: agent.effectiveReasoningEffort ?? undefined,
        modelSource: agent.modelSource,
        branch: agent.branch, worktree: agent.treeDir, baseSha: state.baseSha ?? undefined,
    })) as { ok?: boolean; reason?: string; executionId?: string; seatBound?: boolean };
    if (!result.ok || !result.executionId) throw new Error(`execution evidence rejected: ${result.reason ?? "unknown"}`);
    agent.executionId = result.executionId;
    agent.executionFence = fence;
    if (signal?.aborted) {
        await stopRecordedExecution(agent, "startup cancelled before execution acknowledgement");
        signal.throwIfAborted();
    }
    if (result.seatBound !== true) throw new Error("execution registration did not confirm runtime credential binding");
}

async function stopRecordedExecution(agent: AgentRuntime, reason: string): Promise<void> {
    if (agent.executionCleanup) return agent.executionCleanup;
    const executionId = agent.executionId;
    const fence = agent.executionFence;
    if (!executionId || !fence) return;
    const cleanup = (async () => {
        try {
            const result = JSON.parse(await callTool("council_execution_stop", {
                executionId, hostId: fence.hostId, leaseEpoch: fence.leaseEpoch, stopReason: reason.slice(0, 500),
            }, mcpHostKey, AbortSignal.timeout(CLEANUP_TIMEOUT_MS))) as { ok?: boolean; reason?: string };
            if (result.ok !== true) throw new Error(result.reason ?? "server did not confirm execution stop");
            if (agent.executionId === executionId) {
                agent.executionId = null;
                agent.executionFence = undefined;
            }
        } catch (error) {
            const detail = `${agent.name}: execution cleanup unconfirmed for ${fence.sessionCode}: ${error instanceof Error ? error.message : String(error)}`;
            broadcast({ type: "error", agent: agent.name, detail });
            log(detail);
        }
    })();
    agent.executionCleanup = cleanup;
    try { await cleanup; }
    finally { agent.executionCleanup = undefined; }
}

async function startRecordedAgent(agent: AgentRuntime, joinSeat: boolean, shellPrompt?: string): Promise<void> {
    const controller = new AbortController();
    const { signal } = controller;
    agent.startupController = controller;
    agent.state = "starting";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`${agent.name}: ${agent.mode === "acp" ? "ACP" : "shell"} startup timed out after ${ACP_STARTUP_TIMEOUT_MS / 1000}s`);
            controller.abort(error);
            closeAgent(agent);
            reject(error);
        }, ACP_STARTUP_TIMEOUT_MS);
    });
    try {
        await Promise.race([deadline, (async () => {
            if (agent.mode === "shell") {
                if (!shellPrompt) throw new Error(`${agent.name}: shell startup requires a prompt`);
                agent.effectiveModel = agent.requestedModel;
                agent.adapterVersion = agent.adapter.version ?? null;
                agent.effectiveReasoningEffort = agent.requestedReasoningEffort;
                agent.modelSource = agent.requestedModel || agent.requestedReasoningEffort ? "configured_cli" : "unknown";
                await recordAgentExecution(agent, signal);
                signal.throwIfAborted();
                if (state.stopping) throw new Error(`${agent.name}: host stopped during startup`);
                startShellAgent(agent, shellPrompt);
                return;
            }
            await startAcpAgent(agent, signal);
            signal.throwIfAborted();
            await recordAgentExecution(agent, signal);
            if (joinSeat) {
                await callTool("council_join", {
                    sessionCode: state.code, agentName: agent.name,
                    expertise: agent.expertise, dispatchMode: true,
                }, agent.seatToken!, signal);
            }
            signal.throwIfAborted();
            if (agent.state === "exited" || agent.state === "failed" || state.stopping) throw new Error(`${agent.name}: adapter stopped during startup`);
            agent.ready = true;
            agent.state = "idle";
            agent.detail = "session ready";
        })()]);
    } finally {
        clearTimeout(timer);
        agent.startupController = undefined;
    }
}

async function startAgents(kickoff: Map<string, string>): Promise<void> {
    for (const agent of state.agents.values()) {
        const prompt = kickoff.get(agent.name) ?? RESUME_PREAMBLE(state.code!);
        try {
            await startRecordedAgent(agent, true, prompt);
            if (agent.mode === "shell") continue;
            void promptAgent(agent, `${prompt}\n${renderDispatchKickoff(state.code!, agent.name)}`);
        } catch (error) {
            closeAgent(agent);
            agent.state = "failed";
            agent.detail = error instanceof Error ? error.message : String(error);
            await stopRecordedExecution(agent, `startup failed: ${agent.detail}`);
            broadcast({ type: "error", agent: agent.name, detail: agent.detail });
            log(`${agent.name} failed to start: ${agent.detail}`);
        }
    }
    broadcast({ type: "state", ...snapshot() });
}

function closeAgent(agent: AgentRuntime): void {
    agent.ready = false;
    agent.startupController?.abort(new Error(`${agent.name}: startup cancelled`));
    agent.session?.dispose();
    agent.session = undefined;
    agent.connection?.close();
    agent.connection = undefined;
    if (agent.child) killTree(agent.child);
    const stream = agent.log;
    agent.log = undefined;
    stream?.end();
}

function restoreAgents(code: string, names: string[], resumedNames: string[]): AgentRuntime[] {
    const path = join(state.repo, "..", `.council-run-${code.toLowerCase()}`, "campaign-run.json");
    if (!existsSync(path)) {
        if (resumedNames.length) throw new Error(`${code}: saved campaign selections are missing for ${resumedNames.join(", ")}; refusing to replace them with host defaults`);
        return names.map((name) => makeRuntime(name, code));
    }
    const journal = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!journal || journal.code !== code || journal.baseSha !== state.baseSha || !Array.isArray(journal.agents)
        || (journal.repo !== undefined && journal.repo !== state.repo)
        || (journal.sessionId !== undefined && journal.sessionId !== state.sessionId)) {
        throw new Error(`${code}: saved campaign journal does not match this Council and frozen repository`);
    }
    return names.map((name) => {
        const entries = journal.agents as Record<string, unknown>[];
        const matching = entries.filter((entry) => entry && entry.name === name);
        if (matching.length === 0 && !resumedNames.includes(name)) return makeRuntime(name, code);
        if (matching.length !== 1) throw new Error(`${name}: saved campaign journal must contain exactly one seat`);
        const saved = matching[0];
        if ((saved.requestedModel !== null && (typeof saved.requestedModel !== "string" || !saved.requestedModel.trim()))
            || (saved.requestedReasoningEffort !== null && (typeof saved.requestedReasoningEffort !== "string" || !saved.requestedReasoningEffort.trim()))) {
            throw new Error(`${name}: saved campaign model selection is invalid`);
        }
        const agent = makeRuntime(name, code, {
            modelId: saved.requestedModel ?? undefined,
            reasoningEffort: saved.requestedReasoningEffort ?? undefined,
        }, state.repo, true);
        if (typeof saved.dir !== "string" || resolve(saved.dir) !== agent.treeDir
            || saved.branch !== agent.branch || saved.mode !== agent.mode) {
            throw new Error(`${name}: saved campaign seat does not match its configured worktree`);
        }
        return agent;
    });
}

function prepareRun(code: string, names: string[], preparedAgents?: AgentRuntime[]): void {
    state.code = code;
    state.runDir = join(state.repo, "..", `.council-run-${code.toLowerCase()}`);
    mkdirSync(state.runDir, { recursive: true });
    for (const agent of preparedAgents ?? names.map((name) => makeRuntime(name, code))) state.agents.set(agent.name, agent);
    writeFileSync(join(state.runDir, "campaign-run.json"), JSON.stringify({
        code, configPath, port: hostPort, repo: state.repo, sessionId: state.sessionId,
        hostId: state.hostId, leaseEpoch: state.leaseEpoch, baseSha: state.baseSha,
        agents: [...state.agents.values()].map((a) => ({
            name: a.name, dir: a.treeDir, branch: a.branch, mcpFile: a.mcpFile, mode: a.mode,
            requestedModel: a.requestedModel, requestedReasoningEffort: a.requestedReasoningEffort,
        })),
    }, null, 2));
}

interface HostClaimPayload {
    ok: boolean; reason?: string; hostId?: string; leaseEpoch?: number; leaseExpiresAt?: string;
    session?: { id: string; protocolVersion: number; baseSha: string | null; repoPath: string | null; baseBranch: string | null; topic: string; status: string };
}

async function claimLease(code: string): Promise<HostClaimPayload> {
    const claim = JSON.parse(await callTool("council_host_claim", {
        sessionCode: code, hostId: state.hostId,
    })) as HostClaimPayload;
    if (!claim.ok || !claim.leaseEpoch || !claim.session) throw new Error(`host lease rejected: ${claim.reason ?? "unknown"}`);
    if (claim.session.protocolVersion !== 3) throw new Error(`Council ${code} is protocol V${claim.session.protocolVersion}; this host requires V3`);
    state.sessionId = claim.session.id;
    state.leaseEpoch = claim.leaseEpoch;
    state.leaseExpiresAt = claim.leaseExpiresAt ?? null;
    state.leaseHealthy = true;
    state.baseSha = claim.session.baseSha;
    return claim;
}

async function renewLease(): Promise<void> {
    if (!state.code || state.leaseEpoch === null || state.stopping) return;
    try {
        const result = JSON.parse(await callTool("council_host_renew", {
            sessionCode: state.code, hostId: state.hostId, leaseEpoch: state.leaseEpoch,
        })) as { ok?: boolean; reason?: string; leaseExpiresAt?: string };
        if (!result.ok) throw new Error(result.reason ?? "renewal rejected");
        state.leaseExpiresAt = result.leaseExpiresAt ?? null;
        state.leaseHealthy = true;
    } catch (error) {
        state.leaseHealthy = false;
        for (const agent of state.agents.values()) agent.detail = "paused: host lease lost";
        broadcast({ type: "error", detail: `host lease lost; dispatch stopped: ${error instanceof Error ? error.message : String(error)}` });
    }
}

async function issueAgentSeats(): Promise<void> {
    for (const agent of state.agents.values()) await issueAgentSeat(agent);
}

async function issueAgentSeat(agent: AgentRuntime): Promise<void> {
    if (!state.code || state.leaseEpoch === null) throw new Error("host lease is not active");
    const fence = { sessionCode: state.code, hostId: state.hostId, leaseEpoch: state.leaseEpoch };
    const result = JSON.parse(await callTool("council_host_issue_seat", {
        ...fence, agentName: agent.name,
        bindExecution: true,
    })) as { ok?: boolean; token?: string; reason?: string; executionBindingRequired?: boolean };
    if (state.code !== fence.sessionCode || state.leaseEpoch !== fence.leaseEpoch || state.stopping) {
        throw new Error(`${agent.name}: host ownership changed during seat issuance`);
    }
    if (!result.ok || !result.token) throw new Error(`${agent.name}: seat credential rejected (${result.reason ?? "unknown"})`);
    if (result.executionBindingRequired !== true) throw new Error(`${agent.name}: seat issuance did not confirm required execution binding`);
    agent.seatToken = result.token;
}

interface ConveneParams {
    topic: string; brief: string; names: string[]; closer: string; councilType: string;
    workspace?: string; baseBranch?: string;
    selections?: Record<string, CouncilAgentSelection>;
}

let startingCouncil = false;

async function withCouncilStart(action: () => Promise<void>): Promise<void> {
    if (state.code) throw new Error(`this host already owns ${state.code}`);
    if (startingCouncil || state.stopping) throw new Error("this host is already starting or stopping a council");
    startingCouncil = true;
    emitHealth();
    try {
        await action();
    } finally {
        startingCouncil = false;
        emitHealth();
    }
}

async function convene(params: ConveneParams): Promise<void> {
    return withCouncilStart(() => launchCouncil(params));
}

async function launchCouncil(params: ConveneParams): Promise<void> {
    const { topic, brief, names, closer, councilType } = params;
    if (!topic || !brief || names.length < 2 || !closer) throw new Error("convene needs topic, brief, at least two agents and a closer");
    if (!names.includes(closer)) throw new Error(`closer "${closer}" is not one of ${names.join(", ")}`);
    if (new Set(names).size !== names.length) throw new Error("agent names must be unique");
    if (!(COUNCIL_TYPES as readonly string[]).includes(councilType)) throw new Error(`type must be one of ${COUNCIL_TYPES.join(", ")}`);

    let repo = state.repo;
    let baseBranch = state.baseBranch;
    if (params.workspace) {
        const chosen = workspaceByName(params.workspace);
        if (!chosen) throw new Error(`workspace "${params.workspace}" is not in host.repos; known: ${workspaces.map((w) => w.name).join(", ")}`);
        repo = chosen.path;
        baseBranch = chosen.baseBranch;
    }
    if (!git(repo, ["rev-parse", "--git-dir"]).ok) throw new Error(`${repo} is not a git repository`);

    // Checked by MEMBERSHIP in the repo's own head list, not by pattern: that
    // rejects a name shaped like a git option before it can reach an argv.
    if (params.baseBranch && params.baseBranch !== baseBranch) {
        if (!listBranches(repo).includes(params.baseBranch)) {
            throw new Error(`"${params.baseBranch}" is not a local branch of ${repo}`);
        }
        baseBranch = params.baseBranch;
    }

    const frozenBase = git(repo, ["rev-parse", "--verify", baseBranch]);
    if (!frozenBase.ok) throw new Error(`could not freeze base branch ${baseBranch}`);
    const baseSha = frozenBase.out.split(/\s/)[0];
    const protectedRefs = snapshotProtectedRefs(repo, [baseBranch, "main"]);
    const requestedCode = generateCouncilCode();
    const preparedAgents = names.map((name) => makeRuntime(name, requestedCode, params.selections?.[name], repo));
    await preflightCouncilPaths(repo, requestedCode, names, gitAsync);
    await requireLaunchPreflightProtocol((cursor) => callMcp("tools/list", cursor ? { cursor } : {}));
    await requireHostRuntimeProtocol();
    if (state.stopping) throw new Error("host stopped during launch preflight");

    const text = await callTool("council_convene", {
        topic, brief, closerName: closer, councilType, requestedCode,
        participants: preparedAgents.map(({ name, expertise }) => ({ name, expertise })),
        workspace: { repoPath: repo, baseBranch, baseSha },
    });
    const { code, blocks } = parseKickoffBlocks(text);
    if (!code) throw new Error(`could not read the council code from the convene reply:\n${text.slice(0, 300)}`);
    if (code !== requestedCode) throw new Error(`server returned ${code} instead of preflighted code ${requestedCode}; refusing to launch`);
    if (blocks.length !== names.length) {
        throw new Error(`convene returned ${blocks.length} kickoff blocks for ${names.length} agents; refusing to launch a partial council`);
    }

    await claimLease(code);
    state.repo = repo;
    state.baseBranch = baseBranch;
    state.protectedRefs = protectedRefs;
    prepareRun(code, names, preparedAgents);
    state.topic = topic;
    state.status = "open";
    log(`Council ${code} opened: ${topic}`);

    await issueAgentSeats();
    for (const agent of state.agents.values()) addWorktree(agent);
    await startAgents(new Map(blocks.map((b) => [b.agentName, b.prompt])));
}

// Reconnecting to a council whose worktrees already exist, after the host was
// killed. The agents get a fresh ACP session and the dispatch loop redelivers
// whatever they never acknowledged.
async function attach(code: string): Promise<void> {
    return withCouncilStart(() => attachCouncil(code));
}

async function attachCouncil(code: string): Promise<void> {
    const upper = code.trim().toUpperCase();
    await requireHostRuntimeProtocol();
    const previous = {
        sessionId: state.sessionId, leaseEpoch: state.leaseEpoch, leaseExpiresAt: state.leaseExpiresAt,
        leaseHealthy: state.leaseHealthy, baseSha: state.baseSha, repo: state.repo,
        baseBranch: state.baseBranch, protectedRefs: state.protectedRefs,
    };
    const claim = await claimLease(upper);
    const fence = { sessionCode: upper, hostId: state.hostId, leaseEpoch: state.leaseEpoch };
    try {
        await attachClaimedCouncil(upper, claim);
    } catch (error) {
        if (state.code === upper) throw error;
        let releaseFailure = "";
        try {
            const released = JSON.parse(await callTool("council_host_release", fence, mcpHostKey,
                AbortSignal.timeout(CLEANUP_TIMEOUT_MS))) as { ok?: boolean; reason?: string };
            if (released.ok !== true) throw new Error(released.reason ?? "server did not confirm lease release");
        } catch (cleanupError) {
            releaseFailure = `; lease release unconfirmed for ${upper}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
        }
        Object.assign(state, previous);
        if (releaseFailure) throw new Error(`${error instanceof Error ? error.message : String(error)}${releaseFailure}`);
        throw error;
    }
}

async function attachClaimedCouncil(upper: string, claim: HostClaimPayload): Promise<void> {
    const payload = JSON.parse(await callTool("council_dispatch", {
        sessionCode: upper, agentNames: ["host-probe"], statusOnly: true, hostId: state.hostId, leaseEpoch: state.leaseEpoch,
    })) as DispatchPayload;
    if (payload.error === "unknown_session") throw new Error(`no council found with code ${upper}`);
    if (payload.statusOnly !== true) throw new Error("Council server does not support status-only host probes");
    if (payload.status === "expired" && payload.pausedAt) throw new Error(`${upper} expired while paused and cannot be attached`);

    const configured = (payload.participants ?? [])
        .filter((p) => p.name !== MODERATOR_NAME && p.status !== "left")
        .filter((p) => config.instances?.[p.name] || config.agents[p.name]);

    // Joined but not in dispatch mode means someone is driving it by hand.
    // Claiming it would run a second process for one seat and stop council_wait
    // blocking underneath the agent that is actually polling.
    const claimable = configured.filter((p) => p.status === "invited" || p.dispatchMode);
    const handAttached = configured.filter((p) => !claimable.includes(p));

    if (claimable.length === 0) {
        throw new Error(configured.length === 0
            ? `none of ${upper}'s participants are configured on this machine`
            : `every configured participant of ${upper} is already attached by hand (${configured.map((p) => p.name).join(", ")}); nothing to claim`);
    }
    const names = claimable.map((p) => p.name);
    if (handAttached.length) {
        log(`leaving ${handAttached.map((p) => p.name).join(", ")} to poll for themselves`);
    }

    if (!state.baseSha) throw new Error(`${upper} has no frozen base commit; it cannot be safely attached as a V3 code council`);

    // The council record names the repo it was convened against, and adopting
    // it in the wrong tree would verify commits that do not exist there. The
    // record is untrusted input, so it has to clear the same allowlist convene
    // does before the host will work in it.
    if (claim.session?.repoPath) {
        const recorded = workspaceByPath(claim.session.repoPath);
        if (!recorded) {
            throw new Error(`${upper} was convened against ${claim.session.repoPath}, which is not in host.repos on this machine`);
        }
        state.repo = recorded.path;
    }
    state.baseBranch = claim.session?.baseBranch ?? state.baseBranch;
    state.protectedRefs = snapshotProtectedRefs(state.repo, [state.baseBranch, "main"]);
    prepareRun(upper, names, restoreAgents(upper, names, claimable.filter((p) => p.dispatchMode).map((p) => p.name)));
    state.topic = payload.topic;
    state.status = payload.status;
    log(`Attached to ${upper}: ${names.join(", ")}`);

    await issueAgentSeats();
    for (const agent of state.agents.values()) {
        if (!existsSync(agent.treeDir)) addWorktree(agent);
    }
    await startAgents(new Map());
}

// ---------------------------------------------------------------- dispatch

let dispatching = false;

async function dispatchTick(): Promise<void> {
    const owned = [...state.agents.values()].filter((a) => a.mode === "acp" && a.ready && a.session);
    if (!state.code || dispatching || state.leaseEpoch === null) return;
    const code = state.code;
    const leaseEpoch = state.leaseEpoch;
    const statusOnly = owned.length === 0 || !state.leaseHealthy;
    dispatching = true;
    try {
        const acknowledgementEntries = statusOnly ? [] : [...delivered.entries()];
        const ackDeliveryIds = acknowledgementEntries.map(([, id]) => id);
        const payload = JSON.parse(await callTool("council_dispatch", {
            sessionCode: code,
            agentNames: statusOnly ? ["host-probe"] : owned.map((a) => a.name),
            hostId: state.hostId, leaseEpoch,
            ...(statusOnly ? { statusOnly: true } : {}),
            ...(ackDeliveryIds.length ? { ackDeliveryIds } : {}),
        })) as DispatchPayload;
        if (state.code !== code || state.leaseEpoch !== leaseEpoch) return;
        if (statusOnly && payload.statusOnly !== true) throw new Error("Council server does not support status-only host probes");
        if (payload.status === "expired" && payload.pausedAt) {
            state.status = "expired";
            state.campaignComplete = false;
            await releaseCouncil("Council expired while paused", code, leaseEpoch);
            return;
        }
        if (payload.error) {
            if (payload.error === "stale_host" || payload.error === "stale_epoch") state.leaseHealthy = false;
            return;
        }
        if (statusOnly) return;
        for (const [name, id] of acknowledgementEntries) {
            if (delivered.get(name) === id) delivered.delete(name);
        }
        persistDeliveryJournal();

        // Closure was invisible here: the status moved from open to concluding to
        // awaiting_owner to closed with nothing written down, so the log showed a
        // Council that simply stopped talking.
        if (payload.status !== state.status) log(`${state.code}: ${state.status} -> ${payload.status}`);
        state.status = payload.status;
        state.round = payload.round;
        state.maxRounds = payload.maxRounds;
        state.floorHolder = payload.floorHolder;

        for (const agent of owned) {
            const slice = payload.agents?.[agent.name];
            if (!slice || agent.inFlight || !slice.prompt) continue;
            if (slice.status === "left" || !slice.deliveryId) continue;
            void promptAgent(agent, slice.prompt, slice.deliveryId);
        }
        broadcast({ type: "state", ...snapshot() });
    } catch (error) {
        broadcast({ type: "error", detail: `dispatch: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
        dispatching = false;
    }
}

// ---------------------------------------------------------------- host checks

// Anything matching these must never arrive in a diff. Deliberately crude: the
// point is to catch an agent that committed a .env by accident, not to defeat
// one that is trying to hide something.
const SECRET_PATHS = /(^|\/)(\.env(\..+)?|.*\.pem|.*\.p12|id_rsa|.*\.keystore)$/i;
const SECRET_CONTENT = /(api[_-]?key|secret|password|BEGIN [A-Z ]*PRIVATE KEY)\s*[=:]\s*\S{12,}/i;

interface CheckResult { ok: boolean; lines: string[] }

/**
 * What the host can prove about a submitted commit, as opposed to what the
 * agent said about it. Every check runs; a failure does not short-circuit,
 * because the report is more useful when it lists everything that is wrong.
 */
// V2 compatibility.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function verifySubmission(params: {
    commit: string;
    branch: string;
    declaredPaths: string[];
}): CheckResult {
    const lines: string[] = [];
    let ok = true;
    const fail = (msg: string) => { ok = false; lines.push(`FAIL ${msg}`); };
    const pass = (msg: string) => lines.push(`ok   ${msg}`);

    const exists = git(state.repo, ["cat-file", "-e", `${params.commit}^{commit}`]);
    if (!exists.ok) {
        return { ok: false, lines: [`FAIL commit ${params.commit} does not exist in ${state.repo}`] };
    }
    pass(`commit ${params.commit.slice(0, 12)} exists`);

    // Ancestry, not just reachability: a commit that does not descend from the
    // declared base was built on something else and its diff means nothing.
    const base = git(state.repo, ["merge-base", "--is-ancestor", state.baseBranch, params.commit]);
    if (base.ok) pass(`descends from ${state.baseBranch}`);
    else fail(`does not descend from ${state.baseBranch}`);

    const onBranch = git(state.repo, ["merge-base", "--is-ancestor", params.commit, params.branch]);
    if (onBranch.ok) pass(`reachable from ${params.branch}`);
    else fail(`not reachable from ${params.branch}`);

    const diff = git(state.repo, ["diff", "--name-only", `${state.baseBranch}...${params.commit}`]);
    if (!diff.ok) {
        fail("could not read the diff");
        return { ok, lines };
    }
    const files = diff.out.split("\n").map((f) => f.trim()).filter(Boolean);
    pass(`${files.length} file(s) changed`);

    const secrets = files.filter((f) => SECRET_PATHS.test(f));
    if (secrets.length) fail(`secret-looking files added: ${secrets.join(", ")}`);
    else pass("no secret-looking filenames");

    if (params.declaredPaths.length) {
        const stray = files.filter((f) => !params.declaredPaths.some((p) => f === p || f.startsWith(p.replace(/\/?$/, "/"))));
        if (stray.length) fail(`outside declared scope: ${stray.slice(0, 20).join(", ")}`);
        else pass("diff stays inside the declared scope");
    } else {
        lines.push("note declared no path scope, so scope was not checked");
    }

    const patch = git(state.repo, ["diff", "-U0", `${state.baseBranch}...${params.commit}`]);
    if (patch.ok) {
        const added = patch.out.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
        const leaked = added.filter((l) => SECRET_CONTENT.test(l));
        if (leaked.length) fail(`${leaked.length} added line(s) look like credentials`);
        else pass("no credential-shaped lines added");
    }

    return { ok, lines };
}

// Runs after every accepted item, on a throwaway worktree cut from the base. A
// campaign is not finished because each task passed alone; this is the only
// thing that shows they work together.
function verifyIntegration(branches: string[]): CheckResult & { branch: string } {
    const branch = `council/${(state.code ?? "run").toLowerCase()}/integration`;
    const dir = `../integration-${(state.code ?? "run").toLowerCase()}`;
    const lines: string[] = [];
    let ok = true;

    git(state.repo, ["worktree", "remove", "--force", dir]);
    git(state.repo, ["branch", "-D", branch]);

    const added = git(state.repo, ["worktree", "add", dir, "-b", branch, state.baseBranch]);
    if (!added.ok) return { ok: false, branch, lines: [`FAIL could not create the integration worktree:\n${added.out}`] };
    lines.push(`ok   integration worktree on ${branch} from ${state.baseBranch}`);

    const treeDir = resolve(state.repo, dir);
    try {
        for (const b of branches) {
            const merged = git(treeDir, ["merge", "--no-edit", b]);
            if (merged.ok) {
                lines.push(`ok   merged ${b}`);
            } else {
                ok = false;
                lines.push(`FAIL conflict merging ${b}:\n${merged.out.slice(0, 2000)}`);
                git(treeDir, ["merge", "--abort"]);
                break;
            }
        }
        if (ok && state.verifyCommand.length) {
            const [cmd, ...rest] = state.verifyCommand;
            const run = spawnSync(cmd, rest, {
                cwd: treeDir, encoding: "utf8", shell: process.platform === "win32", env: buildCouncilAdapterEnv(process.env),
            });
            const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
            if (run.status === 0) {
                lines.push(`ok   ${state.verifyCommand.join(" ")} exited 0`);
            } else {
                ok = false;
                lines.push(`FAIL ${state.verifyCommand.join(" ")} exited ${run.status}\n${output.slice(-3000)}`);
            }
        } else if (ok) {
            lines.push("note no verify command configured, so only the merge was checked");
        }
    } finally {
        // The branch survives for review; only the checkout is disposable.
        git(state.repo, ["worktree", "remove", "--force", dir]);
    }
    return { ok, branch, lines };
}

const CAMPAIGN_PROMPT = (code: string, name: string) =>
    `Resume Zuychin work campaign ${code} as ${name}. Work only in this worktree. Call council_work_next with the session code and your agent name, then follow the assigned task exactly. Record heartbeats, commit and verify the work, submit it with council_work_complete, and stop for closer review. If you are the designated closer and council_work_status says review, inspect each submitted diff and verification, then accept it or return it with specific council_work_review feedback.`;

// Agents are looked up in the runtime map, which is keyed by instance name;
// the adapter table is keyed by provider and would miss "codex-1".
interface UnverifiedPayload {
    baseSha?: string | null;
    verificationProfile?: string;
    items?: {
        id: string; agentName: string; commitHash: string | null; declaredPaths?: string[];
        branchName?: string | null; verificationProfile?: string;
    }[];
}

// Runs before the agents are prompted, so the closer never sees a task the host
// has already disproved. Every awaiting-review item the host has not judged yet
// gets checked against the repo it actually owns.
async function hostVerifyTick(): Promise<void> {
    if (!state.code || !state.leaseHealthy || state.leaseEpoch === null) return;
    let payload: UnverifiedPayload;
    try {
        payload = JSON.parse(await callTool("council_work_unverified", { sessionCode: state.code })) as UnverifiedPayload;
    } catch {
        return;
    }
    if (!protectedRefsUnchanged(state.repo, state.protectedRefs)) {
        state.leaseHealthy = false;
        broadcast({ type: "error", detail: "A protected branch moved during Council execution. Verification and dispatch are paused." });
        return;
    }
    for (const item of payload.items ?? []) {
        const baseSha = payload.baseSha ?? state.baseSha;
        if (!item.commitHash || !baseSha) {
            await callTool("council_work_verify", {
                itemId: item.id, hostId: state.hostId, leaseEpoch: state.leaseEpoch,
                commitSha: item.commitHash ?? "0000000000000000000000000000000000000000",
                baseSha: baseSha ?? "0000000000000000000000000000000000000000",
                branchName: item.branchName ?? councilBranch(state.code, item.agentName),
                profileId: item.verificationProfile ?? payload.verificationProfile ?? "standard",
                receipts: [], outputDigest: "missing", passed: false,
                report: "FAIL submitted without an exact commit hash or frozen base",
            }).catch(() => { });
            continue;
        }
        const agent = state.agents.get(item.agentName);
        const branch = item.branchName ?? agent?.branch ?? councilBranch(state.code, item.agentName);
        const profileId = item.verificationProfile ?? payload.verificationProfile ?? "standard";
        let result;
        const shortSha = item.commitHash.slice(0, 12);
        log(`${item.agentName}: verifying ${shortSha} against the ${profileId} profile`);
        setBusy(`verifying ${shortSha}`);
        try {
            result = await verifyExactCommit({
                repo: state.repo, commitSha: item.commitHash, baseSha, branch,
                declaredPaths: item.declaredPaths ?? [], profile: loadVerificationProfile(state.repo, profileId),
                onProgress: (p) => setBusy(`verifying ${shortSha} - step ${p.step}/${p.steps}: ${p.command.join(" ")}`),
            });
        } catch (error) {
            result = {
                ok: false, commitSha: item.commitHash, baseSha, files: [], receipts: [],
                lines: [`FAIL ${error instanceof Error ? error.message : String(error)}`], outputDigest: "profile-error",
            };
        }
        log(`${item.agentName}: host check ${result.ok ? "passed" : "FAILED"} for ${item.commitHash.slice(0, 12)}`);
        await callToolRetrying("council_work_verify", {
            itemId: item.id, hostId: state.hostId, leaseEpoch: state.leaseEpoch,
            commitSha: result.commitSha, baseSha: result.baseSha, branchName: branch,
            profileId, receipts: sanitiseVerificationReceipts(result.receipts, evidenceContext()), redactionVersion: 1, outputDigest: result.outputDigest,
            passed: result.ok, report: sanitiseIntegrationText(result.lines.join("\n"), evidenceContext()),
        }).catch((e) => log(`host verify report failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    setBusy(null);
}

// The campaign is accepted item by item, but nothing has ever been tried
// together until this runs.
// V2 journal compatibility.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function legacyIntegrationTick(): Promise<void> {
    if (!state.code || !state.campaignComplete || integrationDone) return;
    integrationDone = true;
    const branches = [...state.agents.values()].map((a) => a.branch);
    log(`Assembling ${branches.length} branch(es) on a clean integration worktree…`);
    await callTool("council_integration_report", {
        sessionCode: state.code, status: "running", report: "Assembling the integration branch.",
    }).catch(() => { });

    const result = verifyIntegration(branches);
    const status = result.ok ? "verified" : result.lines.some((l) => l.startsWith("FAIL conflict")) ? "conflict" : "failed";
    log(`Integration ${status}.`);
    await callTool("council_integration_report", {
        sessionCode: state.code, status, branch: result.branch, report: result.lines.join("\n"),
    }).catch((e) => log(`integration report failed: ${e instanceof Error ? e.message : String(e)}`));
    broadcast({ type: "state", ...snapshot() });
}

let integrationDone = false;

interface FrozenManifestPayload { ok?: boolean; reason?: string; manifest?: IntegrationManifest; integratorAgent?: string | null; integrationStatus?: string | null }

interface IntegrationAttempt {
    id: string;
    status: "running";
    mode: "host" | "agent";
    integratorAgent: string | null;
    manifest: IntegrationManifest;
    manifestHash: string;
    baseBranch: string;
    baseSha: string;
}

interface IntegrationAssembly {
    ok: boolean;
    branch: string | null;
    tipSha: string | null;
    executionId: string | null;
    files: string[] | null;
    diffSummary: string | null;
    lines: string[];
    receipts: VerificationReceipt[];
}

interface IntegrationRun {
    code: string;
    hostId: string;
    leaseEpoch: number;
    repo: string;
    attemptId: string;
    redaction: IntegrationRedactionContext;
    nomination?: string | null;
    attempt?: IntegrationAttempt;
    finishSubmitted?: boolean;
    finish?: { attemptId: string; hostId: string; leaseEpoch: number; status: "verified" | "conflict" | "failed";
        branch: string | null; tipSha: string | null; executionId: string | null; evidence: IntegrationEvidence };
}

let pendingIntegration: IntegrationRun | null = null;
let integrating = false;

function evidenceContext(previous: IntegrationRedactionContext = {}): IntegrationRedactionContext {
    return { secrets: [...(previous.secrets ?? []), mcpHostKey ?? "", ...[...state.agents.values()].map((agent) => agent.seatToken ?? ""),
        ...credentialValues(process.env, ...Object.values(config.agents).map((adapter) => adapter.env ?? {}))].filter(Boolean),
        privatePaths: [...(previous.privatePaths ?? []), state.repo, state.runDir ?? "", process.env.USERPROFILE ?? "", process.env.HOME ?? ""].filter(Boolean) };
}

function ownsIntegration(run: IntegrationRun): boolean {
    return pendingIntegration === run && state.code === run.code && state.hostId === run.hostId && state.leaseEpoch === run.leaseEpoch
        && state.leaseHealthy && !state.stopping && !releasingCouncil;
}

function failedIntegration(error: unknown): IntegrationAssembly {
    return { ok: false, branch: null, tipSha: null, executionId: null, files: null, diffSummary: null, receipts: [],
        lines: [`FAIL ${error instanceof Error ? error.message : String(error)}`] };
}

async function integrationRequest(run: IntegrationRun, name: string, args: Record<string, unknown>): Promise<string> {
    for (let attempt = 0; ; attempt++) {
        if (!ownsIntegration(run)) throw new Error("host ownership changed during integration");
        if (name === "council_integration_finish" && run.finish && !run.finishSubmitted) {
            const observed = run.finish.evidence.protectedRefs.after;
            if (run.finish.status === "verified" && observed && !protectedRefsUnchanged(run.repo, observed)) {
                run.finish.status = "failed";
                run.finish.evidence.protectedRefs.after = snapshotProtectedRefs(run.repo, Object.keys(observed));
                run.finish.evidence.conflictNotes = "A protected branch moved before finalisation was submitted.";
            }
            run.finishSubmitted = true;
        }
        try {
            return await callTool(name, args, mcpHostKey, AbortSignal.timeout(15_000));
        } catch (error) {
            if (attempt >= 3 || (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === "TimeoutError"))) throw error;
            await new Promise((settle) => setTimeout(settle, 750 * (attempt + 1)));
        }
    }
}

function nextIntegrationBranch(): string {
    const stem = `council/${(state.code ?? "run").toLowerCase()}/integration`;
    let candidate = stem;
    for (let version = 2; git(state.repo, ["show-ref", "--verify", `refs/heads/${candidate}`]).ok; version++) candidate = `${stem}-v${version}`;
    return candidate;
}

async function delegatedIntegration(run: IntegrationRun, manifest: IntegrationManifest, integratorName: string): Promise<IntegrationAssembly> {
    const { code, repo } = run;
    if (!ownsIntegration(run)) throw new Error("delegated integration requires an active host lease");
    const original = state.agents.get(integratorName);
    if (!original) throw new Error(`nominated integrator ${integratorName} is not hosted here`);
    if (original.mode !== "acp") throw new Error(`nominated integrator ${integratorName} requires an ACP adapter`);
    const branch = nextIntegrationBranch();
    const relDir = `../integration-${(state.code ?? "run").toLowerCase()}-${randomBytes(4).toString("hex")}`;
    const treeDir = resolve(repo, relDir);
    const added = git(repo, ["worktree", "add", relDir, "-b", branch, manifest.baseSha]);
    if (!added.ok) throw new Error(`could not create delegated integration worktree: ${added.out}`);
    closeAgent(original);
    const agent = makeRuntime(integratorName, code, {
        modelId: original.requestedModel ?? undefined,
        reasoningEffort: original.requestedReasoningEffort ?? undefined,
    }, repo, true);
    agent.branch = branch; agent.relDir = relDir; agent.treeDir = treeDir;
    agent.logPath = join(state.runDir!, `${integratorName}-integration.log`);
    agent.mcpFile = join(state.runDir!, `${integratorName}-integration.mcp.json`);
    state.agents.set(integratorName, agent);
    try {
        await stopRecordedExecution(original, "replaced by delegated integration");
        if (!ownsIntegration(run)) {
            throw new Error("host ownership changed before delegated integration");
        }
        await issueAgentSeat(agent);
        await startRecordedAgent(agent, false);
        if (!ownsIntegration(run)) throw new Error("host ownership changed before integration prompt");
        const commits = [...manifest.items].sort((a, b) => a.sequence - b.sequence).map((item) => item.commitSha);
        const prompt = `You are the nominated integrator for Council ${state.code}. This is a dedicated integration worktree on ${branch}, frozen at ${manifest.baseSha}.
Merge ONLY these accepted commits in this exact order:\n${commits.map((sha) => `- ${sha}`).join("\n")}
Attempt each merge with git merge --no-edit <sha>. Resolve conflicts only inside this worktree. Do not merge, reset, switch, or update main or ${state.baseBranch}. Run the repository checks, commit any conflict resolution, then stop and summarize the resulting HEAD. The host will independently verify the exact manifest and branch tip.`;
        await promptAgent(agent, prompt);
        if (!ownsIntegration(run)) throw new Error("host ownership changed during integration prompt");
        if (agent.detail.startsWith("turn failed:")) throw new Error(agent.detail);
        const tip = git(treeDir, ["rev-parse", "HEAD"]);
        if (!tip.ok) throw new Error("integrator produced no branch tip");
        const tipSha = tip.out.split(/\s/)[0];
        for (const sha of commits) {
            if (!git(treeDir, ["merge-base", "--is-ancestor", sha, tipSha]).ok) throw new Error(`integration tip omits accepted commit ${sha}`);
        }
        const profile = loadVerificationProfile(repo, "standard");
        const verified = await verifyExactCommit({
            repo, commitSha: tipSha, baseSha: manifest.baseSha, branch,
            declaredPaths: [], profile: { ...profile, commands: [{ command: ["git", "diff", "--check", manifest.baseSha, tipSha, "--"] }, ...profile.commands] },
            onProgress: (p) => setBusy(`verifying ${integratorName}'s integration tip - step ${p.step}/${p.steps}: ${p.command.join(" ")}`),
        });
        if (git(repo, ["rev-parse", branch]).out !== tipSha) { verified.ok = false; verified.lines.push("FAIL integration tip changed during verification"); }
        return { ...verified, ...exactIntegrationDiff(repo, manifest.baseSha, tipSha), branch, tipSha, executionId: agent.executionId };
    } catch (error) {
        return { ...failedIntegration(error), branch, executionId: agent.executionId };
    } finally {
        closeAgent(agent);
        await stopRecordedExecution(agent, "delegated integration ended");
        await gitAsync(repo, ["worktree", "remove", "--force", treeDir]);
    }
}

async function integrationTick(): Promise<void> {
    if (!state.code || !state.campaignComplete || integrationDone || integrating || !state.leaseHealthy || state.leaseEpoch === null) return;
    integrating = true;
    const run = pendingIntegration ??= { code: state.code, hostId: state.hostId, leaseEpoch: state.leaseEpoch, repo: state.repo,
        attemptId: randomUUID(), redaction: evidenceContext() };
    try {
        if (!ownsIntegration(run)) return;
        if (!run.attempt) {
            await requireToolProperties(new Map([
                ["council_integration_begin", { property: "attemptId", type: "string", label: "immutable integration attempts" }],
                ["council_integration_finish", { property: "evidence", type: "object", label: "integration attempt evidence" }],
            ]));
            if (run.nomination === undefined) {
                const frozen = JSON.parse(await integrationRequest(run, "council_integration_manifest", {
                    sessionCode: run.code, hostId: run.hostId, leaseEpoch: run.leaseEpoch,
                })) as FrozenManifestPayload;
                if (!frozen.ok || !frozen.manifest) throw new Error(`integration manifest rejected: ${frozen.reason ?? "unknown"}`);
                run.nomination = frozen.integratorAgent ?? null;
            }
            const begun = JSON.parse(await integrationRequest(run, "council_integration_begin", {
                sessionCode: run.code, hostId: run.hostId, leaseEpoch: run.leaseEpoch, attemptId: run.attemptId, expectedIntegrator: run.nomination,
            })) as { ok?: boolean; reason?: string; attempt?: IntegrationAttempt };
            if (!ownsIntegration(run)) return;
            if (!begun.ok && begun.reason === "integrator_changed") run.nomination = undefined;
            const attempt = begun.attempt;
            if (!begun.ok || !attempt || attempt.id !== run.attemptId || attempt.status !== "running"
                || attempt.integratorAgent !== run.nomination || attempt.mode !== (run.nomination ? "agent" : "host")
                || attempt.baseSha !== state.baseSha || attempt.manifest?.baseSha !== attempt.baseSha || !Array.isArray(attempt.manifest.items)
                || !/^[0-9a-f]{64}$/i.test(attempt.manifestHash)) throw new Error(`integration begin rejected: ${begun.reason ?? "invalid attempt acknowledgement"}`);
            run.attempt = attempt;
        }
        if (!run.finish) {
            const attempt = run.attempt;
            const before = snapshotProtectedRefs(run.repo, [...new Set([attempt.baseBranch, "main"])]);
            let result: IntegrationAssembly;
            setBusy(attempt.integratorAgent ? `${attempt.integratorAgent} is merging the accepted manifest` : "assembling the accepted manifest");
            try {
                if (!protectedRefsUnchanged(run.repo, state.protectedRefs)) throw new Error("a protected branch moved before integration");
                result = attempt.integratorAgent
                    ? await delegatedIntegration(run, attempt.manifest, attempt.integratorAgent)
                    : { ...await integrateAcceptedManifest({ repo: run.repo, code: run.code, manifest: attempt.manifest,
                        profile: loadVerificationProfile(run.repo, "standard"),
                        onProgress: (progress) => { if (ownsIntegration(run)) setBusy(`integrating - step ${progress.step}/${progress.steps}: ${progress.command.join(" ")}`); },
                    }), executionId: null };
            } catch (error) { result = failedIntegration(error); }
            if (!ownsIntegration(run)) return;
            const after = snapshotProtectedRefs(run.repo, Object.keys(before));
            if (Object.keys(before).some((ref) => before[ref] !== after[ref])) { result.ok = false; result.lines.push("FAIL a protected branch moved during integration"); }
            let status: "verified" | "conflict" | "failed" = result.ok ? "verified" : result.lines.some((line) => line.startsWith("FAIL conflict")) ? "conflict" : "failed";
            let evidence: IntegrationEvidence;
            try {
                evidence = sanitiseIntegrationEvidence({ version: 1, redactionVersion: 1, receipts: result.receipts,
                    changedPaths: result.files, diffSummary: result.diffSummary, protectedRefs: { before, after },
                    conflictNotes: result.ok ? null : result.lines.filter((line) => line.startsWith("FAIL ")).join("\n"), manualChecks: null,
                }, evidenceContext(run.redaction));
            } catch {
                status = "failed";
                evidence = { version: 1, redactionVersion: 1, receipts: [], changedPaths: null, diffSummary: null,
                    protectedRefs: { before: null, after: null }, conflictNotes: "Integration evidence exceeded supported limits or could not be recorded safely.",
                    manualChecks: ["Inspect the retained integration branch. Structured verification evidence is incomplete."] };
            }
            run.finish = { attemptId: run.attemptId, hostId: run.hostId, leaseEpoch: run.leaseEpoch, status,
                branch: result.branch, tipSha: result.tipSha, executionId: result.executionId, evidence };
        }
        const finished = JSON.parse(await integrationRequest(run, "council_integration_finish", run.finish)) as { ok?: boolean; reason?: string; attemptId?: string };
        if (!ownsIntegration(run)) return;
        if (!finished.ok || finished.attemptId !== run.attemptId) throw new Error(`integration finish rejected: ${finished.reason ?? "invalid acknowledgement"}`);
        integrationDone = true;
        log(`Integration ${run.finish.status}.`);
    } catch (error) {
        if (ownsIntegration(run)) {
            const detail = sanitiseIntegrationText(`integration attempt failed: ${error instanceof Error ? error.message : String(error)}`, evidenceContext(run.redaction));
            log(detail); broadcast({ type: "error", detail });
        }
    } finally {
        integrating = false;
        if (ownsIntegration(run)) { setBusy(null); broadcast({ type: "state", ...snapshot() }); }
    }
}

// Non-reentrant: hostVerifyTick now yields for the minutes a build takes, so
// the 30s timer would otherwise stack passes and re-verify the same item.
let supervising = false;

// A campaign is created when the owner accepts a verdict, in the same step that
// closes the session. Requiring two consecutive sightings avoids releasing a
// Council in the window where the close is visible and the campaign is not.
let noCampaignSightings = 0;

/**
 * Hands a finished Council back. A debate Council closes, files its verdict and
 * has no campaign, so nothing drives it again; without this the host sat on a
 * dead Council holding its lease until someone killed the process, and no other
 * host could adopt it.
 */
let releasingCouncil: Promise<void> | undefined;

async function releaseCouncil(reason: string, code: string, leaseEpoch: number | null): Promise<void> {
    if (state.code !== code || state.leaseEpoch !== leaseEpoch) return;
    if (releasingCouncil) return releasingCouncil;
    const release = releaseOwnedCouncil(reason, code, leaseEpoch);
    releasingCouncil = release;
    try { await release; }
    finally { if (releasingCouncil === release) releasingCouncil = undefined; }
}

async function releaseOwnedCouncil(reason: string, code: string, leaseEpoch: number | null): Promise<void> {
    log(`${code} stopping: ${reason}`);
    const agents = [...state.agents.values()];
    for (const agent of agents) closeAgent(agent);
    for (const agent of agents) await stopRecordedExecution(agent, reason);
    if (leaseEpoch !== null) {
        try {
            const released = JSON.parse(await callTool("council_host_release", {
                sessionCode: code, hostId: state.hostId, leaseEpoch,
            }, mcpHostKey, AbortSignal.timeout(CLEANUP_TIMEOUT_MS))) as { ok?: boolean; reason?: string };
            if (released.ok !== true) throw new Error(released.reason ?? "server did not confirm lease release");
            log(`${code} released: ${reason}`);
        } catch (error) {
            const detail = `lease release unconfirmed for ${code}: ${error instanceof Error ? error.message : String(error)}`;
            broadcast({ type: "error", detail });
            log(detail);
        }
    }
    if (state.code !== code || state.leaseEpoch !== leaseEpoch) return;
    state.agents.clear();
    delivered.clear();
    state.code = null;
    state.sessionId = null;
    state.leaseEpoch = null;
    state.leaseExpiresAt = null;
    state.leaseHealthy = false;
    state.topic = null;
    state.status = "idle";
    state.campaignComplete = false;
    state.busyWith = null;
    state.round = 0;
    state.maxRounds = 0;
    state.floorHolder = null;
    state.runDir = null;
    state.baseSha = null;
    state.protectedRefs = {};
    integrationDone = false;
    pendingIntegration = null;
    noCampaignSightings = 0;
    broadcast({ type: "state", ...snapshot() });
    log("idle - waiting for a convene from /council");
}

async function superviseTick(): Promise<void> {
    if (!state.code || state.status !== "closed" || supervising) return;
    const code = state.code;
    const leaseEpoch = state.leaseEpoch;
    if (state.campaignComplete) {
        const completed = pendingIntegration;
        if (integrationDone && completed && ownsIntegration(completed)) {
            supervising = true;
            try {
                const current = JSON.parse(await callTool("council_integration_manifest", {
                    sessionCode: code, hostId: completed.hostId, leaseEpoch,
                }, mcpHostKey, AbortSignal.timeout(CLEANUP_TIMEOUT_MS))) as FrozenManifestPayload;
                if (ownsIntegration(completed) && integrationDone && current.ok && current.integrationStatus === "pending") {
                    pendingIntegration = null;
                    integrationDone = false;
                }
            } catch { /* A failed status read must not reopen a completed attempt. */ }
            finally { supervising = false; }
        }
        if (!integrationDone) void integrationTick();
        return;
    }
    supervising = true;
    try {
        await hostVerifyTick();
        if (state.code !== code || state.leaseEpoch !== leaseEpoch || state.status !== "closed" || releasingCouncil) return;
        for (const agent of state.agents.values()) {
            if (agent.mode !== "acp" || !agent.ready || !agent.session || agent.inFlight) continue;
            let text: string;
            try {
                text = await callTool("council_work_status", { sessionCode: code, agentName: agent.name });
            } catch {
                continue;
            }
            if (state.code !== code || state.leaseEpoch !== leaseEpoch || state.status !== "closed" || releasingCouncil) return;
            if (text.startsWith("SUPERVISE: complete")) {
                log("Campaign complete.");
                state.campaignComplete = true;
                broadcast({ type: "state", ...snapshot() });
                void integrationTick();
                return;
            }
            if (text.startsWith("SUPERVISE: blocked")) {
                broadcast({ type: "error", detail: "campaign blocked; resolve the recorded blocker" });
                return;
            }
            if (text.startsWith("SUPERVISE: no_campaign")) {
                if (++noCampaignSightings >= 2) await releaseCouncil("closed with no work campaign", code, leaseEpoch);
                return;
            }
            noCampaignSightings = 0;
            if (text.startsWith("SUPERVISE: active") || text.startsWith("SUPERVISE: review")) {
                void promptAgent(agent, CAMPAIGN_PROMPT(state.code, agent.name));
            }
        }
    } finally {
        supervising = false;
    }
}

// ---------------------------------------------------------------- auto-adopt

interface OpenCouncilsPayload {
    councils?: {
        code: string;
        topic: string;
        participants: { name: string; status: string; dispatchMode: boolean }[];
    }[];
}

let autoAdopting = false;

/**
 * Claims a council convened from somewhere this host cannot be reached, e.g.
 * the phone. Deliberately stricter than attach(): it takes a council only if it
 * can run ALL of it, because a half-adopted council leaves seats nobody is
 * driving and no human present to notice.
 */
async function autoAdoptTick(): Promise<void> {
    if (!autoAdopt || state.code || state.stopping || startingCouncil || autoAdopting) return;
    autoAdopting = true;
    try {
        const payload = JSON.parse(await callTool("council_open", {})) as OpenCouncilsPayload;
        for (const council of payload.councils ?? []) {
            const live = council.participants.filter((p) => p.status !== "left");
            if (live.length === 0) continue;
            if (!live.every((p) => config.instances?.[p.name] || config.agents[p.name])) continue;
            if (!live.every((p) => p.status === "invited" || p.dispatchMode)) continue;

            log(`AUTO-ADOPT: claiming ${council.code} (${live.map((p) => p.name).join(", ")}) - ${council.topic}`);
            broadcast({ type: "auto_adopt", code: council.code, topic: council.topic });
            await attach(council.code);
            return;
        }
    } catch (error) {
        log(`auto-adopt: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        autoAdopting = false;
    }
}

// ---------------------------------------------------------------- main

async function shutdown(code: number, reason: HostExitReason = "requested", detail: string | null = null): Promise<void> {
    if (state.stopping) return;
    facts.workInFlight = startingCouncil || (state.code !== null && !state.campaignComplete);
    state.stopping = true;
    log("stopping");
    emitHealth();
    for (const terminal of terminals.values()) killTree(terminal.child);
    for (const agent of state.agents.values()) {
        await stopRecordedExecution(agent, "host shutdown");
        closeAgent(agent);
    }
    if (state.code && state.leaseEpoch !== null) {
        await callTool("council_host_release", {
            sessionCode: state.code, hostId: state.hostId, leaseEpoch: state.leaseEpoch,
        }).catch(() => {});
    }
    broadcast({ type: "stopped" });
    releaseHostLock(state.hostId);
    emitExit(code, reason, detail);
    setTimeout(() => process.exit(code), 200);
}

if (!onPath("git")) die("git is not on PATH");
if (!git(state.repo, ["rev-parse", "--git-dir"]).ok) die(`${state.repo} is not a git repository`);
if (!git(state.repo, ["rev-parse", "--verify", state.baseBranch]).ok) die(`base branch "${state.baseBranch}" does not exist in ${state.repo}`);

const { port: hostPort } = await startControlChannel();
facts.hostId = state.hostId;
facts.port = hostPort;

// After binding, before the token file: the loser must not overwrite the
// winner's token and strand every paired browser on its way out. --no-lock is
// the documented recovery path for a lock nobody can explain.
if (process.argv.includes("--no-lock")) {
    hostSay("  singleton     off (--no-lock)");
} else {
    const lock = acquireHostLock({ pid: process.pid, hostId: state.hostId, port: hostPort, repo: state.repo });
    if (!lock.ok) {
        die(`another council host is already running on this machine (pid ${lock.holder.pid}, port ${lock.holder.port ?? "?"}, repo ${lock.holder.repo || "?"}).\nStop it first, or pass --no-lock if you are certain it is gone and ${lock.path} is stale.`, "singleton");
    }
    if (lock.tookOverStale) hostSay(`  singleton     reclaimed a stale lock at ${lock.path}`);
}

const hostDir = join(state.repo, "..", ".council-host");
mkdirSync(hostDir, { recursive: true });
// Keyed to the repo, not the port. .council-host is shared by sibling repos so
// the name still has to distinguish them, but a port fallback used to mint a
// new token and pairing code and silently strand every paired browser.
const repoSlug = state.repo.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "repo";
const hostFile = join(hostDir, `host-${repoSlug}.json`);
const legacyFile = join(hostDir, `host-${config.host?.port ?? HOST_PORT_FIRST}.json`);
const reused = adoptIdentity(hostFile) || adoptIdentity(legacyFile);
writeFileSync(hostFile, JSON.stringify({ port: hostPort, pid: process.pid, hostId: state.hostId, token, pairingCode, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });

const wantedPort = config.host?.port ?? HOST_PORT_FIRST;
hostSay(`\nCouncil host ${HOST_VERSION} on http://127.0.0.1:${hostPort} (loopback only)`);
if (hostPort !== wantedPort) {
    hostSay(`  NOTE          ${wantedPort} was busy, so this host is on ${hostPort}. The pairing code below is unchanged; a page already paired to ${wantedPort} is talking to a different process.`);
}
hostSay(`  pairing code  ${pairingCode}${reused ? " (reused; delete the token file to rotate)" : ""}`);
hostSay(`  token file    ${hostFile}`);
hostSay(`  origins       ${[...allowedOrigins].join(", ")}`);
hostSay(`  repo          ${state.repo} (base ${state.baseBranch})`);
hostSay(`  auto-adopt    ${autoAdopt ? "ON - will claim an open council it can run in full" : "off"}\n`);

process.on("SIGINT", () => void shutdown(0, "signal", "SIGINT"));
process.on("SIGTERM", () => void shutdown(0, "signal", "SIGTERM"));
// A crash has to reach the supervisor as an exit report, or the shell can only
// report "the process vanished" for the one case where it knows why.
process.on("uncaughtException", (error) => {
    console.error(error);
    emitExit(1, "fatal", error instanceof Error ? error.message : String(error));
    releaseHostLock(state.hostId);
    process.exit(1);
});

emitHealth();
setInterval(() => emitHealth(), HEALTH_BEAT_MS).unref();

// Windows delivers no SIGTERM, so without this a shell can only kill the host,
// which strands its database lease and orphans every agent it spawned.
if (supervised) {
    let buffered = "";
    process.stdin.setEncoding("utf8").on("data", (chunk: string) => {
        buffered += chunk;
        let cut = buffered.indexOf("\n");
        for (; cut >= 0; cut = buffered.indexOf("\n")) {
            const line = buffered.slice(0, cut);
            buffered = buffered.slice(cut + 1);
            const control = parseControl(line);
            if (control === null) continue;
            if (!control.ok) { emitLog("warn", `control refused: ${control.reason}`); continue; }
            void shutdown(0, "requested", control.value.reason ?? null);
        }
    });
    // A supervisor that goes away without asking is still a stop request: the
    // host it was launched to serve has nobody left to serve.
    process.stdin.on("end", () => void shutdown(0, "requested", "supervisor closed the control pipe"));
}

const attachCode = launch.attach ?? arg("attach");
if (attachCode) {
    await attach(attachCode).catch((error) => die(String(error instanceof Error ? error.message : error)));
} else if (arg("topic")) {
    await convene({
        topic: arg("topic") ?? "",
        brief: arg("brief") ?? "",
        names: (arg("agents") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        closer: arg("closer") ?? "",
        councilType: arg("type") ?? "debate",
        baseBranch: arg("base"),
    }).catch((error) => die(String(error instanceof Error ? error.message : error)));
} else {
    log(autoAdopt
        ? "idle - watching for a council to auto-adopt, or a convene from /council"
        : "idle - waiting for a convene from /council");
}

setInterval(() => void dispatchTick(), DISPATCH_POLL_MS);
setInterval(() => void renewLease(), 15_000);
setInterval(() => void superviseTick(), CAMPAIGN_POLL_MS);
// Campaign cadence, not dispatch: nothing here is time-critical, and a council
// waiting 30s for a host nobody asked for has lost nothing.
if (autoAdopt) setInterval(() => void autoAdoptTick(), CAMPAIGN_POLL_MS);
