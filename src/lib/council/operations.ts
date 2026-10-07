import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { canOwnCouncil, canParticipateInCouncil, isCouncilOwner } from "@/lib/agents/scopes";
import { requireCouncilObserver } from "@/lib/agents/read-access";
import {
    blockWorkItem, claimNextWorkItem, completeWorkItem, getCampaignForSession, heartbeatWorkItem,
    listCampaignWorkItems, reviewWorkItem, type CouncilCampaign, type CouncilWorkItem, type CouncilWorkItemInput,
} from "@/lib/council/campaign";
import { proposeCouncilVerdict } from "@/lib/council/close";
import { requireCouncilHost, type CouncilCaller } from "@/lib/council/host-contracts";
import { MAX_BODY_CHARS, MAX_OPEN_COUNCILS, MODERATOR_NAME } from "@/lib/council/protocol";
import { renderTurn } from "@/lib/council/render";
import { councilHostService } from "@/lib/council/service";
import {
    appendMessage, createCouncilSession, getParticipant, getSessionByCode, joinCouncil, leaveCouncil,
    listOpenCouncils, listParticipants, readTranscript, type CouncilSession,
} from "@/lib/council/store";
import { getCouncilTemplate, type CouncilType } from "@/lib/council/templates";
import { promptDigest } from "@/lib/council/v3";
import { dispatchCouncil, pollCouncil } from "@/lib/council/wait";
import { getCouncilWriteIdentity } from "@/lib/council/write-identity";

// Council operations shared by every transport. Each one authorises its caller
// and enforces its rules here; a transport only parses input and renders the
// outcome, so a new transport cannot skip a rule by calling the store directly.

type Caller = AuthInfo | undefined;
type Denied = { kind: "denied"; message: string };
type UnknownSession = { kind: "unknown_session" };

const PARTICIPANT_REQUIRED = "This tool needs an owner API key or a council seat key; the key you used has neither.";

function seatIdentity(caller: Caller): { sessionId: string; seatName: string } | null {
    const id = caller?.clientId ?? "";
    const marker = "council-seat:";
    if (!id.startsWith(marker)) return null;
    // Split on the FIRST colon only: a seat name may contain one, a uuid may not.
    const rest = id.slice(marker.length);
    const idx = rest.indexOf(":");
    if (idx < 0) return null;
    return { sessionId: rest.slice(0, idx), seatName: rest.slice(idx + 1) };
}

// A seat credential binds an agent to one Council and participant name. The
// agentName argument must match it and is never the source of authority.
export function seatDenial(
    caller: Caller,
    scope: { sessionId?: string; agentName?: string; protocolVersion?: number },
): string | null {
    // Owner scope retains V2 compatibility; V3 always requires a seat.
    if (isCouncilOwner(caller?.scopes)) {
        if (scope.protocolVersion === 3) return "Council V3 requires the participant's seat credential.";
        if (scope.protocolVersion === undefined && process.env.COUNCIL_V2_ASSERTED_IDENTITY !== "true") {
            return "Agent work requires a Council seat credential.";
        }
        return null;
    }
    const seat = seatIdentity(caller);
    if (!seat) return "This tool needs a read-write API key.";
    if (caller?.extra?.councilExecutionBindingRequired === true && !caller.extra.councilExecutionId) {
        return "This seat is waiting for its execution binding.";
    }
    if (scope.sessionId && scope.sessionId !== seat.sessionId) return "That seat key belongs to a different council.";
    if (scope.agentName && scope.agentName !== seat.seatName) {
        return `That seat key is for the seat "${seat.seatName}", not "${scope.agentName}".`;
    }
    return null;
}

