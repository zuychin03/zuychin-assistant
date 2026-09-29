import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { parseLaunch } from "../src/lib/council/supervisor.ts";

const repo = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const supported = new Set(["--app-url", "--host-config", "--env-file", "--workspace", "--local"]);
const options = new Map<string, string>();
let local = false;
for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!supported.has(key)) throw new Error(`Unknown option: ${key}`);
    if (key === "--local") { local = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    options.set(key, value);
}

const hostConfigPath = realpathSync(resolve(repo, options.get("--host-config") ?? "scripts/council-agents.json"));
const host = JSON.parse(readFileSync(hostConfigPath, "utf8"));
const appUrl = new URL(options.get("--app-url") ?? new URL(host.mcpUrl).origin);
const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname);
if ((appUrl.protocol !== "https:" && !(local && loopback && appUrl.protocol === "http:"))
    || appUrl.username || appUrl.password || appUrl.search || appUrl.hash || !/^[A-Za-z0-9.:[\]-]+$/.test(appUrl.hostname)) {
    throw new Error("Use an HTTPS app URL without credentials, query or fragment. Local HTTP requires --local.");
}
appUrl.pathname = "/council";
if (!["http://localhost:3000", "http://127.0.0.1:3000"].includes(appUrl.origin)
    && !host.host?.origins?.includes(appUrl.origin)) {
    throw new Error("Add the app origin to host.origins in your Council host configuration, then run setup again.");
}
if (!existsSync(join(repo, "node_modules/tsx/package.json"))) throw new Error("Run npm install before desktop setup.");
const launch = parseLaunch(JSON.stringify({ v: 1, type: "launch", autoAdopt: false, workspace: options.get("--workspace") }));
if (!launch.ok) throw new Error(launch.reason);
if (launch.value.workspace && !host.host?.repos?.[launch.value.workspace]) {
    throw new Error("The workspace must be listed in host.repos.");
}
const sourceEnv = parseEnv(readFileSync(resolve(repo, options.get("--env-file") ?? ".env.local"), "utf8"));
const hostKey = sourceEnv.MCP_COUNCIL_HOST_KEY;
if (!hostKey || !/^[A-Za-z0-9_.~+/:=-]+$/.test(hostKey)) throw new Error("A valid MCP_COUNCIL_HOST_KEY is required in the selected env file.");
const directory = local ? join(repo, "src-tauri")
    : process.platform === "win32" ? join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "com.zuychin.council")
        : process.platform === "darwin" ? join(homedir(), "Library/Application Support/com.zuychin.council")
            : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "com.zuychin.council");
mkdirSync(directory, { recursive: true });
const envFilePath = join(directory, "host.local.env");
writeFileSync(envFilePath, `MCP_COUNCIL_HOST_KEY=${hostKey}\n`, { mode: 0o600 });
writeFileSync(join(directory, local ? "desktop.local.json" : "desktop.json"), JSON.stringify({
    appUrl: appUrl.href,
    nodePath: realpathSync(process.execPath),
    repositoryPath: repo,
    hostConfigPath,
    envFilePath,
    launch: launch.value,
}, null, 2) + "\n", { mode: 0o600 });
console.log(`Desktop ${local ? "development" : "installed app"} configuration written. Host credentials stay on this computer.`);
console.log("Start the app, then choose Host > Start host. Existing terminal hosts must be stopped by their owner first.");
