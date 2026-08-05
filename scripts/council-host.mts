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
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, type WriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import * as acp from "@agentclientprotocol/sdk";
import { insideWorktree, killTree, onPath, spawnResolved } from "./council-host-paths.mts";
import {
    CODE_ALPHABET, COUNCIL_MCP_SERVER_NAME, DISPATCH_POLL_MS, HOST_PORT_FIRST, HOST_PORT_LAST,
    MODERATOR_NAME, PERMISSION_PROMPT_TIMEOUT_MS, councilBranch, councilWorktreeDir,
} from "../src/lib/council/protocol.ts";
import { parseKickoffBlocks, renderDispatchKickoff } from "../src/lib/council/render.ts";
import { COUNCIL_TYPES } from "../src/lib/council/templates.ts";

const HOST_VERSION = "1.0.0";
const CAMPAIGN_POLL_MS = 30_000;
const TERMINAL_OUTPUT_LIMIT = 1_000_000;
const MAX_PAIR_FAILURES = 10;

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
}
interface AgentInstance { provider: string; expertise?: string }
interface HostConfig {
    mcpUrl: string;
    /**
     * autoAdopt lets an idle host claim a council convened elsewhere, which is
     * what makes "ask Zuychin from the phone" work. Off unless set: it starts
     * vendor processes with nobody at the keyboard, and a permission prompt
     * outside a worktree auto-denies after 120s unseen.
     */
    host?: { port?: number; origins?: string[]; autoAdopt?: boolean };
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

function die(message: string): never {
    console.error(`\n✗ ${message}\n`);
    process.exit(1);
}

function log(message: string): void {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

// ---------------------------------------------------------------- MCP

const mcpKey = process.env.MCP_API_KEY;
if (!mcpKey) die("MCP_API_KEY is not set (run with --env-file=.env.local)");

const configPath = arg("config") ?? join(HERE, "council-agents.json");
if (!existsSync(configPath)) {
    die(`missing ${configPath}\nCopy council-agents.example.json to council-agents.json and set the commands you actually run.`);
}
const config: HostConfig = JSON.parse(readFileSync(configPath, "utf8"));

// The endpoint answers a bare tools/call with no initialize handshake, and
// frames the reply as one SSE "data:" line.
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await fetch(config.mcpUrl, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${mcpKey}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`${name} failed: HTTP ${res.status} ${raw.slice(0, 300)}`);
    const line = raw.split("\n").find((l) => l.startsWith("data:"));
    const payload = JSON.parse(line ? line.slice(5).trim() : raw);
    if (payload.error) throw new Error(`${name} failed: ${payload.error.message ?? JSON.stringify(payload.error)}`);
    const text = payload.result?.content?.[0]?.text;
    // An unknown tool or a rejected key comes back as a RESULT carrying isError,
    // not as a JSON-RPC error. Returning that prose would hand a JSON caller a
    // parse failure instead of the reason, which is how "council_open not found"
    // reads as a syntax error.
    if (payload.result?.isError) throw new Error(`${name} failed: ${typeof text === "string" ? text : "unknown error"}`);
    if (typeof text !== "string") throw new Error(`${name} returned no text`);
    return text;
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
}
interface DispatchPayload {
    error?: string;
    sessionCode: string;
    topic: string;
    status: string;
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
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
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
    /**
     * Last turn read to completion; an errored turn never lands here, so a
     * failed delivery redelivers while an identical clean one does not.
     */
    lastDelivered: string | null;
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
    code: string | null;
    topic: string | null;
    status: string;
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
}

const repoArg = arg("repo");
const state: HostState = {
    code: null,
    topic: null,
    status: "idle",
    round: 0,
    maxRounds: 0,
    floorHolder: null,
    repo: repoArg ? resolve(repoArg) : process.cwd(),
    baseBranch: arg("base") ?? "main",
    verifyCommand: config.verifyCommand ?? [],
    runDir: null,
    agents: new Map(),
    pending: new Map(),
    stopping: false,
};

function seatExpertise(name: string, provider: string): string {
    return config.instances?.[name]?.expertise ?? `${provider} coding agent`;
}

function resolveAgent(name: string): { adapter: Adapter; provider: string; expertise: string } {
    const instance = config.instances?.[name];
    const provider = instance?.provider ?? name;
    const adapter = config.agents[provider];
    if (!adapter) die(`no provider adapter for "${name}" (provider "${provider}") in council-agents.json`);
    return { adapter, provider, expertise: seatExpertise(name, provider) };
}

/**
 * The seats this machine can actually fill, so the app proposes names that
 * exist instead of guessing. A seat whose provider has no adapter is omitted:
 * it could only fail at spawn.
 */
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
    };
}

