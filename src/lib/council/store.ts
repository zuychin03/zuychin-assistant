import { supabaseAdmin as supabase } from "@/lib/supabase";
import type { CouncilType } from "./templates";
import {
    MAX_BATCH_CHARS, MAX_BATCH_MESSAGES, MAX_MESSAGES, MAX_ROUNDS, MODERATOR_NAME,
    PARTICIPANT_STALE_SECONDS, POSTS_PER_ROUND, SESSION_TTL_MINUTES,
    SILENCE_GRANT_SECONDS, FLOOR_TTL_SECONDS, WAITER_FRESH_SECONDS,
    CODE_ALPHABET, CONTINUE_EXTRA_ROUNDS, STANDBY_TTL_SECONDS, generateCouncilCode,
    type CouncilRole, type CouncilStatus, type CouncilStatusKeyword,
} from "./protocol";

export type { CouncilStatus, CouncilStatusKeyword };

export interface CouncilSession {
    id: string; code: string; topic: string; brief: string; closerName: string; councilType: CouncilType;
    status: CouncilStatus; round: number; maxRounds: number; maxMessages: number;
    lastSeq: number; lastMessageAt: string; quorumAt: string | null;
    floorHolder: string | null; floorGrantedAt: string | null; floorEpoch: number;
    silentGrants: number; verdict: string | null; openQuestions: string[];
    archiveStatus: "pending" | "filed" | "failed" | "skipped";
    vaultPath: string | null; expiresAt: string; closedAt: string | null; createdAt: string;
    repoPath: string | null; baseBranch: string | null;
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
    body: string; answered: boolean; createdAt: string;
}

export interface CouncilParticipant {
    name: string; kind: "agent" | "moderator"; expertise: string;
    status: "invited" | "active" | "passed" | "left";
    postsTotal: number; postsThisRound: number; cursorSeq: number;
    pendingAckSeq: number;
    expiredGrants: number; waitCalls: number; joinedSeq: number; lastSeenAt: string;
    // True when council-host.mts owns this agent's turns over ACP. Such an agent
    // must never also long-poll, or the host's ack advances its cursor past
    // messages it never read.
    dispatchMode: boolean;
}

// Everything render.ts needs, assembled once per tool call.
export interface CouncilView {
    session: CouncilSession; participants: CouncilParticipant[]; you: CouncilParticipant | null;
    fresh: CouncilMessage[]; openToYou: CouncilMessage[];
    cursor: number; omittedBefore: number | null; keyword: CouncilStatusKeyword;
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
    paused_at: string | null; paused_total_seconds: number;
    verdict_proposed_at: string | null; standby_expires_at: string | null; continue_count: number;
}

interface MessageRow {
    seq: number; round: number; speaker: string; role: CouncilRole;
    addressed_to: string; intent: string; reply_to_seq: number | null;
    body: string; answered: boolean; created_at: string;
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
    "verdict, open_questions, archive_status, vault_path, expires_at, closed_at, created_at, repo_path, base_branch, " +
    "paused_at, paused_total_seconds, verdict_proposed_at, standby_expires_at, continue_count";

const MESSAGE_COLUMNS =
    "seq, round, speaker, role, addressed_to, intent, reply_to_seq, body, answered, created_at";

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
    workspace?: { repoPath: string; baseBranch: string };
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
                repo_path: params.workspace?.repoPath ?? null,
                base_branch: params.workspace?.baseBranch ?? null,
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

async function selectSession(column: "id" | "code", value: string): Promise<CouncilSession | null> {
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
        return null;
    }
}

export async function getSessionByCode(code: string): Promise<CouncilSession | null> {
    return selectSession("code", code.trim().toUpperCase());
}

export async function getSessionById(id: string): Promise<CouncilSession | null> {
    return selectSession("id", id);
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
}): Promise<{
    ok: boolean; seq?: number; round: number; reason?: string;
    duplicate?: boolean; advanced?: boolean; posts?: number;
    cleared?: boolean; status?: CouncilStatus;
}> {
    try {
        const { data, error } = await supabase.rpc("append_council_message", {
            p_session_id: params.sessionId,
            p_speaker: params.speaker,
            p_role: params.role ?? "agent",
            p_intent: params.intent,
            p_body: params.body,
            p_client_key: params.clientKey,
            p_addressed_to: params.addressedTo ?? "all",
            p_reply_to_seq: params.replyToSeq ?? null,
            p_ack_seq: params.ackSeq ?? null,
            p_posts_per_round: POSTS_PER_ROUND,
            p_stale_seconds: PARTICIPANT_STALE_SECONDS,
        });
        if (error) throw new Error(error.message);
        return (data ?? { ok: false, reason: "no_result", round: 0 }) as {
            ok: boolean; seq?: number; round: number; reason?: string;
            duplicate?: boolean; advanced?: boolean; posts?: number;
            cleared?: boolean; status?: CouncilStatus;
        };
    } catch (err) {
        return throwWrite("appendMessage", err);
    }
}

