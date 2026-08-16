import { createHash, createHmac, randomBytes } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase";

export const KEY_PREFIX = "zck_";
export const CLAIM_PREFIX = "zkc_";
export const CLAIM_TTL_MINUTES = 15;

export type AccessLevel = "read" | "notes" | "full" | "council";
export type ClientKind = "local_host" | "remote_agent" | "owner_tool";

// council is opt-in per client and deliberately not part of full. The rule it
// bends is "council:owner is never minted into an agent key", which existed so
// that every read/write key could not convene; choosing it for one named,
// revocable client does not reinstate that. It is still strictly tighter than
// the shared MCP_API_KEY it replaces, which grants the same authority to anyone
// holding one unattributable secret.
export const ACCESS_SCOPES: Record<AccessLevel, string[]> = {
    read: ["knowledge:read"],
    notes: ["knowledge:read", "notes:write"],
    full: ["knowledge:read", "notes:write", "vault:write"],
    council: ["knowledge:read", "notes:write", "vault:write", "council:owner"],
};

export const ACCESS_LABELS: Record<AccessLevel, string> = {
    read: "Read-only",
    notes: "Notes read/write",
    full: "Full read/write",
    council: "Full read/write + convene councils",
};

export function isAccessLevel(value: unknown): value is AccessLevel {
    return value === "read" || value === "notes" || value === "full" || value === "council";
}

export interface AgentClientKey {
    id: string;
    purpose: "knowledge" | "council_seat";
    accessLevel: AccessLevel | null;
    scopes: string[];
    issuedAt: string;
    expiresAt: string | null;
    lastUsedAt: string | null;
    sessionId: string | null;
    seatName: string | null;
}

export interface AgentClient {
    id: string;
    displayName: string;
    kind: ClientKind;
    providerHint: string | null;
    note: string | null;
    createdAt: string;
    lastSeenAt: string | null;
    keys: AgentClientKey[];
}

export interface AgentIdentity {
    clientId: string;
    displayName: string;
    keyId: string;
    scopes: string[];
}

function hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

// The durable key is derived from the claim rather than generated, which is what
// makes the exchange idempotent without storing plaintext anywhere: a retry
// recomputes the same token. Domain-separated so it cannot collide with any
// other use of the session secret.
function deriveKey(claim: string): string {
    const secret = process.env.AUTH_SESSION_SECRET;
    if (!secret) throw new Error("AUTH_SESSION_SECRET is required to issue agent keys.");
    const mac = createHmac("sha256", secret).update(`zuychin-agent-claim:v1:${claim}`).digest("hex");
    return `${KEY_PREFIX}${mac}`;
}

export function looksLikeAgentKey(token: string): boolean {
    return token.startsWith(KEY_PREFIX);
}

export function looksLikeClaim(token: string): boolean {
    return token.startsWith(CLAIM_PREFIX);
}

export async function createAgentClient(params: {
    displayName: string;
    kind: ClientKind;
    providerHint?: string | null;
    note?: string | null;
}): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
    const { data, error } = await supabase.from("agent_clients").insert({
        display_name: params.displayName,
        kind: params.kind,
        provider_hint: params.providerHint ?? null,
        note: params.note ?? null,
    }).select("id").single();
    if (error) {
        if (error.code === "23505") return { ok: false, reason: "duplicate_name" };
        throw new Error(error.message);
    }
    return { ok: true, id: data.id as string };
}

export async function listAgentClients(): Promise<AgentClient[]> {
    const { data, error } = await supabase
        .from("agent_clients")
        .select("id, display_name, kind, provider_hint, note, created_at, last_seen_at")
        .is("revoked_at", null)
        .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    const clients = (data ?? []) as {
        id: string; display_name: string; kind: ClientKind; provider_hint: string | null;
        note: string | null; created_at: string; last_seen_at: string | null;
    }[];
    if (clients.length === 0) return [];

    const { data: keyRows, error: keyError } = await supabase
        .from("agent_client_keys")
        .select("id, client_id, purpose, access_level, scopes, issued_at, expires_at, last_used_at, session_id, seat_name")
        .in("client_id", clients.map((c) => c.id))
        .is("revoked_at", null)
        .order("issued_at", { ascending: true });
    if (keyError) throw new Error(keyError.message);

    const byClient = new Map<string, AgentClientKey[]>();
    for (const r of (keyRows ?? []) as Record<string, unknown>[]) {
        const list = byClient.get(r.client_id as string) ?? [];
        list.push({
            id: r.id as string,
            purpose: r.purpose as AgentClientKey["purpose"],
            accessLevel: (r.access_level as AccessLevel | null) ?? null,
            scopes: (r.scopes as string[]) ?? [],
            issuedAt: r.issued_at as string,
            expiresAt: (r.expires_at as string | null) ?? null,
            lastUsedAt: (r.last_used_at as string | null) ?? null,
            sessionId: (r.session_id as string | null) ?? null,
            seatName: (r.seat_name as string | null) ?? null,
        });
        byClient.set(r.client_id as string, list);
    }

    return clients.map((c) => ({
        id: c.id,
        displayName: c.display_name,
        kind: c.kind,
        providerHint: c.provider_hint,
        note: c.note,
        createdAt: c.created_at,
        lastSeenAt: c.last_seen_at,
        keys: byClient.get(c.id) ?? [],
    }));
}

