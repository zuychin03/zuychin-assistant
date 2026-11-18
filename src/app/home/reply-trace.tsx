"use client";

import { Check, ChevronRight, Circle } from "lucide-react";
import type { ReplyTrace } from "@/lib/ai/reply-trace";
import type { ModelCallObservation } from "@/lib/ai/model-observations";
import { parseAgentActivity, type AgentActivity } from "@/lib/ai/agent/activity";
import { toolInfo } from "./tool-labels";

const STATUS_LABELS = {
    success: "Succeeded", auth: "Authentication failed", rate_limit: "Rate limited", transient: "Temporary failure",
    unavailable: "Unavailable", retired: "Retired", aborted: "Cancelled", unknown: "Unknown outcome",
};
const DATA_CLASS_ORDER = ["personal", "knowledge", "public_search", "unattended"];
const measured = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-AU") : "Unknown";
const duration = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value)
    ? value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s` : "Not measured";

export const validTrace = (trace: ReplyTrace | undefined): trace is ReplyTrace => trace?.version === 1 && Array.isArray(trace.calls);

interface CallGroup {
    key: string;
    first: ModelCallObservation;
    count: number;
    durationMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    dataClasses: string[];
}

// Calls with the same model, purpose and outcome fold into one line, so an agent run's many rounds stay short.
function groupCalls(calls: readonly ModelCallObservation[]): CallGroup[] {
    const groups = new Map<string, CallGroup>();
    const add = (a: number | null, b: number | null | undefined) => a === null || typeof b !== "number" ? null : a + b;
    for (const call of calls) {
        const key = `${call.providerId}/${call.modelId}/${call.purpose}/${call.status}/${call.httpStatus ?? ""}`;
        const group = groups.get(key) ?? { key, first: call, count: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, dataClasses: [] };
        group.count += 1;
        group.durationMs += Number.isFinite(call.durationMs) ? call.durationMs : 0;
        group.inputTokens = add(group.inputTokens, call.usage?.promptTokens);
        group.outputTokens = add(group.outputTokens, call.usage?.outputTokens);
        for (const value of call.dataClasses ?? []) if (!group.dataClasses.includes(value)) group.dataClasses.push(value);
        groups.set(key, group);
    }
    return [...groups.values()].map((group) => ({ ...group, dataClasses: DATA_CLASS_ORDER.filter((value) => group.dataClasses.includes(value)) }));
}

function AgentRun({ agent }: { agent: AgentActivity }) {
    const tools = agent.tools.map((tool) => `${toolInfo(tool.name).activity}${tool.count > 1 ? ` ×${tool.count}` : ""}`);
    return <section style={styles.agent} aria-label="Agent run">
        <p style={styles.heading}>Agent run</p>
        {agent.steps.length > 0 && <ol style={styles.steps}>
            {agent.steps.map((step, index) => <li key={index} style={styles.step} data-status={step.status}>
                {step.status === "done" ? <Check size={13} aria-hidden="true" style={{ ...styles.icon, color: "var(--success)" }} /> : step.status === "in_progress" ? <ChevronRight size={13} aria-hidden="true" style={styles.icon} /> : <Circle size={13} aria-hidden="true" style={styles.icon} />}
                <span>{step.title}</span>
            </li>)}
        </ol>}
        {tools.length > 0 && <p style={styles.line}><span style={styles.label}>Tools:</span> {tools.join(", ")}</p>}
        {agent.workers.length > 0 && <>
            <p style={styles.line}><span style={styles.label}>Sub-agents ({agent.workers.length}):</span></p>
            <ul style={styles.workers}>
                {agent.workers.map((worker, index) => <li key={index} style={styles.worker}>
                    <span style={styles.objective}>{worker.objective}</span> <span style={styles.workerModel}>on {worker.model}</span>
                </li>)}
            </ul>
        </>}
        {agent.files.length > 0 && <p style={styles.line}><span style={styles.label}>Files:</span> {agent.files.join(", ")}</p>}
    </section>;
}

export function ReplyTraceBody({ trace, id }: { trace: ReplyTrace; id?: string }) {
    if (!validTrace(trace)) return null;
    const agent = parseAgentActivity(trace.agent);
    const groups = groupCalls(trace.calls);
    return (
            <div id={id} style={styles.content}>
                {agent && <AgentRun agent={agent} />}
                <p style={styles.note}>{trace.origin === "scheduled" ? "Scheduled request" : "Interactive request"} · {trace.freeOnly ? "Free only" : "Standard model selection"} · {duration(trace.durationMs)} overall · first answer {duration(trace.firstAnswerMs).toLowerCase()}.</p>
                <dl style={styles.usage}>
                    <div><dt>Input tokens</dt><dd>{measured(trace.usage?.promptTokens)}</dd></div>
                    <div><dt>Output tokens</dt><dd>{measured(trace.usage?.outputTokens)}</dd></div>
                    <div><dt>Cached input</dt><dd>{measured(trace.usage?.cachedInputTokens)}</dd></div>
                    <div><dt>Total tokens</dt><dd>{measured(trace.usage?.totalTokens)}</dd></div>
                </dl>
                <p style={styles.note}>Usage reporting: {trace.usage?.completeness ?? "unavailable"}. Unknown values are unreported, not zero.</p>
                {trace.background === "pending" && <p style={styles.note} role="status">Background work pending. Reload this page later to load saved updates.</p>}
                {trace.background === "failed" && <p style={styles.note} role="status">Background work did not complete. These observations may be incomplete.</p>}
                {trace.background === "skipped" && <p style={styles.note}>Optional background work was skipped.</p>}
                {!trace.saved && <p style={styles.warning} role="status">Reply details have not been saved. They may be lost when you leave this chat.</p>}
                <p style={styles.note}>{trace.calls.length} observed model call{trace.calls.length === 1 ? "" : "s"}</p>
                <ol style={styles.calls}>
                    {groups.map(({ key, first: call, count, durationMs, inputTokens, outputTokens, dataClasses }) => <li key={key} style={styles.call}>
                        <div style={styles.callHeader}>
                            <strong style={styles.model}>{call.providerId} / {call.modelId}</strong>
                            <span>{count > 1 ? `${count} calls, ` : ""}{STATUS_LABELS[call.status] ?? "Unknown outcome"}</span>
                        </div>
                        <p style={styles.compact}>
                            {call.purpose} · {count > 1 ? `${duration(durationMs)} in total` : `${duration(call.durationMs)} · first answer ${duration(call.firstAnswerMs).toLowerCase()}`}
                            {call.httpStatus !== null ? ` · HTTP ${call.httpStatus}` : ""}{call.errorClass ? ` · ${call.errorClass}` : ""}
                            {` · input ${measured(inputTokens)}, output ${measured(outputTokens)}`}{count === 1 ? `, cached input ${measured(call.usage?.cachedInputTokens)}` : ""}
                        </p>
                        <p style={styles.compact}>Data classes: {dataClasses.length ? dataClasses.join(", ").replaceAll("_", " ") : "Not classified"}{call.dataRoute ? ` · ${call.dataRoute.tier} route` : ""}.</p>
                        {call.groundingRequested && <p style={styles.compact}>Grounding requested{call.capabilities.grounding ? "; returned source evidence observed." : "; returned source evidence not observed."}</p>}
                        {!call.groundingRequested && call.capabilities.grounding && <p style={styles.compact}>Grounding source evidence observed.</p>}
                        {call.dataRoute?.rule === "shared_embedding_partition" && <p style={styles.compact}>Scheduled generation uses the paid key. This embedding uses the existing shared knowledge partition and may be free.</p>}
                    </li>)}
                </ol>
                {!trace.calls.length && <p style={styles.note}>No model calls were recorded in these reply details.</p>}
                {!!trace.externalServices?.length && <>
                    <p style={styles.note}>{trace.externalServices.length} observed external service call{trace.externalServices.length === 1 ? "" : "s"}</p>
                    <ul style={styles.calls}>{trace.externalServices.map(service => <li key={service.id} style={styles.call}>
                        <div style={styles.callHeader}><strong style={styles.model}>{service.providerId}</strong><span>{STATUS_LABELS[service.status] ?? "Unknown outcome"}</span></div>
                        <p style={styles.compact}>Web search · {duration(service.durationMs)}{service.httpStatus !== null ? ` · HTTP ${service.httpStatus}` : ""}{service.errorClass ? ` · ${service.errorClass}` : ""} · data classes: {service.dataClasses?.length ? service.dataClasses.join(", ").replaceAll("_", " ") : "not classified"}.</p>
                    </li>)}</ul>
                </>}
                <p style={styles.note}>Records cover instrumented calls only. Provider retention is not verified.</p>
            </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    content: { maxWidth: 600, padding: "2px 0 4px", fontSize: 13, lineHeight: 1.5, overflowWrap: "anywhere", color: "var(--muted)" },
    note: { margin: "6px 0", color: "var(--muted)" },
    compact: { margin: "1px 0 0", color: "var(--muted)" },
    warning: { margin: "10px 0", color: "var(--ink)", fontWeight: 600 },
    usage: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 115px), 1fr))", gap: "6px 16px", margin: "8px 0", color: "var(--ink-2)", fontVariantNumeric: "tabular-nums" },
    calls: { padding: 0, listStyle: "none", margin: "8px 0" },
    call: { padding: "7px 0", borderTop: "1px solid var(--line)" },
    callHeader: { display: "flex", flexWrap: "wrap", gap: "2px 16px", color: "var(--ink)" },
    model: { flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere", fontWeight: 600 },
    agent: { margin: "4px 0 10px", paddingBottom: 10, borderBottom: "1px solid var(--line)" },
    heading: { margin: "0 0 4px", color: "var(--ink)", fontWeight: 600 },
    steps: { display: "flex", flexDirection: "column", gap: 2, margin: "0 0 6px", padding: 0, listStyle: "none", color: "var(--ink-2)" },
    step: { display: "flex", alignItems: "flex-start", gap: 6 },
    icon: { flex: "none", marginTop: 3 },
    line: { margin: "3px 0", color: "var(--ink-2)" },
    label: { color: "var(--ink)", fontWeight: 500 },
    workers: { display: "flex", flexDirection: "column", gap: 2, margin: "2px 0 4px", padding: 0, listStyle: "none" },
    worker: { color: "var(--ink-2)" },
    objective: { color: "var(--ink-2)" },
    workerModel: { color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 12 },
};
