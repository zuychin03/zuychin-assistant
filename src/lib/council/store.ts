import { supabaseAdmin as supabase } from "@/lib/supabase";
import type { CouncilType } from "./templates";
import { COUNCIL_PROTOCOL_VERSION } from "./v3";
import { councilWriteIdentitySchema, type CouncilWriteIdentity } from "./write-identity";
import { CouncilSpeakProtocolError, validateSpeakMessage } from "./speak-validation";
export { CouncilSpeakProtocolError } from "./speak-validation";
import {
    AGENT_INTENTS, MAX_MESSAGES, MAX_ROUNDS, MODERATOR_NAME,
    PARTICIPANT_STALE_SECONDS, POSTS_PER_ROUND, SESSION_TTL_MINUTES, PAUSE_TTL_MS,
    CONTINUE_EXTRA_ROUNDS, STANDBY_TTL_SECONDS, generateCouncilCode,
    type CouncilIntent, type CouncilRole, type CouncilStatus,
} from "./protocol";

export type { CouncilStatus };

export interface CouncilSession {
    id: string; code: string; topic: string; brief: string; closerName: string; councilType: CouncilType;
    status: CouncilStatus; round: number; maxRounds: number; maxMessages: number;
    lastSeq: number; lastMessageAt: string; quorumAt: string | null;
    floorHolder: string | null; floorGrantedAt: string | null; floorEpoch: number;
    silentGrants: number; verdict: string | null; openQuestions: string[];
    archiveStatus: "pending" | "filed" | "failed" | "skipped";
    vaultPath: string | null; expiresAt: string; closedAt: string | null; createdAt: string;
    repoPath: string | null; baseBranch: string | null;
    protocolVersion: number; baseSha: string | null;
    pausedAt: string | null; pausedTotalSeconds: number;
    verdictProposedAt: string | null; standbyExpiresAt: string | null; continueCount: number;
}

// Exactly the columns one poll tick reads: a ~180-byte primary-key point read.
export interface CouncilTick {
    lastSeq: number; round: number; status: CouncilStatus; lastMessageAt: string;
    floorHolder: string | null; floorGrantedAt: string | null; floorEpoch: number;
    silentGrants: number; quorumAt: string | null; expiresAt: string;
    pausedAt: string | null;
}

export interface CouncilOwnerMessage {
    id: string; role: "owner" | "zuychin"; body: string;
    relayedSeq: number | null; createdAt: string;
}

export interface CouncilMessage {
    seq: number; round: number; speaker: string; role: CouncilRole;
    addressedTo: string; intent: string; replyToSeq: number | null;
    body: string; answered: boolean; createdAt: string; executionId: string | null;
}

export interface CouncilParticipant {
    name: string; kind: "agent" | "moderator"; expertise: string;
    status: "invited" | "active" | "passed" | "left";
    postsTotal: number; postsThisRound: number; cursorSeq: number;
    pendingAckSeq: number;
    expiredGrants: number; waitCalls: number; joinedSeq: number; lastSeenAt: string;
    // True when a host drives this seat's turns. Online seats are always host-driven.
    dispatchMode: boolean;
}

interface SessionRow {
    id: string; code: string; topic: string; brief: string; closer_name: string; council_type: CouncilType;
    status: CouncilStatus; round: number; max_rounds: number; max_messages: number;
    last_seq: number; last_message_at: string; quorum_at: string | null;
    floor_holder: string | null; floor_granted_at: string | null; floor_epoch: number;
    silent_grants: number; verdict: string | null; open_questions: string[] | null;
    archive_status: "pending" | "filed" | "failed" | "skipped";
    vault_path: string | null; expires_at: string; closed_at: string | null; created_at: string;
    repo_path: string | null; base_branch: string | null;
    protocol_version: number; base_sha: string | null;
    paused_at: string | null; paused_total_seconds: number;
    verdict_proposed_at: string | null; standby_expires_at: string | null; continue_count: number;
}

interface MessageRow {
    seq: number; round: number; speaker: string; role: CouncilRole;
    addressed_to: string; intent: string; reply_to_seq: number | null;
    body: string; answered: boolean; created_at: string; execution_id: string | null;
}

