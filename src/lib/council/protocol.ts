// Timing, caps and vocabulary for zuychin-council: only values the protocol is
// defined in terms of.

// Round-advance quorum membership: a dead seat stays nominally in the quorum
// for up to this long.
export const PARTICIPANT_STALE_SECONDS = 180;

export const POSTS_PER_ROUND = 2;
export const MAX_ROUNDS = 6;
export const MAX_MESSAGES = 60;
export const MAX_BODY_CHARS = 6_000;
export const MAX_OPEN_COUNCILS = 3;
export const SESSION_TTL_MINUTES = 90;
export const PAUSE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Read and retyped by people: no 0/O/1/I.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 4;

export const MODERATOR_NAME = "zuychin";

export type CouncilStatus = "open" | "concluding" | "awaiting_owner" | "closed" | "expired";

// How long a proposed verdict waits for the owner before it is filed as-is.
// Expiry accepts rather than discards: the verdict already exists by then, and
// throwing away finished work to tidy up is the worse failure.
export const STANDBY_TTL_SECONDS = 24 * 60 * 60;
// Rounds added when the owner sends a council back for more work.
export const CONTINUE_EXTRA_ROUNDS = 3;
export type CouncilIntent = "propose" | "challenge" | "answer" | "concede" | "refine" | "ask";
export type CouncilRole = "agent" | "moderator" | "system";

export const AGENT_INTENTS: readonly CouncilIntent[] = [
    "propose", "challenge", "answer", "concede", "refine", "ask",
];

// 'challenge' and 'ask' single out a participant; the rest may address 'all'.
export const INTENTS_REQUIRING_TARGET: readonly CouncilIntent[] = ["challenge", "ask"];
// What clears an obligation, so these must point at the seq they discharge.
export const INTENTS_REQUIRING_REPLY_TO: readonly CouncilIntent[] = ["answer", "concede", "challenge"];

// There is no sleep helper anywhere else in src/.
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function generateCouncilCode(): string {
    let out = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
        out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return `CN-${out}`;
}
