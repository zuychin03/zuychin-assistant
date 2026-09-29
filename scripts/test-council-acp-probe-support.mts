import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { confirmsMcpVisibility, formatProbeDiagnostic, installProbeDiagnostics, loadProbeAdapter, probeCredential, probeEndpoint } from "./council-acp-probe-support.mts";

await test("adapter configuration errors omit file contents, paths and unchecked adapter names", () => {
    const root = mkdtempSync(join(tmpdir(), "council-probe-config-"));
    const path = join(root, "agents.json");
    const secret = "fixture-bootstrap-secret";
    const checkError = (action: () => unknown) => assert.throws(action, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /fixture-bootstrap-secret|SyntaxError|ENOENT/);
        assert.ok(!error.message.includes(root));
        assert.ok(error.message.length < 100);
        return true;
    });
    try {
        checkError(() => loadProbeAdapter(path, secret));
        writeFileSync(path, `{"agents": { "${secret}":`);
        checkError(() => loadProbeAdapter(path, secret));
        writeFileSync(path, JSON.stringify({ agents: { fixture: { command: "node", args: ["fixture.mjs"], env: { CODEX_PROFILE: "fixture" } } } }));
        checkError(() => loadProbeAdapter(path, secret));
        assert.deepEqual(loadProbeAdapter(path, "fixture"), { command: "node", args: ["fixture.mjs"], env: { CODEX_PROFILE: "fixture" } });
        writeFileSync(path, JSON.stringify({ agents: { [secret]: { command: "node", args: secret } } }));
        checkError(() => loadProbeAdapter(path, secret));
    } finally {
        assert.ok(root.startsWith(join(tmpdir(), "council-probe-config-")));
        rmSync(root, { recursive: true, force: true });
    }
});

await test("diagnostic formatting redacts nested values before truncation and tolerates cycles", () => {
    const secret = "fixture-diagnostic-secret";
    const circular: Record<string, unknown> = { secret };
    circular.self = circular;
    const result = formatProbeDiagnostic(["x".repeat(1_985) + secret, { nested: secret }, new Error(secret)], [secret]);
    assert.equal(result.length, 2_000);
    assert.doesNotMatch(result, /fixture-diagnostic/);
    assert.match(result, /REDACTED/);
    assert.doesNotMatch(formatProbeDiagnostic([circular], [secret]), /fixture-diagnostic/);
});

await test("SDK console interception redacts values and restores the prior console method", () => {
    const prior = console.error;
    const lines: string[] = [];
    const capture = (...values: unknown[]) => { lines.push(values.map(String).join(" ")); };
    console.error = capture;
    const restore = installProbeDiagnostics(["fixture-console-secret"]);
    try {
        console.error("adapter diagnostic", { token: "fixture-console-secret" });
    } finally {
        restore();
        assert.equal(console.error, capture);
        console.error = prior;
    }
    assert.deepEqual(lines, ['adapter diagnostic {"token":"[REDACTED]"}']);
});

await test("probe accepts only complete named-client credentials", () => {
    const key = "zck_" + "a".repeat(64);
    assert.equal(probeCredential(key, true), key);
    assert.equal(probeCredential(undefined, false), undefined);
    for (const candidate of [undefined, "", "shared-key", "zck_" + "a".repeat(63), key + "a", "zck_" + "g".repeat(64), ` ${key}`, `${key}\n`]) {
        assert.throws(() => probeCredential(candidate, true), /COUNCIL_PROBE_MCP_KEY/);
    }
});

await test("probe URLs exclude insecure remote and credential-bearing destinations", () => {
    for (const url of ["https://fixture.invalid/api/mcp/mcp", "http://127.0.0.1:3000/mcp", "http://localhost:3000/mcp", "http://[::1]:3000/mcp"]) {
        assert.equal(probeEndpoint(url).toString(), url);
    }
    for (const url of ["invalid", "file:///tmp/mcp", "http://example.com/mcp", "https://user:secret@fixture.invalid/mcp", "http://127.0.0.1/mcp?secret=fixture", "http://localhost/mcp#fixture"]) {
        assert.throws(() => probeEndpoint(url), /--mcp-url/);
    }
});

await test("visibility requires an explicit list containing a verified read tool", () => {
    for (const reply of ["MCP_TOOLS: search_knowledge, list_notes", "MCP_TOOLS: mcp__zuychin-council__vault_read"]) {
        assert.equal(confirmsMcpVisibility(reply, ["search_knowledge", "vault_read"]), true);
    }
    for (const reply of ["NO MCP TOOLS", "I cannot see search_knowledge", "MCP_TOOLS: council_dispatch", "MCP_TOOLS: search_knowledge\nNO MCP TOOLS", "MCP_TOOLS: search_knowledge?", "Maybe MCP_TOOLS: search_knowledge", "MCP_TOOLS: "]) {
        assert.equal(confirmsMcpVisibility(reply, ["search_knowledge"]), false, reply);
    }
});

await test("settled deadlines leave no timers keeping Node alive", async () => {
    const moduleUrl = new URL("./council-acp-probe-support.mts", import.meta.url).href;
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE)$/i.test(name)));
    const script = `import { deadline } from ${JSON.stringify(moduleUrl)}; await deadline(Promise.resolve(), 60000, 'fixture'); await deadline(Promise.reject(new Error('fixture')), 60000, 'fixture').catch(() => {});`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { NODE_ENV: "test", ...env }, stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 4_000);
    const [code] = await once(child, "close");
    clearTimeout(timer);
    assert.equal(code, 0);
});
