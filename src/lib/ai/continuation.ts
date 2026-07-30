// A turn the provider cut short is resumed rather than discarded: the partial
// is fed back, each pass gets a fresh window, and the pieces are stitched into
// one answer. Providers differ only in how the cut shows up - a gateway timeout
// or finish_reason "length" on the OpenAI-compatible side, a MAX_TOKENS stop on
// Gemini - so detection stays with each caller and the rest lives here.

export const MAX_CONTINUATIONS = 3;
// Bounded to stay inside the 300s route limit.
export const CONTINUATION_BUDGET_MS = 200_000;

const OVERLAP_WINDOW = 240;
const MIN_OVERLAP = 24;

export const CONTINUE_PROMPT =
    "Your previous message was cut off by a provider limit. Continue it from exactly where it stopped, in the same voice and formatting. Do not repeat, restate or summarise what you already wrote, and do not apologise or add a preamble; if it stopped mid-sentence, resume mid-sentence.";

export const ANSWER_NOW_PROMPT =
    "Your previous attempt was cut off by a provider limit while you were still reasoning, so none of the answer survived. Write the final answer now, directly, without further deliberation.";

export const TRUNCATION_NOTE = "\n\n_[Cut short by the provider's response limit.]_";

export interface Segment {
    text: string;
    /** Whitespace the trim removed, which marks a word boundary at the seam. */
    spaceBefore: boolean;
    spaceAfter: boolean;
}

export function segmentText(raw: string): Segment {
    return { text: raw.trim(), spaceBefore: /^\s/.test(raw), spaceAfter: /\s$/.test(raw) };
}

// Asked to continue, models often restate their last sentence first. Drop the
// longest suffix of what we already have that the continuation repeats. The
// remainder keeps its leading whitespace, which marks the seam for the join.
export function trimOverlap(prev: string, next: string): { text: string; spliced: boolean } {
    const tail = prev.slice(-OVERLAP_WINDOW);
    for (let len = Math.min(tail.length, next.length); len >= MIN_OVERLAP; len--) {
        if (next.startsWith(tail.slice(-len))) return { text: next.slice(len), spliced: true };
    }
    return { text: next, spliced: false };
}

// Characters that glue to whatever follows or precedes them, so a seam landing
// beside one takes no space: markdown markers, brackets, hyphens, closers.
const BINDS_RIGHT = /[-([{/@#$~_*`"'\\<]$/;
const BINDS_LEFT = /^[.,!?:;)\]}%*`"'\\>/]/;

// A resumed turn rarely marks its own seam: tokenizers hang the leading space on
// the following token, so a clean word boundary shows whitespace on neither
// side. `spaced` carries the boundary when one side did record it. Otherwise a
// space is assumed. Neither guess is safe - a cut lands mid-word often enough to
// matter (observed: "sixteen" cut to "six") - but roughly three boundaries in
// four fall between words, so assuming a space is wrong least often.
export function joinContinuation(prev: string, next: string, spaced: boolean): string {
    if (!next) return prev;
    if (/\s$/.test(prev) || /^\s/.test(next)) return prev + next;
    if (!spaced && (BINDS_RIGHT.test(prev) || BINDS_LEFT.test(next))) return prev + next;
    return prev + " " + next;
}

/** Appends one continuation to what is already assembled. */
export function appendPiece(text: string, raw: string): { text: string; empty: boolean } {
    const piece = segmentText(raw);
    if (!piece.text) return { text, empty: true };
    const cut = trimOverlap(text, piece.text);
    const spaced = cut.spliced ? /^\s/.test(cut.text) : piece.spaceBefore;
    return { text: joinContinuation(text, cut.text, spaced), empty: false };
}

/**
 * Drives the resume loop for callers whose continuation is a single plain
 * request. `generate` returns the next slice and whether it was cut short too;
 * throwing ends the loop with what survived.
 */
export async function resumeTruncated(opts: {
    initial: string;
    label: string;
    generate: (soFar: string) => Promise<{ text: string; truncated: boolean }>;
    onText?: (text: string) => void;
    /** Lower where the resume competes with the caller's own time budget. */
    maxAttempts?: number;
}): Promise<string> {
    let text = opts.initial;
    const limit = opts.maxAttempts ?? MAX_CONTINUATIONS;
    const startedAt = Date.now();

    for (let attempt = 0; attempt < limit; attempt++) {
        if (Date.now() - startedAt > CONTINUATION_BUDGET_MS) break;

        let next: { text: string; truncated: boolean };
        try {
            next = await opts.generate(text);
        } catch (err) {
            console.error(`[${opts.label}] continuation ${attempt + 1} failed:`, err);
            break;
        }

        const joined = appendPiece(text, next.text);
        if (joined.empty) break;
        text = joined.text;
        opts.onText?.(text);
        if (!next.truncated) return text;
    }

    return text ? text + TRUNCATION_NOTE : text;
}
