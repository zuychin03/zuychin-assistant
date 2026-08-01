/**
 * Probes one candidate ACP command exactly the way scripts/council-host.mts
 * will drive it, and prints what the council needs to know about it.
 *
 *   npx tsx --env-file=.env.local <this file> -- codex acp
 *   npx tsx --env-file=.env.local <this file> --prompt -- npx -y @zed-industries/codex-acp
 *
 * --prompt adds a real turn that asks the agent to list its council tools. It
 * costs vendor tokens and is the only check that proves the MCP server passed in
 * session/new actually reached the model.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { onPath, spawnResolved } from "./council-host-paths.mts";
import { COUNCIL_MCP_SERVER_NAME } from "../src/lib/council/protocol.ts";

interface ProbeAdapter {
    command: string;
    args: string[];
    env?: Record<string, string | Record<string, unknown> | null>;
}

const split = process.argv.indexOf("--");
const flags = process.argv.slice(0, split < 0 ? process.argv.length : split);
// Only flags BEFORE the separator are ours; everything after belongs to the
// agent, which may legitimately take a --prompt of its own.
const wantPrompt = flags.includes("--prompt") || flags.includes("--edit");
const wantEdit = flags.includes("--edit");
const adapterName = flags[flags.indexOf("--agent") + 1];

let command: string;
let args: string[];
let adapterEnv: NodeJS.ProcessEnv = process.env;
let mcpUrl = process.env.COUNCIL_MCP_URL ?? "http://localhost:3000/api/mcp/mcp";
const mcpKey = process.env.MCP_API_KEY;

// --agent probes the entry as CONFIGURED, env and all, which is the question
// that actually matters once council-agents.json has been written.
if (flags.includes("--agent")) {
    const configFile = join(dirname(fileURLToPath(import.meta.url)), "council-agents.json");
    const parsed = JSON.parse(readFileSync(configFile, "utf8")) as { mcpUrl?: string; agents: Record<string, ProbeAdapter> };
    // The endpoint the HOST will use, not a hardcoded default, or the probe can
    // pass against localhost while the council runs against production.
    if (parsed.mcpUrl && !process.env.COUNCIL_MCP_URL) mcpUrl = parsed.mcpUrl;
    const adapter = parsed.agents[adapterName];
    if (!adapter?.command) {
        console.error(`no adapter "${adapterName}" in council-agents.json`);
        process.exit(2);
    }
    command = adapter.command;
    args = adapter.args ?? [];
    adapterEnv = { ...process.env };
    for (const [k, v] of Object.entries(adapter.env ?? {})) {
        if (v === null) delete adapterEnv[k];
        else adapterEnv[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
} else if (split >= 0 && process.argv[split + 1]) {
    [command, ...args] = process.argv.slice(split + 1);
} else {
    console.error("usage: ... acp-probe.mts [--prompt] (--agent <name> | -- <command> [args...])");
    process.exit(2);
}

const cwd = mkdtempSync(join(tmpdir(), "acp-probe-"));
const results: string[] = [];
let stderrTail = "";

function ok(label: string, detail = "") { results.push(`  PASS  ${label}${detail ? ` - ${detail}` : ""}`); }
function bad(label: string, detail = "") { results.push(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`); }
function note(label: string, detail = "") { results.push(`  ....  ${label}${detail ? ` - ${detail}` : ""}`); }

function deadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms)),
    ]);
}

console.log(`\nProbing: ${command} ${args.join(" ")}`);
console.log(`cwd:     ${cwd}`);
console.log(`mcp:     ${mcpUrl} (key ${mcpKey ? "present" : "MISSING - run with --env-file=.env.local"})\n`);

if (!onPath(command)) {
    console.error(`"${command}" is not on PATH. The host resolves the command the same way, so fix this first.\n`);
    process.exit(1);
}
// Spawned exactly as scripts/council-host.mts spawns it: same resolution, same
// stdio, no shell. A probe that starts the agent differently proves nothing.
const child = spawnResolved(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: adapterEnv });
child.on("error", (error) => {
    console.error(`\ncould not start "${command}": ${error.message}\n`);
    process.exit(1);
});
child.stderr?.on("data", (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString()).slice(-1500); });

const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
);

let sawUpdate = false;
let sawLocations: boolean | null = null;
let sawPermission = false;
let sawTerminal = false;
let sawFsRead = false;
let sawFsWrite: string | null = null;
let text = "";

const app = acp.client({ name: "council-acp-probe" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        sawPermission = true;
        const locations = ctx.params.toolCall.locations ?? [];
        sawLocations = locations.length > 0;
        const allow = ctx.params.options.find((o) => o.kind === "allow_once") ?? ctx.params.options[0];
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
    })
    .onRequest(acp.methods.client.fs.readTextFile, () => { sawFsRead = true; return { content: "" }; })
    .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => { sawFsWrite = ctx.params.path; return {}; })
    .onRequest(acp.methods.client.terminal.create, () => { sawTerminal = true; return { terminalId: "probe-terminal" }; })
    .onRequest(acp.methods.client.terminal.output, () => ({ output: "", truncated: false, exitStatus: { exitCode: 0, signal: null } }))
    .onRequest(acp.methods.client.terminal.waitForExit, () => ({ exitCode: 0, signal: null }))
    .onRequest(acp.methods.client.terminal.release, () => ({}))
    .onRequest(acp.methods.client.terminal.kill, () => ({}));

const connection = app.connect(stream);

try {
    const init = await deadline(
        connection.agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
            clientInfo: { name: "council-acp-probe", version: "1.0.0" },
        }),
        30_000,
        "initialize",
    );
    ok("1. speaks ACP on stdio", `protocol v${init.protocolVersion}${init.agentInfo ? `, ${init.agentInfo.name} ${init.agentInfo.version}` : ""}`);
    if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
        bad("   protocol version", `host speaks v${acp.PROTOCOL_VERSION}, agent answered v${init.protocolVersion}`);
    }
    if (init.authMethods?.length) {
        note("2. auth methods offered", init.authMethods.map((m) => m.id).join(", ") + " (log in with the vendor CLI first)");
    } else {
        ok("2. no ACP-level auth required");
    }

    const session = await deadline(
        connection.agent.buildSession({
            cwd,
            mcpServers: mcpKey ? [{
                type: "http", name: COUNCIL_MCP_SERVER_NAME, url: mcpUrl,
                headers: [{ name: "Authorization", value: `Bearer ${mcpKey}` }],
            }] : [],
        }).start(),
        60_000,
        "session/new",
    );
    ok("3. session/new accepted with an http MCP server", `session ${session.sessionId.slice(0, 12)}…`);

    if (wantPrompt) {
        // --edit is the only way to learn whether an agent populates
        // toolCall.locations, which decides whether the host's worktree gate can
        // see its file access at all. A list-tools turn never asks permission.
        const turn = session.prompt(wantEdit
            ? "Create a file called probe.txt in the current directory containing the single word ok, then stop. Do not read or write anything else."
            : "Reply in one short paragraph, then stop. Do not edit any file. "
              + `List the tool names you have from the ${COUNCIL_MCP_SERVER_NAME} MCP server. `
              + "If you have none, say exactly: NO MCP TOOLS.",
        );
        void (async () => {
            for (;;) {
                const message = await session.nextUpdate();
                if (message.kind === "stop") return;
                sawUpdate = true;
                const update = message.update;
                if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
                    text += update.content.text;
                }
            }
        })().catch(() => {});
        const response = await deadline(turn, 180_000, "the prompt turn");
        ok("4. prompt turn completed", `stopReason ${response.stopReason}`);
        if (sawUpdate) ok("5. streams session/update", "the /council activity feed will show its work");
        else bad("5. streams session/update", "no updates arrived; /council will show state changes only");
        if (wantEdit) {
            note("6. MCP visibility", "not checked in --edit mode; run --prompt for that");
        } else if (/council_(dispatch|speak|join|wait)/i.test(text)) {
            ok("6. MCP servers from session/new reached the model", "council tools are visible");
        } else if (/NO MCP TOOLS/i.test(text)) {
            bad("6. MCP servers from session/new reached the model", "agent reports no MCP tools - it needs the server in its OWN config instead");
        } else {
            note("6. MCP servers from session/new", "inconclusive, read the reply below");
        }
        // What the host can actually SEE decides whether the worktree boundary
        // applies to this agent at all. Writing through the client's fs methods
        // is the strong case: every path is checked, permission or not.
        if (sawFsWrite) {
            ok("7. writes through the client's fs methods", `e.g. ${sawFsWrite} - the host path-checks every write`);
        } else if (wantEdit) {
            bad("7. writes through the client's fs methods", "it wrote the file WITHOUT calling fs/write_text_file, so the host never sees its file access");
        }
        if (sawPermission) {
            note("   permission requests", sawLocations ? "populate toolCall.locations, so the host can path-check them too" : "send NO toolCall.locations, so the host cannot path-check them and auto-allows");
        } else if (wantEdit) {
            note("   permission requests", "none even for a file write - this agent gates itself");
        }
        if (sawFsRead) note("   reads through the client's fs methods", "gated the same way");
        if (sawTerminal) note("8. uses client terminals", "the host forces cwd to the worktree");
    } else {
        note("4-8. turn behaviour", "skipped; add --prompt to check MCP visibility, streaming and permissions");
    }
} catch (error) {
    bad("handshake", error instanceof Error ? error.message : String(error));
    if (stderrTail.trim()) console.log(`\nagent stderr (tail):\n${stderrTail.trim().slice(-800)}\n`);
    console.log(
        "\nIf initialize timed out, the usual cause is the command printing a banner or logs on\n" +
        "STDOUT. ACP requires stdout to carry newline-delimited JSON-RPC and nothing else; all\n" +
        "human-readable output must go to stderr. Check with:\n" +
        `  ${command} ${args.join(" ")} < /dev/null | head -c 300\n`,
    );
}

console.log(`\nResult for: ${command} ${args.join(" ")}`);
console.log(results.join("\n"));
if (wantPrompt && text) console.log(`\nAgent reply:\n${text.trim().slice(0, 1200)}`);
console.log("");

connection.close();
child.kill();
process.exit(0);
