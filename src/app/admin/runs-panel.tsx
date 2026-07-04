"use client";

import { useState, useEffect } from "react";
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
    usage: { totalTokens?: number; llmCalls?: number; workerTokens?: number };
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

const STATUS_COLORS: Record<RunSummary["status"], string> = {
    running: "#7aa2ff",
    done: "#31d07f",
    error: "#ff6b5a",
    timeout: "#e8b34b",
};

async function loadRuns(): Promise<RunSummary[]> {
    try {
        const res = await fetch("/api/admin/runs");
        if (!res.ok) return [];
        const data = await res.json();
        return data.runs ?? [];
    } catch {
        return [];
    }
}

function formatDuration(start: string, end: string | null): string {
    if (!end) return "…";
    const secs = Math.max(0, (new Date(end).getTime() - new Date(start).getTime()) / 1000);
    return secs < 60 ? `${secs.toFixed(0)}s` : `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
}

function formatTokens(n?: number): string {
    if (!n) return "–";
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
    const [expanded, setExpanded] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        loadRuns().then((data) => {
            if (cancelled) return;
            setRuns(data);
            setLoading(false);
        });
        return () => { cancelled = true; };
    }, []);

    const refresh = () => {
        setLoading(true);
        loadRuns().then((data) => {
            setRuns(data);
            setLoading(false);
        });
    };

    const toggle = async (id: string) => {
        if (expanded === id) {
            setExpanded(null);
            return;
        }
        setExpanded(id);
        if (!details[id]) {
            try {
                const res = await fetch(`/api/admin/runs?id=${id}`);
                if (res.ok) {
                    const data = await res.json();
                    setDetails((d) => ({ ...d, [id]: data.run }));
                }
            } catch { }
        }
    };

    return (
        <div>
            <div style={panelStyles.header}>
                <div style={panelStyles.headerIcon}><Workflow size={16} /></div>
                <div style={{ flex: 1 }}>
                    <h2 style={panelStyles.title}>Agent Runs</h2>
                    <p style={panelStyles.description}>Recent agent executions with steps, tools and token usage</p>
                </div>
                <button style={panelStyles.refreshBtn} onClick={refresh} title="Refresh runs">
                    <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
                </button>
            </div>
            <div style={panelStyles.list}>
                {runs.map((run) => {
                    const isOpen = expanded === run.id;
                    const detail = details[run.id];
                    return (
                        <div key={run.id} style={panelStyles.row}>
                            <button style={panelStyles.rowHead} onClick={() => toggle(run.id)}>
                                <span style={{ ...panelStyles.dot, background: STATUS_COLORS[run.status] }} />
                                <span style={panelStyles.rowMessage}>{run.message}</span>
                                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            </button>
                            <div style={panelStyles.rowMeta}>
                                {run.status} · {formatDuration(run.startedAt, run.finishedAt)} · {formatTokens(run.usage?.totalTokens)}
                                {run.model ? ` · ${run.model}` : ""}
                            </div>
                            {isOpen && (
                                <div style={panelStyles.detail}>
                                    {run.plan.length > 0 && (
                                        <div style={panelStyles.detailBlock}>
                                            {run.plan.map((s, i) => (
                                                <div key={i} style={panelStyles.planLine}>
                                                    <span>{s.status === "done" ? "✓" : s.status === "in_progress" ? "▸" : "○"}</span>
                                                    <span style={s.status === "done" ? panelStyles.planDone : undefined}>{s.title}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {detail ? (
                                        <>
                                            <div style={panelStyles.detailBlock}>
                                                {buildTimeline(detail.events).map((line, i) => (
                                                    <div key={i} style={panelStyles.timelineLine}>
                                                        <span style={panelStyles.timelineLabel}>
                                                            {line.label.startsWith("artifact:") && <FileText size={11} style={{ marginRight: 4, verticalAlign: -1 }} />}
                                                            {line.label}
                                                        </span>
                                                        {line.duration && <span style={panelStyles.timelineDuration}>{line.duration}</span>}
                                                    </div>
                                                ))}
                                                {detail.events.length === 0 && <div style={panelStyles.muted}>No events recorded.</div>}
                                            </div>
                                            {detail.error && <div style={panelStyles.errorText}>{detail.error}</div>}
                                        </>
                                    ) : (
                                        <div style={panelStyles.muted}>Loading…</div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
                {!loading && runs.length === 0 && <div style={panelStyles.muted}>No agent runs yet.</div>}
            </div>
        </div>
    );
}

const panelStyles: Record<string, React.CSSProperties> = {
    header: { display: "flex", gap: 11, alignItems: "flex-start", marginBottom: 14 },
    headerIcon: {
        width: 32,
        height: 32,
        borderRadius: 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in srgb, var(--color-background) 58%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
        flexShrink: 0,
    },
    title: { fontSize: 15, fontWeight: 800, letterSpacing: "-0.02em", margin: 0 },
    description: { margin: "3px 0 0", fontSize: 12, color: "var(--color-text-muted)" },
    refreshBtn: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: 10,
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
        background: "transparent",
        color: "var(--color-text-muted)",
        cursor: "pointer",
        flexShrink: 0,
    },
    list: { display: "flex", flexDirection: "column", gap: 9 },
    row: {
        padding: "10px 12px",
        borderRadius: 16,
        background: "color-mix(in srgb, var(--color-background) 48%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 48%, transparent)",
    },
    rowHead: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: 0,
        border: "none",
        background: "transparent",
        color: "var(--color-text-primary)",
        cursor: "pointer",
        textAlign: "left",
        fontSize: 13,
        fontWeight: 650,
    },
    dot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
    rowMessage: {
        flex: 1,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: 0,
    },
    rowMeta: { marginTop: 4, marginLeft: 16, fontSize: 11.5, color: "var(--color-text-muted)" },
    detail: { marginTop: 10, display: "flex", flexDirection: "column", gap: 10 },
    detailBlock: {
        padding: "9px 10px",
        borderRadius: 12,
        background: "color-mix(in srgb, var(--color-background) 62%, transparent)",
        display: "flex",
        flexDirection: "column",
        gap: 5,
    },
    planLine: { display: "flex", gap: 7, fontSize: 12.5, alignItems: "baseline" },
    planDone: { color: "var(--color-text-muted)", textDecoration: "line-through" },
    timelineLine: { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 },
    timelineLabel: { color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 },
    timelineDuration: { color: "var(--color-text-muted)", flexShrink: 0, fontVariantNumeric: "tabular-nums" },
    errorText: { fontSize: 12, color: "#ff6b5a", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
    muted: { color: "var(--color-text-muted)", fontSize: 12.5, padding: 4 },
};