// Checked BEFORE the conclude CAS. create_council_campaign raises on a bad work
// plan, and the campaign is created after the verdict commits, so without this
// an invalid plan leaves a durable verdict with no transcript and no notice.
export async function validateWorkItems(params: {
    sessionId: string;
    createdBy: string;
    workItems: { agentName: string; title: string; instructions: string; acceptanceCriteria: string[] }[];
}): Promise<string | null> {
    const { data, error } = await supabase.rpc("validate_council_work_items", {
        p_session_id: params.sessionId,
        p_created_by: params.createdBy,
        p_work_items: params.workItems.map((item) => ({
            agent_name: item.agentName,
            title: item.title,
            instructions: item.instructions,
            acceptance_criteria: item.acceptanceCriteria,
        })),
    });
    if (error) throw new Error(error.message);
    return (data as string | null) ?? null;
}

// Best-effort: presence is judged by age on read, so a missed touch costs
// nothing until it compounds.
export async function touchParticipant(params: {
    sessionId: string;
    agentName: string;
    pendingAck?: number;
    countWait?: boolean;
}): Promise<boolean> {
    try {
        const { data, error } = await supabase.rpc("touch_council_participant", {
            p_session_id: params.sessionId,
            p_agent_name: params.agentName,
            p_pending_ack: params.pendingAck ?? null,
            p_count_wait: params.countWait ?? false,
        });
        if (error) throw new Error(error.message);
        return data === true;
    } catch (err) {
        console.warn("[Council] touchParticipant failed:", err);
        return true;
    }
}

// Keeps host-owned agents inside WAITER_FRESH_SECONDS between turns. Not
// touch_council_participant: that promotes pending_ack_seq into cursor_seq, and
// a dispatched agent's delivery is proven by the host's ack, not by a tick.
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

// Stages what the host is about to deliver. Monotonic in JS because PostgREST
// cannot express greatest(col, val); the owning host is the only writer.
export async function stagePendingAck(params: {
    sessionId: string;
    agentName: string;
    delivered: number;
    current: number;
}): Promise<void> {
    const next = Math.max(params.current, params.delivered);
    if (next === params.current) return;
    const { error } = await supabase
        .from("council_participants")
        .update({ pending_ack_seq: next, last_seen_at: new Date().toISOString() })
        .eq("session_id", params.sessionId)
        .eq("name", params.agentName);
    if (error) console.warn("[Council] stagePendingAck failed:", error.message);
}

export async function electFloor(params: {
    sessionId: string;
    epoch: number;
    lastSeq: number;
}): Promise<{ granted: boolean; holder?: string; reason?: string }> {
    try {
        const { data, error } = await supabase.rpc("elect_council_floor", {
            p_session_id: params.sessionId,
            p_expected_epoch: params.epoch,
            p_expected_last_seq: params.lastSeq,
            p_silence_seconds: SILENCE_GRANT_SECONDS,
            p_floor_ttl_seconds: FLOOR_TTL_SECONDS,
            p_waiter_fresh_seconds: WAITER_FRESH_SECONDS,
        });
        if (error) throw new Error(error.message);
        return (data ?? { granted: false, reason: "no_result" }) as { granted: boolean; holder?: string; reason?: string };
    } catch (err) {
        console.warn("[Council] electFloor failed:", err);
        return { granted: false, reason: "error" };
    }
}

export async function getParticipant(sessionId: string, name: string): Promise<CouncilParticipant | null> {
    const { data, error } = await supabase
        .from("council_participants")
        .select(PARTICIPANT_COLUMNS)
        .eq("session_id", sessionId)
        .eq("name", name)
        .maybeSingle();
    if (error || !data) return null;
    return mapParticipant(data as unknown as ParticipantRow);
}

