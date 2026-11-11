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
    return new Date(value).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export default function ConversationCleanupPanel() {
    const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [reviewing, setReviewing] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [keeping, setKeeping] = useState<string | null>(null);
    const [message, setMessage] = useState("");
    const pending = loading || reviewing || deleting || keeping !== null;

    const refresh = async () => {
        setLoading(true); setLoadError(false);
        try {
            const items = await loadRecommendations();
            setRecommendations(items);
            const visible = new Set(items.map(item => item.conversationId));
            setSelected(current => new Set([...current].filter(id => visible.has(id))));
        } catch {
            setLoadError(true);
            setMessage("Could not load recommendations. Use Refresh to retry.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { void refresh(); }, []);

    const toggle = (id: string) => {
        if (pending) return;
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const runReview = async () => {
        if (pending) return;
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
        if (pending) return;
        setKeeping(conversationId); setMessage("");
        try {
            const response = await fetch("/api/admin/conversation-cleanup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "dismiss", conversationId }),
            });
            if (!response.ok) throw new Error();
            setRecommendations((current) => current.filter((item) => item.conversationId !== conversationId));
            setSelected((current) => {
                const next = new Set(current);
                next.delete(conversationId);
                return next;
            });
        } catch { setMessage("Could not mark this conversation to keep. Please retry."); }
        finally { setKeeping(null); }
    };

    const deleteSelected = async () => {
        if (pending || loadError) return;
        const ids = recommendations.filter(item => selected.has(item.conversationId)).map(item => item.conversationId);
        if (ids.length === 0 || !window.confirm(`Delete ${ids.length} selected conversation${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
        setDeleting(true);
        setMessage("");
        try {
            const results = await Promise.all(ids.map(async (id) => {
                const response = await fetch(`/api/conversations?id=${encodeURIComponent(id)}`, { method: "DELETE" });
                return response.ok ? id : null;
            }).map((request) => request.catch(() => null)));
            const deleted = new Set(results.filter((id): id is string => id !== null));
            setRecommendations((current) => current.filter((item) => !deleted.has(item.conversationId)));
            setSelected(new Set(ids.filter((id) => !deleted.has(id))));
            setMessage(`Deleted ${deleted.size} conversation${deleted.size === 1 ? "" : "s"} and their linked records.${deleted.size < ids.length ? " Some deletions failed; those chats remain selected for retry." : ""}`);
        } catch {
            setMessage("Some selected conversations could not be deleted.");
        } finally {
            setDeleting(false);
        }
    };

    return (
        <div>
            <div className="panel-head">
                <ShieldAlert size={16} />
                <div className="panel-heading">
                    <h2>Conversation cleanup</h2>
                    <p>Weekly, conservative recommendations for inactive chats. Nothing is deleted automatically.</p>
                </div>
                <button className="icon-btn" onClick={() => void refresh()} title="Refresh recommendations" disabled={pending}>
                    <RefreshCw size={15} className={loading ? "animate-spin" : undefined} />
                </button>
            </div>

            <div style={styles.actions}>
                <button className="btn" onClick={() => void runReview()} disabled={pending}>
                    <RefreshCw size={14} className={reviewing ? "animate-spin" : undefined} />
                    {reviewing ? "Reviewing..." : "Run review now"}
                </button>
                <button className="btn" data-tone="danger" onClick={() => void deleteSelected()} disabled={!selected.size || pending || loadError}>
                    <Trash2 size={14} />
                    {deleting ? "Deleting..." : `Delete selected${selected.size ? ` (${selected.size})` : ""}`}
                </button>
            </div>

            <div className="list scroll" style={styles.list}>
                {recommendations.map((item) => {
                    const isSelected = selected.has(item.conversationId);
                    return <div key={item.conversationId} className="row" style={{ ...styles.row, ...(isSelected ? styles.rowSelected : {}) }}>
                        <label style={styles.selectLabel}>
                            <input type="checkbox" checked={isSelected} disabled={pending || loadError} onChange={() => toggle(item.conversationId)} />
                            <span className="row-title" style={styles.rowTitle}>{item.title || "Untitled conversation"}</span>
                        </label>
                        <div className="meta" style={styles.reason}>{item.reason}</div>
                        <div className="meta" style={styles.meta}>
                            <span style={styles.score}><CheckSquare size={12} /> {item.score}% confidence</span>
                            <span>Reviewed {reviewedAt(item.reviewedAt)}</span>
                            <a href={`/?c=${encodeURIComponent(item.conversationId)}`} style={styles.openLink} title="Open conversation">
                                Open <ExternalLink size={12} />
                            </a>
                            <button className="link-btn" style={{ marginLeft: "auto" }} onClick={() => void dismiss(item.conversationId)} disabled={pending || loadError} title="Keep this conversation"> <X size={14} /> Keep </button>
                        </div>
                    </div>;
                })}
                {!loading && !loadError && recommendations.length === 0 && <div className="empty">No conversations currently meet the conservative deletion threshold.</div>}
            </div>
            {message && <div className="meta" style={{ marginTop: 10 }} role="status">{message}</div>}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    actions: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 },
    // Bleeds into the panel padding so a selected row's fill has side room.
    list: { maxHeight: 490, margin: "0 -8px" },
    row: { padding: "10px 8px" },
    rowSelected: { background: "var(--active)" },
    selectLabel: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", minWidth: 0 },
    rowTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    reason: { margin: "6px 0" },
    meta: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
    score: { display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 500, color: "var(--ink-2)" },
    openLink: { display: "inline-flex", alignItems: "center", gap: 3, color: "var(--accent-text)", textDecoration: "none", fontWeight: 500 },
};
