/**
 * Convenes a council on the local host, starting it first if it is not running.
 *
 *   npx tsx --env-file=.env.local scripts/council-launch.mts \
 *     --topic "..." --brief "..." --agents claude-a,codex-1 \
 *     --closer claude-a --repo C:/path/to/repo
 *
 * The work is all in scripts/council-host.mts: this is the CLI onto it. Every
 * preflight below happens before anything exists in Postgres or on disk,
 * because a failure is cheapest there.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_PORT_FIRST, HOST_PORT_LAST, councilBranch, councilWorktreeDir } from "../src/lib/council/protocol.ts";
import { COUNCIL_TYPES } from "../src/lib/council/templates.ts";

interface Adapter { mode?: "acp" | "shell"; command: string; args: string[]; warn?: string }
interface AgentInstance { provider: string; expertise?: string }
interface LauncherConfig {
    mcpUrl: string;
    host?: { port?: number; origins?: string[] };
    agents: Record<string, Adapter>;
    instances?: Record<string, AgentInstance>;
}
interface HostRecord { port: number; pid: number; token: string; pairingCode: string }

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function die(message: string): never {
    console.error(`\n✗ ${message}\n`);
    process.exit(1);
}

function onPath(command: string): boolean {
    const probe = process.platform === "win32" ? "where" : "which";
    return spawnSync(probe, [command], { stdio: "ignore" }).status === 0;
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

const topic = arg("topic");
const brief = arg("brief");
const closer = arg("closer");
const names = (arg("agents") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const repo = arg("repo") ? resolve(arg("repo")!) : process.cwd();
const base = arg("base") ?? "main";
const councilType = arg("type") ?? "debate";
const dryRun = process.argv.includes("--dry-run");

if (!topic || !brief || names.length < 2 || !closer) {
    die("usage: --topic <t> --brief <b> --agents a,b[,c] --closer <a> [--type debate|code|research|audit|debug] [--repo <path>] [--base main] [--dry-run]");
}
if (!names.includes(closer)) die(`--closer "${closer}" is not in --agents (${names.join(", ")})`);
if (new Set(names).size !== names.length) die("--agents names must be unique; use instance names such as codex-1 and claude-a.");
if (!(COUNCIL_TYPES as readonly string[]).includes(councilType)) die(`--type must be one of ${COUNCIL_TYPES.join(", ")}`);

const configPath = join(HERE, "council-agents.json");
if (!existsSync(configPath)) {
    die(`missing ${configPath}\nCopy council-agents.example.json to council-agents.json and set the commands you actually run.`);
}
const config: LauncherConfig = JSON.parse(readFileSync(configPath, "utf8"));

function resolveAgent(name: string): { adapter: Adapter; provider: string } {
    const provider = config.instances?.[name]?.provider ?? name;
    const adapter = config.agents[provider];
    if (!adapter) die(`no provider adapter for "${name}" (provider "${provider}") in council-agents.json`);
    return { adapter, provider };
}

const selected = new Map(names.map((name) => [name, resolveAgent(name)]));

if (!process.env.MCP_API_KEY) die("MCP_API_KEY is not set (run with --env-file=.env.local)");
if (!onPath("git")) die("git is not on PATH");
if (!git(repo, ["rev-parse", "--git-dir"]).ok) die(`${repo} is not a git repository`);
if (!git(repo, ["rev-parse", "--verify", base]).ok) die(`base branch "${base}" does not exist in ${repo}`);

for (const name of names) {
    const { adapter, provider } = selected.get(name)!;
    if (!onPath(adapter.command)) die(`"${adapter.command}" for ${name} (provider ${provider}) is not on PATH`);
    const treeDir = resolve(repo, councilWorktreeDir(repo, name));
    if (existsSync(treeDir)) die(`${treeDir} already exists; remove it or close the previous council first`);
}

console.log(`Convening "${topic}"`);
console.log(`  type ${councilType} - agents ${names.join(", ")} - closer ${closer} - repo ${repo} - base ${base}\n`);

// Stops before convening on purpose: a dry run must not create a session in
// Postgres or a worktree on disk, or it is not dry.
if (dryRun) {
    console.log("dry run - nothing convened, no host started, no worktree created.\n");
    for (const name of names) {
        const { adapter, provider } = selected.get(name)!;
        const mode = adapter.mode ?? "acp";
        console.log(`  ${name} (${provider}, ${mode} mode)`);
        console.log(`    worktree ${councilWorktreeDir(repo, name)} on ${councilBranch("CN-XXXX", name)}`);
        console.log(`    ${adapter.command} ${adapter.args.join(" ")}`);
        if (adapter.warn) console.log(`    ! ${adapter.warn}`);
    }
    process.exit(0);
}

const hostDir = join(repo, "..", ".council-host");

function knownHosts(): HostRecord[] {
    if (!existsSync(hostDir)) return [];
    return readdirSync(hostDir)
        .filter((f) => f.startsWith("host-") && f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(hostDir, f), "utf8")) as HostRecord);
}

async function liveHost(): Promise<HostRecord | null> {
    for (const record of knownHosts()) {
        try {
            const res = await fetch(`http://127.0.0.1:${record.port}/health`, {
                headers: { Authorization: `Bearer ${record.token}` },
            });
            if (!res.ok) continue;
            const health = await res.json() as { code?: string | null };
            if (health.code) {
                die(`the host on port ${record.port} already owns council ${health.code}. Stop it before convening another.`);
            }
            return record;
        } catch {
            continue;
        }
    }
    return null;
}

async function waitForHost(deadlineMs: number): Promise<HostRecord> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
        const record = await liveHost();
        if (record) return record;
        if (Date.now() > deadline) die(`the host did not come up on ports ${HOST_PORT_FIRST}-${HOST_PORT_LAST}; see ${join(hostDir, "host.log")}`);
        await new Promise((r) => setTimeout(r, 500));
    }
}

let host = await liveHost();
if (host) {
    console.log(`Using the council host already running on port ${host.port}.`);
} else {
    // Detached so the council outlives this terminal.
    mkdirSync(hostDir, { recursive: true });
    const child = spawn(process.execPath, [
        "--no-warnings", "--experimental-strip-types",
        join(HERE, "council-host.mts"), "--repo", repo, "--base", base,
    ], { detached: true, stdio: "ignore", env: process.env });
    child.unref();
    console.log("Starting the council host...");
    host = await waitForHost(30_000);
    console.log(`Council host up on port ${host.port} - pairing code ${host.pairingCode}`);
}

const res = await fetch(`http://127.0.0.1:${host.port}/health`, { headers: { Authorization: `Bearer ${host.token}` } });
if (!res.ok) die(`the host on port ${host.port} refused the token in ${hostDir}`);

// The host owns convening, so the CLI hands it the request over the same
// control channel the PWA uses rather than calling MCP itself.
const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws`, [host.token]);
const opened = new Promise<void>((ok, fail) => {
    ws.addEventListener("open", () => ok());
    ws.addEventListener("error", () => fail(new Error("could not open the host control channel")));
});
await opened.catch((error) => die(String(error.message)));

ws.send(JSON.stringify({ type: "convene", topic, brief, agents: names, closer, councilType }));

const settled = await new Promise<{ code?: string | null; error?: string }>((done) => {
    const timer = setTimeout(() => done({ error: "the host did not report a council within 60s" }), 60_000);
    ws.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; code?: string | null; detail?: string };
        if (message.type === "error") { clearTimeout(timer); done({ error: message.detail }); }
        if (message.type === "state" && message.code) { clearTimeout(timer); done({ code: message.code }); }
    });
});
ws.close();

if (settled.error) die(settled.error);
const code = settled.code!;
const runDir = join(repo, "..", `.council-run-${code.toLowerCase()}`);

console.log(`\nCouncil ${code} opened on host port ${host.port}.\n`);
for (const name of names) {
    const { adapter } = selected.get(name)!;
    console.log(`  ${name}: ${councilWorktreeDir(repo, name)} on ${councilBranch(code, name)} (${adapter.mode ?? "acp"} mode)`);
    if (adapter.warn) console.log(`     ! ${adapter.warn}`);
}

console.log(`\nWatch: http://localhost:3000/council   (or tail ${runDir})`);
console.log(`Pair a deployed PWA with code ${host.pairingCode}.`);
console.log(`The host keeps running after this command exits. Stop it from /council, or:`);
console.log(`  taskkill /PID ${host.pid} /F`);
console.log(`\nWhen it closes, merge from ${repo}:`);
for (const name of names) console.log(`  git merge --no-ff ${councilBranch(code, name)}`);
console.log(`\nThen clean up:`);
for (const name of names) console.log(`  git worktree remove ${councilWorktreeDir(repo, name)}`);
