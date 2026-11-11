"use client";

import { useState, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, FileText, RefreshCw, Workflow } from "lucide-react";

interface PlanStep {
    title: string;
    status: "pending" | "in_progress" | "done";
}

interface RunSummary {
    id: string;
    status: "running" | "done" | "error" | "timeout";
    message: string;
    model: string | null;
    plan: PlanStep[];
    usage: { totalTokens?: number; llmCalls?: number; workerTokens?: number | null };
    startedAt: string;
    finishedAt: string | null;
}

interface RunEvent {
    t: string;
    type: string;
    name?: string;
    phase?: "start" | "done";
    objective?: string;
    model?: string;
    message?: string;
    artifact?: { name?: string };
}

interface RunDetail extends RunSummary {
    events: RunEvent[];
    reply: string | null;
    error: string | null;
}

const STATUS_TONES: Record<RunSummary["status"], string | undefined> = {
    running: undefined,
    done: "success",
    error: "danger",
    timeout: "warning",
};

async function loadRuns(): Promise<RunSummary[]> {
    const res = await fetch("/api/admin/runs");
    if (!res.ok) throw new Error("Could not load runs. Please retry.");
    const data = await res.json();
    return data.runs ?? [];
}

function formatDuration(start: string, end: string | null): string {
    if (!end) return "…";
    const secs = Math.max(0, (new Date(end).getTime() - new Date(start).getTime()) / 1000);
    return secs < 60 ? `${secs.toFixed(0)}s` : `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
}

function formatTokens(n?: number): string {
    if (n == null || !Number.isFinite(n)) return "Not measured";
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

// Pairs sequential start/done events of the same name into one timeline line.
function buildTimeline(events: RunEvent[]): { label: string; duration?: string }[] {
    const lines: { label: string; duration?: string }[] = [];
    const open = new Map<string, { index: number; t: string }>();
    for (const e of events) {
        if (e.type === "tool" || e.type === "subagent") {
            const key = e.type === "tool" ? `tool:${e.name}` : `sub:${e.objective}`;
            const label = e.type === "tool" ? e.name ?? "tool" : `worker (${e.model ?? "auto"}): ${(e.objective ?? "").slice(0, 70)}`;
            if (e.phase === "start") {
                open.set(key, { index: lines.length, t: e.t });
                lines.push({ label });
            } else {
                const started = open.get(key);
                if (started) {
                    lines[started.index].duration = formatDuration(started.t, e.t);
                    open.delete(key);
                }
            }
        } else if (e.type === "artifact") {
            lines.push({ label: `artifact: ${e.artifact?.name ?? "file"}` });
        }
    }
    return lines;
}

export default function RunsPanel() {
    const [runs, setRuns] = useState<RunSummary[]>([]);
    const [details, setDetails] = useState<Record<string, RunDetail>>({});
    const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
    const [expanded, setExpanded] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const detailVersion = useRef(0);
    const expandedRef = useRef<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        loadRuns().then((data) => {
            if (cancelled) return;
            setRuns(data);
            setError("");
        }).catch(() => { if (!cancelled) setError("Could not load runs. Use Refresh to retry."); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, []);

    const refresh = () => {
        detailVersion.current += 1;
        setLoading(true);
        loadRuns().then((data) => {
            setRuns(data);
            setError("");
            setDetails({});
            setDetailErrors({});
            const current = expandedRef.current;
            if (current && data.some(run => run.id === current)) void loadDetail(current);
        }).catch(() => {
            setError("Could not load runs. Use Refresh to retry.");
            const current = expandedRef.current;
            if (current && !details[current]) setDetailErrors(errors => ({ ...errors, [current]: "Could not refresh run details." }));
        })
            .finally(() => setLoading(false));
    };

    const loadDetail = async (id: string) => {
        const version = detailVersion.current;
        setDetailErrors((errors) => ({ ...errors, [id]: "" }));
        try {
            const response = await fetch("/api/admin/runs?id=" + encodeURIComponent(id));
            if (!response.ok) throw new Error();
            const data = await response.json();
            if (!data.run) throw new Error();
            if (version !== detailVersion.current) return;
            setDetails((items) => ({ ...items, [id]: data.run }));
        } catch { if (version === detailVersion.current) setDetailErrors((errors) => ({ ...errors, [id]: "Could not load run details." })); }
    };
    const toggle = (id: string) => {
        if (loading) return;
        if (expanded === id) { expandedRef.current = null; setExpanded(null); return; }
        expandedRef.current = id;
        setExpanded(id);
        if (!details[id]) void loadDetail(id);
    };

    return (
        <div>
            <div className="panel-head">
                <Workflow size={16} />
                <div className="panel-heading">
                    <h2>Agent runs</h2>
                    <p>Recent agent executions with steps, tools and token usage</p>
                </div>
                <button className="icon-btn" onClick={refresh} disabled={loading} title="Refresh runs">
                    <RefreshCw size={15} className={loading ? "animate-spin" : undefined} />
                </button>
            </div>
            {error && <p role="alert" className="error" style={{ marginBottom: 12 }}>{error}</p>}
            {loading && <p role="status" className="empty">Loading runs…</p>}
            {/* Runs accumulate without bound; taller than the skills/memories lists because rows expand. */}
            <div className="list scroll" style={{ maxHeight: 420 }}>
                {runs.map((run) => {
                    const isOpen = expanded === run.id;
                    const detail = details[run.id];
                    return (
                        <div key={run.id} className="row">
                            <button className="row-toggle" style={styles.rowHead} aria-expanded={isOpen} aria-controls={"run-" + run.id} onClick={() => toggle(run.id)} disabled={loading}>
                                <span className="dot" data-tone={STATUS_TONES[run.status]} />
                                <span style={styles.rowMessage}>{run.message}</span>
                                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                            <div className="meta" style={styles.rowMeta}>
                                {run.status} · {formatDuration(run.startedAt, run.finishedAt)} · {formatTokens(run.usage?.totalTokens)}
                                {run.model ? ` · ${run.model}` : ""}
                            </div>
                            {isOpen && (
                                <div id={"run-" + run.id} style={styles.detail}>
                                    {run.plan.length > 0 && (
                                        <div className="inset" style={styles.detailBlock}>
                                            {run.plan.map((s, i) => (
                                                <div key={i} style={styles.planLine}>
                                                    <span style={styles.planMark}>{s.status === "done" ? "✓" : s.status === "in_progress" ? "▸" : "○"}</span>
                                                    <span style={s.status === "done" ? styles.planDone : undefined}>{s.title}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {detail ? (
                                        <>
                                            <div className="inset" style={styles.detailBlock}>
                                                {buildTimeline(detail.events).map((line, i) => (
                                                    <div key={i} style={styles.timelineLine}>
                                                        <span style={styles.timelineLabel}>
                                                            {line.label.startsWith("artifact:") && <FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} />}
                                                            {line.label}
                                                        </span>
                                                        {line.duration && <span className="meta" style={{ flexShrink: 0 }}>{line.duration}</span>}
                                                    </div>
                                                ))}
                                                {detail.events.length === 0 && <div className="meta">No events recorded.</div>}
                                            </div>
                                            {detail.error && <div className="error" style={styles.errorText}>{detail.error}</div>}
                                        </>
                                    ) : (
                                        <div className="meta">{detailErrors[run.id] ? <><p role="alert">{detailErrors[run.id]}</p><button type="button" className="link-btn" style={{ marginTop: 4 }} onClick={() => void loadDetail(run.id)}>Retry details</button></> : <span role="status">Loading details…</span>}</div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
                {!loading && !error && runs.length === 0 && <div className="empty">No agent runs yet.</div>}
            </div>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    rowHead: { fontSize: 14, fontWeight: 500 },
    rowMessage: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    rowMeta: { marginTop: 2, marginLeft: 16, overflowWrap: "anywhere" },
    detail: { display: "flex", flexDirection: "column", gap: 8, marginTop: 10 },
    detailBlock: { display: "flex", flexDirection: "column", gap: 5 },
    planLine: { display: "flex", alignItems: "baseline", gap: 8, fontSize: 13 },
    planMark: { flexShrink: 0, color: "var(--muted)" },
    planDone: { color: "var(--muted)", textDecoration: "line-through" },
    timelineLine: { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 },
    timelineLabel: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    errorText: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
};