interface ParticipantRow {
    name: string; kind: "agent" | "moderator"; expertise: string;
    status: "invited" | "active" | "passed" | "left";
    posts_total: number; posts_this_round: number; cursor_seq: number;
    pending_ack_seq: number;
    expired_grants: number; wait_calls: number; joined_seq: number; last_seen_at: string;
    dispatch_mode: boolean;
}

const SESSION_COLUMNS =
    "id, code, topic, brief, closer_name, council_type, status, round, max_rounds, max_messages, last_seq, " +
    "last_message_at, quorum_at, floor_holder, floor_granted_at, floor_epoch, silent_grants, " +
    "verdict, open_questions, archive_status, vault_path, expires_at, closed_at, created_at, repo_path, base_branch, protocol_version, base_sha, " +
    "paused_at, paused_total_seconds, verdict_proposed_at, standby_expires_at, continue_count";

const MESSAGE_COLUMNS =
    "seq, round, speaker, role, addressed_to, intent, reply_to_seq, body, answered, created_at, execution_id";

const PARTICIPANT_COLUMNS =
    "name, kind, expertise, status, posts_total, posts_this_round, cursor_seq, " +
    "pending_ack_seq, expired_grants, wait_calls, joined_seq, last_seen_at, dispatch_mode";

function mapSession(row: SessionRow): CouncilSession {
    return {
        id: row.id,
        code: row.code,
        topic: row.topic,
        brief: row.brief,
        closerName: row.closer_name,
        councilType: row.council_type,
        status: row.status,
        round: row.round,
        maxRounds: row.max_rounds,
        maxMessages: row.max_messages,
        lastSeq: row.last_seq,
        lastMessageAt: row.last_message_at,
        quorumAt: row.quorum_at,
        floorHolder: row.floor_holder,
        floorGrantedAt: row.floor_granted_at,
        floorEpoch: row.floor_epoch,
        silentGrants: row.silent_grants,
        verdict: row.verdict,
        openQuestions: row.open_questions ?? [],
        archiveStatus: row.archive_status,
        vaultPath: row.vault_path,
        expiresAt: row.expires_at,
        closedAt: row.closed_at,
        createdAt: row.created_at,
        repoPath: row.repo_path,
        baseBranch: row.base_branch,
        protocolVersion: row.protocol_version ?? 2,
        baseSha: row.base_sha,
        pausedAt: row.paused_at,
        pausedTotalSeconds: row.paused_total_seconds ?? 0,
        verdictProposedAt: row.verdict_proposed_at,
        standbyExpiresAt: row.standby_expires_at,
        continueCount: row.continue_count ?? 0,
    };
}

function mapMessage(row: MessageRow): CouncilMessage {
    return {
        seq: row.seq,
        round: row.round,
        speaker: row.speaker,
        role: row.role,
        addressedTo: row.addressed_to,
        intent: row.intent,
        replyToSeq: row.reply_to_seq,
        body: row.body,
        answered: row.answered,
        createdAt: row.created_at,
        executionId: row.execution_id ?? null,
    };
}

function mapParticipant(row: ParticipantRow): CouncilParticipant {
    return {
        name: row.name,
        kind: row.kind,
        expertise: row.expertise,
        status: row.status,
        postsTotal: row.posts_total,
        postsThisRound: row.posts_this_round,
        cursorSeq: row.cursor_seq,
        pendingAckSeq: row.pending_ack_seq,
        expiredGrants: row.expired_grants,
        waitCalls: row.wait_calls,
        joinedSeq: row.joined_seq,
        lastSeenAt: row.last_seen_at,
        dispatchMode: row.dispatch_mode === true,
    };
}

function schemaUnavailable(message: string): boolean {
    return /does not exist|schema cache|could not find the table|could not find the function/i.test(message);
}

export class CouncilSchemaError extends Error {
    constructor() {
        super(
            "The council tables are not installed. Run the Council wave block at the bottom of " +
            "supabase-setup.sql in the Supabase SQL Editor.",
        );
        this.name = "CouncilSchemaError";
    }
}

