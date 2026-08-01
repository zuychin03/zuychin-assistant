"use client";

import { HOST_PORT_FIRST, HOST_PORT_LAST } from "@/lib/council/protocol";

// Client for scripts/council-host.mts. The page can never be the ACP client -
// a browser has no child_process and no stdio - so this is a control surface
// over a loopback process, and everything it cannot reach degrades to the
// read-only view the page already had.

export type HostConnection = "probing" | "absent" | "unpaired" | "connected" | "observing";

export interface HostAgent {
    name: string;
    provider: string;
    mode: "acp" | "shell";
    state: string;
    detail: string;
    branch: string;
    worktree: string;
    inFlight: boolean;
    lastActivity: string;
    warn: string | null;
}

export interface HostPermission {
    id: string;
    agent: string;
    kind: string;
    title: string;
    path: string | null;
    reason: string;
    createdAt: string;
}

/** A seat this machine can fill, as configured in scripts/council-agents.json. */
export interface HostInstance {
    name: string;
    provider: string;
    mode: "acp" | "shell";
    expertise: string;
    warn: string | null;
}

export interface HostSnapshot {
    version: string;
    code: string | null;
    /** Both absent from a host older than the build that added them. */
    busy?: boolean;
    instances?: HostInstance[];
    topic: string | null;
    status: string;
    round: number;
    maxRounds: number;
    floorHolder: string | null;
    repo: string;
    runDir: string | null;
    agents: HostAgent[];
    permissions: HostPermission[];
}

export interface HostActivity {
    agent: string;
    kind: string;
    detail: string;
    at: string;
}

const STORAGE_KEY = "zuychin.councilHost";
const MAX_ACTIVITY = 40;
const PROBE_TIMEOUT_MS = 1500;

interface Stored { port: number; token: string }

function readStored(): Stored | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) as Stored : null;
    } catch {
        return null;
    }
}

function writeStored(value: Stored | null): void {
    try {
        if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
        else localStorage.removeItem(STORAGE_KEY);
    } catch {
        // Private mode or a blocked store: pairing simply will not persist.
    }
}

