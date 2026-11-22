import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { stdin, stdout } from "node:process";
import readline from "node:readline/promises";
import {
    CLAIM_PREFIX, CLIENTS, EXPECTED_TOOLS, KEY_PREFIX, clientMatchesClaim, defaultConfigPath, isConnectClient,
    jsonServerHasKey, mcpEndpoint, parseMcpReply, pickBaseUrl, planCodexConfig, readEnvValues, upsertJsonServer,
    type ConnectClient,
} from "./agent-connect-config.mts";

// Connects one agent client to the knowledge MCP server without the claim or the key passing
// through a chat: the claim is typed at a hidden prompt, and the key goes from the response
// straight into the client's config (or, for Codex, the user environment variable it names).

const USER_AGENT = "zuychin-agent-connect/1.0";
const LABELS: Record<ConnectClient, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", antigravity: "Antigravity" };

const USAGE = `Usage: npm run agent:connect -- <${CLIENTS.join("|")}> [--url <base url>] [--config <file>]

Mint a claim for the agent on /admin (Agents), run this, and paste the claim at the hidden prompt.
--url     the deployment to connect to; defaults to NEXT_PUBLIC_BASE_URL, then AUTH_ORIGIN, in .env.local
--config  the client's config file, when it is not in the usual place`;

class Stop extends Error {}
class Help extends Stop {}

type Args = { client: ConnectClient; url?: string; config?: string };

function parseArgs(argv: string[]): Args {
    let client: string | undefined;
    let url: string | undefined;
    let config: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") throw new Help(USAGE);
        if (arg === "--url" || arg === "--config") {
            const value = argv[++i];
            if (!value) throw new Stop(`${arg} needs a value.\n\n${USAGE}`);
            if (arg === "--url") url = value;
            else config = value;
        } else if (!arg.startsWith("-") && !client) {
            client = arg.toLowerCase();
        } else {
            throw new Stop(`Unknown argument "${arg}".\n\n${USAGE}`);
        }
    }
    if (!client || !isConnectClient(client)) throw new Stop(USAGE);
    return { client, url, config };
}

async function readFileOrEmpty(file: string): Promise<string> {
    try {
        return await fs.readFile(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw new Stop(`Could not read ${file}.`);
    }
}

async function resolveBaseUrl(flag: string | undefined): Promise<string> {
    const envFile = path.resolve(import.meta.dirname, "..", ".env.local");
    const fromFile = flag ? {} : readEnvValues(await readFileOrEmpty(envFile), ["NEXT_PUBLIC_BASE_URL", "AUTH_ORIGIN"]);
    try {
        const base = pickBaseUrl(flag, {
            NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL || fromFile.NEXT_PUBLIC_BASE_URL,
            AUTH_ORIGIN: process.env.AUTH_ORIGIN || fromFile.AUTH_ORIGIN,
        });
        if (!base) throw new Stop("No base URL found. Pass --url https://<your deployment>.");
        return base;
    } catch (error) {
        if (error instanceof Stop) throw error;
        throw new Stop((error as Error).message);
    }
}

// Bracketed paste markers arrive as plain input in raw mode, so they are stripped before reading.
async function readHidden(prompt: string): Promise<string> {
    if (!stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of stdin) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks).toString("utf8").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
    }
    stdout.write(prompt);
    return new Promise((resolve, reject) => {
        let value = "";
        const finish = (error?: Error) => {
            stdin.off("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
            stdout.write("\n");
            if (error) reject(error);
            else resolve(value.trim());
        };
        const onData = (chunk: string) => {
            for (const char of chunk.replace(/\x1b\[20[01]~/g, "")) {
                if (char === "\r" || char === "\n") return finish();
                if (char === "\u0003" || char === "\u0004") return finish(new Stop("Cancelled. Nothing was changed."));
                if (char === "\b" || char === "\x7f") value = value.slice(0, -1);
                else if (char >= " ") value += char;
            }
        };
        stdin.setEncoding("utf8");
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", onData);
    });
}

async function confirm(question: string): Promise<boolean> {
    if (!stdin.isTTY) return false;
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
        return /^y(es)?$/i.test((await rl.question(question)).trim());
    } finally {
        rl.close();
    }
}

