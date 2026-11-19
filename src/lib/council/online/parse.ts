import { AGENT_INTENTS, MAX_BODY_CHARS, type CouncilIntent } from "@/lib/council/protocol";
import type { CouncilMessage } from "@/lib/council/store";
import { MAX_OPEN_QUESTIONS } from "./limits";

export interface SeatReply {
    intent: CouncilIntent;
    addressedTo: string;
    replyToSeq: number | null;
    message: string;
    repairs: string[];
}

export interface ReplyContext {
    seat: string;
    /** Every seat name, including this one. */
    seats: readonly string[];
    /** Agent messages in the transcript, for challenge targets. */
    messages: readonly CouncilMessage[];
    /** Open challenges and asks this seat may answer or concede. */
    openToYou: readonly CouncilMessage[];
    blind: boolean;
}

function stripFences(raw: string): string {
    return raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

/** The first JSON object in the text, trying the longest candidate first. */
export function firstJsonObject(raw: string): Record<string, unknown> | null {
    const text = stripFences(raw);
    const start = text.indexOf("{");
    if (start < 0) return null;
    for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
        try {
            const value: unknown = JSON.parse(text.slice(start, end + 1));
            if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
        } catch { /* try a shorter candidate */ }
    }
    return null;
}

const TRUNCATION_MARK = /\s*_\[Cut short by the provider's response limit\.\]_\s*$/;

function decodeJsonString(chunk: string): string {
    const safe = chunk.replace(/\\$/, "").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    try {
        return JSON.parse(`"${safe}"`) as string;
    } catch {
        return chunk.replace(/\\n/g, "\n").replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
    }
}

/**
 * String values of `field` from broken JSON. A reply cut by the token cap ends
 * inside a string, and a continuation can restart the object mid-string, so a
 * value also ends where a new `{"intent"` begins.
 */
export function salvageStrings(raw: string, field: string): string[] {
    const text = raw.replace(TRUNCATION_MARK, "");
    const found: string[] = [];
    const re = new RegExp(`"${field}"\\s*:\\s*"`, "g");
    for (let m = re.exec(text); m; m = re.exec(text)) {
        let i = re.lastIndex;
        let chunk = "";
        while (i < text.length) {
            const ch = text[i];
            if (ch === "\\" && i + 1 < text.length) { chunk += ch + text[i + 1]; i += 2; continue; }
            if (ch === "\"" || (ch === "{" && /^\{\s*"intent"\s*:/.test(text.slice(i, i + 20)))) break;
            chunk += ch;
            i++;
        }
        re.lastIndex = i;
        const value = decodeJsonString(chunk).trim();
        if (value) found.push(value);
    }
    return found;
}

/** Joins salvaged pieces; a piece that restarts the first one replaces it. */
function joinPieces(pieces: string[]): string {
    const head = pieces[0]?.slice(0, 60) ?? "";
    if (head && pieces.slice(1).some((p) => p.startsWith(head))) return pieces.reduce((a, b) => (b.length > a.length ? b : a));
    return pieces.join(" ");
}

function salvageReply(raw: string): Record<string, unknown> | null {
    const message = joinPieces(salvageStrings(raw, "message"));
    if (!message) return null;
    const seq = /"replyToSeq"\s*:\s*(\d+)/.exec(raw);
    return {
        intent: salvageStrings(raw, "intent")[0], addressedTo: salvageStrings(raw, "addressedTo")[0],
        replyToSeq: seq ? Number(seq[1]) : null, message,
    };
}

function asSeq(value: unknown): number | null {
    const n = typeof value === "string" && value.trim() ? Number(value) : value;
    return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Repairs instead of retrying: free models drift from the format, and a second
 * call costs more than a slightly downgraded intent.
 */
export function parseSeatReply(raw: string, ctx: ReplyContext): SeatReply | null {
    const repairs: string[] = [];
    let json = firstJsonObject(raw);
    const fallbackIntent: CouncilIntent = ctx.blind ? "propose" : "refine";
    if (!json) {
        json = salvageReply(raw);
        if (json) repairs.push("rebuilt from broken JSON");
    }
    if (!json) {
        const message = stripFences(raw).slice(0, MAX_BODY_CHARS).trim();
        return message ? { intent: fallbackIntent, addressedTo: "all", replyToSeq: null, message, repairs: ["no JSON object"] } : null;
    }

    const text = [json.message, json.content, json.text].find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const message = text ? text.trim().slice(0, MAX_BODY_CHARS) : "";
    if (!message) return null;

    let intent = typeof json.intent === "string" ? json.intent.trim().toLowerCase() as CouncilIntent : fallbackIntent;
    if (!AGENT_INTENTS.includes(intent)) {
        repairs.push(`unknown intent "${String(json.intent)}"`);
        intent = fallbackIntent;
    }

    const rawTarget = typeof json.addressedTo === "string" ? json.addressedTo.trim() : "all";
    let addressedTo = rawTarget.toLowerCase() === "all" ? "all"
        : ctx.seats.find((name) => name.toLowerCase() === rawTarget.toLowerCase()) ?? "all";
    if (addressedTo === ctx.seat) addressedTo = "all";
    if (addressedTo === "all" && rawTarget.toLowerCase() !== "all") repairs.push(`target "${rawTarget}" is not another seat`);

    let replyToSeq = asSeq(json.replyToSeq);

    if (ctx.blind) {
        if (intent !== "propose" || addressedTo !== "all" || replyToSeq !== null) repairs.push("opening forced to propose to all");
        return { intent: "propose", addressedTo: "all", replyToSeq: null, message, repairs };
    }

    const agentSeqs = new Map(ctx.messages.filter((m) => m.role === "agent").map((m) => [m.seq, m]));
    if (intent === "challenge" || intent === "ask") {
        if (addressedTo === "all") {
            repairs.push(`${intent} without a seat to address`);
            intent = "refine";
        }
    }
    if (intent === "challenge") {
        const disputed = replyToSeq !== null ? agentSeqs.get(replyToSeq) : undefined;
        if (!disputed || disputed.speaker === ctx.seat) {
            const latest = [...agentSeqs.values()].reverse().find((m) => m.speaker === addressedTo);
            if (latest) {
                repairs.push("challenge pointed at the target's latest message");
                replyToSeq = latest.seq;
            } else {
                repairs.push("challenge with nothing to dispute");
                intent = "refine";
            }
        }
    }
    if (intent === "answer" || intent === "concede") {
        const open = new Set(ctx.openToYou.map((m) => m.seq));
        if (replyToSeq === null || !open.has(replyToSeq)) {
            if (ctx.openToYou.length === 1) {
                repairs.push(`${intent} pointed at the only open obligation`);
                replyToSeq = ctx.openToYou[0].seq;
            } else {
                repairs.push(`${intent} without a valid open obligation`);
                intent = "refine";
                replyToSeq = null;
            }
        }
    }
    if ((intent === "propose" || intent === "refine" || intent === "ask") && replyToSeq !== null && !agentSeqs.has(replyToSeq)) {
        repairs.push(`replyToSeq ${replyToSeq} is not in the transcript`);
        replyToSeq = null;
    }
    return { intent, addressedTo, replyToSeq, message, repairs };
}

export interface VerdictReply {
    verdict: string;
    openQuestions: string[];
}

export function parseVerdict(raw: string): VerdictReply | null {
    const json = firstJsonObject(raw);
    if (!json) {
        const salvaged = joinPieces(salvageStrings(raw, "verdict"));
        const verdict = salvaged || stripFences(raw).trim();
        return verdict ? { verdict, openQuestions: [] } : null;
    }
    const verdict = typeof json.verdict === "string" ? json.verdict.trim() : "";
    if (!verdict) return null;
    const openQuestions = Array.isArray(json.openQuestions)
        ? json.openQuestions.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
            .map((q) => q.trim().slice(0, 300)).slice(0, MAX_OPEN_QUESTIONS)
        : [];
    return { verdict, openQuestions };
}
