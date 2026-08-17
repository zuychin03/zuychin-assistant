/**
 * Council V4.1 supervision contract, version 1.
 *
 * Messages between a supervising shell and the Node council host: a launch
 * config and a stop request in, health, log and exit out. This is deliberately
 * NOT the council protocol - a supervisor never parses a delivery, a transcript
 * or a verdict, only liveness and lifecycle. CN-8PWA made that separation the
 * condition for building the shell before the V4.0 wire freeze, so keeping the
 * two vocabularies apart is load-bearing rather than tidiness.
 *
 * The channel is the child's own stdio, not a port: the supervisor already owns
 * the process handle, so a pipe needs no token, no origin check and no free
 * port, and it cannot be reached by a page that guessed a loopback address.
 *
 * Nothing here imports Node or the rest of src/. It is mirrored by fixtures in
 * fixtures/council/supervisor-v1.json so the Rust host of V4.2 can be held to
 * the same corpus.
 */

export const SUPERVISION_SCHEMA_VERSION = 1;

/** Printed at the head of every supervision line so a human tail is greppable. */
export const SUPERVISION_PREFIX = "zch";

export type HostLifecycle = "starting" | "ready" | "degraded" | "draining" | "stopping";

export type HostExitReason =
    | "requested"    // the supervisor or an operator asked for it
    | "signal"       // SIGINT/SIGTERM
    | "singleton"    // another host already owns this machine
    | "config"       // refused to start: bad launch, missing repo, bad base branch
    | "fatal";       // an unhandled error

export type HostLogLevel = "info" | "warn" | "error";

/**
 * Supervisor -> host, once, as a single JSON line on stdin before the host
 * finishes starting.
 *
 * `workspace` is a NAME from host.repos in council-agents.json, never a path.
 * That is the whole trust boundary of this message: a shell driven by a webview
 * can pick which allowlisted repo to start in, and cannot name a directory the
 * owner's own config did not nominate. Same rule the /council page already
 * follows for convene.
 */
export interface HostLaunchV1 {
    v: 1;
    type: "launch";
    workspace?: string | null;
    baseBranch?: string | null;
    autoAdopt?: boolean | null;
    /** Council code to attach to on startup, for resuming after a restart. */
    attach?: string | null;
}

/**
 * Supervisor -> host, on stdin, any time after launch.
 *
 * The fifth message CN-8PWA's four did not anticipate, and it is here for a
 * platform reason rather than a protocol one: Windows does not deliver SIGTERM,
 * so a parent that only has the process handle can kill the host but cannot ask
 * it to stop. Killing it strands the database lease and orphans every vendor
 * process the host spawned, which is exactly what V4.1 is supposed to fix.
 *
 * It carries no council content: stop is a lifecycle request, and the host still
 * decides what shutting down means.
 */
export interface HostControlV1 {
    v: 1;
    type: "stop";
    reason?: string | null;
}

export interface HostHealthV1 {
    v: 1;
    type: "health";
    at: string;
    hostVersion: string;
    hostGeneration: string;
    hostId: string;
    pid: number;
    port: number | null;
    lifecycle: HostLifecycle;
    /**
     * The one boolean a supervisor reads before restarting. True whenever
     * stopping or whenever a council or its campaign is still in flight, so a
     * shell decides "may I restart now" without inspecting council traffic.
     */
    draining: boolean;
    leaseHealthy: boolean;
    councilCode: string | null;
    agents: number;
    uptimeMs: number;
}

export interface HostLogV1 {
    v: 1;
    type: "log";
    at: string;
    level: HostLogLevel;
    message: string;
}

export interface HostExitV1 {
    v: 1;
    type: "exit";
    at: string;
    code: number;
    reason: HostExitReason;
    detail: string | null;
    /** What was in flight when it went, so the shell can say so rather than guess. */
    councilCode: string | null;
    draining: boolean;
}

export type HostSupervisionMessage = HostHealthV1 | HostLogV1 | HostExitV1;

/**
 * Denials carry a stable code as well as prose. The code is what the fixture
 * corpus and a second implementation are held to; the sentence is for the owner
 * and may be reworded freely.
 */
export type SupervisionDenial =
    | "not_json"
    | "not_object"
    | "wrong_type"
    | "unsupported_version"
    | "unknown_field"
    | "bad_workspace"
    | "bad_base_branch"
    | "bad_auto_adopt"
    | "bad_attach";

export type ParseResult<T> =
    | { ok: true; value: T }
    | { ok: false; code: SupervisionDenial; reason: string };

// A council branch name, not a git refspec: no leading dash to be read as a
// flag, no "..", no path traversal, and none of git's own reserved shapes.
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/;
// A key in host.repos. Names only - a separator or a drive letter here would
// defeat the point of resolving through the allowlist.
const WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COUNCIL_CODE = /^CN-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;

