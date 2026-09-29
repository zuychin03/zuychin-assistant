import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { hostEnvironment, parseFaultOptions, probeMcpEndpoint } from "./test-council-fault.mts";

const entry = fileURLToPath(new URL("./test-council-fault.mts", import.meta.url));
let passed = 0;
function check(name: string, test: () => void): void {
    test();
    passed++;
    console.log(`ok ${name}`);
}

check("default mode keeps optional Phase B", () => assert.deepEqual(parseFaultOptions([]), {
    phaseAOnly: false, requirePhaseB: false,
}));
for (const endpoint of ["http://localhost:3105/api/mcp/mcp", "http://127.0.0.1:3105/api/mcp/mcp", "http://[::1]:3105/api/mcp/mcp"]) {
    check("required mode accepts a loopback HTTP endpoint", () => {
        assert.equal(parseFaultOptions(["--require-phase-b", "--mcp-url", endpoint]).mcpUrl, endpoint);
    });
}
for (const args of [
    ["--phase-a-only", "--require-phase-b"], ["--require-phase-b"],
    ["--phase-a-only", "--phase-a-only"], ["--mcp-url"], ["--unknown"],
    ...["https://localhost/api/mcp/mcp", "http://example.invalid/api/mcp/mcp", "http://localhost.example.invalid",
        "http://user:secret@127.0.0.1", "http://127.0.0.1/?key=secret", "http://127.0.0.1/#secret", "file:///tmp/mcp"]
        .map((endpoint) => ["--mcp-url", endpoint]),
]) {
    check("invalid options fail before execution", () => assert.throws(() => parseFaultOptions(args)));
}

const prior = process.env.ZUYCHIN_HOST_LAUNCH;
process.env.ZUYCHIN_HOST_LAUNCH = '{"v":1,"type":"launch","autoAdopt":true,"attach":"CN-ABCD"}';
try {
    check("host environment excludes inherited launches and credentials", () => {
        const env = hostEnvironment({ MCP_COUNCIL_HOST_KEY: "fixture-key" });
        assert.equal(env.ZUYCHIN_HOST_LAUNCH, undefined);
        assert.equal(env.NODE_OPTIONS, undefined);
        assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
        assert.equal(env.MCP_COUNCIL_HOST_KEY, "fixture-key");
    });
} finally {
    if (prior === undefined) delete process.env.ZUYCHIN_HOST_LAUNCH;
    else process.env.ZUYCHIN_HOST_LAUNCH = prior;
}

const tools = ["council_host_claim", "council_host_issue_seat", "council_dispatch"].map((name) => ({ name }));
const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } });
const requests: { path: string; authorization: string | undefined; body: string }[] = [];
const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url ?? "", authorization: request.headers.authorization, body });
    if (request.url === "/timeout") return;
    if (request.url === "/redirect") { response.writeHead(302, { Location: "/json" }); response.end(); return; }
    if (request.url === "/401" || request.url === "/404" || request.url === "/500") {
        response.writeHead(Number(request.url.slice(1))); response.end("unavailable"); return;
    }
    response.setHeader("Content-Type", request.url === "/sse" ? "text/event-stream" : "application/json");
    response.end(request.url === "/json" ? payload
        : request.url === "/sse" ? `event: message\ndata: ${payload}\n\n`
        : request.url === "/oversized" ? "x".repeat(1_000_001)
        : request.url === "/wrong-tools" ? JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } })
        : request.url === "/rpc-error" ? JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603 } })
        : "not json");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;

async function run(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; output: string }> {
    const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
        env: { ...hostEnvironment(), ...extraEnv }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const deadline = setTimeout(() => {
        if (child.pid && process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        else child.kill("SIGKILL");
    }, 120_000);
    try {
        const code = await new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
        });
        return { code, output };
    } finally { clearTimeout(deadline); }
}

try {
    for (const path of ["/json", "/sse"]) {
        const ready = await probeMcpEndpoint(`${base}${path}`, "fixture-host-key");
        check("readiness accepts authenticated JSON and SSE host-tool results", () => {
            assert.equal(ready, true);
            assert.equal(requests.at(-1)?.authorization, "Bearer fixture-host-key");
            assert.equal(JSON.parse(requests.at(-1)!.body).method, "tools/list");
        });
    }
    for (const path of ["/401", "/404", "/500", "/wrong-tools", "/rpc-error", "/malformed", "/oversized", "/redirect", "/timeout"]) {
        const before = requests.length;
        const ready = await probeMcpEndpoint(`${base}${path}`, "fixture-host-key", path === "/timeout" ? 75 : 5000);
        check("readiness refuses invalid responses, redirects and timeouts", () => {
            assert.equal(ready, false);
            assert.equal(requests.length, before + 1);
        });
    }

    const fixtures = {
        NEXT_PUBLIC_SUPABASE_URL: `${base}/database-must-not-be-called`,
        SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key",
        MCP_COUNCIL_HOST_KEY: "fixture-injected-host-key",
    };
    let before = requests.length;
    const invalid = await run(["--phase-a-only", "--require-phase-b", "--mcp-url", `${base}/json`], fixtures);
    check("invalid CLI options cause no host start or network call", () => {
        assert.equal(invalid.code, 2);
        assert(!invalid.output.includes("phase A:"));
        assert.equal(requests.length, before);
    });

    const missing = await run(["--require-phase-b", "--mcp-url", `${base}/json`], { ...fixtures, SUPABASE_SERVICE_ROLE_KEY: "" });
    check("required missing credentials fail without starting hosts or contacting endpoints", () => {
        assert.equal(missing.code, 1);
        assert(missing.output.includes("Required Phase B unavailable"));
        assert(!missing.output.includes("phase A:"));
        assert.equal(requests.length, before);
    });

    const unavailable = await run(["--require-phase-b", "--mcp-url", `${base}/401`], fixtures);
    check("required readiness failure uses the injected key and prevents DB writes", () => {
        assert.equal(unavailable.code, 1);
        assert(!unavailable.output.includes("phase A:"));
        assert(!unavailable.output.includes(fixtures.MCP_COUNCIL_HOST_KEY));
        assert.equal(requests.length, before + 1);
        assert.equal(requests.at(-1)?.authorization, `Bearer ${fixtures.MCP_COUNCIL_HOST_KEY}`);
        assert.equal(requests.at(-1)?.path, "/401");
    });

    before = requests.length;
    const offline = await run(["--phase-a-only", "--mcp-url", `${base}/json`], {
        ...fixtures, ZUYCHIN_HOST_LAUNCH: '{"v":1,"type":"launch","autoAdopt":true,"attach":"CN-ABCD"}',
    });
    check("offline Phase A passes despite configured credentials and an inherited attach launch", () => {
        assert.equal(offline.code, 0, offline.output);
        assert(offline.output.includes("17 passed, 0 failed, 0 skipped"));
        assert.equal(requests.length, before, "offline mode contacted the configured endpoint");
    });
    const optional = await run([], { ...fixtures, SUPABASE_SERVICE_ROLE_KEY: "" });
    check("default mode preserves optional Phase B skipping", () => {
        assert.equal(optional.code, 0, optional.output);
        assert(optional.output.includes("17 passed, 0 failed, 1 skipped"));
        assert.equal(requests.length, before);
    });
    console.log(`\n${passed} fault harness regression checks passed; offline Phase A: 17 passed.`);
} finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