type Exchange = { key: string; client: string; accessLevel: string; scopes: string[] };

async function exchangeClaim(baseUrl: string, claim: string): Promise<Exchange> {
    let response: Response;
    try {
        response = await fetch(`${baseUrl}/api/agent/claim`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
            body: JSON.stringify({ claim }),
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
        });
    } catch {
        throw new Stop(`Could not reach ${baseUrl}. If the request may have arrived, run this again with the same claim within 60 seconds; otherwise the claim is still unused.`);
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.status === 429) throw new Stop("Too many claim attempts from this address. Wait a while, then try again.");
    if (!response.ok || !body || typeof body.key !== "string" || !body.key.startsWith(KEY_PREFIX)) {
        throw new Stop(`The claim was refused (HTTP ${response.status}). It may be mistyped, expired or already used. Mint a fresh one on /admin.`);
    }
    return {
        key: body.key,
        client: typeof body.client === "string" ? body.client : "",
        accessLevel: typeof body.accessLevel === "string" ? body.accessLevel : "",
        scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : [],
    };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Windows refuses a rename over a file another process has open for a moment, so it retries briefly.
async function writeAtomic(file: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    for (let attempt = 1; ; attempt++) {
        try {
            await fs.rename(temp, file);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (attempt < 10 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
                await sleep(150);
                continue;
            }
            await fs.rm(temp, { force: true });
            throw new Stop(`Could not save ${file} (${code ?? "unknown error"}). Close anything that holds it open and run this again with a fresh claim.`);
        }
    }
}

// The key reaches PowerShell on stdin, never as an argument, so it stays out of process listings.
function setUserEnvironmentVariable(name: string, value: string): Promise<void> {
    if (process.platform !== "win32") {
        return Promise.reject(new Stop(`Setting ${name} is only automated on Windows. Nothing was saved for Codex.`));
    }
    return new Promise((resolve, reject) => {
        const child = spawn("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-Command",
            "$value = [Console]::In.ReadLine(); [Environment]::SetEnvironmentVariable($env:ZC_KEY_VAR, $value, 'User')",
        ], { env: { ...process.env, ZC_KEY_VAR: name }, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
        child.on("error", () => reject(new Stop(`Could not start PowerShell to set ${name}.`)));
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Stop(`PowerShell could not set ${name} (exit ${code}).`))));
        child.stdin.end(`${value}\n`);
    });
}

async function rpc(mcpUrl: string, key: string, id: number | null, method: string, params: Record<string, unknown>, session?: string) {
    const headers: Record<string, string> = {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": USER_AGENT,
    };
    if (session) headers["mcp-session-id"] = session;
    const message = id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
    const response = await fetch(mcpUrl, { method: "POST", headers, body: JSON.stringify(message), redirect: "error", signal: AbortSignal.timeout(30_000) });
    const raw = await response.text();
    return { status: response.status, reply: response.ok ? parseMcpReply(raw) : null, session: response.headers.get("mcp-session-id") ?? session };
}

