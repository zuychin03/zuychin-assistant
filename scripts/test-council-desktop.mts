import assert from "node:assert/strict";
import { spawn, spawnSync, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Script } from "node:vm";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = join(REPO, "src-tauri/target/debug/zuychin-council-desktop.exe");
const execute = promisify(execFile);
const delay = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds));

interface Report { stage: string; pid?: number; port?: number; detail?: string }

const browserScript = String.raw`
(async () => {
    const options = window.smokeOptions;
    const report = async (stage, extra = {}) => {
        const response = await fetch(options.report, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stage, ...extra }), signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("The smoke reporter refused a result");
    };
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
    let step = "native bridge";
    try {
        check(typeof window.__TAURI_INTERNALS__?.invoke === "function", "Native IPC was not injected");
        const invoke = (command, args = {}) => window.__TAURI_INTERNALS__.invoke(command, args);
        const status = () => invoke("council_desktop_status");
        const waitFor = async (description, predicate) => {
            const until = Date.now() + 30000;
            while (Date.now() < until) {
                const current = await status();
                if (predicate(current)) return current;
                if (current.phase === "failed") {
                    const exit = current.lastExit;
                    throw new Error(description + ": " + (current.error || "host failed")
                        + " (exit=" + (exit?.code ?? "unknown") + ", reason=" + (exit?.reason ?? "unreported")
                        + ", forced=" + Boolean(exit?.forced) + ")");
                }
                await sleep(100);
            }
            throw new Error("Timed out waiting for " + description);
        };
        const ready = (current) => current.phase === "running" && current.owned && current.restartSafe
            && current.health?.lifecycle === "ready" && !current.health.draining;
        const describe = (current) => ({ pid: current.health.pid, port: current.health.port });
        const first = await status();
        check(first.phase === "stopped" && !first.owned, "The isolated app did not start idle");
        await report("initial-idle");

        step = "native capability denial";
        let denied = false;
        try {
            await invoke("plugin:window|set_title", { label: "main", value: "Unexpected native permission" });
        } catch (error) {
            denied = /not allowed|not permitted|denied/i.test(String(error));
        }
        check(denied, "An ungranted native window command was not rejected by the ACL");
        await report("capability-denied");

        step = "start";
        await invoke("council_desktop_start");
        const started = await waitFor("host readiness", ready);
        check(started.health.port >= 8788 && started.health.port <= 8791, "Host escaped the isolated port range");
        check(started.health.agents === 0 && started.health.councilCode === null, "Host unexpectedly started Council work");
        await report("started", describe(started));

        step = "repeat start";
        let duplicateRefused = false;
        try { await invoke("council_desktop_start"); } catch { duplicateRefused = true; }
        check(duplicateRefused && (await status()).health.pid === started.health.pid, "Repeated start created another host");
        await report("duplicate-start-refused");

        step = "browser loopback transport";
        const base = "http://127.0.0.1:" + started.health.port;
        const probe = await fetch(base + "/health", { signal: AbortSignal.timeout(5000) }).then((response) => response.json());
        check(probe.service === "zuychin-council-host", "Webview could not probe the owned loopback host");
        const pairing = await fetch(options.pairing).then((response) => response.json());
        const paired = await fetch(base + "/pair?code=" + encodeURIComponent(pairing.code)).then((response) => response.json());
        check(typeof paired.token === "string", "Webview pairing failed");
        const health = await fetch(base + "/health", { headers: { Authorization: "Bearer " + paired.token } }).then((response) => response.json());
        check(health.repo === options.workspace && health.agents.length === 0, "Pairing reached the wrong workspace");
        await new Promise((done, fail) => {
            const socket = new WebSocket("ws://127.0.0.1:" + started.health.port + "/ws", [paired.token]);
            const timer = setTimeout(() => { socket.close(); fail(new Error("WebSocket state timed out")); }, 5000);
            socket.onerror = () => { clearTimeout(timer); fail(new Error("WebSocket connection failed")); };
            socket.onmessage = (event) => {
                try {
                    const frame = JSON.parse(event.data);
                    if (frame.type !== "state") return;
                    check(frame.repo === options.workspace && frame.code === null, "WebSocket reached the wrong host");
                    clearTimeout(timer); socket.close(); done();
                } catch (error) { clearTimeout(timer); socket.close(); fail(error); }
            };
        });
        await report("loopback-paired-websocket");

        step = "restart";
        await invoke("council_desktop_restart");
        const restarted = await waitFor("replacement host", (current) => ready(current) && current.health.pid !== started.health.pid);
        await report("restarted", describe(restarted));

        step = "stop";
        await invoke("council_desktop_stop");
        const stopped = await waitFor("clean stop", (current) => current.phase === "stopped" && !current.owned);
        check(stopped.lastExit?.clean && !stopped.lastExit.forced && stopped.lastExit.reason === "requested", "Stop was not a clean requested exit");
        await report("clean-stop");

        step = "close cleanup preparation";
        await invoke("council_desktop_start");
        const closing = await waitFor("host before window close", ready);
        await report("ready-to-close", describe(closing));
        document.body.textContent = "Native lifecycle checks passed. Testing window-close cleanup…";
    } catch (error) {
        document.body.textContent = "Native smoke failed: " + step;
        await report("failed", { detail: step + ": " + String(error).slice(0, 1000) }).catch(() => {});
    }
})();
`;

