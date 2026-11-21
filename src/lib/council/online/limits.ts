// Numbers for online councils (docs/V7_ONLINE_COUNCIL_PLAN.md, decisions D2 and D3).

export const ONLINE_POSTS_PER_ROUND = 1;
export const ONLINE_DEFAULT_ROUNDS = 4;
export const ONLINE_MIN_ROUNDS = 2;
export const ONLINE_MAX_ROUNDS = 8;
export const ONLINE_TTL_MINUTES = 60;

export const SEAT_MAX_TOKENS = 1200;
export const VERDICT_MAX_TOKENS = 1600;
export const MODERATOR_MAX_TOKENS = 400;
// Gemini and most reasoning models count thinking against the output cap, and a
// 400-token moderator call came back as one clause. The prompts' word caps bound
// the visible reply instead.
export const REASONING_HEADROOM_TOKENS = 2048;
// NIM once took about 110 s to start a reply, so a slower seat passes rather than stalls the room.
export const SEAT_CALL_TIMEOUT_MS = 90_000;
export const RETRY_DELAY_MS = 5_000;
export const FAILED_ROUNDS_TO_LEAVE = 2;

export const LEASE_SECONDS = 45;
export const LEASE_RENEW_MS = 15_000;
export const PAUSED_POLL_MS = 5_000;
// A failed tick (usually a network blip) is retried; after about a minute the
// runner stops and the resume scan picks the council up later.
export const TICK_RETRY_MS = 5_000;
export const TICK_FAILURES_TO_STOP = 12;
export const RESUME_FIRST_SCAN_MS = 15_000;
export const RESUME_SCAN_MS = 60_000;

// About 6k tokens of transcript per turn, so small-context free models still fit.
export const TRANSCRIPT_CHAR_BUDGET = 24_000;
export const SEAT_REPLY_WORDS = 220;
export const VERDICT_WORDS = 350;
export const MAX_OPEN_QUESTIONS = 5;

// Research first (docs/V7_COUNCIL_RESEARCH_PLAN.md): one search per source before
// round 1. The pack stays under MAX_BODY_CHARS (6,000) as one moderator message.
export const RESEARCH_PACK_CHARS = 5_000;
export const RESEARCH_WEB_RESULTS = 5;
export const RESEARCH_NOTES = 4;
export const RESEARCH_VAULT_PAGES = 3;
export const RESEARCH_WEB_EXCERPT_CHARS = 600;
export const RESEARCH_NOTE_EXCERPT_CHARS = 400;
export const RESEARCH_TITLE_CHARS = 120;
export const RESEARCH_QUERY_CHARS = 200;
export const RESEARCH_SOURCE_TIMEOUT_MS = 15_000;

export const ADAPTER_VERSION = "zuychin-online-1";
export const FAILED_PASS_PREFIX = "Model call failed:";
