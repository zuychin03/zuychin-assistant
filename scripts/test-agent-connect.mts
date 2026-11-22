import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
    checkBaseUrl, clientMatchesClaim, defaultConfigPath, jsonServerHasKey, parseMcpReply, pickBaseUrl,
    planCodexConfig, readEnvValues, upsertJsonServer,
} from "./agent-connect-config.mts";

let passed = 0;
let failed = 0;
async function check(name: string, test: () => void | Promise<void>): Promise<void> {
    try {
        await test();
        passed++;
        console.log(`ok ${name}`);
    } catch (error) {
        failed++;
        console.error(`FAIL ${name}`);
        console.error(error instanceof Error ? error.message : error);
    }
}

const MCP = "https://knowledge.example.invalid/api/mcp/mcp";
const KEY = "zck_fixture_new_key";

await check("base URLs come from the flag, then NEXT_PUBLIC_BASE_URL, then AUTH_ORIGIN, https only", () => {
    const env = { NEXT_PUBLIC_BASE_URL: "https://public.example.invalid/", AUTH_ORIGIN: "https://auth.example.invalid" };
    assert.equal(pickBaseUrl("https://flag.example.invalid", env), "https://flag.example.invalid");
    assert.equal(pickBaseUrl(undefined, env), "https://public.example.invalid");
    assert.equal(pickBaseUrl(undefined, { AUTH_ORIGIN: env.AUTH_ORIGIN }), "https://auth.example.invalid");
    assert.equal(pickBaseUrl(undefined, {}), null);
    assert.equal(checkBaseUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
    assert.throws(() => checkBaseUrl("http://knowledge.example.invalid"), /https/);
});

await check("only the named keys are read from an env file", () => {
    const text = "SUPABASE_SERVICE_ROLE_KEY=secret\nNEXT_PUBLIC_BASE_URL=\"https://a.example.invalid\"\r\nAUTH_ORIGIN=https://b.example.invalid # note\nEMPTY=\n";
    assert.deepEqual(readEnvValues(text, ["NEXT_PUBLIC_BASE_URL", "AUTH_ORIGIN", "EMPTY"]), {
        NEXT_PUBLIC_BASE_URL: "https://a.example.invalid",
        AUTH_ORIGIN: "https://b.example.invalid",
    });
});

await check("default config paths follow each client and its home override", () => {
    const home = path.join("C:", "home");
    assert.equal(defaultConfigPath("claude", {}, home), path.join(home, ".claude.json"));
    assert.equal(defaultConfigPath("claude", { CLAUDE_CONFIG_DIR: path.join(home, "alt") }, home), path.join(home, "alt", ".claude.json"));
    assert.equal(defaultConfigPath("codex", { CODEX_HOME: path.join(home, "cx") }, home), path.join(home, "cx", "config.toml"));
    assert.equal(defaultConfigPath("cursor", {}, home), path.join(home, ".cursor", "mcp.json"));
    assert.equal(defaultConfigPath("antigravity", {}, home), path.join(home, ".gemini", "config", "mcp_config.json"));
});

await check("a same-endpoint entry keeps its name, fields and other headers; nothing is duplicated", () => {
    const original = JSON.stringify({
        mcpServers: {
            "zuychin-council": { url: `${MCP}/`, headers: { authorization: "Bearer zck_old", "X-Trace": "1" } },
            inspo: { url: "https://inspo.example.invalid/api/mcp" },
        },
    }, null, 2) + "\n";
    const change = upsertJsonServer(original, { client: "cursor", mcpUrl: MCP, key: KEY });
    assert.equal(change.action, "replaced");
    assert.deepEqual(change.names, ["zuychin-council"]);
    const servers = JSON.parse(change.text).mcpServers;
    assert.deepEqual(Object.keys(servers), ["zuychin-council", "inspo"]);
    assert.deepEqual(servers["zuychin-council"].headers, { "X-Trace": "1", Authorization: `Bearer ${KEY}` });
    assert.deepEqual(servers.inspo, { url: "https://inspo.example.invalid/api/mcp" });
    assert(!change.text.includes("zck_old"));
    assert(change.text.endsWith("}\n"));
    assert(jsonServerHasKey(change.text, MCP, KEY));
    assert(!jsonServerHasKey(original, MCP, KEY));
});

await check("Claude's file keeps its other settings, its indent and its missing final newline", () => {
    const original = JSON.stringify({ numStartups: 3, projects: { a: { x: 1 } }, mcpServers: { other: { type: "stdio", command: "x" } } }, null, 2);
    const change = upsertJsonServer(original, { client: "claude", mcpUrl: MCP, key: KEY });
    assert.equal(change.action, "added");
    const root = JSON.parse(change.text);
    assert.equal(root.numStartups, 3);
    assert.deepEqual(root.projects, { a: { x: 1 } });
    assert.deepEqual(root.mcpServers["zuychin-knowledge"], { type: "http", url: MCP, headers: { Authorization: `Bearer ${KEY}` } });
    assert(!change.text.endsWith("\n"));
    assert.equal(change.text, JSON.stringify(root, null, 2));
});

await check("a new entry avoids a name taken by another server, and an empty file is created", () => {
    const taken = JSON.stringify({ mcpServers: { "zuychin-knowledge": { url: "https://elsewhere.example.invalid/api/mcp/mcp" } } }, null, 4) + "\r\n";
    const change = upsertJsonServer(taken, { client: "antigravity", mcpUrl: MCP, key: KEY });
    assert.deepEqual(change.names, ["zuychin-knowledge-2"]);
    assert.deepEqual(JSON.parse(change.text).mcpServers["zuychin-knowledge-2"], { url: MCP, headers: { Authorization: `Bearer ${KEY}` } });
    assert(change.text.includes('\r\n    "mcpServers"'));
    assert(change.text.endsWith("}\r\n"));
    const fresh = upsertJsonServer("", { client: "cursor", mcpUrl: MCP, key: KEY });
    assert.equal(fresh.action, "added");
    assert(jsonServerHasKey(fresh.text, MCP, KEY));
});

await check("a broken config is refused without quoting it", () => {
    for (const bad of ['{"mcpServers": {"x": "zck_secret"', "[]", '{"mcpServers": []}']) {
        assert.throws(() => upsertJsonServer(bad, { client: "cursor", mcpUrl: MCP, key: KEY }), (error: Error) => !error.message.includes("zck_secret") && /left untouched/.test(error.message));
    }
});

const CODEX = [
    'model = "gpt"',
    "",
    "[mcp_servers.zuychin-knowledge]",
    `url = "${MCP}"`,
    'bearer_token_env_var = "ZUYCHIN_MCP_KEY"',
    "",
    "[mcp_servers.node_repl]",
    'command = "node"',
    "",
    "[mcp_servers.node_repl.env]",
    'A = "1"',
    "",
].join("\n");

await check("Codex: an existing table with a key variable is left byte for byte", () => {
    const plan = planCodexConfig(CODEX, MCP);
    assert.equal(plan.action, "unchanged");
    assert.equal(plan.text, CODEX);
    assert.equal(plan.name, "zuychin-knowledge");
    assert.equal(plan.envVar, "ZUYCHIN_MCP_KEY");
    const custom = planCodexConfig(CODEX.replace('"ZUYCHIN_MCP_KEY"', '"MY_KEY"'), MCP);
    assert.equal(custom.envVar, "MY_KEY");
});

await check("Codex: a quoted table without a key variable gets one after its url; CRLF stays", () => {
    const original = CODEX.replace("[mcp_servers.zuychin-knowledge]", '[mcp_servers."zuychin-council"]').replace('bearer_token_env_var = "ZUYCHIN_MCP_KEY"\n', "").replace(/\n/g, "\r\n");
    const plan = planCodexConfig(original, MCP);
    assert.equal(plan.action, "replaced");
    assert.equal(plan.name, "zuychin-council");
    assert(plan.text.includes(`url = "${MCP}"\r\nbearer_token_env_var = "ZUYCHIN_MCP_KEY"\r\n`));
    assert.equal(plan.text.replace('bearer_token_env_var = "ZUYCHIN_MCP_KEY"\r\n', ""), original);
    assert(!/[^\r]\n/.test(plan.text));
});

await check("Codex: a missing table is appended and the rest of the file is untouched", () => {
    const original = CODEX.replace(`url = "${MCP}"`, 'url = "https://elsewhere.example.invalid/api/mcp/mcp"');
    const plan = planCodexConfig(original, MCP);
    assert.equal(plan.action, "added");
    assert.equal(plan.name, "zuychin-knowledge-2");
    assert(plan.text.startsWith(original.trimEnd()));
    assert(plan.text.endsWith(`\n\n[mcp_servers.zuychin-knowledge-2]\nurl = "${MCP}"\nbearer_token_env_var = "ZUYCHIN_MCP_KEY"\n`));
    assert.equal(planCodexConfig("", MCP).text, `[mcp_servers.zuychin-knowledge]\nurl = "${MCP}"\nbearer_token_env_var = "ZUYCHIN_MCP_KEY"\n`);
});

await check("Codex: a table holding a literal credential is refused", () => {
    const literal = CODEX.replace('bearer_token_env_var = "ZUYCHIN_MCP_KEY"', 'http_headers = { Authorization = "Bearer zck_secret" }');
    assert.throws(() => planCodexConfig(literal, MCP), (error: Error) => !error.message.includes("zck_secret") && /another way/.test(error.message));
});

await check("MCP replies parse from JSON and from server-sent events", () => {
    assert.deepEqual(parseMcpReply('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')?.result, { ok: true });
    assert.deepEqual(parseMcpReply('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n')?.result, { tools: [] });
    assert.equal(parseMcpReply("<html>"), null);
});

await check("a claim's client name has to match the chosen client", () => {
    assert(clientMatchesClaim("claude", "claude-code-windows"));
    assert(clientMatchesClaim("codex", "codex-windows"));
    assert(!clientMatchesClaim("cursor", "claude-code-windows"));
});

// End to end against a local stub: the real script, a piped claim and a temporary config file.
const CLAIM = "zkc_" + "a".repeat(64);
const ISSUED = "zck_" + "b".repeat(43);

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => resolve(body));
    });
}