async function seatSession(
    caller: Caller, sessionCode: string, agentName: string,
): Promise<Denied | UnknownSession | { kind: "seat"; session: CouncilSession }> {
    if (!canParticipateInCouncil(caller?.scopes)) return { kind: "denied", message: PARTICIPANT_REQUIRED };
    const session = await getSessionByCode(sessionCode);
    if (!session) return { kind: "unknown_session" };
    const message = seatDenial(caller, { sessionId: session.id, agentName, protocolVersion: session.protocolVersion });
    return message ? { kind: "denied", message } : { kind: "seat", session };
}

// Work tools name an item rather than a Council, so only the seat name is checked
// here; the item's owner or closer is checked in SQL.
function workerDenial(caller: Caller, agentName: string): Denied | null {
    const message = canParticipateInCouncil(caller?.scopes) ? seatDenial(caller, { agentName }) : PARTICIPANT_REQUIRED;
    return message ? { kind: "denied", message } : null;
}

export async function joinAsSeat(
    params: { sessionCode: string; agentName: string; expertise?: string; dispatchMode?: boolean },
    caller: Caller,
) {
    const seat = await seatSession(caller, params.sessionCode, params.agentName);
    if (seat.kind !== "seat") return seat;
    const { session } = seat;
    const result = await joinCouncil({
        sessionId: session.id, agentName: params.agentName, expertise: params.expertise, dispatchMode: params.dispatchMode,
    });
    const roster = await listParticipants(session.id);
    if (!result.ok) return { kind: "rejected" as const, session, roster };
    const transcript = await readTranscript({ sessionId: session.id, limit: 20 });
    return { kind: "joined" as const, session, roster, transcript };
}

export async function waitAsSeat(
    params: { sessionCode: string; agentName: string; sinceSeq?: number; waitMs: number; signal?: AbortSignal },
    caller: Caller,
) {
    const seat = await seatSession(caller, params.sessionCode, params.agentName);
    if (seat.kind !== "seat") return seat;
    const { session } = seat;
    // Enforcement, not instruction: a host-dispatched agent that also polled
    // would have its cursor acked twice, once by the host and once by itself,
    // and would silently skip messages.
    const me = await getParticipant(session.id, params.agentName);
    if (me?.dispatchMode) return { kind: "dispatched" as const, session, cursor: params.sinceSeq ?? me.cursorSeq };
    const result = await pollCouncil({
        session, agentName: params.agentName, sinceSeq: params.sinceSeq, waitMs: params.waitMs, signal: params.signal,
    });
    return { kind: "polled" as const, session, result };
}

export async function speakAsSeat(
    params: {
        sessionCode: string; agentName: string; intent: string; message: string; clientKey: string;
        addressedTo?: string; replyToSeq?: number; sinceSeq?: number; waitMs: number; signal?: AbortSignal;
        onRoundAdvanced?: (sessionId: string, round: number) => void;
    },
    caller: Caller,
) {
    const seat = await seatSession(caller, params.sessionCode, params.agentName);
    if (seat.kind !== "seat") return seat;
    const { session } = seat;
    const roster = await listParticipants(session.id);
    const me = roster.find((p) => p.name === params.agentName && p.kind === "agent");
    if (!me) return { kind: "not_participant" as const, session };

    const target = params.addressedTo ?? "all";
    const post = await appendMessage({
        sessionId: session.id, speaker: params.agentName, intent: params.intent, body: params.message,
        clientKey: params.clientKey, addressedTo: target, replyToSeq: params.replyToSeq, ackSeq: params.sinceSeq,
        identity: getCouncilWriteIdentity(caller),
    });
    if (post.advanced) params.onRoundAdvanced?.(session.id, post.round);
    const receipt = {
        ...post, intent: params.intent, addressedTo: target, replyToSeq: params.replyToSeq,
        truncatedChars: params.message.length > MAX_BODY_CHARS ? params.message.length - MAX_BODY_CHARS : undefined,
    };

    // A dispatched agent posts and ends its turn; the host delivers what
    // arrives next, so no wait follows.
    if (me.dispatchMode) {
        return { kind: "dispatched" as const, session, post: receipt, cursor: params.sinceSeq ?? me.cursorSeq };
    }

    // The cursor for the block that follows is what the agent had READ, never
    // the seq it just wrote: acking its own seq would silently drop every peer
    // message below it.
    const result = await pollCouncil({
        session, agentName: params.agentName, sinceSeq: params.sinceSeq ?? undefined,
        waitMs: params.waitMs, countWait: false, signal: params.signal,
    });
    return { kind: "posted" as const, session, post: receipt, result };
}