// A swallowed council write silently corrupts a debate, so write paths throw
// while read paths degrade to empty.
function throwWrite(scope: string, err: unknown): never {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Council] ${scope} failed:`, message);
    if (schemaUnavailable(message)) throw new CouncilSchemaError();
    throw new Error("Council message could not be recorded; nothing was said.");
}

export async function createCouncilSession(params: {
    topic: string;
    brief: string;
    closerName: string;
    participants: { name: string; expertise: string }[];
    maxRounds?: number;
    maxMessages?: number;
    ttlMinutes?: number;
    userProfileId?: string;
    councilType?: CouncilType;
}): Promise<CouncilSession> {
    const ttl = params.ttlMinutes ?? SESSION_TTL_MINUTES;
    const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();

    // Retry only the code collision; anything else is a real failure.
    let row: SessionRow | null = null;
    for (let attempt = 0; attempt < 5 && !row; attempt++) {
        const { data, error } = await supabase
            .from("council_sessions")
            .insert({
                code: generateCouncilCode(),
                user_profile_id: params.userProfileId ?? null,
                topic: params.topic,
                brief: params.brief,
                closer_name: params.closerName,
                council_type: params.councilType ?? "debate",
                max_rounds: params.maxRounds ?? MAX_ROUNDS,
                max_messages: params.maxMessages ?? MAX_MESSAGES,
                expires_at: expiresAt,
                protocol_version: COUNCIL_PROTOCOL_VERSION,
            })
            .select(SESSION_COLUMNS)
            .single();
        if (!error) {
            row = data as unknown as SessionRow;
            break;
        }
        if (error.code !== "23505") throwWrite("createCouncilSession", new Error(error.message));
    }
    if (!row) throwWrite("createCouncilSession", new Error("could not allocate a unique council code"));
    const session = row;

    // joined_seq is the invite index, so floor election has a deterministic
    // tiebreak instead of every candidate sharing the default 0.
    const roster: {
        session_id: string; name: string; kind: "agent" | "moderator";
        expertise: string; joined_seq: number;
    }[] = params.participants.map((p, i) => ({
        session_id: session.id,
        name: p.name,
        kind: "agent",
        expertise: p.expertise,
        joined_seq: i + 1,
    }));
    roster.push({
        session_id: session.id,
        name: MODERATOR_NAME,
        kind: "moderator",
        expertise: "Convener and recorder. Answers procedural questions when addressed.",
        joined_seq: 0,
    });

    const { error: rosterError } = await supabase.from("council_participants").insert(roster);
    if (rosterError) throwWrite("createCouncilSession roster", new Error(rosterError.message));

    // The brief is seq 1 so every participant's first batch carries it verbatim.
    await appendMessage({
        sessionId: session.id,
        speaker: MODERATOR_NAME,
        role: "moderator",
        intent: "moderate",
        body: params.brief,
        clientKey: "mod:brief",
    });

    const refreshed = await getSessionById(session.id);
    return refreshed ?? mapSession(session);
}

// strict: a failed read throws instead of looking like a missing row. The online
// runner needs that, or one network blip reads as "council gone".
async function selectSession(column: "id" | "code", value: string, strict = false): Promise<CouncilSession | null> {
    try {
        const { data, error } = await supabase
            .from("council_sessions")
            .select(SESSION_COLUMNS)
            .eq(column, value)
            .maybeSingle();
        if (error) throw new Error(error.message);
        return data ? mapSession(data as unknown as SessionRow) : null;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[Council] getSession failed:", message);
        if (schemaUnavailable(message)) throw new CouncilSchemaError();
        if (strict) throw err;
        return null;
    }
}

export async function getSessionByCode(code: string): Promise<CouncilSession | null> {
    return selectSession("code", code.trim().toUpperCase());
}

export async function getSessionById(id: string, opts: { strict?: boolean } = {}): Promise<CouncilSession | null> {
    return selectSession("id", id, opts.strict);
}

// A single primary-key point read. Never { count: "exact", head: true }: a count
// is an aggregate over rows, last_seq is a stored value.
export async function readTick(sessionId: string): Promise<CouncilTick | null> {
    const { data, error } = await supabase
        .from("council_sessions")
        .select("last_seq, round, status, last_message_at, floor_holder, floor_granted_at, floor_epoch, silent_grants, quorum_at, expires_at, paused_at")
        .eq("id", sessionId)
        .maybeSingle();
    if (error || !data) {
        if (error) console.error("[Council] readTick failed:", error.message);
        return null;
    }
    const row = data as unknown as SessionRow;
    return {
        lastSeq: row.last_seq,
        round: row.round,
        status: row.status,
        lastMessageAt: row.last_message_at,
        floorHolder: row.floor_holder,
        floorGrantedAt: row.floor_granted_at,
        floorEpoch: row.floor_epoch,
        silentGrants: row.silent_grants,
        quorumAt: row.quorum_at,
        expiresAt: row.expires_at,
        pausedAt: row.paused_at,
    };
}

export async function joinCouncil(params: {
    sessionId: string;
    agentName: string;
    expertise?: string;
    dispatchMode?: boolean;
}): Promise<{ ok: boolean; reason?: string; live?: number }> {
    try {
        const { data, error } = await supabase.rpc("join_council", {
            p_session_id: params.sessionId,
            p_agent_name: params.agentName,
            p_expertise: params.expertise ?? "",
            // null, not false: a re-join to recover a truncated context must not
            // flip a host-owned agent back into long-polling.
            p_dispatch_mode: params.dispatchMode ?? null,
        });
        if (error) throw new Error(error.message);
        return (data ?? { ok: false, reason: "no_result" }) as { ok: boolean; reason?: string; live?: number };
    } catch (err) {
        return throwWrite("joinCouncil", err);
    }
}

export async function appendMessage(params: {
    sessionId: string;
    speaker: string;
    role?: CouncilRole;
    intent: string;
    body: string;
    clientKey: string;
    addressedTo?: string;
    replyToSeq?: number;
    ackSeq?: number;
    identity?: CouncilWriteIdentity;
    /** Online councils take one post per seat per round; everyone else keeps the protocol default. */
    postsPerRound?: number;
}): Promise<{
    ok: boolean; seq?: number; round: number; reason?: string;
    duplicate?: boolean; advanced?: boolean; posts?: number;
    cleared?: boolean; status?: CouncilStatus;
}> {
    try {
        const identity = params.identity === undefined ? undefined : councilWriteIdentitySchema.parse(params.identity);
        if ((params.role ?? "agent") === "agent" && AGENT_INTENTS.includes(params.intent as CouncilIntent)) {
            validateSpeakMessage(params, await listParticipants(params.sessionId));
        }
        const { data, error } = await supabase.rpc(identity ? "append_council_message_attributed" : "append_council_message", {
            p_session_id: params.sessionId,
            p_speaker: params.speaker,
            p_role: params.role ?? "agent",
            p_intent: params.intent,
            p_body: params.body,
            p_client_key: params.clientKey,
            p_addressed_to: params.addressedTo ?? "all",
            p_reply_to_seq: params.replyToSeq ?? null,
            p_ack_seq: params.ackSeq ?? null,
            p_posts_per_round: params.postsPerRound ?? POSTS_PER_ROUND,
            p_stale_seconds: PARTICIPANT_STALE_SECONDS,
            ...(identity ? { p_seat_token_hash: identity.tokenHash, p_expected_execution_id: identity.executionId } : {}),
        });
        if (error) throw new Error(error.message);
        return (data ?? { ok: false, reason: "no_result", round: 0 }) as {
            ok: boolean; seq?: number; round: number; reason?: string;
            duplicate?: boolean; advanced?: boolean; posts?: number;
            cleared?: boolean; status?: CouncilStatus;
        };
    } catch (err) {
        if (err instanceof CouncilSpeakProtocolError) throw err;
        return throwWrite("appendMessage", err);
    }
}

// Keeps host-driven seats inside PARTICIPANT_STALE_SECONDS between turns so the
// round quorum still counts them.
export async function markParticipantsAlive(sessionId: string, names: string[]): Promise<void> {
    if (names.length === 0) return;
    const { error } = await supabase
        .from("council_participants")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("session_id", sessionId)
        .in("name", names)
        .neq("status", "left");
    if (error) console.warn("[Council] markParticipantsAlive failed:", error.message);
}

function expiryFilter(): string {
    const now = Date.now();
    const pauseCutoff = new Date(now - PAUSE_TTL_MS).toISOString();
    return `and(paused_at.is.null,expires_at.lt.${new Date(now).toISOString()}),paused_at.lte.${pauseCutoff}`;
}

export async function pauseCouncil(sessionId: string): Promise<{ ok: boolean; already?: boolean; reason?: string }> {
    const { data, error } = await supabase.rpc("pause_council", { p_session_id: sessionId });
    if (error) throw new Error(error.message);
    return (data ?? { ok: false, reason: "no_result" }) as { ok: boolean; already?: boolean; reason?: string };
}

export async function resumeCouncil(sessionId: string): Promise<{ ok: boolean; already?: boolean; pausedSeconds?: number; reason?: string }> {
    const { data, error } = await supabase.rpc("resume_council", { p_session_id: sessionId });
    if (error) throw new Error(error.message);
    const row = (data ?? { ok: false, reason: "no_result" }) as {
        ok: boolean; already?: boolean; paused_seconds?: number; reason?: string;
    };
    return { ok: row.ok, already: row.already, pausedSeconds: row.paused_seconds, reason: row.reason };
}

// The private owner/Zuychin thread. Never joined into the transcript: agents do
// not see it, and closeCouncil does not file it.
export async function appendOwnerMessage(params: {
    sessionId: string; role: "owner" | "zuychin"; body: string; relayedSeq?: number;
}): Promise<void> {
    const { error } = await supabase.from("council_owner_messages").insert({
        session_id: params.sessionId,
        role: params.role,
        body: params.body.slice(0, 6000),
        relayed_seq: params.relayedSeq ?? null,
    });
    if (error) throw new Error(error.message);
}

export async function readOwnerThread(sessionId: string, limit = 100): Promise<CouncilOwnerMessage[]> {
    const { data, error } = await supabase
        .from("council_owner_messages")
        .select("id, role, body, relayed_seq, created_at")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true })
        .limit(limit);
    if (error) {
        console.error("[Council] readOwnerThread failed:", error.message);
        return [];
    }
    return (data ?? []).map((row) => {
        const r = row as { id: string; role: "owner" | "zuychin"; body: string; relayed_seq: number | null; created_at: string };
        return { id: r.id, role: r.role, body: r.body, relayedSeq: r.relayed_seq, createdAt: r.created_at };
    });
}

// Shrinks the round-advance quorum immediately instead of waiting out the 180s
// staleness threshold.
export async function leaveCouncil(sessionId: string, agentName: string): Promise<void> {
    const { error } = await supabase
        .from("council_participants")
        .update({ status: "left" })
        .eq("session_id", sessionId)
        .eq("name", agentName);
    if (error) console.warn("[Council] leaveCouncil failed:", error.message);
}

export async function listParticipants(sessionId: string, opts: { strict?: boolean } = {}): Promise<CouncilParticipant[]> {
    const { data, error } = await supabase
        .from("council_participants")
        .select(PARTICIPANT_COLUMNS)
        .eq("session_id", sessionId)
        .order("joined_seq", { ascending: true });
    if (error) {
        console.error("[Council] listParticipants failed:", error.message);
        if (opts.strict) throw new Error(`listParticipants failed: ${error.message}`);
        return [];
    }
    return (data as unknown as ParticipantRow[]).map(mapParticipant);
}

export async function readTranscript(params: {
    sessionId: string;
    fromSeq?: number;
    limit?: number;
    /** Throw on a failed read instead of returning an empty transcript. */
    strict?: boolean;
}): Promise<CouncilMessage[]> {
    const { data, error } = await supabase
        .from("council_messages")
        .select(MESSAGE_COLUMNS)
        .eq("session_id", params.sessionId)
        .gt("seq", params.fromSeq ?? 0)
        .order("seq", { ascending: true })
        .limit(params.limit ?? 30);
    if (error) {
        console.error("[Council] readTranscript failed:", error.message);
        if (params.strict) throw new Error(`readTranscript failed: ${error.message}`);
        return [];
    }
    return (data as unknown as MessageRow[]).map(mapMessage);
}

// The closer records a verdict; it is not final until the owner accepts.
export async function proposeVerdict(params: {
    sessionId: string;
    closer: string;
    verdict: string;
    openQuestions: string[];
    standbySeconds?: number;
}): Promise<{ changed: boolean; status?: CouncilStatus; verdict?: string; closer?: string; vaultPath?: string | null; round?: number; messages?: number }> {
    try {
        const { data, error } = await supabase.rpc("propose_council_verdict", {
            p_session_id: params.sessionId,
            p_closer: params.closer,
            p_verdict: params.verdict,
            p_open_questions: params.openQuestions,
            // Kept in the RPC for old rows; councils no longer plan work items.
            p_work_items: null,
            p_standby_seconds: params.standbySeconds ?? STANDBY_TTL_SECONDS,
        });
        if (error) throw new Error(error.message);
        return (data ?? { changed: false }) as { changed: boolean; status?: CouncilStatus };
    } catch (err) {
        return throwWrite("proposeVerdict", err);
    }
}

export async function acceptVerdict(sessionId: string): Promise<{
    changed: boolean; status?: CouncilStatus; verdict?: string; closer?: string;
    vaultPath?: string | null;
}> {
    try {
        const { data, error } = await supabase.rpc("accept_council_verdict", { p_session_id: sessionId });
        if (error) throw new Error(error.message);
        const row = (data ?? { changed: false }) as {
            changed: boolean; status?: CouncilStatus; verdict?: string; closer?: string;
            vault_path?: string | null;
        };
        return {
            changed: row.changed,
            status: row.status,
            verdict: row.verdict,
            closer: row.closer,
            vaultPath: row.vault_path ?? null,
        };
    } catch (err) {
        return throwWrite("acceptVerdict", err);
    }
}

export async function continueCouncil(params: {
    sessionId: string; extraRounds?: number;
}): Promise<{ ok: boolean; round?: number; maxRounds?: number; continueCount?: number; reason?: string }> {
    try {
        const { data, error } = await supabase.rpc("continue_council", {
            p_session_id: params.sessionId,
            p_extra_rounds: params.extraRounds ?? CONTINUE_EXTRA_ROUNDS,
        });
        if (error) throw new Error(error.message);
        const row = (data ?? { ok: false }) as {
            ok: boolean; round?: number; max_rounds?: number; continue_count?: number; reason?: string;
        };
        return { ok: row.ok, round: row.round, maxRounds: row.max_rounds, continueCount: row.continue_count, reason: row.reason };
    } catch (err) {
        return throwWrite("continueCouncil", err);
    }
}

// Standby that ran out. Accepting on expiry rather than discarding: the verdict
// is already written by this point, and binning finished work to tidy up is the
// worse of the two failures.
export async function listStandbyExpired(): Promise<CouncilSession[]> {
    const { data, error } = await supabase
        .from("council_sessions")
        .select(SESSION_COLUMNS)
        .eq("status", "awaiting_owner")
        .lt("standby_expires_at", new Date().toISOString());
    if (error) {
        console.error("[Council] listStandbyExpired failed:", error.message);
        return [];
    }
    return (data as unknown as SessionRow[]).map(mapSession);
}

export async function markArchive(params: {
    sessionId: string;
    status: "filed" | "failed" | "skipped";
    vaultPath?: string;
}): Promise<void> {
    const { error } = await supabase
        .from("council_sessions")
        .update({ archive_status: params.status, vault_path: params.vaultPath ?? null })
        .eq("id", params.sessionId);
    if (error) console.warn("[Council] markArchive failed:", error.message);
}

// Kept out of listOpenCouncils: a parked council must not count against the
// convene cap or appear in MCP open listings. No standby predicate - a council
// becomes visible here the moment its verdict is proposed, not after 24h.
export async function listAwaitingOwnerCouncils(): Promise<CouncilSession[]> {
    const { data, error } = await supabase
        .from("council_sessions")
        .select(SESSION_COLUMNS)
        .eq("status", "awaiting_owner")
        .order("verdict_proposed_at", { ascending: false });
    if (error) {
        console.error("[Council] listAwaitingOwnerCouncils failed:", error.message);
        return [];
    }
    return (data as unknown as SessionRow[]).map(mapSession);
}

export async function listOpenCouncils(): Promise<CouncilSession[]> {
    const { data, error } = await supabase
        .from("council_sessions")
        .select(SESSION_COLUMNS)
        .in("status", ["open", "concluding"])
        .order("created_at", { ascending: false });
    if (error) {
        console.error("[Council] listOpenCouncils failed:", error.message);
        return [];
    }
    return (data as unknown as SessionRow[]).map(mapSession);
}

// The four sweep queries below with only their time comparisons dropped, so
// every row any of them can return is counted here and a zero means the sweep
// has nothing to act on. Each branch must stay a superset of its query: change
// one of those predicates and this one widens with it.
//
// Status alone is not enough. A paused council with no verdict, and the legacy
// closed rows whose closed_at was never written, both sit in a sweepable status
// forever while no query can ever return them - a status-only count never
// reaches zero on this database. null is "unknown", never "idle".
const SWEEP_CANDIDATE_FILTER = [
    // expireOverdueSessions, and listSessionsNeedingVerdict's 'concluding' half.
    "status.in.(open,concluding,awaiting_owner)",
    "and(status.eq.expired,verdict.is.null,paused_at.is.null)",
    "and(status.eq.closed,archive_status.eq.failed)",
    "and(status.eq.closed,archive_status.eq.pending,closed_at.not.is.null)",
].join(",");

export async function countSweepCandidates(): Promise<number | null> {
    const { count, error } = await supabase
        .from("council_sessions")
        .select("id", { count: "exact", head: true })
        .or(SWEEP_CANDIDATE_FILTER);
    if (error) {
        console.error("[Council] countSweepCandidates failed:", error.message);
        return null;
    }
    return count ?? null;
}

// Terminal but unwritten: the sweep is the only actor when every participant is
// dead and nobody is polling to execute a transition.
//
// Age is measured by last_message_at, NOT updated_at: the updated_at trigger
// fires on every write including the sweep's own expiry update, so a session
// could never age past the grace window.
export async function listSessionsNeedingVerdict(olderThanMs: number): Promise<CouncilSession[]> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const { data, error } = await supabase
        .from("council_sessions")
        .select(SESSION_COLUMNS)
        .in("status", ["expired", "concluding"])
        .is("verdict", null)
        // A paused council is on hold, not stalled. Auto-verdicting one would
        // write over a debate the owner deliberately stopped to think about.
        .is("paused_at", null)
        .lt("last_message_at", cutoff);
    if (error) {
        console.error("[Council] listSessionsNeedingVerdict failed:", error.message);
        return [];
    }
    return (data as unknown as SessionRow[]).map(mapSession);
}

// 'failed' means filing threw and was recorded. 'pending' past the grace period
// means the process died between the verdict CAS and markArchive - or the close
// path threw before reaching it - so nothing ever recorded a failure to retry.
// Only the first was swept before, which left those councils unfiled forever.
export async function listUnfiledArchives(graceMs: number): Promise<CouncilSession[]> {
    const cutoff = new Date(Date.now() - graceMs).toISOString();
    const { data, error } = await supabase
        .from("council_sessions")
        .select(SESSION_COLUMNS)
        .eq("status", "closed")
        .or(`archive_status.eq.failed,and(archive_status.eq.pending,closed_at.lt.${cutoff})`);
    if (error) {
        console.error("[Council] listUnfiledArchives failed:", error.message);
        return [];
    }
    return (data as unknown as SessionRow[]).map(mapSession);
}

export async function expireOverdueSessions(): Promise<CouncilSession[]> {
    const { data, error } = await supabase
        .from("council_sessions")
        .update({ status: "expired" })
        .in("status", ["open", "concluding"])
        .or(expiryFilter())
        .select(SESSION_COLUMNS);
    if (error) {
        console.error("[Council] expireOverdueSessions failed:", error.message);
        return [];
    }
    return (data as unknown as SessionRow[]).map(mapSession);
}