function snapshot() {
    return {
        version: HOST_VERSION,
        code: state.code,
        // Same rule convene() and attach() refuse on, so the app can grey out a
        // Launch button instead of learning by error.
        busy: state.code !== null,
        instances: seats,
        topic: state.topic,
        status: state.status,
        round: state.round,
        maxRounds: state.maxRounds,
        floorHolder: state.floorHolder,
        repo: state.repo,
        runDir: state.runDir,
        agents: [...state.agents.values()].map(agentView),
        permissions: [...state.pending.values()].map((p) => ({
            id: p.id, agent: p.agent, kind: p.kind, title: p.title,
            path: p.path, reason: p.reason, createdAt: p.createdAt,
        })),
    };
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
            }).catch((error) => broadcast({ type: "error", detail: String(error) }));
            break;
        case "attach":
            void attach(String(message.code ?? "")).catch((error) => broadcast({ type: "error", detail: String(error) }));
            break;
        case "interrupt": {
            const agent = state.agents.get(String(message.agent));
            if (agent?.session) void agent.session.prompt("").catch(() => {});
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
            server.listen(port, "127.0.0.1", () => resolvePort({ server, port }));
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
        env: { ...process.env, ...Object.fromEntries((params.env ?? []).map((e) => [e.name, e.value])) },
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
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(agent.adapter.env ?? {})) {
        // Removal matters as much as setting: an agent that refuses to run when
        // it detects its own vendor's session variable cannot be started from a
        // host launched inside one.
        if (value === null) delete env[key];
        else env[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
    return env;
}

function mcpServersFor(): acp.McpServer[] {
    // Passed over the stdio pipe, so the bearer token never lands on disk the
    // way the shell adapters' --mcp-config file has to.
    return [{
        type: "http",
        name: COUNCIL_MCP_SERVER_NAME,
        url: config.mcpUrl,
        headers: [{ name: "Authorization", value: `Bearer ${mcpKey}` }],
    }];
}

async function startAcpAgent(agent: AgentRuntime): Promise<void> {
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
        agent.state = "exited";
        agent.detail = `process exited (${code})`;
        agent.inFlight = false;
        broadcast({ type: "agent_exit", agent: agent.name, code });
        log(`${agent.name} exited (${code})`);
    });
    child.on("error", (error) => {
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

    await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: "zuychin-council-host", version: HOST_VERSION },
    });

    agent.session = await connection.agent
        .buildSession({ cwd: agent.treeDir, mcpServers: mcpServersFor() })
        .start();

    // prompt() resolves with the turn's stop reason, so this loop only relays;
    // turn completion is handled where the prompt was sent.
    void (async () => {
        for (;;) {
            try {
                const message = await agent.session!.nextUpdate();
                if (message.kind === "session_update") relayUpdate(agent, message.update);
            } catch {
                return;
            }
        }
    })();

    agent.state = "idle";
    agent.detail = "session ready";
    log(`${agent.name}: ACP session ${agent.session.sessionId}`);
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
                    headers: { Authorization: `Bearer ${mcpKey}` },
                },
            },
        }, null, 2));
    }
    const args = agent.adapter.args.map((a) => a.replace("{prompt}", prompt).replace("{mcpConfigFile}", agent.mcpFile));
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
const delivered = new Set<string>();

// Delivery is at-least-once. The ack is deferred to the tick AFTER the turn
// completes, so a host that dies mid-turn redelivers the same batch rather than
// leaving a hole in what the agent read.
async function promptAgent(agent: AgentRuntime, prompt: string, ack: boolean): Promise<void> {
    if (!agent.session || agent.inFlight) return;
    agent.inFlight = true;
    agent.state = "busy";
    broadcast({ type: "turn", agent: agent.name, chars: prompt.length });
    agent.log?.write(`\n--- TURN PUSHED ---\n${prompt}\n\n`);
    try {
        const response = await agent.session.prompt(prompt);
        agent.detail = `turn ended: ${response.stopReason}`;
        agent.lastDelivered = prompt;
        if (ack) delivered.add(agent.name);
    } catch (error) {
        agent.detail = `turn failed: ${error instanceof Error ? error.message : String(error)}`;
        broadcast({ type: "error", agent: agent.name, detail: agent.detail });
    } finally {
        agent.inFlight = false;
        if (agent.state === "busy") agent.state = "idle";
        agent.lastActivity = new Date().toISOString();
    }
}

