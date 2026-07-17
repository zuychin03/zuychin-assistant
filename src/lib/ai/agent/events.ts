import type { ArtifactDescriptor } from "@/lib/types";

export interface PlanStep {
    title: string;
    status: "pending" | "in_progress" | "done";
}

export type AgentEvent =
    | { type: "run"; runId: string }
    | { type: "status"; message: string }
    | { type: "plan"; steps: PlanStep[] }
    | { type: "tool"; name: string; phase: "start" | "done" }
    | { type: "subagent"; objective: string; model: string; phase: "start" | "done" }
    | { type: "artifact"; artifact: ArtifactDescriptor }
    /** Text delta of the forming reply; reset replaces everything shown so far (new model turn). */
    | { type: "token"; text: string; reset?: boolean }
    | { type: "done"; reply: string; messageId: string; artifacts: ArtifactDescriptor[] }
    | { type: "error"; message: string };

export type AgentEventSink = (event: AgentEvent) => void;

export function sseFormat(event: AgentEvent): string {
    return `data: ${JSON.stringify(event)}\n\n`;
}
