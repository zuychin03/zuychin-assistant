// Timing, caps and vocabulary for zuychin-council. Agent-facing prose lives in
// render.ts; this file is only values the protocol is defined in terms of.

// The binding constraint is the CLIENT, not the platform: MCP clients default to
// a 60s per-tool-call timeout (SDK DEFAULT_REQUEST_TIMEOUT_MSEC). Tripping it is
// strictly worse than a short window, because the agent sees a tool *error*
// rather than an empty result and typically abandons the loop entirely.
export const WAIT_DEFAULT_MS = 30_000;
export const WAIT_MAX_MS = 45_000;

// Immediate read at t=0 catches the very common case where the agent that just
// posted enters the wait while a peer's message is already committed.
export const POLL_FAST_MS = 1_500;
export const POLL_FAST_UNTIL_MS = 6_000;
export const POLL_SLOW_MS = 3_000;
// Desynchronises waiters that would otherwise poll the session row in lockstep.
export const POLL_JITTER_MS = 400;

export const TOUCH_MS = 10_000;
export const KEEPALIVE_MS = 15_000;

// Fastest interval that cannot fire while a peer is mid-post (one round trip
// plus lock hold is sub-second).
export const SILENCE_GRANT_SECONDS = 8;
// Above WAIT_MAX_MS so a grant issued the instant a window closed survives until
// that agent's next window opens, and no higher: N expiries cost N x TTL of dead
// air.
export const FLOOR_TTL_SECONDS = 50;
export const WAITER_FRESH_SECONDS = 30;
// Round-advance quorum membership. A dead agent stays nominally in the quorum
// for up to this long; council_pass({done:true}) is the cooperative shortcut.
export const PARTICIPANT_STALE_SECONDS = 180;

export const POSTS_PER_ROUND = 2;
export const MAX_ROUNDS = 6;
export const MAX_MESSAGES = 60;
export const MAX_WAIT_CALLS = 40;
export const MAX_BODY_CHARS = 6_000;
export const MAX_BATCH_MESSAGES = 20;
export const MAX_BATCH_CHARS = 12_000;
export const MAX_OPEN_COUNCILS = 3;
export const SESSION_TTL_MINUTES = 90;

// Retyped by the human into several terminals: no 0/O/1/I.
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 4;

export const MODERATOR_NAME = "zuychin";

// Co-working mode. The council orders who SPEAKS and never touches file access:
// no tool, column or message field names a path, and the anti-injection rule
// stops an agent acting on a peer's division of labour. So agents sharing one
// checkout would still overwrite each other. The answer is isolation, not
// locking - a worktree and branch per agent, merged by the human at the end.
export const WORKTREE_BRANCH_PREFIX = "council";

export function agentSlug(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

export function councilBranch(code: string, agentName: string): string {
    return `${WORKTREE_BRANCH_PREFIX}/${code.toLowerCase()}/${agentSlug(agentName)}`;
}

// Relative so git resolves it against the repo root, which keeps the rendered
// command identical on Windows and POSIX.
export function councilWorktreeDir(repoPath: string, agentName: string): string {
    const base = repoPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "repo";
    return `../${base}-${agentSlug(agentName)}`;
}

export type CouncilStatus = "open" | "concluding" | "closed" | "expired";
export type CouncilIntent = "propose" | "challenge" | "answer" | "concede" | "refine" | "ask";
export type CouncilRole = "agent" | "moderator" | "system";

// Every council tool result opens with exactly one of these.
export type CouncilStatusKeyword =
    | "YOUR_TURN"
    | "WAITING"
    | "POSTED"
    | "NOT_YOUR_TURN"
    | "COUNCIL_CONCLUDING"
    | "COUNCIL_CLOSED";

export const AGENT_INTENTS: readonly CouncilIntent[] = [
    "propose", "challenge", "answer", "concede", "refine", "ask",
];

// 'challenge' and 'ask' single out a participant; the rest may address 'all'.
export const INTENTS_REQUIRING_TARGET: readonly CouncilIntent[] = ["challenge", "ask"];
// What clears an obligation, so these must point at the seq they discharge.
export const INTENTS_REQUIRING_REPLY_TO: readonly CouncilIntent[] = ["answer", "concede", "challenge"];

// There is no sleep helper anywhere else in src/.
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function clampWaitMs(seconds: number | undefined): number {
    if (seconds === undefined) return WAIT_DEFAULT_MS;
    return Math.min(Math.max(seconds, 0) * 1000, WAIT_MAX_MS);
}

// Jittered so concurrent waiters drift apart instead of hammering the session
// row on the same schedule.
export function pollIntervalMs(elapsedMs: number): number {
    const base = elapsedMs < POLL_FAST_UNTIL_MS ? POLL_FAST_MS : POLL_SLOW_MS;
    return base + Math.floor(Math.random() * POLL_JITTER_MS);
}

export function generateCouncilCode(): string {
    let out = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
        out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return `CN-${out}`;
}