export async function concludeAsSeat(
    params: {
        sessionCode: string; agentName: string; verdict: string; openQuestions?: string[];
        workItems?: CouncilWorkItemInput[];
    },
    caller: Caller,
) {
    const seat = await seatSession(caller, params.sessionCode, params.agentName);
    if (seat.kind !== "seat") return seat;
    const { session } = seat;
    if (params.agentName !== session.closerName) return { kind: "not_closer" as const, session };
    // The closer PROPOSES; it does not close. Nothing is filed and no campaign
    // exists until the owner accepts.
    const outcome = await proposeCouncilVerdict({
        session, closer: params.agentName, verdict: params.verdict, openQuestions: params.openQuestions ?? [],
        workItems: params.workItems?.map((item) => ({ ...item })),
    });
    return { kind: "proposed" as const, session, outcome };
}

export async function passAsSeat(
    params: { sessionCode: string; agentName: string; reason: string; done?: boolean },
    caller: Caller,
) {
    const seat = await seatSession(caller, params.sessionCode, params.agentName);
    if (seat.kind !== "seat") return seat;
    const { session } = seat;
    const me = await getParticipant(session.id, params.agentName);
    if (!me) return { kind: "not_participant" as const, session };

    // One pass per seat, round and kind: a retry returns the recorded one.
    const result = await appendMessage({
        sessionId: session.id, speaker: params.agentName, intent: "pass", body: params.reason,
        clientKey: `${params.agentName}-pass-r${session.round}-${params.done ? "done" : "round"}`,
        identity: getCouncilWriteIdentity(caller),
    });
    if (!result.ok) return { kind: "refused" as const, session, reason: result.reason };
    if (params.done) {
        await leaveCouncil(session.id, params.agentName);
        return { kind: "left" as const, session };
    }
    return { kind: "passed" as const, session, cursor: result.seq ?? session.lastSeq, advanced: result.advanced === true };
}

export async function claimWorkAsSeat(params: { sessionCode: string; agentName: string }, caller: Caller) {
    const seat = await seatSession(caller, params.sessionCode, params.agentName);
    if (seat.kind !== "seat") return seat;
    const { session } = seat;
    if (session.status !== "closed") return { kind: "not_ready" as const };
    const campaign = await getCampaignForSession(session.id);
    if (!campaign) return { kind: "no_campaign" as const };
    const item = await claimNextWorkItem(session.id, params.agentName);
    return item ? { kind: "assigned" as const, item } : { kind: "idle" as const, campaign };
}

export async function heartbeatWorkAsSeat(params: { itemId: string; agentName: string; progress?: string }, caller: Caller) {
    const denied = workerDenial(caller, params.agentName);
    if (denied) return denied;
    const ok = await heartbeatWorkItem({ itemId: params.itemId, agentName: params.agentName, progress: params.progress });
    return { kind: "done" as const, ok };
}

export async function completeWorkAsSeat(
    params: { itemId: string; agentName: string; commitHash: string; verification: string },
    caller: Caller,
) {
    const denied = workerDenial(caller, params.agentName);
    if (denied) return denied;
    const ok = await completeWorkItem({
        itemId: params.itemId, agentName: params.agentName, commitHash: params.commitHash,
        verification: params.verification, identity: getCouncilWriteIdentity(caller),
    });
    return { kind: "done" as const, ok };
}