class FatalProbe extends Error {
    constructor(cause: unknown) {
        super("Fatal probe failure", { cause });
    }
}

async function waitFor<T>(description: string, probe: () => Promise<T | null>, timeout = 30_000): Promise<T> {
    const until = Date.now() + timeout;
    let hadError = false;
    let lastError: unknown;
    while (Date.now() < until) {
        let value: T | null = null;
        try {
            value = await probe();
        } catch (error) {
            if (error instanceof FatalProbe) throw error.cause;
            hadError = true;
            lastError = error;
        }
        if (value !== null) return value;
        await delay(100);
    }
    if (hadError) throw new Error(`Timed out waiting for ${description}; last error: ${String(lastError)}`, { cause: lastError });
    throw new Error(`Timed out waiting for ${description}`);
}

// Node keeps its child's process handle until the exit is reaped, so the app's
// PID cannot be recycled while this still reports it running.
function exited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

// Windows recycles PIDs, so an owned host counts as running only while its PID
// belongs to a process whose command line names this run's scratch root.
async function runningHosts(root: string): Promise<Set<number>> {
    const query = "Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%council-host.mts%'\""
        + " | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine.IndexOf($env:COUNCIL_SMOKE_ROOT, [StringComparison]::OrdinalIgnoreCase) -ge 0 }"
        + " | ForEach-Object { $_.ProcessId }";
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query],
        { windowsHide: true, timeout: 10_000, env: { ...process.env, COUNCIL_SMOKE_ROOT: basename(root) } });
    return new Set(stdout.split(/\s+/).filter(Boolean).map(Number));
}

async function freeHostPort(): Promise<number> {
    for (let port = 8788; port <= 8791; port++) {
        const free = await new Promise<boolean>((done) => {
            const probe = createTcpServer();
            probe.once("error", () => done(false));
            probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
        });
        if (free) return port;
    }
    throw new Error("No isolated host port is available in 8788-8791; port 8787 is never used by this test");
}

async function listen(server: Server): Promise<number> {
    await new Promise<void>((done, fail) => {
        server.once("error", fail);
        server.listen(0, "127.0.0.1", done);
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    return address.port;
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
    const allowed = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"]);
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
    const home = join(root, "home");
    const roaming = join(home, "AppData/Roaming");
    const local = join(home, "AppData/Local");
    const temporary = join(root, "temp");
    const webview = join(root, "webview-data");
    for (const directory of [home, roaming, local, temporary, webview]) mkdirSync(directory, { recursive: true });
    return { ...environment, NODE_ENV: "test", HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local,
        TEMP: temporary, TMP: temporary, TMPDIR: temporary, WEBVIEW2_USER_DATA_FOLDER: webview,
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "empty.gitconfig") };
}

async function closeNativeWindow(pid: number): Promise<void> {
    assert(Number.isSafeInteger(pid) && pid > 0);
    const command = `$taskDesktop = Get-Process -Id ${pid} -ErrorAction Stop; `
        + "if (-not $taskDesktop.CloseMainWindow()) { throw 'Native window could not be closed' }; "
        + "Start-Sleep -Milliseconds 25; $taskDesktop.Refresh(); "
        + "if (-not $taskDesktop.HasExited) { [void]$taskDesktop.CloseMainWindow() }";
    await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 10_000 });
}

