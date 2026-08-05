"use client";

import { useState } from "react";
import { GitMerge, ShieldCheck } from "lucide-react";

// The last step of a code council. Every task passing on its own says nothing
// about whether they work together, so the host assembles them on a clean
// branch cut from base and runs the project's own checks there.
//
// Nominating an integrator delegates that ASSEMBLY, not the decision to ship:
// the integration branch is never the base branch, and merging it stays manual.

interface Campaign {
    status: string;
    baseBranch: string;
    integratorAgent: string | null;
    integrationBranch: string | null;
    integrationStatus: string | null;
    integrationReport: string | null;
    integrationCheckedAt: string | null;
}

const TONE: Record<string, string> = {
    verified: "#31d07f",
    running: "#e0a33e",
    pending: "#e0a33e",
    conflict: "#e5484d",
    failed: "#e5484d",
};

export function IntegrationPanel({ code, campaign, agentNames, onChange }: {
    code: string;
    campaign: Campaign;
    agentNames: string[];
    onChange: () => void;
}) {
    const [agent, setAgent] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function nominate() {
        const agentName = agent.trim();
        if (!agentName || busy) return;
        setBusy(true);
        setError("");
        try {
            const res = await fetch(`/api/council/${encodeURIComponent(code)}/integrator`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ agentName }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({})) as { error?: string };
                setError(data.error ?? "Could not nominate an integrator.");
                return;
            }
            setAgent("");
            onChange();
        } catch {
            setError("Could not nominate an integrator.");
        } finally {
            setBusy(false);
        }
    }

    const status = campaign.integrationStatus;
    const tone = status ? TONE[status] ?? "var(--color-text-muted)" : "var(--color-text-muted)";

    return (
        <div style={styles.wrap}>
            <div style={styles.head}><GitMerge size={15} /><span>Integration</span></div>

            {status ? (
                <>
                    <div style={styles.statusRow}>
                        <span style={{ ...styles.pill, color: tone, borderColor: `color-mix(in srgb, ${tone} 50%, transparent)` }}>
                            {status}
                        </span>
                        {campaign.integrationBranch && <code style={styles.branch}>{campaign.integrationBranch}</code>}
                        {campaign.integratorAgent && <span style={styles.meta}>by {campaign.integratorAgent}</span>}
                    </div>
                    {campaign.integrationReport && (
                        <pre style={styles.report}>{campaign.integrationReport}</pre>
                    )}
                    {status === "verified" && (
                        <div style={styles.merged}>
                            <ShieldCheck size={13} /> Assembled and checked. Merging into{" "}
                            <code style={styles.branch}>{campaign.baseBranch}</code> is still yours to do.
                        </div>
                    )}
                </>
            ) : (
                <div style={styles.note}>
                    {campaign.status === "complete"
                        ? "Every task is accepted. The host assembles them on a clean branch when it next ticks, or nominate one agent to do it."
                        : "Runs once every task has been accepted."}
                </div>
            )}

            {campaign.status === "complete" && (
                <div style={styles.row}>
                    <input
                        value={agent}
                        onChange={(e) => setAgent(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void nominate(); } }}
                        placeholder="Delegate the assembly to…"
                        list={`integrators-${code}`}
                        style={styles.input}
                    />
                    <datalist id={`integrators-${code}`}>
                        {agentNames.map((n) => <option key={n} value={n} />)}
                    </datalist>
                    <button type="button" onClick={nominate} disabled={busy || !agent.trim()} style={styles.button}>
                        Delegate
                    </button>
                </div>
            )}

            {error && <div style={styles.error}>{error}</div>}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    wrap: {
        display: "flex", flexDirection: "column", gap: 9, marginTop: 12, padding: 12, borderRadius: 12,
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-text-muted) 25%, transparent)",
        background: "color-mix(in srgb, var(--color-text-muted) 5%, transparent)",
    },
    head: {
        display: "flex", alignItems: "center", gap: 7,
        fontSize: 12.5, fontWeight: 700, color: "var(--color-text-primary)",
    },
    statusRow: { display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" },
    pill: {
        fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 999,
        borderWidth: 1, borderStyle: "solid", background: "transparent",
    },
    branch: { fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 11.5 },
    meta: { fontSize: 11.5, color: "var(--color-text-muted)" },
    note: { fontSize: 11.5, color: "var(--color-text-muted)", lineHeight: 1.5 },
    report: {
        margin: 0, padding: 9, borderRadius: 9, maxHeight: 220, overflow: "auto",
        fontSize: 11, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word",
        background: "color-mix(in srgb, var(--color-text-muted) 10%, transparent)",
        color: "var(--color-text-primary)",
    },
    merged: {
        display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
        fontSize: 11.5, color: "var(--color-text-muted)",
    },
    row: { display: "flex", gap: 8 },
    input: {
        flex: 1, padding: "6px 10px", borderRadius: 9, fontSize: 12.5,
        fontFamily: "var(--font-family)",
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-text-muted) 30%, transparent)",
        background: "var(--color-background)", color: "var(--color-text-primary)",
    },
    button: {
        padding: "6px 13px", borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: "pointer",
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-text-muted) 35%, transparent)",
        background: "transparent", color: "var(--color-text-primary)",
    },
    error: { fontSize: 12, color: "#e5484d" },
};
