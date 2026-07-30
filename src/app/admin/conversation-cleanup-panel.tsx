"use client";

import { useEffect, useState } from "react";
import { CheckSquare, ExternalLink, RefreshCw, ShieldAlert, Trash2, X } from "lucide-react";

interface Recommendation {
    conversationId: string;
    title: string;
    score: number;
    reason: string;
    reviewedAt: string;
}

async function loadRecommendations(): Promise<Recommendation[]> {
    const response = await fetch("/api/admin/conversation-cleanup");
    if (!response.ok) throw new Error("Could not load recommendations.");
    const data = await response.json() as { recommendations?: Recommendation[] };
    return data.recommendations ?? [];
}

function reviewedAt(value: string): string {
    return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function ConversationCleanupPanel() {
    const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(true);
    const [reviewing, setReviewing] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [message, setMessage] = useState("");

    const refresh = async () => {
        setLoading(true);
        try {
            setRecommendations(await loadRecommendations());
        } catch {
            setMessage("Could not load recommendations. Apply the latest database setup if this is a new feature.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { void refresh(); }, []);

    const toggle = (id: string) => {
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const runReview = async () => {
        setReviewing(true);
        setMessage("");
        try {
            const response = await fetch("/api/admin/conversation-cleanup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "review" }),
            });
            if (!response.ok) throw new Error();
            const result = await response.json() as { reviewed?: number; recommendations?: number };
            setMessage(`Reviewed ${result.reviewed ?? 0} inactive conversations and found ${result.recommendations ?? 0} recommendation(s).`);
            await refresh();
        } catch {
            setMessage("The review could not finish. Check the model and database configuration.");
        } finally {
            setReviewing(false);
        }
    };

    const dismiss = async (conversationId: string) => {
        await fetch("/api/admin/conversation-cleanup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "dismiss", conversationId }),
        });
        setRecommendations((current) => current.filter((item) => item.conversationId !== conversationId));
        setSelected((current) => {
            const next = new Set(current);
            next.delete(conversationId);
            return next;
        });
    };

    const deleteSelected = async () => {
        const ids = [...selected];
        if (ids.length === 0 || !window.confirm(`Delete ${ids.length} selected conversation${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
        setDeleting(true);
        setMessage("");
        try {
            const results = await Promise.all(ids.map(async (id) => {
                const response = await fetch(`/api/conversations?id=${encodeURIComponent(id)}`, { method: "DELETE" });
                return response.ok ? id : null;
            }));
            const deleted = new Set(results.filter((id): id is string => id !== null));
            setRecommendations((current) => current.filter((item) => !deleted.has(item.conversationId)));
            setSelected(new Set());
            setMessage(`Deleted ${deleted.size} conversation${deleted.size === 1 ? "" : "s"} and their linked records.`);
        } catch {
            setMessage("Some selected conversations could not be deleted.");
        } finally {
            setDeleting(false);
        }
    };

    return (
        <div>
            <div style={styles.header}>
                <div style={styles.headerIcon}><ShieldAlert size={16} /></div>
                <div style={{ flex: 1 }}>
                    <h2 style={styles.title}>Conversation Cleanup</h2>
                    <p style={styles.description}>Weekly, conservative recommendations for inactive chats. Nothing is deleted automatically.</p>
                </div>
                <button style={styles.iconButton} onClick={() => void refresh()} title="Refresh recommendations" disabled={loading}>
                    <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
                </button>
            </div>

            <div style={styles.actions}>
                <button style={styles.reviewButton} onClick={() => void runReview()} disabled={reviewing || deleting}>
                    <RefreshCw size={13} className={reviewing ? "animate-spin" : undefined} />
                    {reviewing ? "Reviewing..." : "Run review now"}
                </button>
                <button style={{ ...styles.deleteButton, opacity: selected.size && !deleting ? 1 : 0.45 }} onClick={() => void deleteSelected()} disabled={!selected.size || deleting}>
                    <Trash2 size={13} />
                    {deleting ? "Deleting..." : `Delete selected${selected.size ? ` (${selected.size})` : ""}`}
                </button>
            </div>

            <div style={styles.list}>
                {recommendations.map((item) => {
                    const isSelected = selected.has(item.conversationId);
                    return <div key={item.conversationId} style={{ ...styles.row, ...(isSelected ? styles.rowSelected : {}) }}>
                        <label style={styles.selectLabel}>
                            <input type="checkbox" checked={isSelected} onChange={() => toggle(item.conversationId)} />
                            <span style={styles.rowTitle}>{item.title || "Untitled conversation"}</span>
                        </label>
                        <div style={styles.reason}>{item.reason}</div>
                        <div style={styles.meta}>
                            <span style={styles.score}><CheckSquare size={11} /> {item.score}% confidence</span>
                            <span>Reviewed {reviewedAt(item.reviewedAt)}</span>
                            <a href={`/?c=${encodeURIComponent(item.conversationId)}`} style={styles.openLink} title="Open conversation">
                                Open <ExternalLink size={11} />
                            </a>
                            <button style={styles.dismissButton} onClick={() => void dismiss(item.conversationId)} title="Keep this conversation"> <X size={13} /> Keep </button>
                        </div>
                    </div>;
                })}
                {!loading && recommendations.length === 0 && <div style={styles.empty}>No conversations currently meet the conservative deletion threshold.</div>}
            </div>
            {message && <div style={styles.message} role="status">{message}</div>}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    header: { display: "flex", gap: 11, alignItems: "flex-start", marginBottom: 14 },
    headerIcon: { width: 32, height: 32, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", color: "#e8b34b", background: "color-mix(in srgb, #e8b34b 13%, transparent)", border: "1px solid color-mix(in srgb, #e8b34b 28%, transparent)", flexShrink: 0 },
    title: { margin: 0, fontSize: 15, fontWeight: 800, letterSpacing: "-0.02em" },
    description: { margin: "3px 0 0", fontSize: 12, lineHeight: 1.45, color: "var(--color-text-muted)" },
    iconButton: { width: 29, height: 29, display: "grid", placeItems: "center", borderRadius: 10, border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)", background: "transparent", color: "var(--color-text-muted)", cursor: "pointer" },
    actions: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 },
    reviewButton: { display: "inline-flex", alignItems: "center", gap: 6, minHeight: 33, padding: "7px 10px", border: 0, borderRadius: 10, color: "white", background: "var(--color-primary)", font: "inherit", fontSize: 12, fontWeight: 750, cursor: "pointer" },
    deleteButton: { display: "inline-flex", alignItems: "center", gap: 6, minHeight: 33, padding: "7px 10px", border: "1px solid color-mix(in srgb, #ff6b5a 42%, transparent)", borderRadius: 10, color: "#ff8f6b", background: "color-mix(in srgb, #ff6b5a 10%, transparent)", font: "inherit", fontSize: 12, fontWeight: 750, cursor: "pointer" },
    list: { display: "flex", flexDirection: "column", gap: 8, maxHeight: 490, overflowY: "auto" },
    row: { padding: "10px 11px", borderRadius: 14, background: "color-mix(in srgb, var(--color-background) 48%, transparent)", border: "1px solid color-mix(in srgb, var(--color-border) 48%, transparent)" },
    rowSelected: { borderColor: "color-mix(in srgb, #e8b34b 55%, transparent)", background: "color-mix(in srgb, #e8b34b 7%, var(--color-background))" },
    selectLabel: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" },
    rowTitle: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, fontWeight: 750 },
    reason: { margin: "7px 0", fontSize: 12, lineHeight: 1.45, color: "var(--color-text-muted)" },
    meta: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11, color: "var(--color-text-muted)" },
    score: { display: "inline-flex", alignItems: "center", gap: 4, color: "#e8b34b", fontWeight: 700 },
    openLink: { display: "inline-flex", alignItems: "center", gap: 3, color: "var(--color-text-primary)", textDecoration: "none", fontWeight: 700 },
    dismissButton: { display: "inline-flex", alignItems: "center", gap: 3, marginLeft: "auto", padding: 0, border: 0, color: "var(--color-text-muted)", background: "transparent", cursor: "pointer", font: "inherit", fontSize: 11, fontWeight: 700 },
    empty: { padding: "14px 4px", fontSize: 12.5, lineHeight: 1.5, color: "var(--color-text-muted)" },
    message: { marginTop: 10, fontSize: 12, color: "var(--color-text-muted)", lineHeight: 1.45 },
};