async function withStub(claimClient: string, run: (base: string, calls: string[]) => Promise<void>): Promise<void> {
    const calls: string[] = [];
    const server = createServer(async (req, res) => {
        const body = await readBody(req);
        if (req.url === "/api/agent/claim") {
            calls.push("claim");
            const ok = JSON.parse(body).claim === CLAIM;
            res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
            res.end(JSON.stringify(ok ? { key: ISSUED, client: claimClient, scopes: ["full"], accessLevel: "full" } : { error: "That claim cannot be used." }));
            return;
        }
        if (req.url === "/api/mcp/mcp") {
            if (req.headers.authorization !== `Bearer ${ISSUED}`) { res.writeHead(401).end(); return; }
            const message = JSON.parse(body);
            calls.push(message.method);
            if (message.id === undefined) { res.writeHead(202).end(); return; }
            const result = message.method === "initialize"
                ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stub", version: "1" } }
                : { tools: ["search_knowledge", "list_notes", "vault_search", "vault_read", "save_note"].map((name) => ({ name })) };
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function runConnect(args: string[], input: string): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "agent-connect.mts"), ...args], {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, NEXT_PUBLIC_BASE_URL: "", AUTH_ORIGIN: "" },
        });
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => { output += chunk; });
        child.on("close", (code) => resolve({ code, output }));
        child.stdin.end(input);
    });
}

