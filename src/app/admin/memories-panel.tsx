"use client";

import { useState, useEffect } from "react";
import { Brain, Check, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { PROMOTE_EVIDENCE_COUNT } from "@/lib/types";
import { Dropdown } from "@/components/dropdown";
import { ConfirmModal } from "../home/controls";

interface MemoryFact {
    id: string;
    fact: string;
    category: string;
    projectId: string | null;
    source: string;
    status?: "candidate" | "confirmed";
    evidenceCount?: number;
    updatedAt: string;
}

const CATEGORIES = ["identity", "preference", "relationship", "project", "routine", "fact", "other"];

async function loadMemories(): Promise<MemoryFact[]> {
    const res = await fetch("/api/admin/memories");
    if (!res.ok) throw new Error("Could not load memories. Please retry.");
    const data = await res.json();
    return data.memories ?? [];
}

export default function MemoriesPanel({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
    const [memories, setMemories] = useState<MemoryFact[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editText, setEditText] = useState("");
    const [editOriginal, setEditOriginal] = useState("");
    const [newFact, setNewFact] = useState("");
    const [newCategory, setNewCategory] = useState("fact");
    const [adding, setAdding] = useState(false);
    const [busy, setBusy] = useState(false);
    const [forgetting, setForgetting] = useState<MemoryFact | null>(null);

    useEffect(() => {
        let cancelled = false;
        loadMemories().then((data) => {
            if (cancelled) return;
            setMemories(data);
            setError("");
        }).catch(() => { if (!cancelled) setError("Could not load memories. Use Refresh to retry."); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, []);

    const editDirty = editingId !== null && editText !== editOriginal;
    useEffect(() => { onDirtyChange?.(editDirty || newFact.trim().length > 0); }, [editDirty, newFact, onDirtyChange]);
    const discardEdit = () => !editDirty || window.confirm("Discard your unsaved memory edit?");
    const refresh = (afterAdd = false) => {
        if (!afterAdd && (loading || busy || adding || !discardEdit())) return;
        if (!afterAdd) setEditingId(null);
        setLoading(true);
        loadMemories().then((data) => {
            setMemories(data);
            setError("");
        }).catch(() => setError("Could not load memories. Use Refresh to retry."))
            .finally(() => setLoading(false));
    };

    const saveEdit = async (id: string) => {
        const fact = editText.trim();
        if (!fact || loading || busy || adding) return;
        setBusy(true); setError("");
        try {
            const response = await fetch("/api/admin/memories", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, fact }) });
            if (!response.ok) throw new Error();
            setMemories((items) => items.map((item) => item.id === id ? { ...item, fact } : item));
            setEditingId(null);
        } catch { setError("Could not save this fact. Your edit is still here; please retry."); }
        finally { setBusy(false); }
    };

    const remove = async (id: string) => {
        if (loading || busy || adding) return;
        setBusy(true); setError("");
        try {
            const response = await fetch("/api/admin/memories?id=" + encodeURIComponent(id), { method: "DELETE" });
            if (!response.ok) throw new Error();
            setMemories((items) => items.filter((item) => item.id !== id));
            if (editingId === id) setEditingId(null);
        } catch { setError("Could not forget this fact. Please retry."); }
        finally { setBusy(false); setForgetting(null); }
    };

    const add = async () => {
        const fact = newFact.trim();
        if (!fact || loading || adding || busy) return;
        setAdding(true); setError("");
        try {
            const res = await fetch("/api/admin/memories", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fact, category: newCategory }),
            });
            if (!res.ok) throw new Error();
            setNewFact("");
            refresh(true);
        } catch { setError("Could not add this fact. Your text is still here; please retry."); }
        setAdding(false);
    };

    return (
        <div>
            <div className="panel-head">
                <Brain size={16} />
                <div className="panel-heading">
                    <h2>Long-term memory</h2>
                    <p>Extracted facts the assistant remembers across conversations</p>
                </div>
                <button className="icon-btn" onClick={() => refresh()} disabled={loading || busy || adding} title="Refresh memories">
                    <RefreshCw size={15} className={loading ? "animate-spin" : undefined} />
                </button>
            </div>

            <div style={styles.addRow}>
                <input
                    className="field"
                    style={styles.addInput}
                    disabled={loading || adding || busy}
                    value={newFact}
                    onChange={(e) => setNewFact(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") add(); }}
                    aria-label="New memory fact"
                    placeholder="Add a fact to remember…"
                />
                <Dropdown
                    ariaLabel="Category"
                    className="field"
                    style={styles.categorySelect}
                    disabled={loading || adding || busy}
                    value={newCategory}
                    onChange={setNewCategory}
                    options={CATEGORIES as readonly string[]}
                />
                <button className="btn" style={styles.square} onClick={add} disabled={loading || adding || busy || !newFact.trim()} title="Save fact">
                    <Plus size={15} />
                </button>
            </div>

            {error && <p role="alert" className="error" style={{ marginBottom: 12 }}>{error}</p>}
            {loading && <p role="status" className="empty">Loading memories…</p>}
            <div className="list scroll" style={{ maxHeight: 340 }}>
                {memories.map((m) => (
                    <div key={m.id} className="row">
                        {editingId === m.id ? (
                            <div style={styles.editWrap}>
                                <textarea
                                    aria-label="Edit memory fact"
                                    className="field"
                                    style={styles.editArea}
                                    disabled={loading || busy || adding}
                                    value={editText}
                                    onChange={(e) => setEditText(e.target.value)}
                                    rows={2}
                                    autoFocus
                                />
                                <div style={styles.editActions}>
                                    <button className="icon-btn" onClick={() => saveEdit(m.id)} disabled={loading || busy || adding || !editText.trim()} title="Save"><Check size={15} /></button>
                                    <button className="icon-btn" onClick={() => { if (discardEdit()) setEditingId(null); }} disabled={loading || busy || adding} title="Cancel"><X size={15} /></button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <div style={styles.factText}>{m.fact}</div>
                                <div style={styles.rowFooter}>
                                    <span className="pill">{m.category}</span>
                                    {m.status === "candidate" && (
                                        <span className="pill" style={{ borderStyle: "dashed" }} title="Unconfirmed work/study pattern - becomes a Known Fact when it repeats in another conversation">
                                            pattern {m.evidenceCount ?? 1}/{PROMOTE_EVIDENCE_COUNT}
                                        </span>
                                    )}
                                    <span className="meta">
                                        {m.projectId ? "project · " : ""}{new Date(m.updatedAt).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" })}
                                    </span>
                                    <span style={{ flex: 1 }} />
                                    <button className="icon-btn" onClick={() => { if (discardEdit()) { setEditingId(m.id); setEditText(m.fact); setEditOriginal(m.fact); } }} disabled={loading || busy || adding} title="Edit fact">
                                        <Pencil size={14} />
                                    </button>
                                    <button className="icon-btn" data-tone="danger" onClick={() => setForgetting(m)} disabled={loading || busy || adding} title="Forget fact">
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                ))}
                {!loading && !error && memories.length === 0 && <div className="empty">Nothing remembered yet - facts appear here as you chat.</div>}
            </div>
            {forgetting && <ConfirmModal title="Forget this fact?" body={`“${forgetting.fact}” will be removed from long-term memory. This cannot be undone.${editingId === forgetting.id && editDirty ? " Its unsaved edit will also be discarded." : ""}`}
                confirmLabel="Forget fact" busyText={busy ? "Forgetting fact…" : undefined}
                onConfirm={() => void remove(forgetting.id)} onCancel={() => setForgetting(null)} />}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    addRow: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 },
    addInput: { flex: "1 1 180px" },
    categorySelect: { flex: "0 1 140px", padding: "0 10px", background: "var(--surface)" },
    square: { width: 34, height: 34, padding: 0 },
    factText: { fontSize: 14, lineHeight: 1.5, overflowWrap: "anywhere" },
    rowFooter: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 6 },
    editWrap: { display: "flex", flexDirection: "column", gap: 6 },
    editArea: { width: "100%" },
    editActions: { display: "flex", gap: 4, justifyContent: "flex-end" },
};
