import os from "node:os";
import path from "node:path";

// Pure parts of the agent connect script, kept apart so they can be tested without a network,
// a terminal or the owner's real config files.

export const CLIENTS = ["claude", "codex", "cursor", "antigravity"] as const;
export type ConnectClient = (typeof CLIENTS)[number];

export const DEFAULT_SERVER_NAME = "zuychin-knowledge";
export const DEFAULT_KEY_VAR = "ZUYCHIN_MCP_KEY";
export const KEY_PREFIX = "zck_";
export const CLAIM_PREFIX = "zkc_";

export function isConnectClient(value: string): value is ConnectClient {
    return (CLIENTS as readonly string[]).includes(value);
}

export function defaultConfigPath(client: ConnectClient, env: Record<string, string | undefined> = process.env, home = os.homedir()): string {
    switch (client) {
        case "claude":
            return path.join(env.CLAUDE_CONFIG_DIR || home, ".claude.json");
        case "codex":
            return path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml");
        case "cursor":
            return path.join(home, ".cursor", "mcp.json");
        case "antigravity":
            return path.join(home, ".gemini", "config", "mcp_config.json");
    }
}

export function normaliseUrl(value: string): string {
    try {
        const url = new URL(value.trim());
        return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
    } catch {
        return value.trim().replace(/\/+$/, "").toLowerCase();
    }
}

export function mcpEndpoint(baseUrl: string): string {
    return `${baseUrl.replace(/\/+$/, "")}/api/mcp/mcp`;
}

// The claim travels in a request body, so plain http is allowed only to this machine.
export function checkBaseUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("The base URL is not a valid URL.");
    }
    const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        throw new Error("The base URL must use https (plain http only for 127.0.0.1 or localhost).");
    }
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

