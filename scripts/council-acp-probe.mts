// --models reads adapter configuration; --prompt and --edit spend vendor tokens.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { killTree, onPath, spawnResolved } from "./council-host-paths.mts";
import { selectConfig } from "./council-models.mts";
import { COUNCIL_MCP_SERVER_NAME } from "../src/lib/council/protocol.ts";
import { buildCouncilAdapterEnv, credentialValues, redactCredentials, type AdapterEnvOverrides } from "./council-adapter-env.mts";
import { confirmsMcpVisibility, deadline, installProbeDiagnostics, loadProbeAdapter, parseProbeArguments, probeCredential, probeEndpoint, probeMcpTools, type ProbeArguments } from "./council-acp-probe-support.mts";

let options: ProbeArguments;
try { options = parseProbeArguments(process.argv.slice(2)); }
catch (error) {
    console.error(`FAIL arguments: ${error instanceof Error ? error.message : "invalid probe arguments"}`);
    process.exit(2);
}
const { wantPrompt, wantEdit, wantModels, adapterName, endpointArg } = options;

let command: string;
let args: string[];
let adapterOverrides: AdapterEnvOverrides = {};

if (adapterName) {
    const configFile = join(dirname(fileURLToPath(import.meta.url)), "council-agents.json");
    try {
        const adapter = loadProbeAdapter(configFile, adapterName);
        command = adapter.command;
        args = adapter.args;
        adapterOverrides = adapter.env ?? {};
    } catch (error) {
        console.error(`FAIL configuration: ${error instanceof Error ? error.message : "invalid adapter configuration"}`);
        process.exit(2);
    }
} else if (options.command) {
    command = options.command;
    args = options.args;
} else {
    console.error("usage: ... acp-probe.mts [--prompt --mcp-url <url> | --edit] [--models] (--agent <name> | -- <command> [args...])");
    process.exit(2);
}

const secrets = credentialValues(process.env, adapterOverrides);
const redact = (value: string) => redactCredentials(value, secrets);
const output = console.log.bind(console);
const print = (value: string) => output(redact(value));
const adapterEnv = buildCouncilAdapterEnv(process.env, adapterOverrides);
let mcpKey: string | undefined;
let mcpUrl: string | undefined;
let readableTools: string[] = [];
try {
    if (wantPrompt && (!wantEdit || endpointArg)) {
        mcpKey = probeCredential(process.env.COUNCIL_PROBE_MCP_KEY, true);
        if ([process.env.MCP_API_KEY, process.env.MCP_API_KEY_READONLY, process.env.MCP_COUNCIL_HOST_KEY].includes(mcpKey)) {
            throw new Error("COUNCIL_PROBE_MCP_KEY must be separate from configured shared and host bearers.");
        }
        if (!endpointArg) throw new Error("MCP validation requires --mcp-url with an explicit credential destination; configuration and environment URL defaults are not used.");
        mcpUrl = probeEndpoint(endpointArg).toString();
        readableTools = await probeMcpTools(new URL(mcpUrl), mcpKey!);
    }
} catch (error) {
    print(`FAIL  MCP preflight: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}

const cwd = mkdtempSync(join(tmpdir(), "acp-probe-"));
const results: string[] = [];
let stderrTail = "";
let failed = false;

let modelsBlock = "";

function ok(label: string, detail = "") { results.push(`  PASS  ${label}${detail ? ` - ${detail}` : ""}`); }
function bad(label: string, detail = "") { failed = true; results.push(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`); }
function note(label: string, detail = "") { results.push(`  ....  ${label}${detail ? ` - ${detail}` : ""}`); }

interface AdvertisedOption { id: string; currentValue?: string; options?: { value: string; name?: string }[] }

function renderInstanceBlock(model: AdvertisedOption | null, reasoning: AdvertisedOption | null): string {
    const values = (option: AdvertisedOption | null) => (option?.options ?? []).map((o) => o.value);
    const lines: string[] = [];
    for (const [label, option] of [["models", model], ["reasoning efforts", reasoning]] as const) {
        const advertised = values(option);
        lines.push(`\nAdvertised ${label}: ${advertised.length ? "" : "(none)"}`);
        for (const o of option?.options ?? []) {
            const marker = o.value === option?.currentValue ? "  <- current" : "";
            lines.push(`  ${o.value}${o.name && o.name !== o.value ? `   (${o.name})` : ""}${marker}`);
        }
    }
    const json = JSON.stringify({
        provider: adapterName ?? "<provider>",
        expertise: "<expertise>",
        allowedModels: values(model),
        allowedReasoningEfforts: values(reasoning),
        ...(model?.currentValue ? { defaultModel: model.currentValue } : {}),
        ...(reasoning?.currentValue ? { defaultReasoningEffort: reasoning.currentValue } : {}),
    }, null, 2);
    lines.push(`\nFor scripts/council-agents.json, under "instances":\n  "<instance-name>": ${json.replace(/\n/g, "\n  ")}`);
    lines.push("\ndefaultModel must be inside allowedModels. Anything you list that the");
    lines.push("adapter did not advertise above is rejected at session start, not ignored.");
    return lines.join("\n");
}

print(`\nProbing: ${command} ${args.join(" ")}`);
print(`cwd:     ${cwd}`);
print(mcpKey ? `mcp:     ${mcpUrl} (dedicated named-client key; read tools verified)\n` : "MCP validation skipped; this session has no MCP server.\n");

