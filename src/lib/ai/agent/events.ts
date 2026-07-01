// Events emitted during an agent run and streamed to the web client over SSE.
import type { ArtifactDescriptor } from "@/lib/types";

export interface PlanStep {
    title: string;
    status: "pending" | "in_progress" | "done";
}

export type AgentEvent =
    | { type: "status"; message: string }
    | { type: "plan"; steps: PlanStep[] }
    | { type: "tool"; name: string; phase: "start" | "done" }
    | { type: "subagent"; objective: string; model: string; phase: "start" | "done" }
    | { type: "artifact"; artifact: ArtifactDescriptor }
    | { type: "done"; reply: string; messageId: string; artifacts: ArtifactDescriptor[] }
    | { type: "error"; message: string };

export type AgentEventSink = (event: AgentEvent) => void;

/** Serialize an event as an SSE `data:` frame. */
export function sseFormat(event: AgentEvent): string {
    return `data: ${JSON.stringify(event)}\n\n`;
}