// Reads only the named keys, so the production secrets in .env.local never enter the process.
export function readEnvValues(text: string, names: readonly string[]): Record<string, string> {
    const found: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!match || !names.includes(match[1])) continue;
        let value = match[2];
        const quoted = /^(["'])(.*)\1$/.exec(value);
        value = quoted ? quoted[2] : value.replace(/\s+#.*$/, "");
        if (value) found[match[1]] = value;
    }
    return found;
}

export function pickBaseUrl(flag: string | undefined, env: Record<string, string | undefined>): string | null {
    const value = flag || env.NEXT_PUBLIC_BASE_URL || env.AUTH_ORIGIN;
    return value ? checkBaseUrl(value) : null;
}

export function clientMatchesClaim(client: ConnectClient, claimClient: string): boolean {
    return claimClient.toLowerCase().includes(client);
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const URL_FIELDS = ["url", "serverUrl", "httpUrl"] as const;

function entryUrl(entry: JsonObject): string {
    for (const field of URL_FIELDS) {
        if (typeof entry[field] === "string") return entry[field] as string;
    }
    return "";
}

export type ConfigChange = { text: string; action: "replaced" | "added"; names: string[] };

// Replaces the credential on every entry for this endpoint (keeping its name and other fields),
// or adds one entry. Indent, line endings and the trailing newline follow the original file.
export function upsertJsonServer(original: string, params: { client: Exclude<ConnectClient, "codex">; mcpUrl: string; key: string }): ConfigChange {
    const source = original.replace(/^﻿/, "");
    let root: unknown = {};
    if (source.trim()) {
        try {
            root = JSON.parse(source);
        } catch {
            throw new Error("The config file is not valid JSON, so it was left untouched.");
        }
    }
    if (!isObject(root)) throw new Error("The config file does not hold a JSON object, so it was left untouched.");
    if (root.mcpServers !== undefined && !isObject(root.mcpServers)) {
        throw new Error("mcpServers in the config file is not an object, so it was left untouched.");
    }
    const servers: JsonObject = (root.mcpServers as JsonObject | undefined) ?? {};
    const target = normaliseUrl(params.mcpUrl);
    const authorization = `Bearer ${params.key}`;

    const names = Object.keys(servers).filter((name) => {
        const entry = servers[name];
        return isObject(entry) && normaliseUrl(entryUrl(entry)) === target;
    });
    for (const name of names) {
        const entry = servers[name] as JsonObject;
        const headers = isObject(entry.headers) ? entry.headers : {};
        for (const header of Object.keys(headers)) {
            if (header.toLowerCase() === "authorization") delete headers[header];
        }
        entry.headers = { ...headers, Authorization: authorization };
    }

    let action: ConfigChange["action"] = "replaced";
    if (names.length === 0) {
        action = "added";
        let name = DEFAULT_SERVER_NAME;
        for (let n = 2; name in servers; n++) name = `${DEFAULT_SERVER_NAME}-${n}`;
        servers[name] = params.client === "claude"
            ? { type: "http", url: params.mcpUrl, headers: { Authorization: authorization } }
            : { url: params.mcpUrl, headers: { Authorization: authorization } };
        names.push(name);
    }
    root.mcpServers = servers;

    const indent = /\n([ \t]+)\S/.exec(source)?.[1] ?? "  ";
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const trailing = source === "" || /\n$/.test(source) ? eol : "";
    const text = JSON.stringify(root, null, indent).replace(/\n/g, eol) + trailing;
    return { text, action, names };
}

// True when every entry for this endpoint carries the key: the check after saving, which tolerates
// the client rewriting unrelated parts of its own file in the meantime.
export function jsonServerHasKey(text: string, mcpUrl: string, key: string): boolean {
    let root: unknown;
    try {
        root = JSON.parse(text.replace(/^﻿/, ""));
    } catch {
        return false;
    }
    if (!isObject(root) || !isObject(root.mcpServers)) return false;
    const target = normaliseUrl(mcpUrl);
    const entries = Object.values(root.mcpServers).filter((entry): entry is JsonObject => isObject(entry) && normaliseUrl(entryUrl(entry)) === target);
    return entries.length > 0 && entries.every((entry) => isObject(entry.headers) && entry.headers.Authorization === `Bearer ${key}`);
}

export type CodexChange ={ text: string; action: "replaced" | "added" | "unchanged"; name: string; envVar: string };

const TABLE_HEADER = /^\s*\[(?!\[)\s*([^\]]+?)\s*\](?:\s*#.*)?$/;

function codexServerName(header: string): string | null {
    const match = /^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/.exec(header.trim());
    return match ? match[1] ?? match[2] ?? match[3] : null;
}

function tomlString(line: string, key: string): string | null {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(line);
    return match ? match[1] ?? match[2] : null;
}

// Codex reads the key from an environment variable named in the table, so the file itself never
// holds the credential. Edits are line-based to leave the rest of the file byte for byte.
export function planCodexConfig(original: string, mcpUrl: string): CodexChange {
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const lines = original.split(/\r?\n/);
    const target = normaliseUrl(mcpUrl);

    let start = -1;
    let end = lines.length;
    let name = "";
    for (let i = 0; i < lines.length; i++) {
        const header = TABLE_HEADER.exec(lines[i]);
        if (!header) {
            if (/^\s*\[\[/.test(lines[i]) && start !== -1) { end = i; break; }
            continue;
        }
        if (start !== -1) { end = i; break; }
        const server = codexServerName(header[1]);
        if (!server) continue;
        let tableEnd = lines.length;
        for (let j = i + 1; j < lines.length; j++) {
            if (/^\s*\[/.test(lines[j])) { tableEnd = j; break; }
        }
        const url = lines.slice(i + 1, tableEnd).map((line) => tomlString(line, "url")).find((value) => value !== null);
        if (url && normaliseUrl(url) === target) {
            start = i;
            name = server;
        }
    }

    if (start === -1) {
        let added = DEFAULT_SERVER_NAME;
        const taken = new Set(lines.map((line) => TABLE_HEADER.exec(line)?.[1]).filter(Boolean).map((header) => codexServerName(header as string)));
        for (let n = 2; taken.has(added); n++) added = `${DEFAULT_SERVER_NAME}-${n}`;
        const block = [`[mcp_servers.${added}]`, `url = "${mcpUrl}"`, `bearer_token_env_var = "${DEFAULT_KEY_VAR}"`];
        const body = original.replace(/(\r?\n)+$/, "");
        const text = (body ? body + eol + eol : "") + block.join(eol) + eol;
        return { text, action: "added", name: added, envVar: DEFAULT_KEY_VAR };
    }

    const table = lines.slice(start + 1, end);
    if (table.some((line) => /^\s*(bearer_token|http_headers|env_http_headers)\s*=/.test(line) || /authorization/i.test(line))) {
        throw new Error(`The Codex server "${name}" sets its credential another way. Remove that line and run this again.`);
    }
    const varLine = table.findIndex((line) => /^\s*bearer_token_env_var\s*=/.test(line));
    if (varLine !== -1) {
        const envVar = tomlString(table[varLine], "bearer_token_env_var");
        if (envVar && /^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) {
            return { text: original, action: "unchanged", name, envVar };
        }
        lines[start + 1 + varLine] = `bearer_token_env_var = "${DEFAULT_KEY_VAR}"`;
    } else {
        const urlLine = table.findIndex((line) => tomlString(line, "url") !== null);
        lines.splice(start + 2 + urlLine, 0, `bearer_token_env_var = "${DEFAULT_KEY_VAR}"`);
    }
    return { text: lines.join(eol), action: "replaced", name, envVar: DEFAULT_KEY_VAR };
}

// mcp-handler answers as JSON or as server-sent events; the last data line carries the reply.
export function parseMcpReply(raw: string): { result?: JsonObject; error?: { message?: string } } | null {
    const text = raw.trim();
    if (text.startsWith("{")) {
        try { return JSON.parse(text); } catch { return null; }
    }
    let reply = null;
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        try { reply = JSON.parse(line.slice(5)); } catch { /* keep the previous line */ }
    }
    return reply;
}

export const EXPECTED_TOOLS = ["search_knowledge", "list_notes", "vault_search", "vault_read"] as const;