async function probe(port: number, token?: string): Promise<{ ok: boolean; snapshot: HostSnapshot | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: controller.signal,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) return { ok: false, snapshot: null };
        const body = await res.json() as { service?: string; agents?: unknown };
        if (body.service !== "zuychin-council-host") return { ok: false, snapshot: null };
        // The unauthenticated shape carries no agents; that array is what marks
        // the reply as the full state rather than the bare probe.
        return { ok: true, snapshot: Array.isArray(body.agents) ? body as unknown as HostSnapshot : null };
    } catch {
        return { ok: false, snapshot: null };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * A plain fetch first, deliberately. From a deployed origin this is what raises
 * Chrome's Local Network Access prompt, and a denial fails silently - so a
 * failed probe means "no local host", never an error, and the WebSocket is only
 * opened once the permission is already settled.
 */
export async function findHost(): Promise<{ port: number; token: string | null; snapshot: HostSnapshot | null } | null> {
    const stored = readStored();
    const ports = [];
    for (let p = HOST_PORT_FIRST; p <= HOST_PORT_LAST; p++) ports.push(p);
    if (stored) ports.unshift(stored.port);

    for (const port of ports) {
        const token = stored?.port === port ? stored.token : undefined;
        const result = await probe(port, token);
        if (!result.ok) continue;
        if (result.snapshot && token) return { port, token, snapshot: result.snapshot };
        return { port, token: null, snapshot: null };
    }
    return null;
}

export async function pair(port: number, code: string): Promise<string | null> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/pair?code=${encodeURIComponent(code.trim().toUpperCase())}`);
        if (!res.ok) return null;
        const body = await res.json() as { token?: string };
        if (!body.token) return null;
        writeStored({ port, token: body.token });
        return body.token;
    } catch {
        return null;
    }
}

export function forgetHost(): void {
    writeStored(null);
}

export interface HostClientHandlers {
    onState: (snapshot: HostSnapshot) => void;
    onActivity: (activity: HostActivity) => void;
    onError: (detail: string) => void;
    onClose: () => void;
}

export class HostClient {
    private socket: WebSocket | null = null;

    constructor(private readonly port: number, private readonly token: string, private readonly handlers: HostClientHandlers) {}

    open(): void {
        // The token rides the subprotocol because a browser cannot set headers
        // on a WebSocket, and a URL is logged in places a header is not.
        const socket = new WebSocket(`ws://127.0.0.1:${this.port}/ws`, [this.token]);
        this.socket = socket;
        socket.onmessage = (event) => {
            let message: Record<string, unknown>;
            try { message = JSON.parse(String(event.data)); } catch { return; }
            switch (message.type) {
                case "state":
                    this.handlers.onState(message as unknown as HostSnapshot);
                    break;
                case "agent_update":
                case "turn":
                case "agent_exit":
                    this.handlers.onActivity({
                        agent: String(message.agent ?? "host"),
                        kind: String(message.kind ?? message.type),
                        detail: String(message.detail ?? (message.type === "turn" ? `turn pushed (${message.chars} chars)` : "")),
                        at: new Date().toISOString(),
                    });
                    break;
                case "auto_adopt":
                    this.handlers.onActivity({
                        agent: "host",
                        kind: "auto-adopt",
                        detail: `claimed ${String(message.code ?? "")} - ${String(message.topic ?? "")}`,
                        at: new Date().toISOString(),
                    });
                    break;
                case "permission_request":
                case "permission_resolved":
                    // Both only change the queue, which arrives in full on the
                    // next state frame; this just makes it feel immediate.
                    this.handlers.onActivity({
                        agent: String(message.agent ?? "host"),
                        kind: String(message.type),
                        detail: String(message.title ?? message.reason ?? ""),
                        at: new Date().toISOString(),
                    });
                    break;
                case "error":
                    this.handlers.onError(String(message.detail ?? "host error"));
                    break;
                default:
                    break;
            }
        };
        socket.onclose = () => { this.socket = null; this.handlers.onClose(); };
        socket.onerror = () => this.handlers.onError("lost the connection to the local host");
    }

    close(): void {
        this.socket?.close();
        this.socket = null;
    }

    private send(message: Record<string, unknown>): boolean {
        if (this.socket?.readyState !== WebSocket.OPEN) return false;
        this.socket.send(JSON.stringify(message));
        return true;
    }

    convene(params: { topic: string; brief: string; agents: string[]; closer: string; councilType: string }): boolean {
        return this.send({ type: "convene", ...params });
    }

    attach(code: string): boolean {
        return this.send({ type: "attach", code });
    }

    replyToPermission(id: string, allowed: boolean): boolean {
        return this.send({ type: "permission_reply", id, allowed });
    }

    stop(): boolean {
        return this.send({ type: "stop" });
    }
}

export function trimActivity(list: HostActivity[]): HostActivity[] {
    return list.length > MAX_ACTIVITY ? list.slice(list.length - MAX_ACTIVITY) : list;
}

// Cloning a repo per agent and starting three vendor CLIs is slow, and the code
// only lands once every worktree exists.
const LAUNCH_TIMEOUT_MS = 120_000;

/**
 * One council, from a caller that holds no connection. Convene is a WebSocket
 * message, so this opens a short-lived one: the host sends a state frame on
 * connect, which is both the go-ahead and the check that it is not already busy.
 */
export function launchCouncil(
    port: number,
    token: string,
    params: { topic: string; brief: string; agents: string[]; closer: string; councilType: string },
): Promise<{ code: string } | { error: string }> {
    return new Promise((settle) => {
        let asked = false;
        let done = false;
        const finish = (result: { code: string } | { error: string }) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            client.close();
            settle(result);
        };
        const timer = setTimeout(() => finish({ error: "the local host did not answer in time" }), LAUNCH_TIMEOUT_MS);
        const client = new HostClient(port, token, {
            onState: (snapshot) => {
                if (!asked) {
                    asked = true;
                    // A code on the FIRST frame is someone else's council, not
                    // the answer to a convene we have not sent yet.
                    if (snapshot.code) finish({ error: `that host is already running ${snapshot.code}` });
                    else client.convene(params);
                    return;
                }
                if (snapshot.code) finish({ code: snapshot.code });
            },
            onActivity: () => { },
            onError: (detail) => finish({ error: detail }),
            onClose: () => finish({ error: "the connection to the local host closed" }),
        });
        client.open();
    });
}