const LAUNCH_KEYS = new Set(["v", "type", "workspace", "baseBranch", "autoAdopt", "attach"]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidWorkspaceName(name: string): boolean {
    return WORKSPACE.test(name);
}

export function isValidBranchName(name: string): boolean {
    if (!BRANCH.test(name)) return false;
    if (name.includes("..") || name.includes("//")) return false;
    if (name.endsWith("/") || name.endsWith(".lock") || name.endsWith(".")) return false;
    return true;
}

/**
 * Fails closed on anything it was not written for, including an unknown key: a
 * launch is the one message that crosses into process startup, and a field this
 * version does not understand is a field it cannot honour.
 */
export function parseLaunch(raw: string): ParseResult<HostLaunchV1> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { ok: false, code: "not_json", reason: "launch is not JSON" };
    }
    if (!isRecord(parsed)) return { ok: false, code: "not_object", reason: "launch is not an object" };
    if (parsed.type !== "launch") {
        return { ok: false, code: "wrong_type", reason: `not a launch message: ${String(parsed.type)}` };
    }
    if (parsed.v !== SUPERVISION_SCHEMA_VERSION) {
        return { ok: false, code: "unsupported_version", reason: `unsupported launch version ${String(parsed.v)}` };
    }
    for (const key of Object.keys(parsed)) {
        if (!LAUNCH_KEYS.has(key)) {
            return { ok: false, code: "unknown_field", reason: `unknown launch field "${key}"` };
        }
    }

    const launch: HostLaunchV1 = { v: 1, type: "launch" };

    if (parsed.workspace !== undefined && parsed.workspace !== null) {
        if (typeof parsed.workspace !== "string" || !isValidWorkspaceName(parsed.workspace)) {
            return { ok: false, code: "bad_workspace", reason: "workspace must be a name from host.repos, not a path" };
        }
        launch.workspace = parsed.workspace;
    }
    if (parsed.baseBranch !== undefined && parsed.baseBranch !== null) {
        if (typeof parsed.baseBranch !== "string" || !isValidBranchName(parsed.baseBranch)) {
            return { ok: false, code: "bad_base_branch", reason: "baseBranch is not a valid branch name" };
        }
        launch.baseBranch = parsed.baseBranch;
    }
    if (parsed.autoAdopt !== undefined && parsed.autoAdopt !== null) {
        if (typeof parsed.autoAdopt !== "boolean") {
            return { ok: false, code: "bad_auto_adopt", reason: "autoAdopt must be a boolean" };
        }
        launch.autoAdopt = parsed.autoAdopt;
    }
    if (parsed.attach !== undefined && parsed.attach !== null) {
        if (typeof parsed.attach !== "string" || !COUNCIL_CODE.test(parsed.attach.toUpperCase())) {
            return { ok: false, code: "bad_attach", reason: "attach is not a council code" };
        }
        launch.attach = parsed.attach.toUpperCase();
    }
    return { ok: true, value: launch };
}

const CONTROL_KEYS = new Set(["v", "type", "reason"]);

/**
 * Returns null for a line that is not control at all, so a stray write to the
 * host's stdin is ignored rather than treated as a request.
 */
export function parseControl(raw: string): ParseResult<HostControlV1> | null {
    const trimmed = raw.trim();
    if (trimmed === "") return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return { ok: false, code: "not_json", reason: "control line is not JSON" };
    }
    if (!isRecord(parsed)) return { ok: false, code: "not_object", reason: "control line is not an object" };
    if (parsed.v !== SUPERVISION_SCHEMA_VERSION) {
        return { ok: false, code: "unsupported_version", reason: `unsupported control version ${String(parsed.v)}` };
    }
    if (parsed.type !== "stop") {
        return { ok: false, code: "wrong_type", reason: `unknown control type ${String(parsed.type)}` };
    }
    for (const key of Object.keys(parsed)) {
        if (!CONTROL_KEYS.has(key)) {
            return { ok: false, code: "unknown_field", reason: `unknown control field "${key}"` };
        }
    }
    const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : null;
    return { ok: true, value: { v: 1, type: "stop", reason } };
}

/** One supervision message, newline-terminated, ready to write to the pipe. */
export function formatSupervisionLine(message: HostSupervisionMessage): string {
    return `${SUPERVISION_PREFIX} ${JSON.stringify(message)}\n`;
}

/**
 * The supervisor's half. Returns null for a line that is not supervision at all
 * so a stray write to the pipe is ignored rather than treated as a fault.
 */
export function parseSupervisionLine(line: string): ParseResult<HostSupervisionMessage> | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${SUPERVISION_PREFIX} `)) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed.slice(SUPERVISION_PREFIX.length + 1));
    } catch {
        return { ok: false, code: "not_json", reason: "supervision line is not JSON" };
    }
    if (!isRecord(parsed)) return { ok: false, code: "not_object", reason: "supervision line is not an object" };
    if (parsed.v !== SUPERVISION_SCHEMA_VERSION) {
        return { ok: false, code: "unsupported_version", reason: `unsupported supervision version ${String(parsed.v)}` };
    }
    if (parsed.type !== "health" && parsed.type !== "log" && parsed.type !== "exit") {
        return { ok: false, code: "wrong_type", reason: `unknown supervision type ${String(parsed.type)}` };
    }
    return { ok: true, value: parsed as unknown as HostSupervisionMessage };
}

/**
 * Whether a supervisor may restart the host right now. One call rather than a
 * lifecycle comparison, because "ready but mid-campaign" and "draining" are the
 * same answer and a shell should not have to know why.
 */
export function safeToRestart(health: HostHealthV1): boolean {
    return !health.draining;
}
