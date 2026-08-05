import {
    MAX_BATCH_MESSAGES, MAX_WAIT_CALLS, SILENCE_GRANT_SECONDS, FLOOR_TTL_SECONDS,
    TOUCH_MS, pollIntervalMs, sleep,
} from "./protocol";
import {
    buildDispatchViews, buildView, electFloor, expireSessionIfDue, getParticipant, getSessionById,
    markParticipantsAlive, readTick, stagePendingAck, touchParticipant,
    type CouncilDispatchView, type CouncilMessage, type CouncilParticipant, type CouncilSession,
} from "./store";

// The wake problem inverted: an MCP server can never reach an idle agent, but an
// agent inside its own loop is already calling tools, so the server holds that
// call open until there is something to say. One tool call is one turn.
//
// Vercel hard-kills at maxDuration without running finally blocks, so nothing
// here may rely on cleanup: presence is judged by age on read and the floor
// grant is released by an append or by its TTL, never by this loop exiting.

const MAX_CONSECUTIVE_READ_FAILURES = 3;

// The loop returns WHY it stopped, not prose: council_speak and council_wait
// render the same outcomes under different keywords, and a result may carry
// only one status keyword.
export type WaitResult =
    | { kind: "not_participant" }
    | { kind: "budget_spent" }
    | { kind: "closed"; session: CouncilSession }
    | { kind: "concluding"; session: CouncilSession; fresh: CouncilMessage[]; omittedBefore: number | null; cursor: number }
    | { kind: "batch"; session: CouncilSession; fresh: CouncilMessage[]; openToYou: CouncilMessage[]; omittedBefore: number | null; cursor: number; hasFloor: boolean; moreRemain: boolean }
    | { kind: "floor"; session: CouncilSession; overdue: string[]; cursor: number }
    | { kind: "waiting"; session: CouncilSession; cursor: number; lastMessageAt: string; waitCalls: number }
    | { kind: "paused"; session: CouncilSession; fresh: CouncilMessage[]; omittedBefore: number | null; cursor: number }
    | { kind: "standby"; session: CouncilSession; fresh: CouncilMessage[]; omittedBefore: number | null; cursor: number }
    | { kind: "degraded"; session: CouncilSession; cursor: number };

function isFresh(grantedAt: string | null, ttlSeconds: number): boolean {
    if (!grantedAt) return false;
    return Date.now() - Date.parse(grantedAt) < ttlSeconds * 1000;
}

function overdueFrom(participants: CouncilParticipant[], me: string): string[] {
    return participants
        .filter((p) => p.kind === "agent" && p.name !== me && p.status !== "left")
        .map((p) => p.name);
}

async function drainBatch(params: {
    session: CouncilSession;
    agentName: string;
    cursor: number;
    hasFloor: boolean;
}): Promise<WaitResult> {
    const view = await buildView({
        sessionId: params.session.id, agentName: params.agentName, sinceSeq: params.cursor,
    });
    if (!view) return { kind: "degraded", session: params.session, cursor: params.cursor };

    const delivered = view.fresh.length ? view.fresh[view.fresh.length - 1].seq : params.cursor;
    // Two-phase ack: the batch lands in pending_ack_seq, and the arrival of this
    // participant's NEXT call is the proof the response reached it. Never acked
    // from a speaker's own new seq -- that would ack peers it never read.
    await touchParticipant({
        sessionId: params.session.id, agentName: params.agentName, pendingAck: delivered,
    });

    if (view.session.status === "concluding" || view.session.status === "expired") {
        return {
            kind: "concluding", session: view.session, fresh: view.fresh,
            omittedBefore: view.omittedBefore, cursor: delivered,
        };
    }
    return {
        kind: "batch", session: view.session, fresh: view.fresh, openToYou: view.openToYou,
        omittedBefore: view.omittedBefore, cursor: delivered, hasFloor: params.hasFloor,
        moreRemain: view.fresh.length >= MAX_BATCH_MESSAGES,
    };
}

/**
 * Blocks until something worth reporting happens or the wall-clock deadline
 * passes. The deadline is the PRIMARY exit: mcp-handler registers res.on("close")
 * only on the /sse branches, so a hung-up client does not abort this handler and
 * extra.signal is a best-effort early bail at most.
 */
