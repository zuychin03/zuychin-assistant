import { readFileSync } from "node:fs";
import { redactCredentials, type AdapterEnvOverrides } from "./council-adapter-env.mts";

export const PROBE_READ_TOOLS = ["search_knowledge", "list_notes", "vault_read"] as const;

export interface ProbeAdapter {
    command: string;
    args: string[];
    env?: AdapterEnvOverrides;
}

export function loadProbeAdapter(path: string, name: string): ProbeAdapter {
    let config: { agents?: Record<string, ProbeAdapter> };
    try { config = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error("Could not read or parse council-agents.json."); }
    const adapter = config && config.agents && Object.hasOwn(config.agents, name) ? config.agents[name] : undefined;
    if (!adapter || typeof adapter.command !== "string" || !adapter.command.trim()
        || (adapter.args !== undefined && (!Array.isArray(adapter.args) || adapter.args.some((arg) => typeof arg !== "string")))
        || (adapter.env !== undefined && (!adapter.env || typeof adapter.env !== "object" || Array.isArray(adapter.env)))) {
        throw new Error("Configured adapter is missing or invalid.");
    }
    return { command: adapter.command, args: adapter.args ?? [], env: adapter.env };
}

export function formatProbeDiagnostic(values: readonly unknown[], secrets: readonly string[]): string {
    const encoded = values.map((value) => {
        if (typeof value === "string") return redactCredentials(value, secrets);
        try {
            return JSON.stringify(value, (_name, item) => {
                if (typeof item === "string") return redactCredentials(item, secrets);
                if (item instanceof Error) return { name: item.name, message: redactCredentials(item.message, secrets) };
                return item;
            }) ?? "[unavailable diagnostic]";
        } catch { return "[unserialisable diagnostic]"; }
    }).join(" ");
    return redactCredentials(encoded, secrets).slice(0, 2_000);
}

export function installProbeDiagnostics(secrets: readonly string[]): () => void {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((method) => console[method]);
    methods.forEach((method, index) => {
        console[method] = (...values: unknown[]) => originals[index].call(console, formatProbeDiagnostic(values, secrets));
    });
    return () => { methods.forEach((method, index) => { console[method] = originals[index]; }); };
}

export interface ProbeArguments {
    wantPrompt: boolean;
    wantEdit: boolean;
    wantModels: boolean;
    modelId?: string;
    reasoningEffort?: string;
    adapterName?: string;
    endpointArg?: string;
    command?: string;
    args: string[];
}

export function parseProbeArguments(argv: readonly string[]): ProbeArguments {
    const split = argv.indexOf("--");
    const flags = split < 0 ? argv : argv.slice(0, split);
    const seen = new Set<string>();
    const known = new Set(["--prompt", "--edit", "--models", "--set-model", "--set-reasoning", "--agent", "--mcp-url"]);
    const values = new Map<string, string>();
    for (let index = 0; index < flags.length; index++) {
        const flag = flags[index];
        if (!known.has(flag)) throw new Error("Unknown probe argument; adapter arguments must follow --.");
        if (seen.has(flag)) throw new Error(`Duplicate ${flag} argument.`);
        seen.add(flag);
        if (flag === "--agent" || flag === "--mcp-url" || flag === "--set-model" || flag === "--set-reasoning") {
            const value = flags[++index];
            if (!value?.trim() || value.startsWith("-")) throw new Error(`${flag} requires a value, not another flag.`);
            values.set(flag, value);
        }
    }
    if (seen.has("--prompt") && seen.has("--edit")) throw new Error("--prompt and --edit are mutually exclusive.");
    if (seen.has("--agent") && split >= 0) throw new Error("Choose --agent or a command after --, not both.");
    const command = split < 0 ? undefined : argv[split + 1];
    if (!seen.has("--agent") && (!command?.trim() || command.startsWith("-"))) throw new Error("Select --agent or provide a command after --.");
    if (seen.has("--prompt") && !values.has("--mcp-url")) throw new Error("--prompt requires --mcp-url with an explicit credential destination.");
    return {
        wantPrompt: seen.has("--prompt") || seen.has("--edit"), wantEdit: seen.has("--edit"),
        wantModels: seen.has("--models") || seen.has("--set-model") || seen.has("--set-reasoning"),
        modelId: values.get("--set-model"), reasoningEffort: values.get("--set-reasoning"),
        adapterName: values.get("--agent"), endpointArg: values.get("--mcp-url"), command,
        args: split < 0 ? [] : argv.slice(split + 2),
    };
}