async function listTools(mcpUrl: string, key: string): Promise<string[]> {
    const init = await rpc(mcpUrl, key, 1, "initialize", {
        protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "zuychin-agent-connect", version: "1.0" },
    });
    if (init.status !== 200 || !init.reply?.result) throw new Stop(`The MCP server refused the new key (initialize HTTP ${init.status}).`);
    await rpc(mcpUrl, key, null, "notifications/initialized", {}, init.session).catch(() => undefined);
    const list = await rpc(mcpUrl, key, 2, "tools/list", {}, init.session);
    const tools = list.reply?.result?.tools;
    if (list.status !== 200 || !Array.isArray(tools)) throw new Stop(`Listing tools failed (tools/list HTTP ${list.status}).`);
    return tools.map((tool) => String((tool as { name?: unknown }).name ?? ""));
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const label = LABELS[args.client];
    const baseUrl = await resolveBaseUrl(args.url);
    const mcpUrl = mcpEndpoint(baseUrl);
    const configFile = path.resolve(args.config ?? defaultConfigPath(args.client));

    // Everything that can fail without the network is checked before the claim is spent.
    const before = await readFileOrEmpty(configFile);
    try {
        if (args.client === "codex") {
            planCodexConfig(before, mcpUrl);
            if (process.platform !== "win32") throw new Error("Codex reads its key from a user environment variable, which this script only sets on Windows.");
        } else {
            upsertJsonServer(before, { client: args.client, mcpUrl, key: `${KEY_PREFIX}preflight` });
        }
    } catch (error) {
        throw new Stop((error as Error).message);
    }

    console.log(`Connecting ${label} to ${mcpUrl}`);
    console.log(`Config: ${configFile}${before ? "" : " (will be created)"}`);
    const claim = await readHidden("Paste the claim from /admin (it stays hidden), then press Enter: ");
    if (!claim) throw new Stop("No claim entered. Nothing was changed.");
    if (!claim.startsWith(CLAIM_PREFIX) || !/^[A-Za-z0-9_-]{16,200}$/.test(claim)) {
        throw new Stop(`That does not look like a claim (claims start with ${CLAIM_PREFIX}). Nothing was changed and the claim was not used.`);
    }

    const issued = await exchangeClaim(baseUrl, claim);
    console.log(`Claim accepted for "${issued.client}" (access level ${issued.accessLevel || "unknown"}).`);
    if (!clientMatchesClaim(args.client, issued.client)) {
        const proceed = await confirm(`That claim was minted for "${issued.client}", not ${label}. Save its key into ${label} anyway? [y/N] `);
        if (!proceed) {
            throw new Stop(`The claim was minted for "${issued.client}", so nothing was saved into ${label}. "${issued.client}" now has a new key that no client holds and its earlier key is revoked, so mint fresh claims for both agents.`);
        }
    }

    // Re-read rather than reuse the preflight copy: the client may have saved its config meanwhile.
    const current = await readFileOrEmpty(configFile);
    let summary: string;
    if (args.client === "codex") {
        const plan = planCodexConfig(current, mcpUrl);
        await setUserEnvironmentVariable(plan.envVar, issued.key);
        if (plan.action !== "unchanged") await writeAtomic(configFile, plan.text);
        summary = `${plan.action === "added" ? "Added" : "Kept"} the Codex server "${plan.name}"${plan.action === "replaced" ? " and pointed it at the key variable" : ""}; the key is in the user environment variable ${plan.envVar}.`;
    } else {
        const change = upsertJsonServer(current, { client: args.client, mcpUrl, key: issued.key });
        await writeAtomic(configFile, change.text);
        if (!jsonServerHasKey(await readFileOrEmpty(configFile), mcpUrl, issued.key)) {
            throw new Stop(`${configFile} was overwritten straight after saving, probably by ${label} itself. Close ${label} and run this again with a fresh claim.`);
        }
        summary = `${change.action === "added" ? "Added" : "Replaced the key on"} ${change.names.map((name) => `"${name}"`).join(", ")} in ${configFile}.`;
    }
    console.log(summary);

    try {
        const tools = await listTools(mcpUrl, issued.key);
        const missing = EXPECTED_TOOLS.filter((tool) => !tools.includes(tool));
        console.log(`Live check passed: ${tools.length} tools visible${missing.length ? `, but missing ${missing.join(", ")}` : `, including ${EXPECTED_TOOLS.join(", ")}`}.`);
    } catch (error) {
        const reason = error instanceof Stop ? error.message : "The MCP server could not be reached.";
        throw new Stop(`The key is saved, but the live check failed: ${reason}`);
    }
    console.log(args.client === "codex"
        ? "Done. Close every terminal and Codex window, then reopen Codex so it reads the new variable."
        : `Done. Restart ${label} or reload its MCP servers so it uses the new key.`);
}

main().catch((error: unknown) => {
    if (error instanceof Help) {
        console.log(error.message);
        return;
    }
    // Unexpected errors print no message: one could quote the response or the config file.
    console.error(error instanceof Stop ? error.message : "The connect script failed unexpectedly. Nothing secret was printed.");
    process.exitCode = 1;
});