// Best-effort, and issued only when the transition actually applies: an
// unconditional per-window UPDATE would fire the updated_at trigger and take a
// row-exclusive lock on the one hot row the entire poll reads.
// is("paused_at", null) on every expiry path: a paused council is waiting on a
// human, not on its agents. resume_council adds the paused span back to
// expires_at, so the deadline it is eventually judged against is unchanged.
export async function expireSessionIfDue(sessionId: string): Promise<void> {
    const { error } = await supabase
        .from("council_sessions")
        .update({ status: "expired" })
        .eq("id", sessionId)
        .in("status", ["open", "concluding"])
        .is("paused_at", null)
        .lt("expires_at", new Date().toISOString());
    if (error) console.warn("[Council] expireSessionIfDue failed:", error.message);
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

export async function listParticipants(sessionId: string): Promise<CouncilParticipant[]> {
    const { data, error } = await supabase
        .from("council_participants")
        .select(PARTICIPANT_COLUMNS)
        .eq("session_id", sessionId)
        .order("joined_seq", { ascending: true });
    if (error) {
        console.error("[Council] listParticipants failed:", error.message);
        return [];
    }
    return (data as unknown as ParticipantRow[]).map(mapParticipant);
}

export async function readTranscript(params: {
    sessionId: string;
    fromSeq?: number;
    limit?: number;
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
        return [];
    }
    return (data as unknown as MessageRow[]).map(mapMessage);
}

// Obligations are machine-computed, never inferred by the agent: a challenge or
// ask aimed at you stays open until you reply to that seq with answer/concede.
async function readOpenToYou(sessionId: string, agentName: string): Promise<CouncilMessage[]> {
    const { data, error } = await supabase
        .from("council_messages")
        .select(MESSAGE_COLUMNS)
        .eq("session_id", sessionId)
        .eq("addressed_to", agentName)
        .eq("answered", false)
        .in("intent", ["challenge", "ask"])
        .order("seq", { ascending: true })
        .limit(10);
    if (error) {
        console.error("[Council] readOpenToYou failed:", error.message);
        return [];
    }
    return (data as unknown as MessageRow[]).map(mapMessage);
}

function baseKeyword(session: CouncilSession, you: CouncilParticipant | null): CouncilStatusKeyword {
    if (session.status === "closed") return "COUNCIL_CLOSED";
    if (session.status === "concluding" || session.status === "expired") return "COUNCIL_CONCLUDING";
    if (you && session.floorHolder === you.name) return "YOUR_TURN";
    return "WAITING";
}

// On overflow the OLDEST are dropped and replaced with a pointer: bodies are
// rendered in full because truncating a peer's argument degrades the debate.
function trimBatch(batch: CouncilMessage[]): { fresh: CouncilMessage[]; omittedBefore: number | null } {
    let fresh = batch;
    let omittedBefore: number | null = null;
    let chars = fresh.reduce((n, m) => n + m.body.length, 0);
    while (fresh.length > 1 && chars > MAX_BATCH_CHARS) {
        const dropped = fresh[0];
        chars -= dropped.body.length;
        fresh = fresh.slice(1);
        omittedBefore = dropped.seq;
    }
    return { fresh, omittedBefore };
}

export async function buildView(params: {
    sessionId: string;
    agentName: string;
    sinceSeq?: number;
}): Promise<CouncilView | null> {
    const session = await getSessionById(params.sessionId);
    if (!session) return null;

    const participants = await listParticipants(params.sessionId);
    const you = participants.find((p) => p.name === params.agentName) ?? null;

    // effective = sinceSeq ?? cursor_seq. The agent's claim wins when present;
    // otherwise resume from what the server recorded as acknowledged.
    const cursor = params.sinceSeq ?? you?.cursorSeq ?? 0;

    const { fresh, omittedBefore } = trimBatch(await readTranscript({
        sessionId: params.sessionId,
        fromSeq: cursor,
        limit: MAX_BATCH_MESSAGES,
    }));

    return {
        session,
        participants,
        you,
        fresh,
        openToYou: you ? await readOpenToYou(params.sessionId, params.agentName) : [],
        cursor,
        omittedBefore,
        keyword: baseKeyword(session, you),
    };
}

/** One host-owned agent's slice of a council_dispatch payload. */
export interface CouncilDispatchSlice {
    fresh: CouncilMessage[];
    openToYou: CouncilMessage[];
    cursor: number;
    /** Highest seq in this slice: what the host acknowledges once delivered. */
    delivered: number;
    omittedBefore: number | null;
    hasFloor: boolean;
    moreRemain: boolean;
    status: CouncilParticipant["status"];
    dispatchMode: boolean;
}

export interface CouncilDispatchView {
    session: CouncilSession;
    participants: CouncilParticipant[];
    agents: Record<string, CouncilDispatchSlice>;
}

// buildView per agent would re-read the session and the roster once per agent.
// The host asks about every agent it owns on the same 1.5s tick, so those two
// reads happen once and only the per-agent transcript slice is repeated.
export async function buildDispatchViews(params: {
    session: CouncilSession;
    agentNames: string[];
    floorHolder: string | null;
}): Promise<CouncilDispatchView> {
    const participants = await listParticipants(params.session.id);
    const agents: Record<string, CouncilDispatchSlice> = {};

    for (const name of params.agentNames) {
        const me = participants.find((p) => p.name === name && p.kind === "agent");
        if (!me) continue;
        const cursor = me.cursorSeq;
        const { fresh, omittedBefore } = trimBatch(await readTranscript({
            sessionId: params.session.id, fromSeq: cursor, limit: MAX_BATCH_MESSAGES,
        }));
        agents[name] = {
            fresh,
            openToYou: await readOpenToYou(params.session.id, name),
            cursor,
            delivered: fresh.length ? fresh[fresh.length - 1].seq : cursor,
            omittedBefore,
            hasFloor: params.floorHolder === name,
            moreRemain: fresh.length >= MAX_BATCH_MESSAGES,
            status: me.status,
            dispatchMode: me.dispatchMode,
        };
    }
    return { session: params.session, participants, agents };
}

export async function concludeCouncil(params: {
    sessionId: string;
    closer: string;
    verdict: string;
    openQuestions: string[];
}): Promise<{ changed: boolean; verdict?: string; closer?: string; vaultPath?: string | null; round?: number; messages?: number }> {
    try {
        const { data, error } = await supabase.rpc("conclude_council", {
            p_session_id: params.sessionId,
            p_closer: params.closer,
            p_verdict: params.verdict,
            p_open_questions: params.openQuestions,
        });
        if (error) throw new Error(error.message);
        return (data ?? { changed: false }) as { changed: boolean; verdict?: string; closer?: string; vaultPath?: string | null };
    } catch (err) {
        return throwWrite("concludeCouncil", err);
    }
}

export interface CouncilWorkItemPlan {
    agentName: string; title: string; instructions: string; acceptanceCriteria: string[];
}

interface WorkItemPlanRow {
    agent_name?: unknown; title?: unknown; instructions?: unknown; acceptance_criteria?: unknown;
}

// The closer records a verdict; it is not final until the owner accepts. The
// work plan rides along because the campaign is created on accept, not here.
export async function proposeVerdict(params: {
    sessionId: string;
    closer: string;
    verdict: string;
    openQuestions: string[];
    workItems?: CouncilWorkItemPlan[];
    standbySeconds?: number;
}): Promise<{ changed: boolean; status?: CouncilStatus; verdict?: string; closer?: string; vaultPath?: string | null; round?: number; messages?: number }> {
    try {
        const { data, error } = await supabase.rpc("propose_council_verdict", {
            p_session_id: params.sessionId,
            p_closer: params.closer,
            p_verdict: params.verdict,
            p_open_questions: params.openQuestions,
            p_work_items: params.workItems?.length
                ? params.workItems.map((i) => ({
                    agent_name: i.agentName, title: i.title,
                    instructions: i.instructions, acceptance_criteria: i.acceptanceCriteria,
                }))
                : null,
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
    vaultPath?: string | null; workItems: CouncilWorkItemPlan[];
}> {
    try {
        const { data, error } = await supabase.rpc("accept_council_verdict", { p_session_id: sessionId });
        if (error) throw new Error(error.message);
        const row = (data ?? { changed: false }) as {
            changed: boolean; status?: CouncilStatus; verdict?: string; closer?: string;
            vault_path?: string | null; work_items?: WorkItemPlanRow[] | null;
        };
        return {
            changed: row.changed,
            status: row.status,
            verdict: row.verdict,
            closer: row.closer,
            vaultPath: row.vault_path ?? null,
            workItems: (row.work_items ?? []).map((i) => ({
                agentName: String(i.agent_name ?? ""),
                title: String(i.title ?? ""),
                instructions: String(i.instructions ?? ""),
                acceptanceCriteria: Array.isArray(i.acceptance_criteria) ? i.acceptance_criteria.map(String) : [],
            })),
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
        .is("paused_at", null)
        .lt("expires_at", new Date().toISOString())
        .select(SESSION_COLUMNS);
    if (error) {
        console.error("[Council] expireOverdueSessions failed:", error.message);
        return [];
    }
    return (data as unknown as SessionRow[]).map(mapSession);
}

export function isValidCouncilCode(code: string): boolean {
    const body = code.trim().toUpperCase().replace(/^CN-/, "");
    return body.length > 0 && [...body].every((c) => CODE_ALPHABET.includes(c));
}
