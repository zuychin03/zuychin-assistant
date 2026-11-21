import { randomUUID } from "node:crypto";
import type { ResolvedChat } from "@/lib/ai/providers";
import { MODERATOR_NAME } from "@/lib/council/protocol";
import type { CouncilMessage, CouncilParticipant, CouncilSession } from "@/lib/council/store";
import {
    FAILED_PASS_PREFIX, FAILED_ROUNDS_TO_LEAVE, LEASE_RENEW_MS, MODERATOR_MAX_TOKENS, ONLINE_POSTS_PER_ROUND,
    PAUSED_POLL_MS, TICK_FAILURES_TO_STOP, TICK_RETRY_MS, RETRY_DELAY_MS, SEAT_MAX_TOKENS, VERDICT_MAX_TOKENS,
} from "./limits";
import { parseSeatReply, parseVerdict, type SeatReply } from "./parse";
import { seatPrompt, verdictPrompt, type SeatView } from "./prompt";
import { RESEARCH_CLIENT_KEY, citedSourcesFooter, findResearchPack, parsePackSources, researchClasses, type ResearchPack } from "./research";
import { seatRefusal } from "./seats";
import type { SeatCaller } from "./call";
import type { SeatModel } from "./store";

// Drives one online council: a server-side Council host whose seats are chat
// models. Every decision is read back from the database each tick, so a
// restarted process picks up exactly where the last one stopped.

export interface AppendInput {
    sessionId: string; speaker: string; intent: string; body: string; clientKey: string;
    addressedTo?: string; replyToSeq?: number; ackSeq?: number;
    identity?: { tokenHash: string; executionId: string | null };
    postsPerRound?: number;
}
export interface AppendOutcome {
    ok: boolean; seq?: number; round: number; reason?: string; advanced?: boolean; status?: string; duplicate?: boolean;
}

export interface OnlineDeps {
    getSession(sessionId: string): Promise<CouncilSession | null>;
    listParticipants(sessionId: string): Promise<CouncilParticipant[]>;
    readTranscript(sessionId: string): Promise<CouncilMessage[]>;
    append(input: AppendInput): Promise<AppendOutcome>;
    /** A message from the moderator seat, such as the research pack; no seat identity. */
    postModerator(sessionId: string, body: string, clientKey: string): Promise<{ ok: boolean; reason?: string }>;
    join(sessionId: string, name: string): Promise<void>;
    leave(sessionId: string, name: string): Promise<void>;
    markAlive(sessionId: string, names: string[]): Promise<void>;
    claimLease(sessionId: string, hostId: string): Promise<{ ok: boolean; leaseEpoch?: number; reason?: string }>;
    renewLease(sessionId: string, hostId: string, epoch: number): Promise<boolean>;
    releaseLease(sessionId: string, hostId: string, epoch: number): Promise<void>;
    /** Issues a bound host seat key and returns only its hash; the token never leaves the process. */
    issueSeat(sessionId: string, seatName: string, hostId: string, epoch: number): Promise<{ ok: true; tokenHash: string } | { ok: false; reason: string }>;
    startExecution(params: {
        sessionId: string; seatName: string; hostId: string; epoch: number; tokenHash: string;
        resolved: ResolvedChat; source: string;
    }): Promise<{ ok: boolean; executionId?: string; reason?: string }>;
    stopExecution(executionId: string, hostId: string, epoch: number, reason: string): Promise<void>;
    seatModels(sessionId: string): Promise<Map<string, SeatModel>>;
    propose(session: CouncilSession, verdict: string, openQuestions: string[]): Promise<boolean>;
    moderate(sessionId: string, round: number, generate: (prompt: string) => Promise<string>): Promise<void>;
    moderatorModel(freeOnly: boolean): ResolvedChat | null;
    freeOnly(): Promise<boolean>;
    resolve(modelKey: string): ResolvedChat | null;
    call: SeatCaller;
    sleep(ms: number): Promise<void>;
    log(message: string): void;
    /** Lease renewal interval; tests shorten it. */
    renewMs?: number;
}

export interface SeatRuntime {
    name: string;
    expertise: string;
    modelKey: string;
    source: string;
    tokenHash: string | null;
    executionId: string | null;
}

