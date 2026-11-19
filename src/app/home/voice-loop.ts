import type { AgentEvent } from "@/lib/ai/agent/events";

// A turn that finishes this soon after its first tool call needs no filler.
export const FILLER_DELAY_MS = 700;
// A reply never waits longer than this for a filler that is already playing.
export const FILLER_MAX_WAIT_MS = 4000;

// The warm-up shows only when the on-box transcriber is not ready this soon, so a warm start never flashes it.
export const WARMUP_REVEAL_MS = 400;
export const WARMUP_POLL_MS = 600;
// Transcription waits for its model anyway, so the mic opens after this even if it is still loading.
export const WARMUP_MAX_MS = 15_000;

// Spoken while a voice turn waits on tools or agents, so the wait is not silent.
export const VOICE_FILLERS = [
    "Just a minute.",
    "One moment.",
    "Give me a second.",
    "Let me check.",
    "Hang on a moment.",
    "Bear with me a second.",
    "Let me look into that.",
    "On it, just a minute.",
] as const;

export function pickFiller(previous?: string, random: () => number = Math.random): string {
    const pool = VOICE_FILLERS.filter((phrase) => phrase !== previous);
    return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

/** True when the turn has started tool or agent work, as opposed to only writing its reply. */
export function startsWork(event: AgentEvent): boolean {
    switch (event.type) {
        case "run":
        case "status":
        case "plan":
            return true;
        case "tool":
        case "subagent":
            return event.phase === "start";
        default:
            return false;
    }
}

// Plain English because browser recognition and the on-box model both mishear "Zuychin".
export const STOP_PHRASE = "That's enough, thank you";
const STOP_PATTERN = /\bthat(?:['’]?s|\s+is)\s+enough[\s,.!]*thank(?:\s*you|s)\b/i;

export function hasStopPhrase(transcript: string): boolean {
    return STOP_PATTERN.test(transcript);
}
