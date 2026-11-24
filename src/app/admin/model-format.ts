import type { CatalogueRow } from "@/lib/ai/catalogue/snapshot";

export const STEP_LABELS: Record<string, string> = {
    chat: "Chat", tools: "Tool call", forced: "Forced tool call", vision: "Vision", video: "Video",
    query: "Query", passage: "Passage", plain: "Plain call", typed: "Query and passage", retrieval: "Retrieval check",
    truncate: "Smaller size", batch: "Batch", space: "Same space", speak: "Speech", transcribe: "Transcription",
    rerank: "Ranking", parse: "Page read", image: "Image", photo: "Photo input", decision: "Decisions", token: "Token", live: "Live turn",
    vi: "English to Vietnamese", fr: "English to French",
};
export const OUTCOME_LABELS: Record<string, string> = { pass: "Passed", fail: "Failed", transient: "No clear result", skipped: "Skipped" };

export const keyOf = (row: Pick<CatalogueRow, "providerId" | "modelId">) => `${row.providerId}::${row.modelId}`;

export function melbourneTime(value: string | null): string {
    return value ? new Date(value).toLocaleString("en-AU", { timeZone: "Australia/Melbourne", day: "2-digit", month: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" }) : "Never";
}
export function melbourneDate(value: string): string {
    return new Date(value).toLocaleDateString("en-AU", { timeZone: "Australia/Melbourne", day: "2-digit", month: "2-digit", year: "numeric" });
}
export function duration(ms: number | null): string {
    if (ms === null) return "Not measured";
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function probeSteps(detail: unknown): { name: string; outcome: string; httpStatus: number | null; ms: number | null; detail: string | null }[] {
    const raw = detail !== null && typeof detail === "object" ? (detail as { steps?: unknown }).steps : null;
    if (!raw || typeof raw !== "object") return [];
    return Object.entries(raw as Record<string, unknown>).flatMap(([name, value]) => {
        if (!value || typeof value !== "object") return [];
        const step = value as Record<string, unknown>;
        return [{
            name, outcome: typeof step.outcome === "string" ? step.outcome : "unknown",
            httpStatus: typeof step.httpStatus === "number" ? step.httpStatus : null,
            ms: typeof step.ms === "number" ? step.ms : null,
            detail: typeof step.detail === "string" ? step.detail : null,
        }];
    });
}