export interface OnlineRun {
    sessionId: string;
    hostId: string;
    epoch: number;
    seats: SeatRuntime[];
    lost: boolean;
    abort: AbortController;
}

export type RunOutcome = "proposed" | "awaiting_owner" | "closed" | "gone" | "lease_held" | "lease_lost" | "not_online" | "setup_failed";

const LIVE_STATUSES = new Set(["invited", "active", "passed"]);

export function processHostId(): string {
    const g = globalThis as { __zuychinOnlineHostId?: string };
    g.__zuychinOnlineHostId ??= randomUUID();
    return g.__zuychinOnlineHostId;
}

/** Round r starts at seat (r - 1) mod n, so nobody always opens. */
export function turnOrder<T>(seats: readonly T[], round: number): T[] {
    if (seats.length === 0) return [];
    const start = (Math.max(1, round) - 1) % seats.length;
    return [...seats.slice(start), ...seats.slice(0, start)];
}

/** Failed passes at the end of this seat's own history, so the count survives a restart. */
export function consecutiveFailedRounds(messages: readonly CouncilMessage[], seat: string): number {
    const mine = messages.filter((m) => m.role === "agent" && m.speaker === seat);
    let count = 0;
    for (let i = mine.length - 1; i >= 0; i--) {
        if (mine[i].intent === "pass" && mine[i].body.startsWith(FAILED_PASS_PREFIX)) count++;
        else break;
    }
    return count;
}

export function openObligations(messages: readonly CouncilMessage[], seat: string): CouncilMessage[] {
    return messages.filter((m) => m.role === "agent" && !m.answered && (m.intent === "challenge" || m.intent === "ask")
        && m.addressedTo === seat && m.speaker !== seat);
}

function seatViews(run: OnlineRun): SeatView[] {
    return run.seats.map((s) => ({ name: s.name, expertise: s.expertise }));
}

function liveSeats(run: OnlineRun, participants: readonly CouncilParticipant[]): SeatRuntime[] {
    const status = new Map(participants.filter((p) => p.kind === "agent").map((p) => [p.name, p]));
    return run.seats.filter((s) => {
        const p = status.get(s.name);
        return p !== undefined && LIVE_STATUSES.has(p.status);
    });
}

async function callWithRetry(
    deps: OnlineDeps, run: OnlineRun, params: Parameters<SeatCaller>[0],
    accept: (text: string) => boolean,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    let error = "no attempt";
    for (let attempt = 1; attempt <= 2; attempt++) {
        if (run.lost) return { ok: false, error: "lease lost" };
        const result = await deps.call({ ...params, signal: run.abort.signal });
        if (result.ok && accept(result.text)) return { ok: true, text: result.text };
        const retryable = result.ok ? true : result.retryable;
        error = result.ok ? "reply had no usable message" : result.error;
        if (!retryable || attempt === 2) break;
        await deps.sleep(RETRY_DELAY_MS);
    }
    return { ok: false, error };
}

/** Bound seat keys and managed_api executions for any seat that lacks them under this lease. */
export async function prepareSeats(run: OnlineRun, deps: OnlineDeps, seats: readonly SeatRuntime[] = run.seats): Promise<string | null> {
    for (const seat of seats) {
        if (seat.tokenHash && seat.executionId) continue;
        const resolved = deps.resolve(seat.modelKey);
        if (!resolved) return `${seat.name}: ${seat.modelKey} is no longer in the selectable list`;
        const key = await deps.issueSeat(run.sessionId, seat.name, run.hostId, run.epoch);
        if (!key.ok) return `${seat.name}: seat key refused (${key.reason})`;
        const started = await deps.startExecution({
            sessionId: run.sessionId, seatName: seat.name, hostId: run.hostId, epoch: run.epoch,
            tokenHash: key.tokenHash, resolved, source: seat.source,
        });
        if (!started.ok || !started.executionId) return `${seat.name}: execution refused (${started.reason ?? "unknown"})`;
        seat.tokenHash = key.tokenHash;
        seat.executionId = started.executionId;
    }
    return null;
}

const REPOSTABLE = new Set(["not_addressed_to_you", "already_answered", "no_such_seq", "not_an_obligation"]);