export async function revokeAgentClient(clientId: string): Promise<void> {
    const { error } = await supabase.rpc("revoke_agent_client", { p_client_id: clientId });
    if (error) throw new Error(error.message);
}

export async function revokeAgentKey(keyId: string): Promise<void> {
    const { error } = await supabase
        .from("agent_client_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", keyId)
        .is("revoked_at", null);
    if (error) throw new Error(error.message);
}

export async function mintKnowledgeClaim(params: {
    clientId: string;
    accessLevel: AccessLevel;
}): Promise<{ claim: string; expiresAt: string }> {
    const claim = `${CLAIM_PREFIX}${randomBytes(32).toString("hex")}`;
    const expiresAt = new Date(Date.now() + CLAIM_TTL_MINUTES * 60_000).toISOString();

    // One live claim per client: minting a second invalidates the first, so a
    // brief the owner has replaced cannot still be exchanged.
    await supabase.from("agent_client_claims")
        .update({ revoked_at: new Date().toISOString() })
        .eq("client_id", params.clientId)
        .is("revoked_at", null)
        .is("claimed_at", null);

    const { error } = await supabase.from("agent_client_claims").insert({
        client_id: params.clientId,
        claim_hash: hash(claim),
        scopes: ACCESS_SCOPES[params.accessLevel],
        access_level: params.accessLevel,
        expires_at: expiresAt,
    });
    if (error) throw new Error(error.message);
    return { claim, expiresAt };
}

export interface ExchangeResult {
    key: string;
    client: string;
    scopes: string[];
    accessLevel: AccessLevel;
}

// Returns null for absent, expired, revoked and malformed alike. The caller
// must not distinguish them: doing so turns the endpoint into an oracle for
// which claims exist.
export async function exchangeClaim(claim: string): Promise<ExchangeResult | null> {
    if (!looksLikeClaim(claim)) return null;
    const token = deriveKey(claim);
    const { data, error } = await supabase.rpc("exchange_agent_claim", {
        p_claim_hash: hash(claim),
        p_token_hash: hash(token),
        p_key_prefix: KEY_PREFIX,
    });
    if (error) {
        console.warn("[Agents] claim exchange failed:", error.message);
        return null;
    }
    const row = (data ?? {}) as { ok?: boolean; display_name?: string; scopes?: string[]; access_level?: AccessLevel };
    if (row.ok !== true) return null;
    return {
        key: token,
        client: row.display_name ?? "",
        scopes: row.scopes ?? [],
        accessLevel: row.access_level ?? "read",
    };
}

export async function resolveAgentKey(token: string): Promise<AgentIdentity | null> {
    if (!looksLikeAgentKey(token)) return null;
    const { data, error } = await supabase.rpc("resolve_agent_client_key", {
        p_token_hash: hash(token),
    });
    if (error) {
        console.warn("[Agents] key resolve failed:", error.message);
        return null;
    }
    if (!data) return null;
    const row = data as { client_id?: string; display_name?: string; key_id?: string; scopes?: string[] };
    if (!row.client_id || !row.key_id) return null;
    return {
        clientId: row.client_id,
        displayName: row.display_name ?? "",
        keyId: row.key_id,
        scopes: row.scopes ?? [],
    };
}

const IP_ATTEMPTS_PER_WINDOW = 10;
const GLOBAL_FAILURES_PER_HOUR = 100;

export function hashClientIp(ip: string): string {
    return hash(`agent-claim-ip:${ip}`);
}

// Database-backed because the app is serverless: an in-process counter resets
// per cold start and is not shared between instances, so an attacker would get
// a fresh allowance each time. Booked before the exchange so the limit actually
// prevents the work rather than reporting on it afterwards.
export async function beginClaimAttempt(ipHash: string): Promise<{ attemptId: number | null; limited: boolean }> {
    const { data, error } = await supabase.rpc("begin_agent_claim_attempt", { p_ip_hash: ipHash });
    if (error) {
        // Fail closed. This is the only unauthenticated write surface, so a
        // limiter that silently disables itself on a database blip is worse
        // than an owner having to retry a setup.
        console.warn("[Agents] claim rate check failed:", error.message);
        return { attemptId: null, limited: true };
    }
    const row = (data ?? {}) as { attempt_id?: number; ip_attempts?: number; global_failures?: number };
    const globalFailures = row.global_failures ?? 0;
    if (globalFailures >= GLOBAL_FAILURES_PER_HOUR) {
        console.error(`[Agents] claim endpoint has seen ${globalFailures} failures in the last hour.`);
    }
    return {
        attemptId: row.attempt_id ?? null,
        limited: (row.ip_attempts ?? 0) >= IP_ATTEMPTS_PER_WINDOW || globalFailures >= GLOBAL_FAILURES_PER_HOUR,
    };
}

export async function finishClaimAttempt(attemptId: number | null, succeeded: boolean): Promise<void> {
    if (attemptId === null || !succeeded) return;
    const { error } = await supabase.rpc("finish_agent_claim_attempt", {
        p_attempt_id: attemptId,
        p_succeeded: true,
    });
    if (error) console.warn("[Agents] claim attempt stamp failed:", error.message);
}
