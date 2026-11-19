import { supabaseAdmin as supabase } from "@/lib/supabase";

export interface SeatModel {
    modelKey: string;
    source: string;
    executionId: string;
    ended: boolean;
}

/** Each seat's latest managed_api execution: the record of which model holds it. */
export async function latestSeatModels(sessionId: string): Promise<Map<string, SeatModel>> {
    const [{ data: people, error: peopleError }, { data: runs, error: runsError }] = await Promise.all([
        supabase.from("council_participants").select("id, name, kind").eq("session_id", sessionId),
        supabase.from("council_agent_executions")
            .select("id, participant_id, provider, requested_model, model_source, started_at, ended_at")
            .eq("session_id", sessionId).eq("connector_kind", "managed_api")
            .order("started_at", { ascending: false }),
    ]);
    if (peopleError || runsError) throw new Error((peopleError ?? runsError)!.message);
    const names = new Map((people ?? []).filter((p) => p.kind === "agent").map((p) => [p.id as string, p.name as string]));
    const out = new Map<string, SeatModel>();
    for (const run of runs ?? []) {
        const name = names.get(run.participant_id as string);
        if (!name || out.has(name) || !run.provider || !run.requested_model) continue;
        out.set(name, {
            modelKey: `${run.provider}::${run.requested_model}`,
            source: (run.model_source as string | null) ?? "picker",
            executionId: run.id as string,
            ended: run.ended_at !== null,
        });
    }
    return out;
}

/** True when every agent seat is held by a model, which is what makes a council online. */
export async function isOnlineCouncil(sessionId: string): Promise<boolean> {
    const [{ data: people }, models] = await Promise.all([
        supabase.from("council_participants").select("name").eq("session_id", sessionId).eq("kind", "agent"),
        latestSeatModels(sessionId),
    ]);
    const agents = (people ?? []).map((p) => p.name as string);
    return agents.length > 0 && agents.every((name) => models.has(name));
}

export interface LeaseState {
    hostId: string;
    leaseEpoch: number;
    leaseExpiresAt: string;
    live: boolean;
}

export async function readLease(sessionId: string): Promise<LeaseState | null> {
    const { data, error } = await supabase.from("council_host_leases")
        .select("host_id, lease_epoch, lease_expires_at, released_at").eq("session_id", sessionId).maybeSingle();
    if (error || !data) return null;
    return {
        hostId: data.host_id as string,
        leaseEpoch: Number(data.lease_epoch),
        leaseExpiresAt: data.lease_expires_at as string,
        live: data.released_at === null && Date.parse(data.lease_expires_at as string) > Date.now(),
    };
}