export async function blockWorkAsSeat(params: { itemId: string; agentName: string; reason: string }, caller: Caller) {
    const denied = workerDenial(caller, params.agentName);
    if (denied) return denied;
    const ok = await blockWorkItem({ itemId: params.itemId, agentName: params.agentName, reason: params.reason });
    return { kind: "done" as const, ok };
}

export async function reviewWorkAsSeat(
    params: { itemId: string; agentName: string; accepted: boolean; note: string },
    caller: Caller,
) {
    const denied = workerDenial(caller, params.agentName);
    if (denied) return denied;
    const result = await reviewWorkItem({
        itemId: params.itemId, reviewer: params.agentName, accepted: params.accepted, note: params.note,
    });
    return { kind: "reviewed" as const, result };
}

export type ConveneRejection =
    | { reason: "participant_count"; count: number }
    | { reason: "closer_not_participant"; names: string[] }
    | { reason: "duplicate_names"; names: string[] }
    | { reason: "reserved_name"; name: string }
    | { reason: "open_limit"; open: CouncilSession[] };

// The roster is closed at convene time, so these are the only checks that stop
// a typo from creating a phantom participant or an unclosable Council.
export function conveneRejection(participants: { name: string }[], closerName: string): ConveneRejection | null {
    const names = participants.map((p) => p.name);
    if (participants.length < 2 || participants.length > 5) return { reason: "participant_count", count: participants.length };
    if (!names.includes(closerName)) return { reason: "closer_not_participant", names };
    if (new Set(names).size !== names.length) return { reason: "duplicate_names", names };
    if (names.includes(MODERATOR_NAME)) return { reason: "reserved_name", name: MODERATOR_NAME };
    return null;
}

export async function conveneCouncil(
    params: {
        topic: string; brief: string; participants: { name: string; expertise: string }[]; closerName: string;
        councilType?: CouncilType; maxRounds?: number; maxMessages?: number; ttlMinutes?: number;
        workspace?: { repoPath: string; baseBranch?: string; baseSha?: string }; requestedCode?: string;
    },
    caller: CouncilCaller | undefined,
) {
    // A guest may take part in a Council, never create one.
    if (!canOwnCouncil(caller?.scopes)) {
        return { kind: "denied" as const, message: "This tool requires an owner or Council host credential." };
    }
    if (params.requestedCode !== undefined) requireCouncilHost(caller);
    const rejection = conveneRejection(params.participants, params.closerName);
    if (rejection) return { kind: "rejected" as const, rejection };
    const open = await listOpenCouncils();
    if (open.length >= MAX_OPEN_COUNCILS) return { kind: "rejected" as const, rejection: { reason: "open_limit" as const, open } };

    const template = getCouncilTemplate(params.councilType);
    const { workspace } = params;
    const session = await createCouncilSession({
        topic: params.topic, brief: params.brief, closerName: params.closerName, participants: params.participants,
        councilType: params.councilType, requestedCode: params.requestedCode,
        maxRounds: params.maxRounds ?? template.defaults.maxRounds,
        maxMessages: params.maxMessages ?? template.defaults.maxMessages,
        ttlMinutes: params.ttlMinutes ?? template.defaults.ttlMinutes,
        workspace: workspace ? { repoPath: workspace.repoPath, baseBranch: workspace.baseBranch ?? "main", baseSha: workspace.baseSha } : undefined,
    }, caller);
    return { kind: "convened" as const, session, roster: await listParticipants(session.id) };
}

