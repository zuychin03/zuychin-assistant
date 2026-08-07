import { createHash, randomBytes } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const PREFIX = "zcs_";
const TTL_HOURS = 24;

export interface SeatIdentity {
    sessionId: string;
    seatName: string;
    code: string;
}

export function hashSeatToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

export function looksLikeSeatKey(token: string): boolean {
    return token.startsWith(PREFIX);
}

export async function issueSeatKey(params: {
    sessionId: string;
    seatName: string;
    ttlHours?: number;
}): Promise<{ ok: true; token: string; expiresAt: string } | { ok: false; reason: string }> {
    const token = `${PREFIX}${randomBytes(32).toString("hex")}`;
    const expiresAt = new Date(Date.now() + (params.ttlHours ?? TTL_HOURS) * 3600_000).toISOString();

    const { data, error } = await supabase.rpc("issue_council_seat_key", {
        p_session_id: params.sessionId,
        p_seat_name: params.seatName,
        p_token_hash: hashSeatToken(token),
        p_expires_at: expiresAt,
    });
    if (error) throw new Error(error.message);
    const row = (data ?? { ok: false, reason: "no_result" }) as { ok: boolean; reason?: string };
    if (!row.ok) return { ok: false, reason: row.reason ?? "unknown" };
    return { ok: true, token, expiresAt };
}

export async function issueHostSeatKey(params: {
    sessionId: string;
    seatName: string;
    hostId: string;
    leaseEpoch: number;
    ttlHours?: number;
}): Promise<{ ok: true; token: string; expiresAt: string } | { ok: false; reason: string }> {
    const token = `${PREFIX}${randomBytes(32).toString("hex")}`;
    const expiresAt = new Date(Date.now() + (params.ttlHours ?? TTL_HOURS) * 3600_000).toISOString();
    const { data, error } = await supabase.rpc("issue_council_host_seat_key", {
        p_session_id: params.sessionId,
        p_seat_name: params.seatName,
        p_token_hash: hashSeatToken(token),
        p_expires_at: expiresAt,
        p_host_id: params.hostId,
        p_lease_epoch: params.leaseEpoch,
    });
    if (error) throw new Error(error.message);
    const row = (data ?? { ok: false, reason: "no_result" }) as { ok: boolean; reason?: string };
    if (!row.ok) return { ok: false, reason: row.reason ?? "unknown" };
    return { ok: true, token, expiresAt };
}

export async function resolveSeatKey(token: string): Promise<SeatIdentity | null> {
    if (!looksLikeSeatKey(token)) return null;
    const { data, error } = await supabase.rpc("resolve_council_seat_key", {
        p_token_hash: hashSeatToken(token),
    });
    if (error) {
        console.warn("[Council] seat key resolve failed:", error.message);
        return null;
    }
    if (!data) return null;
    const row = data as { session_id?: string; seat_name?: string; code?: string };
    if (!row.session_id || !row.seat_name) return null;
    return { sessionId: row.session_id, seatName: row.seat_name, code: row.code ?? "" };
}

export async function revokeSeatKey(sessionId: string, seatName: string): Promise<void> {
    const { error } = await supabase
        .from("council_seat_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("session_id", sessionId)
        .eq("seat_name", seatName);
    if (error) console.warn("[Council] seat key revoke failed:", error.message);
}

export async function listSeatKeys(sessionId: string): Promise<{
    seatName: string; issuedAt: string; expiresAt: string; claimedAt: string | null; revokedAt: string | null;
}[]> {
    const { data, error } = await supabase
        .from("council_seat_keys")
        .select("seat_name, issued_at, expires_at, claimed_at, revoked_at")
        .eq("session_id", sessionId)
        .order("issued_at", { ascending: true });
    if (error) {
        console.error("[Council] listSeatKeys failed:", error.message);
        return [];
    }
    return (data ?? []).map((r) => {
        const row = r as { seat_name: string; issued_at: string; expires_at: string; claimed_at: string | null; revoked_at: string | null };
        return {
            seatName: row.seat_name, issuedAt: row.issued_at, expiresAt: row.expires_at,
            claimedAt: row.claimed_at, revokedAt: row.revoked_at,
        };
    });
}