async function post(run: OnlineRun, deps: OnlineDeps, seat: SeatRuntime, session: CouncilSession, reply: SeatReply, ackSeq: number): Promise<AppendOutcome> {
    const base = {
        sessionId: run.sessionId, speaker: seat.name, clientKey: `online:${seat.name}:r${session.round}`, ackSeq,
        identity: { tokenHash: seat.tokenHash!, executionId: seat.executionId }, postsPerRound: ONLINE_POSTS_PER_ROUND,
    };
    try {
        const first = await deps.append({
            ...base, intent: reply.intent, body: reply.message,
            addressedTo: reply.addressedTo, replyToSeq: reply.replyToSeq ?? undefined,
        });
        if (first.ok || !REPOSTABLE.has(first.reason ?? "")) return first;
        deps.log(`${seat.name}: ${first.reason}, posted as refine instead`);
    } catch (error) {
        // A protocol error here means the repair missed a case; nothing was recorded.
        deps.log(`${seat.name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}, posted as refine instead`);
    }
    return deps.append({ ...base, intent: "refine", body: reply.message, addressedTo: "all" });
}

async function takeTurn(
    run: OnlineRun, deps: OnlineDeps, session: CouncilSession, seat: SeatRuntime,
    messages: readonly CouncilMessage[], blind: boolean, freeOnly: boolean,
): Promise<AppendOutcome | null> {
    const resolved = deps.resolve(seat.modelKey);
    // A paid seat only exists because Allow paid was ticked, so only Free only can refuse it now.
    let failure = seatRefusal(seat.modelKey, resolved, { freeOnly, allowPaid: true });
    let reply: SeatReply | null = null;
    const openToYou = openObligations(messages, seat.name);
    const ctx = { seat: seat.name, seats: run.seats.map((s) => s.name), messages, openToYou, blind };
    if (!failure && resolved) {
        const prompt = seatPrompt({ session, seat: { name: seat.name, expertise: seat.expertise }, seats: seatViews(run), messages, openToYou, blind });
        const result = await callWithRetry(deps, run, {
            resolved, system: prompt.system, user: prompt.user, maxTokens: SEAT_MAX_TOKENS, freeOnly, classes: researchClasses(messages),
        }, (text) => parseSeatReply(text, ctx) !== null);
        if (result.ok) reply = parseSeatReply(result.text, ctx);
        else failure = result.error;
    }
    if (run.lost) return null;
    const ackSeq = messages.length ? messages[messages.length - 1].seq : 0;
    if (reply) {
        if (reply.repairs.length) deps.log(`${seat.name} r${session.round}: repaired (${reply.repairs.join("; ")})`);
        return post(run, deps, seat, session, reply, ackSeq);
    }

    const leaving = consecutiveFailedRounds(messages, seat.name) + 1 >= FAILED_ROUNDS_TO_LEAVE;
    deps.log(`${seat.name} r${session.round}: failed (${failure})${leaving ? ", leaving" : ", passing"}`);
    const passed = await deps.append({
        sessionId: run.sessionId, speaker: seat.name, intent: "pass",
        body: `${FAILED_PASS_PREFIX} ${failure}. ${leaving ? "Leaving the council after two failed rounds in a row." : "Passing this round."}`,
        clientKey: `online:${seat.name}:r${session.round}:pass`, ackSeq,
        identity: { tokenHash: seat.tokenHash!, executionId: seat.executionId }, postsPerRound: ONLINE_POSTS_PER_ROUND,
    });
    if (leaving) await deps.leave(run.sessionId, seat.name);
    return passed;
}

async function moderate(run: OnlineRun, deps: OnlineDeps, round: number, freeOnly: boolean): Promise<void> {
    const resolved = deps.moderatorModel(freeOnly);
    if (!resolved) return;
    await deps.moderate(run.sessionId, round, async (prompt) => {
        const result = await deps.call({ resolved, system: "You moderate a debate between AI models. Follow the instructions exactly.", user: prompt, maxTokens: MODERATOR_MAX_TOKENS, freeOnly, signal: run.abort.signal });
        return result.ok ? result.text : "";
    });
}

