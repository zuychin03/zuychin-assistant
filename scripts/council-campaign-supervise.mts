/**
 * Restarts assigned work-campaign agents until their tasks reach review,
 * completion or a recorded blocker. Start it again with the same run directory
 * after a terminal or machine restart.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Adapter { command: string; args: string[]; }
interface LauncherConfig { mcpUrl: string; agents: Record<string, Adapter>; }
interface RunAgent { name: string; dir: string; mcpFile: string; }
interface RunManifest { code: string; configPath: string; agents: RunAgent[]; }

const runDir = process.argv.includes("--run-dir")
    ? process.argv[process.argv.indexOf("--run-dir") + 1]
    : undefined;
if (!runDir) throw new Error("usage: --run-dir <.council-run-cn-xxxx>");

const manifestPath = join(runDir, "campaign-run.json");
if (!existsSync(manifestPath)) throw new Error(`missing ${manifestPath}; run council-launch first.`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RunManifest;
const config = JSON.parse(readFileSync(manifest.configPath, "utf8")) as LauncherConfig;
const key = process.env.MCP_API_KEY;
if (!key) throw new Error("MCP_API_KEY is not set");

const active = new Set<string>();
const pauseMs = 30_000;

async function status(agentName: string): Promise<"active" | "review" | "idle" | "complete" | "blocked"> {
    const response = await fetch(config.mcpUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "council_work_status", arguments: { sessionCode: manifest.code, agentName } } }),
    });
    const raw = await response.text();
    const line = raw.split("\n").find((value) => value.startsWith("data:"));
    const payload = JSON.parse(line ? line.slice(5).trim() : raw);
    const text = payload.result?.content?.[0]?.text ?? "";
    if (text.startsWith("SUPERVISE: complete")) return "complete";
    if (text.startsWith("SUPERVISE: blocked")) return "blocked";
    if (text.startsWith("SUPERVISE: review")) return "review";
    return text.startsWith("SUPERVISE: active") ? "active" : "idle";
}

function start(agent: RunAgent) {
    if (active.has(agent.name)) return;
    const adapter = config.agents[agent.name];
    if (!adapter) throw new Error(`no adapter for ${agent.name}`);
    const prompt = `Resume Zuychin work campaign ${manifest.code} as ${agent.name}. Work only in this worktree. Call council_work_next with the session code and your agent name, then follow the assigned task exactly. Record heartbeats, commit and verify the work, submit it with council_work_complete, and stop for closer review. If you are the designated closer and council_work_status says review, inspect each submitted diff and verification, then accept it or return it with specific council_work_review feedback.`;
    const args = adapter.args.map((value) => value.replace("{prompt}", prompt).replace("{mcpConfigFile}", agent.mcpFile));
    const child = spawn(adapter.command, args, { cwd: agent.dir, stdio: "inherit" });
    active.add(agent.name);
    child.on("exit", () => active.delete(agent.name));
    child.on("error", () => active.delete(agent.name));
}

for (;;) {
    const states = await Promise.all(manifest.agents.map(async (agent) => {
        try { return [agent, await status(agent.name)] as const; }
        catch (error) { console.warn("status check failed for " + agent.name + ":", error); return [agent, "idle"] as const; }
    }));
    if (states.some(([, state]) => state === "complete")) process.exit(0);
    if (states.some(([, state]) => state === "blocked")) { console.error("Campaign is blocked; resolve the recorded blocker before restarting supervision."); process.exit(2); }
    for (const [agent, state] of states) if (state === "active" || state === "review") start(agent);
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
}