// ---------------------------------------------------------------- lifecycle

function makeRuntime(name: string, code: string): AgentRuntime {
    const { adapter, provider, expertise } = resolveAgent(name);
    const relDir = councilWorktreeDir(state.repo, name);
    return {
        name, provider, expertise, adapter,
        mode: adapter.mode ?? "acp",
        branch: councilBranch(code, name),
        relDir,
        treeDir: resolve(state.repo, relDir),
        logPath: join(state.runDir!, `${name}.log`),
        mcpFile: join(state.runDir!, `${name}.mcp.json`),
        state: "pending",
        detail: "",
        inFlight: false,
        lastDelivered: null,
        lastActivity: new Date().toISOString(),
    };
}

function addWorktree(agent: AgentRuntime): void {
    if (existsSync(agent.treeDir)) {
        throw new Error(`${agent.treeDir} already exists; remove it or close the previous council first`);
    }
    const added = git(state.repo, ["worktree", "add", agent.relDir, "-b", agent.branch, state.baseBranch]);
    if (!added.ok) throw new Error(`git worktree add failed for ${agent.name}:\n${added.out}`);
    log(`${agent.name}: worktree ${agent.relDir} on ${agent.branch}`);
}

const RESUME_PREAMBLE = (code: string) =>
    `You are resuming council ${code}. Your previous session on this machine ended; this one has no
memory of it. Call council_join first - it returns the rules and the recent transcript - then
continue the protocol from there. Your worktree and branch are unchanged and your earlier commits
are still in it.`;

async function startAgents(kickoff: Map<string, string>): Promise<void> {
    for (const agent of state.agents.values()) {
        const prompt = kickoff.get(agent.name) ?? RESUME_PREAMBLE(state.code!);
        try {
            if (agent.mode === "shell") {
                startShellAgent(agent, prompt);
                continue;
            }
            await startAcpAgent(agent);
            // Claimed by the host, not the agent: it must be true before the
            // agent's first call and cannot depend on an LLM passing a flag.
            // Only after a session exists, so a failed agent misses quorum.
            await callTool("council_join", {
                sessionCode: state.code, agentName: agent.name,
                expertise: agent.expertise, dispatchMode: true,
            });
            void promptAgent(agent, `${prompt}\n${renderDispatchKickoff(state.code!, agent.name)}`, false);
        } catch (error) {
            agent.state = "failed";
            agent.detail = error instanceof Error ? error.message : String(error);
            broadcast({ type: "error", agent: agent.name, detail: agent.detail });
            log(`${agent.name} failed to start: ${agent.detail}`);
        }
    }
    broadcast({ type: "state", ...snapshot() });
}

function prepareRun(code: string, names: string[]): void {
    state.code = code;
    state.runDir = join(state.repo, "..", `.council-run-${code.toLowerCase()}`);
    mkdirSync(state.runDir, { recursive: true });
    for (const name of names) state.agents.set(name, makeRuntime(name, code));
    writeFileSync(join(state.runDir, "campaign-run.json"), JSON.stringify({
        code, configPath, port: hostPort,
        agents: [...state.agents.values()].map((a) => ({ name: a.name, dir: a.treeDir, mcpFile: a.mcpFile, mode: a.mode })),
    }, null, 2));
}

async function convene(params: {
    topic: string; brief: string; names: string[]; closer: string; councilType: string;
}): Promise<void> {
    if (state.code) throw new Error(`this host already owns ${state.code}`);
    const { topic, brief, names, closer, councilType } = params;
    if (!topic || !brief || names.length < 2 || !closer) throw new Error("convene needs topic, brief, at least two agents and a closer");
    if (!names.includes(closer)) throw new Error(`closer "${closer}" is not one of ${names.join(", ")}`);
    if (new Set(names).size !== names.length) throw new Error("agent names must be unique");
    if (!(COUNCIL_TYPES as readonly string[]).includes(councilType)) throw new Error(`type must be one of ${COUNCIL_TYPES.join(", ")}`);

    const text = await callTool("council_convene", {
        topic, brief, closerName: closer, councilType,
        participants: names.map((name) => ({ name, expertise: resolveAgent(name).expertise })),
        workspace: { repoPath: state.repo, baseBranch: state.baseBranch },
    });
    const { code, blocks } = parseKickoffBlocks(text);
    if (!code) throw new Error(`could not read the council code from the convene reply:\n${text.slice(0, 300)}`);
    if (blocks.length !== names.length) {
        throw new Error(`convene returned ${blocks.length} kickoff blocks for ${names.length} agents; refusing to launch a partial council`);
    }

    prepareRun(code, names);
    state.topic = topic;
    state.status = "open";
    log(`Council ${code} opened: ${topic}`);

    for (const agent of state.agents.values()) addWorktree(agent);
    await startAgents(new Map(blocks.map((b) => [b.agentName, b.prompt])));
}