export async function pollCouncil(params: {
    session: CouncilSession;
    agentName: string;
    sinceSeq?: number;
    waitMs: number;
    countWait?: boolean;
    signal?: AbortSignal;
}): Promise<WaitResult> {
    const { session, agentName, waitMs } = params;
    const sessionId = session.id;

    const alive = await touchParticipant({
        sessionId, agentName, countWait: params.countWait ?? true,
    });
    if (!alive) return { kind: "not_participant" };

    const me = await getParticipant(sessionId, agentName);
    if (me && me.waitCalls >= MAX_WAIT_CALLS) return { kind: "budget_spent" };

    // effective = sinceSeq ?? cursor_seq: the agent's claim wins when present,
    // otherwise resume from what the server recorded as acknowledged.
    const cursor = params.sinceSeq ?? me?.cursorSeq ?? 0;
    const waitCalls = me ? me.waitCalls + 1 : 1;

    const started = Date.now();
    const deadline = started + waitMs;
    let lastTouch = started;
    let failures = 0;
    let latest = session;
    let paused = false;

    for (;;) {
        const tick = await readTick(sessionId);

        if (!tick) {
            failures++;
            // One bad read of ~12 must not abort the window into something the
            // agent may read as terminal.
            if (failures >= MAX_CONSECUTIVE_READ_FAILURES) {
                return { kind: "degraded", session: latest, cursor };
            }
        } else {
            failures = 0;
            latest = { ...latest, round: tick.round, status: tick.status, lastSeq: tick.lastSeq, lastMessageAt: tick.lastMessageAt, pausedAt: tick.pausedAt };
            paused = tick.pausedAt !== null;

            if (tick.status === "closed") {
                return { kind: "closed", session: (await getSessionById(sessionId)) ?? latest };
            }

            // Two ways to be held: the owner stopped the room, or the closer
            // proposed a verdict and the owner has not ruled. Both deliver what
            // was posted - the relay and the standby notice travel this path -
            // and neither grants a turn or elects a floor.
            const held = paused ? "paused" as const
                : tick.status === "awaiting_owner" ? "standby" as const
                    : null;
            if (held) {
                if (tick.lastSeq > cursor) {
                    const view = await buildView({ sessionId, agentName, sinceSeq: cursor });
                    if (view) {
                        const delivered = view.fresh.length ? view.fresh[view.fresh.length - 1].seq : cursor;
                        await touchParticipant({ sessionId, agentName, pendingAck: delivered });
                        return {
                            kind: held, session: latest, fresh: view.fresh,
                            omittedBefore: view.omittedBefore, cursor: delivered,
                        };
                    }
                }
                if (Date.now() >= deadline || params.signal?.aborted) break;
                await sleep(pollIntervalMs(Date.now() - started));
                if (Date.now() - lastTouch >= TOUCH_MS) {
                    await touchParticipant({ sessionId, agentName });
                    lastTouch = Date.now();
                }
                continue;
            }

            if (Date.parse(tick.expiresAt) <= Date.now()) {
                await expireSessionIfDue(sessionId);
                return {
                    kind: "concluding", session: (await getSessionById(sessionId)) ?? latest,
                    fresh: [], omittedBefore: null, cursor,
                };
            }

            // The batch is always drained TOGETHER with any floor grant, never
            // instead of it: telling an agent to speak while its cursor is
            // behind makes it argue points it has not read.
            if (tick.lastSeq > cursor) {
                return drainBatch({
                    session: latest, agentName, cursor, hasFloor: tick.floorHolder === agentName,
                });
            }

            if (tick.floorHolder === agentName && isFresh(tick.floorGrantedAt, FLOOR_TTL_SECONDS)) {
                const view = await buildView({ sessionId, agentName, sinceSeq: cursor });
                return {
                    kind: "floor", session: latest,
                    overdue: overdueFrom(view?.participants ?? [], agentName), cursor,
                };
            }

            // Client-side prefilter only; elect_council_floor re-verifies the
            // silence against now() and the (epoch, last_seq) it was given.
            const silentMs = Date.now() - Date.parse(tick.lastMessageAt);
            const grantable = tick.quorumAt !== null && !isFresh(tick.floorGrantedAt, FLOOR_TTL_SECONDS);
            if (grantable && silentMs >= SILENCE_GRANT_SECONDS * 1000) {
                // Whoever ticks first grants on everyone's behalf; the caller
                // need not be the winner and reads the grant on its next tick.
                await electFloor({ sessionId, epoch: tick.floorEpoch, lastSeq: tick.lastSeq });
            }
        }

        if (Date.now() >= deadline || params.signal?.aborted) break;

        await sleep(pollIntervalMs(Date.now() - started));

        // Refreshed from INSIDE the loop, not at its edges: a 30s window would
        // otherwise make a healthy waiter look dead for 30s at a time.
        if (Date.now() - lastTouch >= TOUCH_MS) {
            await touchParticipant({ sessionId, agentName });
            lastTouch = Date.now();
        }
    }

    if (paused || latest.status === "awaiting_owner") {
        return {
            kind: paused ? "paused" : "standby",
            session: latest, fresh: [], omittedBefore: null, cursor,
        };
    }
    return { kind: "waiting", session: latest, cursor, lastMessageAt: latest.lastMessageAt, waitCalls };
}

