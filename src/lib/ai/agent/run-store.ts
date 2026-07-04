import { supabaseAdmin as supabase } from "@/lib/supabase";
import type { AgentEvent, AgentEventSink, PlanStep } from "@/lib/ai/agent/events";

export interface RunUsage {
    promptTokens: number;
    outputTokens: number;
    totalTokens: number;
    llmCalls: number;
    workerTokens?: number;
}

export interface AgentRunSummary {
    id: string;
    status: "running" | "done" | "error" | "timeout";
    message: string;
    model: string | null;
    plan: PlanStep[];
    usage: Partial<RunUsage>;
    startedAt: string;
    finishedAt: string | null;
}

export interface AgentRunDetail extends AgentRunSummary {
    events: Array<{ t: string } & Record<string, unknown>>;
    reply: string | null;
    error: string | null;
}

const MAX_EVENTS = 500;
const FLUSH_INTERVAL_MS = 2000;
const FLUSH_BATCH = 5;
// Vercel hard-kills at maxDuration (300s) without running finally blocks, so
// rows can be orphaned in 'running'; anything older than this is swept on read.
const STALE_RUNNING_MINUTES = 6;

export async function createAgentRun(params: {
    message: string;
    conversationId?: string;
    userProfileId?: string;
    model: string;
}): Promise<string | null> {
    const { data, error } = await supabase
        .from("agent_runs")
        .insert({
            message: params.message.slice(0, 4000),
            conversation_id: params.conversationId ?? null,
            user_profile_id: params.userProfileId ?? null,
            model: params.model,
        })
        .select("id")
        .single();

    if (error) {
        console.warn("[AgentRun] Failed to create run row:", error.message);
        return null;
    }
    return data.id as string;
}

// Tees agent events into the run row without slowing the run down: events are
// buffered and flushed on a debounce, never awaited on the hot path.
export class RunEventBuffer {
    private events: Array<{ t: string } & AgentEvent> = [];
    private plan: PlanStep[] = [];
    private unflushed = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private runId: string | null) {}

    wrap(sink?: AgentEventSink): AgentEventSink {
        return (event) => {
            sink?.(event);
            this.record(event);
        };
    }

    private record(event: AgentEvent): void {
        if (!this.runId) return;
        if (event.type === "plan") this.plan = event.steps;
        if (this.events.length < MAX_EVENTS) {
            this.events.push({ t: new Date().toISOString(), ...event });
        }
        this.unflushed++;
        if (this.unflushed >= FLUSH_BATCH) {
            void this.flush();
        } else if (!this.timer) {
            this.timer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
        }
    }

    async flush(extra?: Record<string, unknown>): Promise<void> {
        if (!this.runId) return;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.unflushed = 0;
        const { error } = await supabase
            .from("agent_runs")
            .update({ events: this.events, plan: this.plan, ...extra })
            .eq("id", this.runId);
        if (error) console.warn("[AgentRun] Failed to flush events:", error.message);
    }

    async finish(params: {
        status: "done" | "error";
        reply?: string;
        error?: string;
        usage: Partial<RunUsage>;
    }): Promise<void> {
        if (!this.runId) return;
        await this.flush({
            status: params.status,
            reply: params.reply ?? null,
            error: params.error?.slice(0, 2000) ?? null,
            usage: params.usage,
            finished_at: new Date().toISOString(),
        });
    }
}

async function sweepStaleRuns(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_RUNNING_MINUTES * 60_000).toISOString();
    const { error } = await supabase
        .from("agent_runs")
        .update({ status: "timeout", finished_at: new Date().toISOString() })
        .eq("status", "running")
        .lt("started_at", cutoff);
    if (error) console.warn("[AgentRun] Stale sweep failed:", error.message);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toSummary(row: any): AgentRunSummary {
    return {
        id: row.id,
        status: row.status,
        message: row.message,
        model: row.model,
        plan: Array.isArray(row.plan) ? row.plan : [],
        usage: row.usage ?? {},
        startedAt: row.started_at,
        finishedAt: row.finished_at,
    };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function listAgentRuns(limit = 25): Promise<AgentRunSummary[]> {
    await sweepStaleRuns();
    const { data, error } = await supabase
        .from("agent_runs")
        .select("id, status, message, model, plan, usage, started_at, finished_at")
        .order("started_at", { ascending: false })
        .limit(limit);

    if (error) {
        console.error("[AgentRun] Failed to list runs:", error.message);
        return [];
    }
    return (data ?? []).map(toSummary);
}

export async function getAgentRun(id: string): Promise<AgentRunDetail | null> {
    const { data, error } = await supabase
        .from("agent_runs")
        .select("*")
        .eq("id", id)
        .single();

    if (error || !data) return null;
    return {
        ...toSummary(data),
        events: Array.isArray(data.events) ? data.events : [],
        reply: data.reply,
        error: data.error,
    };
}