// Reconnecting to a council whose worktrees already exist, after the host was
// killed. The agents get a fresh ACP session and the dispatch loop redelivers
// whatever they never acknowledged.
async function attach(code: string): Promise<void> {
    if (state.code) throw new Error(`this host already owns ${state.code}`);
    const upper = code.trim().toUpperCase();
    // The roster is the thing being read here; a name that is not on it gets no
    // slice and changes nothing, which is what makes this safe as a probe.
    const payload = JSON.parse(await callTool("council_dispatch", { sessionCode: upper, agentNames: ["host-probe"] })) as DispatchPayload;
    if (payload.error === "unknown_session") throw new Error(`no council found with code ${upper}`);

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

    prepareRun(upper, names);
    state.topic = payload.topic;
    state.status = payload.status;
    log(`Attached to ${upper}: ${names.join(", ")}`);

    for (const agent of state.agents.values()) {
        if (!existsSync(agent.treeDir)) addWorktree(agent);
    }
    await startAgents(new Map());
}

// ---------------------------------------------------------------- dispatch

let dispatching = false;

async function dispatchTick(): Promise<void> {
    const owned = [...state.agents.values()].filter((a) => a.mode === "acp" && a.session);
    if (!state.code || owned.length === 0 || dispatching) return;
    dispatching = true;

    const ackFor = [...delivered];
    for (const name of ackFor) delivered.delete(name);
    let payload: DispatchPayload;
    try {
        payload = JSON.parse(await callTool("council_dispatch", {
            sessionCode: state.code,
            agentNames: owned.map((a) => a.name),
            ...(ackFor.length ? { ackFor } : {}),
        })) as DispatchPayload;
    } catch (error) {
        // Put the acks back rather than dropping them; an unacknowledged batch
        // costs a redelivery, a lost ack costs an endless one.
        for (const name of ackFor) delivered.add(name);
        broadcast({ type: "error", detail: `dispatch: ${error instanceof Error ? error.message : String(error)}` });
        return;
    } finally {
        dispatching = false;
    }
    if (payload.error) {
        for (const name of ackFor) delivered.add(name);
        return;
    }

    state.status = payload.status;
    state.round = payload.round;
    state.maxRounds = payload.maxRounds;
    state.floorHolder = payload.floorHolder;

    for (const agent of owned) {
        const slice = payload.agents?.[agent.name];
        if (!slice || agent.inFlight || !slice.prompt) continue;
        if (slice.status === "left" || slice.prompt === agent.lastDelivered) continue;
        void promptAgent(agent, slice.prompt, true);
    }
    broadcast({ type: "state", ...snapshot() });
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
            const run = spawnSync(cmd, rest, { cwd: treeDir, encoding: "utf8", shell: process.platform === "win32" });
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
    items?: {
        id: string; agentName: string; commitHash: string | null; declaredPaths?: string[];
    }[];
}

// Runs before the agents are prompted, so the closer never sees a task the host
// has already disproved. Every awaiting-review item the host has not judged yet
// gets checked against the repo it actually owns.
async function hostVerifyTick(): Promise<void> {
    if (!state.code) return;
    let payload: UnverifiedPayload;
    try {
        payload = JSON.parse(await callTool("council_work_unverified", { sessionCode: state.code })) as UnverifiedPayload;
    } catch {
        return;
    }
    for (const item of payload.items ?? []) {
        if (!item.commitHash) {
            await callTool("council_work_verify", {
                itemId: item.id, passed: false,
                report: "FAIL submitted without a commit hash",
            }).catch(() => { });
            continue;
        }
        const agent = state.agents.get(item.agentName);
        const branch = agent?.branch ?? councilBranch(state.code, item.agentName);
        const result = verifySubmission({
            commit: item.commitHash, branch, declaredPaths: item.declaredPaths ?? [],
        });
        log(`${item.agentName}: host check ${result.ok ? "passed" : "FAILED"} for ${item.commitHash.slice(0, 12)}`);
        await callTool("council_work_verify", {
            itemId: item.id, passed: result.ok, report: result.lines.join("\n"),
        }).catch((e) => log(`host verify report failed: ${e instanceof Error ? e.message : String(e)}`));
    }
}