export async function prepareHostDispatch(
    params: {
        sessionCode: string; agentNames: string[]; hostId: string; leaseEpoch: number;
        ackDeliveryIds?: string[]; statusOnly?: boolean;
    },
    caller: CouncilCaller | undefined,
) {
    // The host drives other agents' turns; a guest seat drives only itself.
    requireCouncilHost(caller);
    const { sessionCode, agentNames, hostId, leaseEpoch, ackDeliveryIds, statusOnly } = params;
    if (statusOnly && ackDeliveryIds?.length) return { error: "status_only_cannot_acknowledge" };
    const session = await getSessionByCode(sessionCode);
    if (!session) return { error: "unknown_session", sessionCode };
    if (session.protocolVersion !== 3) return { error: "not_v3", sessionCode: session.code };
    if (statusOnly) {
        const participants = await listParticipants(session.id);
        return {
            statusOnly: true,
            sessionCode: session.code, topic: session.topic, status: session.status,
            pausedAt: session.pausedAt, round: session.round, maxRounds: session.maxRounds,
            lastSeq: session.lastSeq, lastMessageAt: session.lastMessageAt,
            closerName: session.closerName, verdict: session.verdict,
            openQuestions: session.openQuestions, vaultPath: session.vaultPath,
            floorHolder: session.floorHolder,
            participants: participants.map(p => ({
                name: p.name, kind: p.kind, status: p.status, postsTotal: p.postsTotal,
                cursorSeq: p.cursorSeq, dispatchMode: p.dispatchMode, lastSeenAt: p.lastSeenAt,
            })),
            agents: {},
        };
    }
    for (const deliveryId of ackDeliveryIds ?? []) {
        const ack = await councilHostService.acknowledgeDelivery({ deliveryId, hostId, leaseEpoch }, caller);
        if (!ack.ok) return { error: ack.reason ?? "ack_failed", deliveryId };
    }
    const outcome = await dispatchCouncil({ session, agentNames, durable: true });
    if (outcome.kind === "degraded") return { error: "degraded", sessionCode: session.code };
    // No agents key at all: the host must push nothing while the owner has the
    // room stopped, and an empty roster is the shape it already treats as "no
    // turns this tick".
    if (outcome.kind === "paused") {
        return {
            sessionCode: session.code, paused: true,
            pausedAt: outcome.session.pausedAt,
            status: outcome.session.status, round: outcome.session.round,
            agents: {},
        };
    }
    const { session: latest, floorHolder, view } = outcome;
    // The slice is what the host BRANCHES on; prompt is the same turn already
    // rendered, non-null exactly when there is a turn to push. Rendering here
    // keeps one copy of the agent-facing prose instead of a second one in the host.
    const overdue = view.participants
        .filter((p) => p.kind === "agent" && p.status !== "left")
        .map((p) => p.name);
    const agentEntries = await Promise.all(Object.entries(view.agents).map(async ([name, slice]) => {
        const turnDue = slice.fresh.length > 0 || slice.hasFloor;
        if (!turnDue) return [name, { ...slice, prompt: null }] as const;
        const prompt = renderTurn({
            session: latest, agentName: name, fresh: slice.fresh,
            openToYou: slice.openToYou, cursor: slice.cursor,
            omittedBefore: slice.omittedBefore, hasFloor: slice.hasFloor,
            moreRemain: slice.moreRemain,
            overdue: overdue.filter((n) => n !== name),
        });
        const prepared = await councilHostService.prepareDelivery({
            sessionId: latest.id, agentName: name, hostId, leaseEpoch,
            fromSeq: Math.max(0, view.participants.find((p) => p.name === name)?.cursorSeq ?? 0),
            throughSeq: slice.delivered, promptHash: promptDigest(prompt), promptBody: prompt,
        }, caller);
        if (!prepared.ok || !prepared.delivery) {
            throw new Error(`delivery for ${name} rejected: ${prepared.reason ?? "unknown"}`);
        }
        const delivery = prepared.delivery;
        return [name, {
            ...slice, prompt: delivery.promptBody, deliveryId: delivery.id,
            promptHash: delivery.promptHash, attempt: delivery.attempt,
            redelivered: delivery.redelivered,
        }] as const;
    }));
    return {
        sessionCode: latest.code,
        topic: latest.topic,
        status: latest.status,
        pausedAt: latest.pausedAt,
        round: latest.round,
        maxRounds: latest.maxRounds,
        lastSeq: latest.lastSeq,
        lastMessageAt: latest.lastMessageAt,
        closerName: latest.closerName,
        verdict: latest.verdict,
        openQuestions: latest.openQuestions,
        vaultPath: latest.vaultPath,
        floorHolder,
        participants: view.participants.map((p) => ({
            name: p.name, kind: p.kind, status: p.status,
            postsTotal: p.postsTotal, cursorSeq: p.cursorSeq,
            dispatchMode: p.dispatchMode, lastSeenAt: p.lastSeenAt,
        })),
        agents: Object.fromEntries(agentEntries),
    };
}

