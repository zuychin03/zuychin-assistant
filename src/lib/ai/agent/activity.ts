import type { AgentEvent, PlanStep } from "@/lib/ai/agent/events";

/** What an agent run did, kept with the reply so the summary survives after the live progress ends. */
export interface AgentActivity {
    steps: PlanStep[];
    tools: { name: string; count: number }[];
    workers: { objective: string; model: string }[];
    files: string[];
}

const MAX_STEPS = 8;
const MAX_TOOLS = 20;
const MAX_WORKERS = 12;
const MAX_FILES = 12;
const STATUSES: readonly PlanStep["status"][] = ["pending", "in_progress", "done"];

const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;

export function createActivityRecorder() {
    let steps: PlanStep[] = [];
    const tools = new Map<string, number>();
    const workers: AgentActivity["workers"] = [];
    const files: string[] = [];
    return {
        record(event: AgentEvent) {
            if (event.type === "plan") steps = event.steps.slice(0, MAX_STEPS).map((step) => ({ title: clip(step.title, 200), status: step.status }));
            // Chat-path tool calls carry `chat`; only agent runs are summarised here.
            else if (event.type === "tool" && event.phase === "start" && !event.chat) tools.set(event.name, (tools.get(event.name) ?? 0) + 1);
            else if (event.type === "subagent" && event.phase === "done" && workers.length < MAX_WORKERS) workers.push({ objective: clip(event.objective, 200), model: clip(event.model, 120) });
            else if (event.type === "artifact" && files.length < MAX_FILES) files.push(clip(event.artifact.name, 160));
        },
        result(): AgentActivity | null {
            if (!steps.length && !tools.size && !workers.length && !files.length) return null;
            return { steps, tools: [...tools].slice(0, MAX_TOOLS).map(([name, count]) => ({ name, count })), workers, files };
        },
    };
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const line = (value: unknown, max: number) => typeof value === "string" && value.trim() ? clip(value.trim(), max) : null;

/** Stored activity read back from message metadata; anything malformed is dropped. */
export function parseAgentActivity(raw: unknown): AgentActivity | null {
    const value = record(raw);
    const list = (key: string) => Array.isArray(value[key]) ? value[key] as unknown[] : [];
    const steps = list("steps").flatMap((entry) => {
        const step = record(entry);
        const title = line(step.title, 200);
        return title ? [{ title, status: STATUSES.includes(step.status as PlanStep["status"]) ? step.status as PlanStep["status"] : "pending" }] : [];
    }).slice(0, MAX_STEPS);
    const tools = list("tools").flatMap((entry) => {
        const tool = record(entry);
        const name = line(tool.name, 80);
        return name && typeof tool.count === "number" && Number.isInteger(tool.count) && tool.count > 0 ? [{ name, count: tool.count }] : [];
    }).slice(0, MAX_TOOLS);
    const workers = list("workers").flatMap((entry) => {
        const worker = record(entry);
        const objective = line(worker.objective, 200);
        return objective ? [{ objective, model: line(worker.model, 120) ?? "auto" }] : [];
    }).slice(0, MAX_WORKERS);
    const files = list("files").flatMap((entry) => { const name = line(entry, 160); return name ? [name] : []; }).slice(0, MAX_FILES);
    return steps.length || tools.length || workers.length || files.length ? { steps, tools, workers, files } : null;
}