if (!onPath(command)) {
    print(`"${command}" is not on PATH. The host resolves the command the same way, so fix this first.\n`);
    process.exit(1);
}
const child = spawnResolved(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: adapterEnv });
child.on("error", (error) => {
    print(`\ncould not start "${command}": ${error.message}\n`);
    process.exit(1);
});
child.stderr?.on("data", (chunk: Buffer) => { if (stderrTail.length < 1_000_000) stderrTail += chunk.toString(); });

const restoreDiagnostics = installProbeDiagnostics(secrets);
process.once("exit", restoreDiagnostics);

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
        throw new Error(`protocol mismatch: host speaks v${acp.PROTOCOL_VERSION}, agent answered v${init.protocolVersion}`);
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
                type: "http", name: COUNCIL_MCP_SERVER_NAME, url: mcpUrl!,
                headers: [{ name: "Authorization", value: `Bearer ${mcpKey}` }],
            }] : [],
        }).start(),
        60_000,
        "session/new",
    );
    ok(mcpKey ? "3. session/new accepted with an HTTP MCP server configuration" : "3. session/new accepted without MCP", `session ${session.sessionId.slice(0, 12)}…`);

    if (wantModels) {
        const options = (session as unknown as { newSessionResponse?: { configOptions?: unknown } })
            .newSessionResponse?.configOptions;
        const model = selectConfig(options, "model");
        const reasoning = selectConfig(options, "thought_level");
        if (!model && !reasoning) {
            note("M. advertises no selectable model", "leave allowedModels empty; this adapter uses whatever the vendor CLI is set to");
        }
        if (model) {
            ok("M. advertises model selection", `config id "${model.id}", currently ${model.currentValue ?? "unset"}`);
        }
        if (reasoning) {
            ok("M. advertises reasoning selection", `config id "${reasoning.id}", currently ${reasoning.currentValue ?? "unset"}`);
        }
        modelsBlock = renderInstanceBlock(model, reasoning);
    }

    if (wantPrompt) {
        const turn = session.prompt(wantEdit
            ? "Create a file called probe.txt in the current directory containing the single word ok, then stop. Do not read or write anything else."
            : "Runtime tool discovery/loading (such as tool_search) is permitted only to list tool names. "
              + "Metadata-only JavaScript through functions.exec is also permitted: inspect ALL_TOOLS names and descriptions "
              + "to find the server's tools, without invoking any tool from that list. "
              + "Do not invoke any discovered MCP tools, including knowledge or Council tools. "
              + "Do not read, write or edit files. Do not run shell commands. Reply with exactly one line, then stop. "
              + `List the tool names you can see from the ${COUNCIL_MCP_SERVER_NAME} MCP server as MCP_TOOLS: followed by comma-separated names. `
              + "If you have none, reply exactly NO MCP TOOLS. Do not print credentials.",
        );
        const updates = (async () => {
            for (;;) {
                const message = await session.nextUpdate();
                if (message.kind === "stop") return;
                sawUpdate = true;
                const update = message.update;
                if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
                    text += update.content.text;
                }
            }
        })();
        void updates.catch(() => {});
        const response = await deadline(turn, 180_000, "the prompt turn");
        await deadline(updates, 2_000, "final prompt updates");
        ok("4. prompt turn completed", `stopReason ${response.stopReason}`);
        if (sawUpdate) ok("5. streams session/update", "the /council activity feed will show its work");
        else bad("5. streams session/update", "no updates arrived; /council will show state changes only");
        if (wantEdit) {
            note("6. MCP visibility", "not checked in --edit mode; run --prompt for that");
        } else if (confirmsMcpVisibility(text, readableTools)) {
            ok("6. MCP visibility", "agent reports expected knowledge read tools from the supplied server");
        } else if (/NO MCP TOOLS/i.test(text)) {
            bad("6. MCP visibility", "agent reports no MCP tools");
        } else {
            bad("6. MCP visibility", "inconclusive reply; expected one MCP_TOOLS line containing a verified knowledge read tool");
        }
        if (sawFsWrite) {
            ok("7. writes through the client's fs methods", `e.g. ${sawFsWrite} - the host path-checks every write`);
        } else if (wantEdit) {
            bad("7. writes through the client's fs methods", "no fs/write_text_file call observed; direct file writes are outside this observation");
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
        if (!wantModels) note("M. advertised models", "skipped; add --models to list the model IDs allowedModels accepts");
    }
} catch (error) {
    bad("handshake", error instanceof Error ? error.message : String(error));
    if (stderrTail.trim()) print(`\nagent stderr (tail):\n${redact(stderrTail.trim()).slice(-800)}\n`);
    print(
        "\nIf initialize timed out, the usual cause is the command printing a banner or logs on\n" +
        "STDOUT. ACP requires stdout to carry newline-delimited JSON-RPC and nothing else; all\n" +
        "human-readable output must go to stderr. Check with:\n" +
        `  ${command} ${args.join(" ")} < /dev/null | head -c 300\n`,
    );
}

print(`\nResult for: ${command} ${args.join(" ")}`);
print(results.join("\n"));
if (modelsBlock) print(modelsBlock);
if (wantPrompt && text) print(`\nAgent reply:\n${redact(text.trim()).slice(0, 1200)}`);
print("");

try {
    connection.close();
    killTree(child);
} finally {
    restoreDiagnostics();
    process.removeListener("exit", restoreDiagnostics);
}
process.exit(failed ? 1 : 0);
