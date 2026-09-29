import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "council-probe-test-"));
const key = "zck_" + "a".repeat(64);
const secrets = {
    MCP_API_KEY: "fixture-shared-secret", MCP_API_KEY_READONLY: "fixture-shared-read-secret",
    MCP_COUNCIL_HOST_KEY: "fixture-host-secret", SUPABASE_SERVICE_ROLE_KEY: "fixture-service-secret",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon-secret", NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid",
    AUTH_SESSION_SECRET: "fixture-session-secret", ACCESS_PASSWORD: "fixture-access-secret",
    CHAT_API_KEY: "fixture-chat-secret", CRON_SECRET: "fixture-cron-secret", VAPID_PRIVATE_KEY: "fixture-vapid-secret",
    GOOGLE_CLIENT_ID: "fixture-google-id", GOOGLE_CLIENT_SECRET: "fixture-google-secret", GOOGLE_REFRESH_TOKEN: "fixture-refresh-secret",
    DISCORD_BOT_TOKEN: "fixture-discord-secret", TELEGRAM_BOT_TOKEN: "fixture-telegram-secret",
    GITHUB_VAULT_TOKEN: "fixture-vault-secret", GEMINI_API_KEY: "fixture-gemini-secret", OPENAI_API_KEY: "fixture-openai-secret",
};
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|SYSTEMDRIVE)$/i.test(name)));
const calls: { method: string; authorization?: string }[] = [];
const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const rpc = JSON.parse(raw) as { id?: number; method: string };
    calls.push({ method: rpc.method, authorization: request.headers.authorization });
    if (request.url === "/redirect") { response.writeHead(307, { Location: "/mcp" }); response.end(); return; }
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/denied") { response.writeHead(401); response.end("denied"); return; }
    if (request.url === "/large") { response.end("x".repeat(1_100_000)); return; }
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: {
        tools: (request.url === "/missing" ? [] : ["search_knowledge", "list_notes", "vault_read"]).map((name) => ({ name, inputSchema: { type: "object" } })),
    } }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
const endpoint = `http://127.0.0.1:${address.port}`;
let counter = 0;