const temp = mkdtempSync(path.join(os.tmpdir(), "agent-connect-"));
try {
    const cursorOriginal = (base: string) => JSON.stringify({
        mcpServers: {
            "zuychin-council": { url: `${base}/api/mcp/mcp`, headers: { Authorization: "Bearer zck_old" } },
            inspo: { url: "https://inspo.example.invalid/api/mcp" },
        },
    }, null, 2) + "\n";

    await check("end to end: the key replaces the old one, the live check passes, and neither secret is printed", async () => {
        await withStub("cursor-windows", async (base, calls) => {
            const file = path.join(temp, "cursor-ok.json");
            writeFileSync(file, cursorOriginal(base));
            const { code, output } = await runConnect(["cursor", "--url", base, "--config", file], `${CLAIM}\n`);
            assert.equal(code, 0, output);
            assert(!output.includes(CLAIM) && !output.includes(ISSUED), "a secret reached the output");
            assert.match(output, /Replaced the key on "zuychin-council"/);
            assert.match(output, /Live check passed: 5 tools visible, including search_knowledge/);
            const saved = JSON.parse(readFileSync(file, "utf8")).mcpServers;
            assert.equal(saved["zuychin-council"].headers.Authorization, `Bearer ${ISSUED}`);
            assert.deepEqual(Object.keys(saved), ["zuychin-council", "inspo"]);
            assert.deepEqual(calls, ["claim", "initialize", "notifications/initialized", "tools/list"]);
        });
    });

    await check("end to end: a refused claim leaves the config untouched", async () => {
        await withStub("cursor-windows", async (base) => {
            const file = path.join(temp, "cursor-refused.json");
            writeFileSync(file, cursorOriginal(base));
            const wrong = "zkc_" + "c".repeat(64);
            const { code, output } = await runConnect(["cursor", "--url", base, "--config", file], `${wrong}\n`);
            assert.equal(code, 1);
            assert.match(output, /refused \(HTTP 400\)/);
            assert(!output.includes(wrong));
            assert.equal(readFileSync(file, "utf8"), cursorOriginal(base));
        });
    });

    await check("end to end: a claim for another agent is not saved without a yes", async () => {
        await withStub("claude-code-windows", async (base) => {
            const file = path.join(temp, "cursor-mismatch.json");
            writeFileSync(file, cursorOriginal(base));
            const { code, output } = await runConnect(["cursor", "--url", base, "--config", file], `${CLAIM}\n`);
            assert.equal(code, 1);
            assert.match(output, /minted for "claude-code-windows"/);
            assert(!output.includes(ISSUED));
            assert.equal(readFileSync(file, "utf8"), cursorOriginal(base));
        });
    });

    await check("end to end: a broken config or a non-claim stops before the claim is spent", async () => {
        await withStub("cursor-windows", async (base, calls) => {
            const broken = path.join(temp, "broken.json");
            writeFileSync(broken, "{ not json");
            const first = await runConnect(["cursor", "--url", base, "--config", broken], `${CLAIM}\n`);
            assert.equal(first.code, 1);
            assert.match(first.output, /not valid JSON/);
            const file = path.join(temp, "cursor-typo.json");
            writeFileSync(file, cursorOriginal(base));
            const second = await runConnect(["cursor", "--url", base, "--config", file], "hello\n");
            assert.equal(second.code, 1);
            assert.match(second.output, /does not look like a claim/);
            assert.deepEqual(calls, []);
            assert.equal(readFileSync(broken, "utf8"), "{ not json");
        });
    });

    await check("end to end: plain http to another host is refused", async () => {
        const { code, output } = await runConnect(["cursor", "--url", "http://knowledge.example.invalid", "--config", path.join(temp, "x.json")], `${CLAIM}\n`);
        assert.equal(code, 1);
        assert.match(output, /must use https/);
    });
} finally {
    rmSync(temp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