async function conclude(run: OnlineRun, deps: OnlineDeps, session: CouncilSession, participants: readonly CouncilParticipant[], freeOnly: boolean): Promise<void> {
    const messages = await deps.readTranscript(run.sessionId);
    const left = new Set(participants.filter((p) => p.status === "left").map((p) => p.name));
    const closer = run.seats.find((s) => s.name === session.closerName);
    const others = run.seats.filter((s) => s.name !== session.closerName && !left.has(s.name));
    const writers = [...(closer && !left.has(closer.name) ? [closer] : []), ...others].slice(0, 2);
    const sources = parsePackSources(findResearchPack(messages)?.body);
    const classes = researchClasses(messages);
    const reasons: string[] = [];
    for (const writer of writers) {
        const resolved = deps.resolve(writer.modelKey);
        const refusal = seatRefusal(writer.modelKey, resolved, { freeOnly, allowPaid: true });
        if (refusal || !resolved) {
            reasons.push(`${writer.name}: ${refusal}`);
            continue;
        }
        const standInFor = writer.name === session.closerName ? undefined : session.closerName;
        const prompt = verdictPrompt({ session, writer: { name: writer.name, expertise: writer.expertise }, seats: seatViews(run), messages, standInFor });
        const result = await callWithRetry(deps, run, {
            resolved, system: prompt.system, user: prompt.user, maxTokens: VERDICT_MAX_TOKENS, freeOnly, classes,
        }, (text) => parseVerdict(text) !== null);
        if (run.lost) return;
        const parsed = result.ok ? parseVerdict(result.text) : null;
        if (!parsed) {
            reasons.push(`${writer.name}: ${result.ok ? "no verdict in the reply" : result.error}`);
            continue;
        }
        const cited = parsed.verdict + citedSourcesFooter(parsed.verdict, sources);
        const verdict = standInFor ? `*${standInFor} could not write the verdict, so ${writer.name} wrote it.*\n\n${cited}` : cited;
        await deps.propose(session, verdict, parsed.openQuestions);
        return;
    }
    const speakers = new Set(messages.filter((m) => m.role === "agent").map((m) => m.speaker));
    await deps.propose(session, `No seat could write the verdict (${reasons.join("; ") || "no seat left"}). `
        + `${speakers.size} seat(s) exchanged ${messages.filter((m) => m.role === "agent").length} messages on "${session.topic}". `
        + "Read the transcript before relying on anything here.", []);
}