// A failed check leaves host_verified false and requeues the item, and
// resubmission does not clear it. Matching only null would strand every
// resubmitted item: never acceptable, never re-checked.
export function unverifiedWork(items: CouncilWorkItem[]) {
    return items
        .filter((i) => i.status === "awaiting_review" && i.hostVerified !== true)
        .map((i) => ({
            id: i.id, agentName: i.agentName, status: i.status,
            commitHash: i.commitHash, declaredPaths: i.declaredPaths,
            branchName: i.branchName, verificationProfile: i.verificationProfile,
            // The host scopes a seat's later task from these, not the frozen base.
            acceptedCommits: items
                .filter((o) => o.id !== i.id && o.agentName === i.agentName && o.status === "verified" && o.commitHash)
                .map((o) => o.commitHash),
        }));
}

export async function listUnverifiedWork(params: { sessionCode: string }, caller: CouncilCaller | undefined) {
    requireCouncilHost(caller);
    const session = await getSessionByCode(params.sessionCode);
    if (!session) return { error: "unknown_session" };
    const campaign = await getCampaignForSession(session.id);
    if (!campaign) return { items: [] };
    const items = unverifiedWork(await listCampaignWorkItems(campaign.id));
    return { campaignId: campaign.id, baseSha: campaign.baseSha, verificationProfile: campaign.verificationProfile, items };
}

export type SupervisionState = "review" | "active" | "idle" | "complete" | "blocked";

// What a supervising host branches on, in place of the SUPERVISE: prose that
// council_work_status writes for agents.
export type SupervisionReport =
    | { state: SupervisionState | "no_campaign" }
    | { error: "unknown_session"; sessionCode: string };

export function supervisionState(params: {
    session: CouncilSession; campaign: CouncilCampaign; items: CouncilWorkItem[]; agentName?: string;
}): SupervisionState {
    const { session, campaign, items, agentName } = params;
    if (campaign.status === "complete") return "complete";
    if (campaign.status === "blocked") return "blocked";
    if (agentName === session.closerName && items.some((item) => item.status === "awaiting_review")) return "review";
    const owned = agentName ? items.filter((item) => item.agentName === agentName) : [];
    return owned.some((item) => item.status === "queued" || item.status === "in_progress") ? "active" : "idle";
}

function observerDenial(caller: Caller, sessionId?: string): Denied | null {
    try {
        requireCouncilObserver(caller, sessionId);
        return null;
    } catch (error) {
        return { kind: "denied", message: error instanceof Error ? error.message : "unexpected error" };
    }
}

export async function superviseCampaign(params: { sessionCode: string; agentName?: string }, caller: Caller) {
    const denied = observerDenial(caller);
    if (denied) return denied;
    const session = await getSessionByCode(params.sessionCode);
    if (!session) return { kind: "unknown_session" as const };
    const seatDenied = observerDenial(caller, session.id);
    if (seatDenied) return seatDenied;
    // Distinct from idle, which an agent with nothing to do right now also
    // reports. The host releases a Council on this and must never release one
    // whose campaign is merely quiet.
    const campaign = await getCampaignForSession(session.id);
    if (!campaign) return { kind: "no_campaign" as const };
    const items = await listCampaignWorkItems(campaign.id);
    return {
        kind: "campaign" as const, campaign, items,
        state: supervisionState({ session, campaign, items, agentName: params.agentName }),
    };
}
