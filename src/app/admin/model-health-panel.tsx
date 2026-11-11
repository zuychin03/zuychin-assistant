"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ChevronDown, RefreshCw } from "lucide-react";
import { Dropdown } from "@/components/dropdown";
import type { ModelHealthEntry, ModelHealthReport } from "@/lib/ai/model-health";

const STATUS_LABELS = {
    success: "Succeeded", auth: "Authentication failed", rate_limit: "Rate limited", transient: "Temporary failure",
    unavailable: "Unavailable", retired: "Retired (HTTP 410)", aborted: "Cancelled", unknown: "Unknown outcome",
};
const STATUS_TONES: Partial<Record<keyof typeof STATUS_LABELS, string>> = {
    success: "success", auth: "danger", unavailable: "danger", retired: "danger", rate_limit: "warning", transient: "warning",
};
const CAPABILITY_LABELS = { streaming: "Streaming", tools: "Tool calls", vision: "Vision", grounding: "Grounding" };

function localTime(value: string | null): string {
    return value ? new Date(value).toLocaleString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Not observed";
}
function latency(value: number | null): string {
    if (value === null) return "Not measured";
    return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}

function ModelRow({ model, storageAvailable }: { model: ModelHealthEntry; storageAvailable: boolean }) {
    const health = model.health;
    const latestLabel = !storageAvailable ? "Records unavailable" : health ? STATUS_LABELS[health.latestStatus] : "No observations";
    return (
        <details className="row" style={styles.row}>
            <summary style={styles.summary}>
                <span style={styles.modelName}>{model.modelLabel}<span className="meta" style={styles.secondary}>{model.providerLabel} · {model.kind === "historical" ? "Historical route" : model.kind}</span></span>
                <span className="tone" data-tone={storageAvailable && health ? STATUS_TONES[health.latestStatus] : undefined} style={styles.outcome}>{latestLabel}</span>
                <span className="meta">{health ? localTime(health.latestAt) : "Unknown health"}</span>
                <ChevronDown size={16} aria-hidden="true" style={{ flexShrink: 0, color: "var(--muted)" }} />
            </summary>
            <div style={styles.detail}>
                <p className="meta" style={styles.route}>{model.providerId} / {model.modelId}</p>
                <p className="meta" style={styles.note}>{model.catalogue === "historical" ? "Not in the current catalogue; retirement is unconfirmed."
                    : model.configured ? `Route configured${model.free ? " · eligible for Free only" : " · not eligible for Free only"}.`
                        : model.unavailableReason ?? "Route is not available."}</p>
                {health ? (
                    <>
                        <dl className="facts" style={styles.measurements}>
                            <div><dt>Last successful request</dt><dd>{localTime(health.lastSuccessfulAt)}</dd></div>
                            <div><dt>Latest request duration</dt><dd>{latency(health.latestDurationMs)}</dd></div>
                            <div><dt>Latest first answer</dt><dd>{latency(health.latestFirstAnswerMs)}</dd></div>
                            <div><dt>Median successful duration</dt><dd>{latency(health.medianSuccessDurationMs)}</dd></div>
                            <div><dt>Median first answer</dt><dd>{latency(health.medianFirstAnswerMs)}</dd></div>
                            <div><dt>Latest failure class / HTTP</dt><dd>{health.latestErrorClass ?? "None reported"}{health.latestHttpStatus !== null ? ` / ${health.latestHttpStatus}` : ""}</dd></div>
                        </dl>
                        <p className="meta" style={styles.note}>{health.totalCalls.toLocaleString()} recorded requests: {health.successfulCalls.toLocaleString()} succeeded, {health.failedCalls.toLocaleString()} failed, {health.abortedCalls.toLocaleString()} cancelled, {health.unknownCalls.toLocaleString()} unknown. Since {localTime(health.firstObservedAt)}.</p>
                        <p className="meta" style={styles.note}>Observed work: {health.purposes.join(", ")}. Medians use all retained successful observations; first-answer timings exclude unmeasured calls.</p>
                    </>
                ) : <p className="meta" style={styles.note}>{storageAvailable ? "No recorded requests for this model. Configuration does not establish health or capability support." : "Recorded health cannot be checked until storage is available."}</p>}
                <dl className="facts" style={styles.measurements}>
                    {Object.entries(model.capabilities).map(([key, capability]) => (
                        <div key={key}><dt>{CAPABILITY_LABELS[key as keyof typeof CAPABILITY_LABELS]}</dt><dd>{capability.observedAt ? `Observed ${localTime(capability.observedAt)}` : "Unknown"}</dd></div>
                    ))}
                </dl>
                <p className="meta" style={styles.note}>Capabilities reflect observed output, not catalogue claims. Missing evidence does not mean unsupported.</p>
            </div>
        </details>
    );
}