/** The tick loop. Returns why it stopped; the lease is released on the way out unless another host took it. */
export async function driveOnlineCouncil(run: OnlineRun, deps: OnlineDeps): Promise<RunOutcome> {
    // Seats waiting through a slow turn must stay inside the 180 s quorum window,
    // or the round advances without them. A retried 90 s call alone is 185 s.
    const renew = setInterval(() => {
        void deps.renewLease(run.sessionId, run.hostId, run.epoch).then((ok) => {
            if (!ok && !run.lost) {
                run.lost = true;
                run.abort.abort();
                deps.log(`${run.sessionId}: host lease lost`);
            }
        }).catch(() => undefined);
        if (!run.lost) void deps.markAlive(run.sessionId, run.seats.map((s) => s.name)).catch(() => undefined);
    }, deps.renewMs ?? LEASE_RENEW_MS);
    const tick = async (): Promise<RunOutcome | null> => {
        const session = await deps.getSession(run.sessionId);
        if (!session) return "gone";
        // An expired pause is a closed council, as everywhere else in the protocol.
        if (session.status === "closed" || (session.status === "expired" && session.pausedAt)) return "closed";
        if (session.status === "awaiting_owner") return "awaiting_owner";
        if (session.pausedAt) {
            await deps.sleep(PAUSED_POLL_MS);
            return null;
        }
        const participants = await deps.listParticipants(run.sessionId);
        const live = liveSeats(run, participants);
        const freeOnly = await deps.freeOnly();
        const overdue = Date.parse(session.expiresAt) <= Date.now();
        if (session.status !== "open" || overdue || live.length < 2) {
            await conclude(run, deps, session, participants, freeOnly);
            if (run.lost) return "lease_lost";
            return "proposed";
        }
        // A model removed from the list while the council ran (or before a restart) never posts again.
        const removed = live.filter((s) => !deps.resolve(s.modelKey));
        if (removed.length) {
            for (const seat of removed) {
                deps.log(`${session.code}: ${seat.name} left, ${seat.modelKey} is no longer in the selectable list`);
                await deps.leave(run.sessionId, seat.name);
            }
            return null;
        }
        await deps.markAlive(run.sessionId, run.seats.map((s) => s.name));
        const setup = await prepareSeats(run, deps, live);
        if (setup) {
            deps.log(`${session.code}: ${setup}`);
            return "setup_failed";
        }

        const posted = new Map(participants.map((p) => [p.name, p.postsThisRound]));
        const pending = live.filter((s) => (posted.get(s.name) ?? 0) < ONLINE_POSTS_PER_ROUND);
        if (pending.length === 0) {
            // Only a stale quorum gets here; markAlive above lets the next post advance it.
            await deps.sleep(1_000);
            return null;
        }
        const messages = await deps.readTranscript(run.sessionId);
        const blind = session.round === 1;
        const turns = blind ? pending : turnOrder(live, session.round).filter((s) => pending.includes(s)).slice(0, 1);
        const results = await Promise.all(turns.map((seat) => takeTurn(run, deps, session, seat, messages, blind, freeOnly)));
        const advanced = results.find((r) => r?.ok && r.advanced);
        if (advanced && advanced.status !== "concluding") await moderate(run, deps, advanced.round, freeOnly);
        return null;
    };
    let failures = 0;
    try {
        for (;;) {
            if (run.lost) return "lease_lost";
            let outcome: RunOutcome | null;
            try {
                outcome = await tick();
                failures = 0;
            } catch (error) {
                if (run.lost) return "lease_lost";
                const message = error instanceof Error ? error.message : String(error);
                if (++failures >= TICK_FAILURES_TO_STOP) {
                    deps.log(`${run.sessionId}: stopping after ${failures} failed ticks (${message})`);
                    throw error;
                }
                deps.log(`${run.sessionId}: tick failed (${message}), retrying`);
                await deps.sleep(TICK_RETRY_MS);
                continue;
            }
            if (outcome) return outcome;
        }
    } finally {
        clearInterval(renew);
        if (!run.lost) {
            for (const seat of run.seats) {
                if (seat.executionId) await deps.stopExecution(seat.executionId, run.hostId, run.epoch, "online council paused for the owner or ended").catch(() => undefined);
                seat.tokenHash = null;
                seat.executionId = null;
            }
            await deps.releaseLease(run.sessionId, run.hostId, run.epoch).catch(() => undefined);
        }
    }
}

/** Takes the lease and rebuilds seats from their execution records, for a council this process did not start. */
export async function acquireOnlineRun(sessionId: string, deps: OnlineDeps, hostId = processHostId()): Promise<OnlineRun | RunOutcome> {
    const [participants, models] = await Promise.all([deps.listParticipants(sessionId), deps.seatModels(sessionId)]);
    const agents = participants.filter((p) => p.kind === "agent" && p.name !== MODERATOR_NAME);
    if (agents.length === 0 || agents.some((p) => !models.has(p.name))) return "not_online";
    const lease = await deps.claimLease(sessionId, hostId);
    if (!lease.ok || !lease.leaseEpoch) return "lease_held";
    return {
        sessionId, hostId, epoch: lease.leaseEpoch, lost: false, abort: new AbortController(),
        seats: agents.map((p) => {
            const model = models.get(p.name)!;
            return { name: p.name, expertise: p.expertise, modelKey: model.modelKey, source: model.source, tokenHash: null, executionId: null };
        }),
    };
}

/**
 * Posts the research pack before round 1. A council still runs when this fails,
 * so the failure comes back as a warning rather than an error.
 */
export async function postResearchPack(sessionId: string, pack: ResearchPack, deps: Pick<OnlineDeps, "postModerator" | "log">): Promise<string | null> {
    if (!pack.body) return null;
    try {
        const posted = await deps.postModerator(sessionId, pack.body, RESEARCH_CLIENT_KEY);
        if (posted.ok) return null;
        deps.log(`${sessionId}: research pack refused (${posted.reason ?? "unknown"})`);
        return `The sources could not be posted (${posted.reason ?? "unknown"}), so the council runs without them.`;
    } catch (error) {
        deps.log(`${sessionId}: research pack failed (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
        return "The sources could not be posted, so the council runs without them.";
    }
}
