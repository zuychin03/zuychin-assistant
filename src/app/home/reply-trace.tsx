"use client";

import { ChevronDown } from "lucide-react";
import type { ReplyTrace } from "@/lib/ai/reply-trace";

const STATUS_LABELS = {
    success: "Succeeded", auth: "Authentication failed", rate_limit: "Rate limited", transient: "Temporary failure",
    unavailable: "Unavailable", retired: "Retired", aborted: "Cancelled", unknown: "Unknown outcome",
};
const measured = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-AU") : "Unknown";
const duration = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value)
    ? value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s` : "Not measured";

export function ReplyTraceDetails({ trace }: { trace: ReplyTrace }) {
    if (trace.version !== 1 || !Array.isArray(trace.calls)) return null;
    return (
        <details style={styles.details}>
            <summary style={styles.summary}>
                <span>Reply details · {trace.calls.length} observed model call{trace.calls.length === 1 ? "" : "s"}</span>
                <ChevronDown size={13} aria-hidden="true" />
            </summary>
            <div style={styles.content}>
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
                <ol style={styles.calls}>
                    {trace.calls.map(call => <li key={call.id} style={styles.call}>
                        <div style={styles.callHeader}><strong style={styles.model}>{call.providerId} / {call.modelId}</strong><span>{STATUS_LABELS[call.status] ?? "Unknown outcome"}</span></div>
                        <p style={styles.note}>{call.purpose} · {duration(call.durationMs)} · first answer {duration(call.firstAnswerMs).toLowerCase()}{call.httpStatus !== null ? ` · HTTP ${call.httpStatus}` : ""}{call.errorClass ? ` · ${call.errorClass}` : ""}</p>
                        <p style={styles.note}>Input {measured(call.usage?.promptTokens)} · output {measured(call.usage?.outputTokens)} · cached input {measured(call.usage?.cachedInputTokens)}</p>
                        <p style={styles.note}>Data classes: {call.dataClasses?.length ? call.dataClasses.join(", ").replaceAll("_", " ") : "Not classified"}{call.dataRoute ? ` · ${call.dataRoute.tier} route` : ""}.</p>
                        {call.groundingRequested && <p style={styles.note}>Grounding requested{call.capabilities.grounding ? "; returned source evidence observed." : "; returned source evidence not observed."}</p>}
                        {!call.groundingRequested && call.capabilities.grounding && <p style={styles.note}>Grounding source evidence observed.</p>}
                        {call.dataRoute?.rule === "shared_embedding_partition" && <p style={styles.note}>Scheduled generation uses the paid key. This embedding uses the existing shared knowledge partition and may be free.</p>}
                    </li>)}
                </ol>
                {!trace.calls.length && <p style={styles.note}>No model calls were recorded in these reply details.</p>}
                {!!trace.externalServices?.length && <>
                    <p style={styles.note}>{trace.externalServices.length} observed external service call{trace.externalServices.length === 1 ? "" : "s"}</p>
                    <ul style={styles.calls}>{trace.externalServices.map(service => <li key={service.id} style={styles.call}>
                        <div style={styles.callHeader}><strong style={styles.model}>{service.providerId}</strong><span>{STATUS_LABELS[service.status] ?? "Unknown outcome"}</span></div>
                        <p style={styles.note}>Web search · {duration(service.durationMs)}{service.httpStatus !== null ? ` · HTTP ${service.httpStatus}` : ""}{service.errorClass ? ` · ${service.errorClass}` : ""}</p>
                        <p style={styles.note}>Data classes: {service.dataClasses?.length ? service.dataClasses.join(", ").replaceAll("_", " ") : "Not classified"}.</p>
                    </li>)}</ul>
                </>}
                <p style={styles.note}>Records cover instrumented calls only. Provider retention is not verified.</p>
            </div>
        </details>
    );
}

export default ReplyTraceDetails;

const styles: Record<string, React.CSSProperties> = {
    details: { marginTop: 8, minWidth: 0, color: "var(--color-text-muted)" },
    summary: { display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 8, minHeight: 44, fontSize: 12, cursor: "pointer", width: "fit-content", maxWidth: "100%" },
    content: { padding: "4px 0 12px", fontSize: 13, lineHeight: 1.5, overflowWrap: "anywhere" },
    note: { margin: "7px 0", color: "var(--color-text-muted)" },
    warning: { margin: "12px 0", color: "var(--color-text-primary)", fontWeight: 600 },
    usage: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 115px), 1fr))", gap: "12px 16px", margin: "14px 0", fontVariantNumeric: "tabular-nums" },
    calls: { padding: 0, listStyle: "none", margin: "16px 0 12px" },
    call: { padding: "12px 0", borderTop: "1px solid var(--color-border)" },
    callHeader: { display: "flex", flexWrap: "wrap", gap: "6px 16px", color: "var(--color-text-primary)" },
    model: { flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere", fontWeight: 600 },
};
