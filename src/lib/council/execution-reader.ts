import { supabaseAdmin } from "@/lib/supabase";
import { EXECUTION_ID_PATTERN, parseExecutionRecord, type CouncilExecutionPage, type CouncilExecutionRecord } from "./execution-evidence";

const PAGE_SIZE = 50;
const COLUMNS = "id,connector_kind,identity_assurance,provider,adapter_version,requested_model,effective_model,requested_reasoning_effort,effective_reasoning_effort,model_source,started_at,ended_at,predecessor_execution_id,participant:council_participants!participant_id(name,session_id)";

export function parseExecutionCursor(cursor: string | null): { startedAt: string; id: string } | null {
    if (!cursor) return null;
    if (cursor.length > 256) throw new Error("Invalid execution cursor.");
    try {
        const value = JSON.parse(cursor);
        if (typeof value.id !== "string" || !EXECUTION_ID_PATTERN.test(value.id) || typeof value.startedAt !== "string"
            || !/^[0-9T:.+Z-]+$/.test(value.startedAt) || !Number.isFinite(Date.parse(value.startedAt))) throw new Error();
        return { startedAt: value.startedAt, id: value.id };
    } catch { throw new Error("Invalid execution cursor."); }
}

function mapRecord(value: unknown, sessionId: string): CouncilExecutionRecord | null {
    const row = value as Record<string, unknown>;
    const participant = row.participant as { name?: unknown; session_id?: unknown } | null;
    if (!participant || participant.session_id !== sessionId) return null;
    return parseExecutionRecord({
        executionId: row.id, agentName: participant.name, connectorKind: row.connector_kind,
        identityAssurance: row.identity_assurance, provider: row.provider, adapterVersion: row.adapter_version,
        requestedModel: row.requested_model, effectiveModel: row.effective_model,
        requestedReasoningEffort: row.requested_reasoning_effort, effectiveReasoningEffort: row.effective_reasoning_effort,
        modelSource: row.model_source, startedAt: row.started_at, endedAt: row.ended_at,
        predecessorExecutionId: row.predecessor_execution_id,
    });
}

export async function readExecutionEvidence(sessionId: string, options: { cursor?: string | null; referencedIds?: (string | null | undefined)[] } = {}): Promise<CouncilExecutionPage> {
    const cursor = parseExecutionCursor(options.cursor ?? null);
    const result: CouncilExecutionPage = { records: [], referencedRecords: [], nextCursor: null, historyStatus: "available", referencesStatus: "available" };
    try {
        let query = supabaseAdmin.from("council_agent_executions").select(COLUMNS).eq("session_id", sessionId)
            .order("started_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE_SIZE + 1);
        if (cursor) query = query.or(`started_at.lt.${cursor.startedAt},and(started_at.eq.${cursor.startedAt},id.lt.${cursor.id})`);
        const { data, error } = await query;
        if (error) throw error;
        const page = (data ?? []).slice(0, PAGE_SIZE);
        result.records = page.flatMap(row => { const record = mapRecord(row, sessionId); return record ? [record] : []; });
        if (result.records.length !== page.length) result.historyStatus = "unavailable";
        if ((data?.length ?? 0) > PAGE_SIZE) {
            const last = page.at(-1)!;
            result.nextCursor = JSON.stringify({ startedAt: last.started_at, id: last.id });
        }
    } catch { result.historyStatus = "unavailable"; }

    const known = new Set(result.records.map(record => record.executionId));
    const ids = [...new Set(options.referencedIds ?? [])].filter((id): id is string => typeof id === "string" && EXECUTION_ID_PATTERN.test(id) && !known.has(id));
    for (let offset = 0; offset < ids.length; offset += 100) {
        try {
            const batch = ids.slice(offset, offset + 100);
            const { data, error } = await supabaseAdmin.from("council_agent_executions").select(COLUMNS).eq("session_id", sessionId).in("id", batch);
            if (error) throw error;
            const records = (data ?? []).flatMap(row => { const record = mapRecord(row, sessionId); return record ? [record] : []; });
            if (records.length !== batch.length) result.referencesStatus = "unavailable";
            result.referencedRecords.push(...records);
        } catch { result.referencesStatus = "unavailable"; }
    }
    return result;
}