export type DispatchResult =
    | { kind: "degraded" }
    | { kind: "paused"; session: CouncilSession }
    | { kind: "ok"; session: CouncilSession; floorHolder: string | null; view: CouncilDispatchView };

/**
 * The host's counterpart to pollCouncil: one tick, one optional election, one
 * batch per owned agent, then return. Never blocks and never spends waitCalls.
 * Authority stays server-side; the host computes no floor of its own.
 */
export async function dispatchCouncil(params: {
    session: CouncilSession;
    agentNames: string[];
    ackFor?: string[];
}): Promise<DispatchResult> {
    const sessionId = params.session.id;
    const tick = await readTick(sessionId);
    if (!tick) return { kind: "degraded" };

    // No turns while the owner has the room stopped. Presence is still refreshed:
    // these agents have not gone anywhere, and dropping them from the election
    // would punish them for a pause they did not cause.
    if (tick.pausedAt || tick.status === "awaiting_owner") {
        await markParticipantsAlive(sessionId, params.agentNames);
        return { kind: "paused", session: (await getSessionById(sessionId)) ?? params.session };
    }

    if (Date.parse(tick.expiresAt) <= Date.now()) await expireSessionIfDue(sessionId);

    // An expired grant is not a grant: the same freshness test pollCouncil
    // applies before it tells an agent the floor is its.
    let floorHolder = isFresh(tick.floorGrantedAt, FLOOR_TTL_SECONDS) ? tick.floorHolder : null;
    const silentMs = Date.now() - Date.parse(tick.lastMessageAt);
    if (floorHolder === null && tick.quorumAt !== null && silentMs >= SILENCE_GRANT_SECONDS * 1000) {
        // Whoever ticks first grants on everyone's behalf, host or agent.
        const elected = await electFloor({ sessionId, epoch: tick.floorEpoch, lastSeq: tick.lastSeq });
        if (elected.granted && elected.holder) floorHolder = elected.holder;
    }

    // The host confirming the PREVIOUS batch reached its agent. This is the only
    // thing that advances a dispatched agent's cursor.
    for (const name of params.ackFor ?? []) {
        await touchParticipant({ sessionId, agentName: name, countWait: false });
    }
    // Presence for agents that never call a council tool between turns; the host
    // being alive is what keeps them in the election.
    await markParticipantsAlive(sessionId, params.agentNames);

    const session = (await getSessionById(sessionId)) ?? params.session;
    const view = await buildDispatchViews({ session, agentNames: params.agentNames, floorHolder });

    for (const [name, slice] of Object.entries(view.agents)) {
        if (slice.fresh.length === 0) continue;
        const me = view.participants.find((p) => p.name === name);
        await stagePendingAck({
            sessionId, agentName: name, delivered: slice.delivered, current: me?.pendingAckSeq ?? 0,
        });
    }

    return { kind: "ok", session, floorHolder, view };
}
