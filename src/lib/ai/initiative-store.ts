import { supabaseAdmin as supabase } from "@/lib/supabase";

export type InitiativeCategory =
    | "overdue_todo"
    | "calendar_conflict"
    | "forgotten_followup"
    | "deadline_warning"
    | "other";

export const INITIATIVE_CATEGORIES: InitiativeCategory[] = [
    "overdue_todo",
    "calendar_conflict",
    "forgotten_followup",
    "deadline_warning",
    "other",
];

export interface InitiativeDecision {
    id: string;
    decidedAt: string;
    shouldSend: boolean;
    category: InitiativeCategory;
    reason: string | null;
    message: string | null;
    feedback: number | null;
}

export interface InitiativeFeedbackStat {
    category: string;
    sent: number;
    up: number;
    down: number;
}

interface DecisionRow {
    id: string;
    decided_at: string;
    should_send: boolean;
    category: string;
    reason: string | null;
    message: string | null;
    feedback: number | null;
}

function mapRow(row: DecisionRow): InitiativeDecision {
    return {
        id: row.id,
        decidedAt: row.decided_at,
        shouldSend: row.should_send,
        category: row.category as InitiativeCategory,
        reason: row.reason,
        message: row.message,
        feedback: row.feedback,
    };
}

export async function logInitiativeDecision(params: {
    shouldSend: boolean;
    category: InitiativeCategory;
    reason?: string;
    message?: string;
}): Promise<string | null> {
    const { data, error } = await supabase
        .from("initiative_log")
        .insert({
            should_send: params.shouldSend,
            category: params.category,
            reason: params.reason ?? null,
            message: params.message ?? null,
        })
        .select("id")
        .single();

    if (error) {
        console.warn("[Initiative] Failed to log decision:", error.message);
        return null;
    }
    return data.id;
}

export async function listInitiativeDecisions(limit = 20): Promise<InitiativeDecision[]> {
    const { data, error } = await supabase
        .from("initiative_log")
        .select("*")
        .order("decided_at", { ascending: false })
        .limit(limit);

    if (error) {
        console.warn("[Initiative] Failed to list decisions:", error.message);
        return [];
    }
    return (data ?? []).map(mapRow);
}

export async function setInitiativeFeedback(id: string, feedback: 1 | -1): Promise<boolean> {
    const { error } = await supabase
        .from("initiative_log")
        .update({ feedback })
        .eq("id", id);

    if (error) {
        console.warn("[Initiative] Failed to set feedback:", error.message);
        return false;
    }
    return true;
}

/**
 * Send-gate facts for the cron. Throws when the log is unreadable (e.g. table
 * missing pre-DDL): without the ledger the rate gates can't hold, and sending
 * blind every tick would spam — same hard-abort stance as email-triggers dedup.
 */
export async function getInitiativeSendGateInfo(): Promise<{
    lastSentAt: string | null;
    sentLast24h: number;
}> {
    const dayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const { data, error } = await supabase
        .from("initiative_log")
        .select("decided_at")
        .eq("should_send", true)
        .gte("decided_at", dayAgo)
        .order("decided_at", { ascending: false });

    if (error) {
        throw new Error(`Initiative log unreadable: ${error.message}`);
    }
    return {
        lastSentAt: data?.[0]?.decided_at ?? null,
        sentLast24h: data?.length ?? 0,
    };
}

/** Per-category 👍/👎 tallies over the last 14 days of sent messages. */
export async function getInitiativeFeedbackStats(): Promise<InitiativeFeedbackStat[]> {
    const cutoff = new Date(Date.now() - 14 * 24 * 3_600_000).toISOString();
    const { data, error } = await supabase
        .from("initiative_log")
        .select("category, feedback")
        .eq("should_send", true)
        .gte("decided_at", cutoff);

    if (error) {
        console.warn("[Initiative] Failed to read feedback stats:", error.message);
        return [];
    }

    const byCategory = new Map<string, InitiativeFeedbackStat>();
    for (const row of data ?? []) {
        const stat = byCategory.get(row.category) ?? { category: row.category, sent: 0, up: 0, down: 0 };
        stat.sent++;
        if (row.feedback === 1) stat.up++;
        if (row.feedback === -1) stat.down++;
        byCategory.set(row.category, stat);
    }
    return [...byCategory.values()];
}
