/**
 * Convenes a council and launches each agent into its own git worktree, so no
 * kickoff block has to be pasted by hand.
 *
 *   npx tsx --env-file=.env.local scripts/council-launch.mts \
 *     --topic "..." --brief "..." --agents claude-code,codex \
 *     --closer claude-code --repo C:/path/to/repo
 *
 * Zuychin is serverless and cannot start a process on this machine, so this
 * runs locally: it calls council_convene over the MCP endpoint, then spawns the
 * agent CLIs itself. The command for each agent comes from the local adapter
 * file ONLY - never from the council record - so convening can never decide
 * what runs here.
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { councilBranch, councilWorktreeDir } from "../src/lib/council/protocol.ts";
import { parseKickoffBlocks } from "../src/lib/council/render.ts";
import { COUNCIL_TYPES } from "../src/lib/council/templates.ts";

interface Adapter {
    command: string;
    /** "{prompt}" and "{mcpConfigFile}" are substituted per agent. */
    args: string[];
    /** Writes an MCP config outside the worktree and substitutes its path. */
    mcpConfig?: "claude";
    warn?: string;
}
interface AgentInstance { provider: string; expertise?: string; }
interface LauncherConfig {
    mcpUrl: string;
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

function onPath(command: string): boolean {
    const probe = process.platform === "win32" ? "where" : "which";
    return spawnSync(probe, [command], { stdio: "ignore" }).status === 0;
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

// The endpoint answers a bare tools/call with no initialize handshake, and
// frames the reply as one SSE "data:" line.
async function callConvene(cfg: LauncherConfig, key: string, args: Record<string, unknown>): Promise<string> {
    const res = await fetch(cfg.mcpUrl, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: "council_convene", arguments: args },
        }),
    });
    const raw = await res.text();
    if (!res.ok) die(`convene failed: HTTP ${res.status}\n${raw.slice(0, 400)}`);

    const line = raw.split("\n").find((l) => l.startsWith("data:"));
    const payload = JSON.parse(line ? line.slice(5).trim() : raw);
    if (payload.error) die(`convene failed: ${payload.error.message ?? JSON.stringify(payload.error)}`);
    const text = payload.result?.content?.[0]?.text;
    if (typeof text !== "string") die(`convene returned no text:\n${raw.slice(0, 400)}`);
    return text;
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
if (new Set(names).size !== names.length) die("--agents names must be unique; use instance names such as codex-1 and codex-2.");
if (!(COUNCIL_TYPES as readonly string[]).includes(councilType)) die(`--type must be one of ${COUNCIL_TYPES.join(", ")}`);

const configPath = join(HERE, "council-agents.json");
if (!existsSync(configPath)) {
    die(`missing ${configPath}\nCopy council-agents.example.json to council-agents.json and set the commands you actually run.`);
}
const config: LauncherConfig = JSON.parse(readFileSync(configPath, "utf8"));

function resolveAgent(name: string): { adapter: Adapter; provider: string; expertise: string } {
    const instance = config.instances?.[name];
    const provider = instance?.provider ?? name;
    const adapter = config.agents[provider];
    if (!adapter) die(`no provider adapter for "${name}" (provider "${provider}") in council-agents.json`);
    return { adapter, provider, expertise: instance?.expertise ?? `${provider} coding agent` };
}

const selectedAgents = new Map(names.map((name) => [name, resolveAgent(name)]));

const mcpKey = process.env.MCP_API_KEY;
if (!mcpKey) die("MCP_API_KEY is not set (run with --env-file=.env.local)");

// Preflight: every failure here is cheaper before a session exists in Postgres.
if (!onPath("git")) die("git is not on PATH");
if (!git(repo, ["rev-parse", "--git-dir"]).ok) die(`${repo} is not a git repository`);
if (!git(repo, ["rev-parse", "--verify", base]).ok) die(`base branch "${base}" does not exist in ${repo}`);

for (const name of names) {
    const { adapter, provider } = selectedAgents.get(name)!;
    if (!onPath(adapter.command)) die(`"${adapter.command}" for ${name} (provider ${provider}) is not on PATH`);
}

console.log(`Convening "${topic}"`);
console.log(`  type ${councilType} - agents ${names.join(", ")} - closer ${closer} - repo ${repo} - base ${base}\n`);