async function removeScratch(root: string): Promise<void> {
    const withinTemp = relative(resolve(tmpdir()), resolve(root));
    assert(withinTemp && !withinTemp.startsWith("..") && !isAbsolute(withinTemp));
    for (let attempt = 0; attempt < 5; attempt++) {
        try { rmSync(root, { recursive: true, force: true }); return; }
        catch { await delay(300); }
    }
    console.warn(`Cleanup deferred because Windows still holds a test directory: ${root}`);
}

async function main(): Promise<void> {
    assert(existsSync(EXE), "Build the debug Tauri executable before running the native smoke test");
    new Script(browserScript);
    const port = await freeHostPort();
    const root = mkdtempSync(join(tmpdir(), "council-desktop-smoke-"));
    const environment = isolatedEnvironment(root);
    const workspace = join(root, "smoke-workspace");
    const ownerConfig = join(root, "desktop.json");
    const hostConfig = join(root, "host.json");
    const hostEnv = join(root, "host.env");
    const identityFile = join(root, ".council-host/host-smoke-workspace.json");
    const reportPath = `/report/${randomBytes(16).toString("hex")}`;
    const pairingPath = `/pairing/${randomBytes(16).toString("hex")}`;
    const reports: Report[] = [];
    const ownedPids = new Set<number>();
    let failure: Error | null = null;
    let mcpCalls = 0;
    let origin = "";
    let html = "";
    let app: ChildProcess | undefined;
    let appError: Error | null = null;
    const cancelled = () => { failure = new Error("Native smoke was interrupted"); };
    process.once("SIGINT", cancelled);
    process.once("SIGTERM", cancelled);
    const server = createServer(async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        try {
            if (request.url === "/council" && request.method === "GET") {
                response.setHeader("Content-Type", "text/html; charset=utf-8");
                response.end(html);
            } else if (request.url === pairingPath && request.method === "GET") {
                const identity = JSON.parse(readFileSync(identityFile, "utf8")) as { pid: number; pairingCode: string };
                assert(ownedPids.has(identity.pid), "Pairing identity is not an observed owned host");
                response.setHeader("Content-Type", "application/json");
                response.end(JSON.stringify({ code: identity.pairingCode }));
            } else if (request.url === reportPath && request.method === "POST" && request.headers.origin === origin) {
                let body = "";
                for await (const chunk of request) {
                    body += String(chunk);
                    assert(body.length <= 4096, "Smoke report exceeds its limit");
                }
                const report = JSON.parse(body) as Report;
                assert(typeof report.stage === "string");
                if (report.pid !== undefined) {
                    assert(Number.isSafeInteger(report.pid) && report.pid > 0);
                    assert(typeof report.port === "number" && report.port >= 8788 && report.port <= 8791);
                    const identity = JSON.parse(readFileSync(identityFile, "utf8")) as { pid: number; port: number };
                    assert.equal(report.pid, identity.pid);
                    assert.equal(report.port, identity.port);
                    ownedPids.add(report.pid);
                }
                reports.push(report);
                if (report.stage === "failed") failure = new Error(report.detail ?? "Native webview smoke failed");
                else console.log(`  ok    ${report.stage}`);
                response.end("ok");
            } else if (request.url === "/mcp") {
                mcpCalls++;
                response.writeHead(503).end("Council mutations are disabled in this smoke test");
            } else response.writeHead(404).end();
        } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
            response.writeHead(500).end("Smoke fixture failed");
        }
    });
    try {
        mkdirSync(workspace);
        writeFileSync(join(root, "empty.gitconfig"), "");
        for (const args of [["init", "-b", "main"], ["-c", "user.name=Council Smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "smoke fixture"]]) {
            const git = spawnSync("git", args, { cwd: workspace, env: environment, windowsHide: true, encoding: "utf8", timeout: 10_000 });
            assert.equal(git.status, 0, `Temporary Git fixture failed: ${git.stderr}`);
        }
        origin = `http://127.0.0.1:${await listen(server)}`;
        const options = JSON.stringify({ report: reportPath, pairing: pairingPath, workspace }).replaceAll("<", "\\u003c");
        html = `<!doctype html><html><meta charset="utf-8"><title>Council native smoke</title><body>Testing isolated native lifecycle…<script>window.smokeOptions=${options};${browserScript}</script></body></html>`;
        writeFileSync(hostConfig, JSON.stringify({ mcpUrl: `${origin}/mcp`, agents: {}, host: {
            port, origins: [origin], autoAdopt: false, repos: { smoke: { path: workspace, baseBranch: "main" } },
        } }));
        writeFileSync(hostEnv, "MCP_COUNCIL_HOST_KEY=council_desktop_smoke_not_a_real_credential\n", { mode: 0o600 });
        writeFileSync(ownerConfig, JSON.stringify({ appUrl: `${origin}/council`, nodePath: process.execPath,
            repositoryPath: REPO, hostConfigPath: hostConfig, envFilePath: hostEnv,
            launch: { v: 1, type: "launch", workspace: "smoke", autoAdopt: false },
        }));
        console.log("Native Council smoke: isolated home, repository, credentials and ports 8788-8791.");
        app = spawn(EXE, [], { cwd: root, env: { ...environment, ZUYCHIN_DESKTOP_CONFIG: ownerConfig }, windowsHide: true, stdio: "ignore" });
        app.once("error", (error) => { appError = error; });
        const closing = await waitFor("native webview lifecycle checks", async () => {
            if (failure) throw new FatalProbe(failure);
            if (appError) throw new FatalProbe(appError);
            if (app?.exitCode !== null || app?.signalCode !== null) throw new FatalProbe(new Error("Native app exited before completing the smoke checks"));
            return reports.find((report) => report.stage === "ready-to-close") ?? null;
        }, 120_000);
        assert.deepEqual(reports.map((report) => report.stage), ["initial-idle", "capability-denied", "started", "duplicate-start-refused", "loopback-paired-websocket", "restarted", "clean-stop", "ready-to-close"]);
        assert.equal(ownedPids.size, 3, "Start, restart and final start must own distinct host processes");
        const running = await runningHosts(root);
        assert(closing.pid !== undefined && running.has(closing.pid), "The running owned host was not found by its command line");
        for (const pid of ownedPids) if (pid !== closing.pid) assert(!running.has(pid), "An earlier owned host survived replacement or stop");
        assert(app.pid);
        await closeNativeWindow(app.pid);
        await waitFor("native app shutdown", async () => app?.exitCode !== null ? true : null, 20_000);
        assert.equal(app.exitCode, 0, "Native app did not exit cleanly");
        await waitFor("owned host processes to exit", async () => {
            const remaining = await runningHosts(root);
            return [...ownedPids].every((pid) => !remaining.has(pid)) ? true : null;
        }, 10_000);
        await waitFor("owned host port to close", async () => {
            try { await fetch(`http://127.0.0.1:${closing.port}/health`, { signal: AbortSignal.timeout(500) }); return null; }
            catch { return true; }
        }, 5000);
        assert(!existsSync(join(environment.HOME!, ".zuychin/council-host.lock")), "Window close left the isolated host lock behind");
        assert.equal(mcpCalls, 0, "Lifecycle smoke unexpectedly invoked MCP");
        console.log("  ok    repeated-window-close-cleanup");
        console.log("Native desktop smoke passed: lifecycle, IPC denial, pairing/WebSocket and owned-process cleanup. No Council sessions created.");
    } finally {
        if (app?.pid && !exited(app)) {
            await closeNativeWindow(app.pid).catch(() => {});
            await waitFor("cleanup close", async () => app && exited(app) ? true : null, 10_000).catch(() => {});
            if (!exited(app)) await execute("taskkill.exe", ["/PID", String(app.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 }).catch(() => {});
        }
        const leftover = await runningHosts(root).catch(() => new Set<number>());
        for (const pid of ownedPids) if (leftover.has(pid)) {
            await execute("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 }).catch(() => {});
        }
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((done) => server.close(() => done()));
        await removeScratch(root);
        process.removeListener("SIGINT", cancelled);
        process.removeListener("SIGTERM", cancelled);
    }
}

if (process.platform !== "win32") console.log("SKIP: native window-close smoke currently targets Windows.");
else await main();