// The campaign is accepted item by item, but nothing has ever been tried
// together until this runs.
async function integrationTick(): Promise<void> {
    if (!state.code || state.status !== "campaign_complete" || integrationDone) return;
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

async function superviseTick(): Promise<void> {
    if (!state.code || state.status !== "closed") return;
    await hostVerifyTick();
    for (const agent of state.agents.values()) {
        if (agent.mode !== "acp" || !agent.session || agent.inFlight) continue;
        let text: string;
        try {
            text = await callTool("council_work_status", { sessionCode: state.code, agentName: agent.name });
        } catch {
            continue;
        }
        if (text.startsWith("SUPERVISE: complete")) {
            log("Campaign complete.");
            state.status = "campaign_complete";
            broadcast({ type: "state", ...snapshot() });
            void integrationTick();
            return;
        }
        if (text.startsWith("SUPERVISE: blocked")) {
            broadcast({ type: "error", detail: "campaign blocked; resolve the recorded blocker" });
            return;
        }
        if (text.startsWith("SUPERVISE: active") || text.startsWith("SUPERVISE: review")) {
            void promptAgent(agent, CAMPAIGN_PROMPT(state.code, agent.name), false);
        }
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
    if (!config.host?.autoAdopt || state.code || state.stopping || autoAdopting) return;
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

async function shutdown(code: number): Promise<void> {
    if (state.stopping) return;
    state.stopping = true;
    log("stopping");
    for (const terminal of terminals.values()) killTree(terminal.child);
    for (const agent of state.agents.values()) {
        agent.connection?.close();
        if (agent.child) killTree(agent.child);
        agent.log?.end();
    }
    broadcast({ type: "stopped" });
    setTimeout(() => process.exit(code), 200);
}

if (!onPath("git")) die("git is not on PATH");
if (!git(state.repo, ["rev-parse", "--git-dir"]).ok) die(`${state.repo} is not a git repository`);
if (!git(state.repo, ["rev-parse", "--verify", state.baseBranch]).ok) die(`base branch "${state.baseBranch}" does not exist in ${state.repo}`);

const { port: hostPort } = await startControlChannel();
const hostDir = join(state.repo, "..", ".council-host");
mkdirSync(hostDir, { recursive: true });
const hostFile = join(hostDir, `host-${hostPort}.json`);
const reused = adoptIdentity(hostFile);
writeFileSync(hostFile, JSON.stringify({ port: hostPort, pid: process.pid, token, pairingCode, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });

console.log(`\nCouncil host ${HOST_VERSION} on http://127.0.0.1:${hostPort} (loopback only)`);
console.log(`  pairing code  ${pairingCode}${reused ? " (reused; delete the token file to rotate)" : ""}`);
console.log(`  token file    ${hostFile}`);
console.log(`  origins       ${[...allowedOrigins].join(", ")}`);
console.log(`  repo          ${state.repo} (base ${state.baseBranch})`);
console.log(`  auto-adopt    ${config.host?.autoAdopt ? "ON - will claim an open council it can run in full" : "off"}\n`);

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

const attachCode = arg("attach");
if (attachCode) {
    await attach(attachCode).catch((error) => die(String(error instanceof Error ? error.message : error)));
} else if (arg("topic")) {
    await convene({
        topic: arg("topic") ?? "",
        brief: arg("brief") ?? "",
        names: (arg("agents") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        closer: arg("closer") ?? "",
        councilType: arg("type") ?? "debate",
    }).catch((error) => die(String(error instanceof Error ? error.message : error)));
} else {
    log(config.host?.autoAdopt
        ? "idle - watching for a council to auto-adopt, or a convene from /council"
        : "idle - waiting for a convene from /council or council-launch.mts");
}

setInterval(() => void dispatchTick(), DISPATCH_POLL_MS);
setInterval(() => void superviseTick(), CAMPAIGN_POLL_MS);
// Campaign cadence, not dispatch: nothing here is time-critical, and a council
// waiting 30s for a host nobody asked for has lost nothing.
if (config.host?.autoAdopt) setInterval(() => void autoAdoptTick(), CAMPAIGN_POLL_MS);