export function probeCredential(value: string | undefined, required: boolean): string | undefined {
    if (!value && !required) return undefined;
    if (!value || !/^zck_[0-9a-f]{64}$/.test(value)) {
        throw new Error("COUNCIL_PROBE_MCP_KEY must be a complete 68-character named-client key (zck_ plus 64 lowercase hex characters). Use a separate read-only probe client.");
    }
    return value;
}

export function probeEndpoint(value: string): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("--mcp-url must be an HTTPS or loopback HTTP URL."); }
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
        throw new Error("--mcp-url requires HTTPS or loopback HTTP, without user information, query or fragment.");
    }
    return url;
}

export async function deadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
        })]);
    } finally { clearTimeout(timer); }
}

export async function probeMcpTools(endpoint: URL, key: string, timeoutMs = 10_000): Promise<string[]> {
    const signal = AbortSignal.timeout(timeoutMs);
    const names = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
        const id = page + 1;
        const response = await fetch(endpoint, {
            method: "POST", redirect: "error", signal,
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: cursor ? { cursor } : {} }),
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`MCP tools/list failed with HTTP ${response.status}.`); }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("MCP tools/list returned no body.");
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > 1_000_000) throw new Error("MCP tools/list response exceeded the size limit.");
                chunks.push(value);
            }
        } finally { await reader.cancel().catch(() => {}); }
        const raw = Buffer.concat(chunks).toString("utf8");
        const messages: unknown[] = response.headers.get("content-type")?.includes("text/event-stream")
            ? raw.replace(/\r\n/g, "\n").split("\n\n").flatMap((event) => {
                const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
                return data ? [JSON.parse(data)] : [];
            }) : [JSON.parse(raw)];
        const payload = messages.find((message) => message && typeof message === "object" && "id" in message && message.id === id) as
            { jsonrpc?: unknown; error?: unknown; result?: { tools?: { name?: unknown }[]; nextCursor?: unknown } } | undefined;
        if (payload?.jsonrpc !== "2.0" || payload.error || !Array.isArray(payload.result?.tools)) throw new Error("Invalid MCP tools/list response.");
        for (const tool of payload.result.tools) {
            if (!tool || typeof tool.name !== "string") throw new Error("Invalid MCP tool name.");
            names.add(tool.name);
        }
        const next = payload.result.nextCursor;
        if (next === undefined) {
            const readable = PROBE_READ_TOOLS.filter((name) => names.has(name));
            if (!readable.length) throw new Error("MCP tools/list did not advertise any expected knowledge read tools.");
            return readable;
        }
        if (typeof next !== "string" || !next || seenCursors.has(next)) throw new Error("Invalid MCP tools/list pagination.");
        seenCursors.add(next);
        cursor = next;
    }
    throw new Error("MCP tools/list exceeded the page limit.");
}

export function confirmsMcpVisibility(reply: string, advertised: readonly string[]): boolean {
    if (/NO MCP TOOLS/i.test(reply)) return false;
    const lines = reply.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length !== 1 || !lines[0].startsWith("MCP_TOOLS: ")) return false;
    const listed = lines[0].slice("MCP_TOOLS: ".length).split(",").map((name) => name.trim());
    return listed.length > 0 && listed.every((name) => /^[a-zA-Z0-9_.-]+$/.test(name))
        && advertised.some((name) => listed.some((entry) => entry === name || entry.endsWith(`__${name}`)));
}