export default function ModelHealthPanel() {
    const [report, setReport] = useState<ModelHealthReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [provider, setProvider] = useState("");
    const requestRef = useRef<AbortController | null>(null);

    const refresh = useCallback(async () => {
        requestRef.current?.abort();
        const controller = new AbortController();
        requestRef.current = controller;
        setLoading(true);
        setError(null);
        try {
            const response = await fetch("/api/admin/model-health", { cache: "no-store", signal: controller.signal });
            const data = await response.json() as ModelHealthReport;
            if (controller.signal.aborted) return;
            if ((response.ok || response.status === 503) && data.scope === "assistant" && Array.isArray(data.models) && data.storage) setReport(data);
            else throw new Error(response.status === 401 ? "Sign in again to view model health." : "Model health could not be loaded. Retry the request.");
        } catch (failure) {
            if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Model health could not be loaded. Retry the request.");
        } finally {
            if (!controller.signal.aborted) setLoading(false);
        }
    }, []);

    useEffect(() => { void refresh(); return () => requestRef.current?.abort(); }, [refresh]);
    const providerOptions = [...new Map((report?.models ?? []).map(model => [model.providerId, model.providerLabel])).entries()];
    const needle = query.trim().toLocaleLowerCase();
    const models = (report?.models ?? []).filter(model => (!provider || model.providerId === provider)
        && (!needle || `${model.modelLabel} ${model.modelId} ${model.providerLabel} ${model.providerId}`.toLocaleLowerCase().includes(needle)));
    const failure = error ?? (!report?.storage.available ? report?.storage.message : null);

    return (
        <div>
            <div className="panel-head">
                <Activity size={16} aria-hidden="true" />
                <div className="panel-heading">
                    <h2>Model health</h2>
                    <p>Passive observations from assistant requests. Refresh reads stored metadata and never calls a model.</p>
                </div>
                <button type="button" className="btn" onClick={() => { void refresh(); }} disabled={loading} aria-label="Refresh model health">
                    <RefreshCw size={15} className={loading ? "animate-spin" : undefined} />
                    {loading ? "Loading" : "Refresh"}
                </button>
            </div>
            {failure && <div className="notice" data-tone="danger" role="alert" style={styles.feedback}>
                <span>{failure}{error && report ? " The last loaded records are shown below." : ""}</span>
                <button type="button" className="btn" disabled={loading} onClick={() => { void refresh(); }}>Retry model health</button>
            </div>}
            {loading && !report && <p role="status" className="empty">Loading the catalogue and recorded observations…</p>}
            {report && <>
                <div style={styles.filters}>
                    <label style={styles.filter}><span>Find a model</span><input className="field" style={styles.input} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Model or provider" /></label>
                    <label style={styles.filter}><span>Provider</span><Dropdown ariaLabel="Model health provider" className="field" style={{ ...styles.input, flex: "none" }} value={provider} onChange={setProvider} options={[{ value: "", label: "All providers" }, ...providerOptions.map(([value, label]) => ({ value, label }))]} /></label>
                </div>
                <p className="meta" role="status">{models.length} of {report.models.length} models shown. Times use your browser&apos;s local timezone. Loaded {localTime(report.generatedAt)}.</p>
                <div className="list scroll" style={styles.list}>
                    {models.map(model => <ModelRow key={`${model.providerId}:${model.modelId}`} model={model} storageAvailable={report.storage.available} />)}
                    {!models.length && <p className="empty">No models match these filters. Clear the search or select another provider.</p>}
                </div>
            </>}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    feedback: { marginBottom: 12 },
    filters: { display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 10 },
    filter: { display: "flex", flexDirection: "column", gap: 6, flex: "1 1 220px", minWidth: 0, fontSize: 13, color: "var(--muted)" },
    input: { width: "100%", padding: "0 10px", background: "var(--surface)" },
    list: { marginTop: 12, maxHeight: 580, scrollbarGutter: "stable" },
    row: { padding: 0 },
    summary: { display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 16, rowGap: 6, minHeight: 56, padding: "10px 0", cursor: "pointer" },
    modelName: { flex: "1 1 220px", minWidth: 0, overflowWrap: "anywhere", fontSize: 14, fontWeight: 600 },
    secondary: { display: "block", marginTop: 2, fontWeight: 400 },
    outcome: { flex: "0 1 160px", fontSize: 13, fontWeight: 500 },
    detail: { padding: "0 0 16px" },
    route: { marginBottom: 6, fontFamily: "var(--font-mono)", fontSize: 12 },
    note: { margin: "6px 0" },
    measurements: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: "14px 24px", margin: "16px 0", lineHeight: 1.45, fontVariantNumeric: "tabular-nums" },
};
