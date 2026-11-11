import type { ModelCallObservation, ExternalServiceObservation } from "@/lib/ai/model-observations";
import { aggregateUsage, type CompatUsage } from "@/lib/ai/stream-usage";
import { mergeDataClasses, type ModelDataClass } from "@/lib/ai/data-policy";

export type ReplySourceKind = "fact" | "memory" | "vault" | "tool" | "web";

/** What a reply drew on; `weight` is retrieval relevance in 0..1, `ref` a vault path or tool name. */
export interface ReplySource {
    kind: ReplySourceKind;
    label: string;
    detail?: string;
    ref?: string;
    weight: number;
}

export interface ReplyTrace {
    version: 1;
    origin: "interactive" | "scheduled";
    dataClasses: ModelDataClass[];
    freeOnly: boolean;
    retention: "not_verified";
    startedAt: string;
    durationMs: number;
    firstAnswerMs: number | null;
    calls: ModelCallObservation[];
    externalServices: ExternalServiceObservation[];
    usage: CompatUsage;
    background: "pending" | "complete" | "failed" | "skipped";
    saved: boolean;
    sources?: ReplySource[];
}

export function makeReplyTrace(params: Omit<ReplyTrace, "version" | "retention" | "usage" | "saved" | "dataClasses">): ReplyTrace {
    return { ...params, version: 1, retention: "not_verified", saved: false,
        dataClasses: mergeDataClasses(...params.calls.map(call => call.dataClasses), ...params.externalServices.map(call => call.dataClasses)),
        usage: aggregateUsage(params.calls.map((call) => call.usage)) };
}

export function mergeReplyTrace(previous: ReplyTrace | undefined, incoming: ReplyTrace): ReplyTrace {
    const calls = [...new Map([...(previous?.calls ?? []), ...incoming.calls].map((call) => [call.id, call])).values()]
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
    const background = incoming.background === "pending" && previous && previous.background !== "pending"
        ? previous.background : incoming.background;
    const externalServices = [...new Map([...(previous?.externalServices ?? []), ...incoming.externalServices].map((call) => [call.id, call])).values()];
    const sources = incoming.sources ?? previous?.sources;
    return { ...incoming, ...(sources ? { sources } : {}), background, calls, externalServices, dataClasses: mergeDataClasses(...calls.map(call => call.dataClasses), ...externalServices.map(call => call.dataClasses)), usage: aggregateUsage(calls.map((call) => call.usage)), saved: true };
}
