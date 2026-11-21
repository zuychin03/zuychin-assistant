import { createHash, randomBytes } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { issueHostSeatSchema, requireCouncilHost, type CouncilCaller } from "./host-contracts";

const PREFIX = "zcs_";
const TTL_HOURS = 24;

export function hashSeatToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

// The online runner holds the token in process and records only its hash.
export async function issueHostSeatKey(params: {
    sessionId: string;
    seatName: string;
    hostId: string;
    leaseEpoch: number;
    bindExecution?: boolean;
    ttlHours?: number;
}, caller: CouncilCaller | undefined): Promise<{ ok: true; token: string; expiresAt: string; executionBindingRequired?: boolean } | { ok: false; reason: string }> {
    requireCouncilHost(caller);
    params = issueHostSeatSchema.parse(params);
    const token = `${PREFIX}${randomBytes(32).toString("hex")}`;
    const expiresAt = new Date(Date.now() + (params.ttlHours ?? TTL_HOURS) * 3600_000).toISOString();
    const { data, error } = await supabase.rpc(params.bindExecution ? "issue_council_bound_host_seat_key" : "issue_council_host_seat_key", {
        p_session_id: params.sessionId,
        p_seat_name: params.seatName,
        p_token_hash: hashSeatToken(token),
        p_expires_at: expiresAt,
        p_host_id: params.hostId,
        p_lease_epoch: params.leaseEpoch,
    });
    if (error) throw new Error(error.message);
    const row = (data ?? { ok: false, reason: "no_result" }) as { ok: boolean; reason?: string; executionBindingRequired?: boolean };
    if (!row.ok) return { ok: false, reason: row.reason ?? "unknown" };
    return { ok: true, token, expiresAt, ...(row.executionBindingRequired === true ? { executionBindingRequired: true } : {}) };
}