async function run(flags: string[], env: Record<string, string | undefined> = {}, mode = "readable", explicitEndpoint = true, adapterArgs: string[] = []) {
    const trace = join(root, `trace-${counter++}.jsonl`);
    const endpointArgs = explicitEndpoint && flags.includes("--prompt") ? ["--mcp-url", env.COUNCIL_MCP_URL ?? `${endpoint}/mcp`] : [];
    const child = spawn(process.execPath, ["--import", "tsx", join(source, "scripts/council-acp-probe.mts"), ...flags, ...endpointArgs,
        "--", "node", join(source, "scripts/fixtures/council-probe-agent.mjs"), trace, mode, ...adapterArgs], {
        cwd: source, env: { NODE_ENV: "test", ...baseEnv, ...secrets, COUNCIL_MCP_URL: `${endpoint}/mcp`, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
    const [code] = await once(child, "close");
    clearTimeout(timer);
    assert.notEqual(code, null, "probe must finish without test timeout");
    const records = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    return { code, output, records };
}

try {
    await test("invalid probe arguments fail before config reads, HTTP requests or adapter launch", async () => {
        const rejected = [
            ["--prompt", "--mcp-url", `${endpoint}/mcp`, "--mcp-url", `${endpoint}/missing`],
            ["--prompt", "--prompt", "--mcp-url", `${endpoint}/mcp`],
            ["--edit", "--edit"], ["--models", "--models"],
            ["--agent", "first", "--agent", "second"], ["--unknown"], ["positional"],
            ["--prompt", "--edit", "--mcp-url", `${endpoint}/mcp`],
            ["--mcp-url"], ["--mcp-url", "--models"], ["--mcp-url", "-url"],
            ["--agent"], ["--agent", "--models"], ["--agent", "fixture"],
        ];
        for (const flags of rejected) {
            calls.length = 0;
            const result = await run(flags, { COUNCIL_PROBE_MCP_KEY: key }, "edit", false);
            assert.equal(result.code, 2, `expected argument error: ${flags.join(" ")}`);
            assert.equal(result.records.length, 0, "adapter launched with invalid arguments");
            assert.deepEqual(calls, [], "invalid arguments sent an HTTP request");
            assert.match(result.output, /arguments/i);
            assert.doesNotMatch(result.output, /ENOENT|readFileSync|Probing:/);
        }
    });
    await test("model listing combines with one prompt mode while adapter flags stay opaque", async () => {
        for (const mode of ["--prompt", "--edit"]) {
            const result = await run(["--models", mode], { COUNCIL_PROBE_MCP_KEY: key }, mode === "--edit" ? "edit" : "readable");
            assert.equal(result.code, 0, result.output);
            assert.match(result.output, /Advertised models/);
        }
        calls.length = 0;
        const opaque = ["--prompt", "--edit", "--mcp-url", "--mcp-url", "--unknown"];
        const result = await run(["--models"], { COUNCIL_PROBE_MCP_KEY: key }, "readable", false, opaque);
        assert.equal(result.code, 0, result.output);
        assert.deepEqual(calls, []);
        assert.deepEqual(result.records[0].args.slice(-opaque.length), opaque);
    });
    await test("prompt rejects missing, shared and malformed credentials before adapter launch", async () => {
        for (const supplied of [undefined, "", "fixture-shared-secret", "zck_" + "a".repeat(63), key + "a", "zck_" + "g".repeat(64)]) {
            const result = await run(["--prompt"], { COUNCIL_PROBE_MCP_KEY: supplied });
            assert.notEqual(result.code, 0);
            assert.equal(result.records.length, 0, "adapter launched before credential validation");
            assert.match(result.output, /COUNCIL_PROBE_MCP_KEY/);
        }
    });
    await test("model discovery is credential-free and explicitly skips MCP validation", async () => {
        const result = await run(["--models"], { COUNCIL_PROBE_MCP_KEY: key });
        assert.equal(result.code, 0, result.output);
        assert.deepEqual(result.records.find((record) => record.method === "session/new").params.mcpServers, []);
        assert.match(result.output, /MCP.*skipped/i);
        assert.doesNotMatch(result.output, /PASS.*http MCP/i);
    });
    await test("dedicated probe credential cannot reuse a configured host or shared bearer", async () => {
        for (const name of ["MCP_API_KEY", "MCP_API_KEY_READONLY", "MCP_COUNCIL_HOST_KEY"]) {
            calls.length = 0;
            const result = await run(["--prompt"], { COUNCIL_PROBE_MCP_KEY: key, [name]: key });
            assert.notEqual(result.code, 0);
            assert.equal(result.records.length, 0);
            assert.deepEqual(calls, []);
        }
    });
    await test("prompt refuses implicit environment destinations", async () => {
        calls.length = 0;
        const result = await run(["--prompt"], { COUNCIL_PROBE_MCP_KEY: key }, "readable", false);
        assert.notEqual(result.code, 0);
        assert.equal(result.records.length, 0);
        assert.deepEqual(calls, []);
        assert.match(result.output, /--mcp-url/);
    });
    await test("edit and discovery skip MCP unless an edit endpoint is explicitly chosen", async () => {
        calls.length = 0;
        for (const flags of [[], ["--edit"]]) {
            const result = await run(flags, { COUNCIL_PROBE_MCP_KEY: "malformed-ignored-key" }, "edit");
            assert.equal(result.code, 0, result.output);
            assert.deepEqual(result.records.find((record) => record.method === "session/new").params.mcpServers, []);
            assert.match(result.output, /MCP.*skipped/i);
        }
        assert.deepEqual(calls, []);
        const result = await run(["--edit", "--mcp-url", `${endpoint}/mcp`], { COUNCIL_PROBE_MCP_KEY: "malformed-key" }, "edit");
        assert.notEqual(result.code, 0);
        assert.equal(result.records.length, 0);
        assert.deepEqual(calls, []);
    });
    await test("adapter inherits runtime paths but no application credentials", async () => {
        const result = await run(["--models"], { CODEX_HOME: root, COUNCIL_PROBE_MCP_KEY: key });
        assert.equal(result.code, 0, result.output);
        const inherited = result.records[0].env;
        for (const name of [...Object.keys(secrets), "COUNCIL_PROBE_MCP_KEY", "COUNCIL_MCP_URL"]) assert.equal(inherited[name], undefined, name);
        assert.equal(inherited.CODEX_HOME, root);
        assert.ok(Object.keys(inherited).some((name) => name.toUpperCase() === "PATH"));
    });
    await test("read-only visibility uses only the dedicated key and ACP headers", async () => {
        calls.length = 0;
        const result = await run(["--prompt"], { COUNCIL_PROBE_MCP_KEY: key });
        assert.equal(result.code, 0, result.output);
        const session = result.records.find((record) => record.method === "session/new");
        assert.deepEqual(session.params.mcpServers[0].headers, [{ name: "Authorization", value: `Bearer ${key}` }]);
        assert.equal(result.records[0].env.COUNCIL_PROBE_MCP_KEY, undefined);
        assert.deepEqual(calls, [{ method: "tools/list", authorization: `Bearer ${key}` }]);
        assert.doesNotMatch(result.output, new RegExp(key));
    });
    await test("visibility instructions permit runtime discovery without permitting MCP execution", async () => {
        calls.length = 0;
        const result = await run(["--prompt"], { COUNCIL_PROBE_MCP_KEY: key });
        assert.equal(result.code, 0, result.output);
        const turn = result.records.find((record) => record.method === "session/prompt");
        assert.ok(turn, "probe must send the visibility instructions to the adapter");
        const instructions = turn.params.prompt.map((block: { text?: string }) => block.text ?? "").join("\n");
        assert.match(instructions, /runtime tool discovery\/loading.*tool_search.*permitted/i);
        assert.doesNotMatch(instructions, /do not (?:call|use|invoke) (?:any )?tools\b/i);
        assert.match(instructions, /do not invoke any discovered MCP tools, including knowledge or Council tools/i);
        assert.match(instructions, /do not read, write or edit files/i);
        assert.match(instructions, /do not run commands/i);
        assert.deepEqual(calls.map((call) => call.method), ["tools/list"]);
    });
    await test("absent, denied, redirected, oversized and tool-free MCP endpoints fail before launch", async () => {
        for (const url of [`http://127.0.0.1:1/mcp`, `${endpoint}/denied`, `${endpoint}/redirect`, `${endpoint}/large`, `${endpoint}/missing`]) {
            const result = await run(["--prompt"], { COUNCIL_PROBE_MCP_KEY: key, COUNCIL_MCP_URL: url });
            assert.notEqual(result.code, 0);
            assert.equal(result.records.length, 0);
            assert.doesNotMatch(result.output, /PASS.*http MCP/i);
        }
    });
    await test("unsafe MCP URLs fail before adapter launch without echoing URL credentials", async () => {
        for (const url of ["http://example.com/mcp", "https://user:fixture-url-secret@example.com/mcp", `${endpoint}/mcp?key=fixture-url-secret`, `${endpoint}/mcp#fixture-url-secret`]) {
            const result = await run(["--prompt"], { COUNCIL_PROBE_MCP_KEY: key, COUNCIL_MCP_URL: url });
            assert.notEqual(result.code, 0);
            assert.equal(result.records.length, 0);
            assert.doesNotMatch(result.output, /fixture-url-secret/);
        }
    });
    await test("protocol mismatch, missing tools and ambiguous visibility return failure", async () => {
        for (const mode of ["mismatch", "none", "ambiguous", "negative"]) {
            const result = await run(["--prompt"], { COUNCIL_PROBE_MCP_KEY: key }, mode);
            assert.notEqual(result.code, 0, result.output);
            assert.match(result.output, /FAIL/);
        }
    });
    await test("adapter stderr, errors and model replies redact echoed credentials", async () => {
        for (const mode of ["echo", "error"]) {
            const result = await run(["--prompt"], { COUNCIL_PROBE_MCP_KEY: key }, mode);
            assert.doesNotMatch(result.output, new RegExp(key));
            assert.match(result.output, /REDACTED/);
        }
    });
    await test("SDK diagnostics redact malformed messages, notification errors and unknown responses", async () => {
        for (const mode of ["invalid-rpc", "notification-error", "unknown-response"]) {
            const result = await run(["--prompt"], { COUNCIL_PROBE_MCP_KEY: key }, mode);
            assert.doesNotMatch(result.output, new RegExp(key));
            assert.match(result.output, /REDACTED/);
            assert.match(result.output, /Invalid message|Error handling notification|unknown request/);
        }
    });
} finally {
    server.closeAllConnections();
    await new Promise<void>((settle) => server.close(() => settle()));
    assert.ok(root.startsWith(join(tmpdir(), "council-probe-test-")));
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