// Stops before convening on purpose: a dry run must not create a session in
// Postgres or a worktree on disk, or it is not dry.
if (dryRun) {
    console.log("dry run - nothing convened, no worktree created.\n");
    for (const name of names) {
        const { adapter, provider } = selectedAgents.get(name)!;
        const shown = adapter.args
            .map((a) => a.replace("{prompt}", "<kickoff block>").replace("{mcpConfigFile}", "<run-dir>/" + name + ".mcp.json"))
            .map((a) => (a.includes(" ") ? `"${a}"` : a))
            .join(" ");
        console.log(`  ${name} (${provider})`);
        console.log(`    worktree ${councilWorktreeDir(repo, name)} on ${councilBranch("CN-XXXX", name)}`);
        console.log(`    ${adapter.command} ${shown}`);
        if (adapter.warn) console.log(`    ! ${adapter.warn}`);
    }
    process.exit(0);
}

const conveneText = await callConvene(config, mcpKey, {
    topic, brief, closerName: closer, councilType,
    participants: names.map((name) => ({ name, expertise: selectedAgents.get(name)!.expertise })),
    workspace: { repoPath: repo, baseBranch: base },
});

const { code, blocks } = parseKickoffBlocks(conveneText);
if (!code) die(`could not read the council code from the convene reply:\n${conveneText.slice(0, 400)}`);
if (blocks.length !== names.length) {
    die(`convene returned ${blocks.length} kickoff blocks for ${names.length} agents; refusing to launch a partial council`);
}
console.log(`Council ${code} opened.\n`);

const runDir = join(repo, "..", `.council-run-${code.toLowerCase()}`);
mkdirSync(runDir, { recursive: true });

const launched: { name: string; branch: string; dir: string; treeDir: string; log: string; mcpFile: string }[] = [];

for (const { agentName, prompt } of blocks) {
    const { adapter } = selectedAgents.get(agentName)!;
    const branch = councilBranch(code, agentName);
    const relDir = councilWorktreeDir(repo, agentName);
    const treeDir = resolve(repo, relDir);

    if (existsSync(treeDir)) die(`${treeDir} already exists; remove it or close the previous council first`);
    const added = git(repo, ["worktree", "add", relDir, "-b", branch, base]);
    if (!added.ok) die(`git worktree add failed for ${agentName}:\n${added.out}`);
    console.log(`  ${agentName}: worktree ${relDir} on ${branch}`);

    // Written outside the worktree on purpose: it carries a bearer token and
    // must never be commitable from inside the repo.
    let mcpFile = "";
    if (adapter.mcpConfig === "claude") {
        mcpFile = join(runDir, `${agentName}.mcp.json`);
        writeFileSync(mcpFile, JSON.stringify({
            mcpServers: {
                "zuychin-knowledge": {
                    type: "http",
                    url: config.mcpUrl,
                    headers: { Authorization: `Bearer ${mcpKey}` },
                },
            },
        }, null, 2));
    }

    const args = adapter.args.map((a) => a.replace("{prompt}", prompt).replace("{mcpConfigFile}", mcpFile));
    const logPath = join(runDir, `${agentName}.log`);

    if (adapter.warn) console.log(`     ! ${adapter.warn}`);
    if (dryRun) {
        console.log(`     dry-run: ${adapter.command} ${args.map((a) => (a === prompt ? "<kickoff block>" : a)).join(" ")}`);
    } else {
        const log = createWriteStream(logPath);
        const child = spawn(adapter.command, args, { cwd: treeDir, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.pipe(log);
        child.stderr.pipe(log);
        child.on("exit", (codeOut) => console.log(`  ${agentName} exited (${codeOut}) → ${logPath}`));
        child.on("error", (err) => console.error(`  ${agentName} failed to start: ${err.message}`));
    }
    launched.push({ name: agentName, branch, dir: relDir, treeDir, log: logPath, mcpFile });
}

writeFileSync(join(runDir, "campaign-run.json"), JSON.stringify({
    code, configPath, agents: launched.map((agent) => ({ name: agent.name, dir: agent.treeDir, mcpFile: agent.mcpFile })),
}, null, 2));

console.log(`\nWatch: http://localhost:3000/council   (or tail ${runDir})`);
console.log(`Resume task supervision after an interruption:\n  npx tsx --env-file=.env.local scripts/council-campaign-supervise.mts --run-dir ${runDir}`);
console.log(`\nWhen it closes, merge from ${repo}:`);
for (const l of launched) console.log(`  git merge --no-ff ${l.branch}`);
console.log(`\nThen clean up:`);
for (const l of launched) console.log(`  git worktree remove ${l.dir}`);
