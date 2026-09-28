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
            <div style={panelStyles.header}>
                <div style={panelStyles.headerIcon}><Brain size={16} /></div>
                <div style={{ flex: 1 }}>
                    <h2 style={panelStyles.title}>Long-Term Memory</h2>
                    <p style={panelStyles.description}>Extracted facts the assistant remembers across conversations</p>
                </div>
                <button style={panelStyles.iconBtn} onClick={() => refresh()} disabled={loading || busy || adding} title="Refresh memories">
                    <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
                </button>
            </div>

            <div style={panelStyles.addRow}>
                <input
                    style={panelStyles.addInput}
                    disabled={loading || adding || busy}
                    value={newFact}
                    onChange={(e) => setNewFact(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") add(); }}
                    aria-label="New memory fact"
                    placeholder="Add a fact to remember…"
                />
                <Dropdown
                    ariaLabel="Category"
                    style={panelStyles.categorySelect}
                    disabled={loading || adding || busy}
                    value={newCategory}
                    onChange={setNewCategory}
                    options={CATEGORIES as readonly string[]}
                />
                <button style={panelStyles.iconBtn} onClick={add} disabled={loading || adding || busy || !newFact.trim()} title="Save fact">
                    <Plus size={14} />
                </button>
            </div>

            {error && <p role="alert" style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>{error}</p>}
            {loading && <p role="status" style={panelStyles.muted}>Loading memories…</p>}
            <div style={panelStyles.list}>
                {memories.map((m) => (
                    <div key={m.id} style={panelStyles.row}>
                        {editingId === m.id ? (
                            <div style={panelStyles.editWrap}>
                                <textarea
                                    aria-label="Edit memory fact"
                                    style={panelStyles.editArea}
                                    disabled={loading || busy || adding}
                                    value={editText}
                                    onChange={(e) => setEditText(e.target.value)}
                                    rows={2}
                                    autoFocus
                                />
                                <div style={panelStyles.editActions}>
                                    <button style={panelStyles.iconBtn} onClick={() => saveEdit(m.id)} disabled={loading || busy || adding || !editText.trim()} title="Save"><Check size={13} /></button>
                                    <button style={panelStyles.iconBtn} onClick={() => { if (discardEdit()) setEditingId(null); }} disabled={loading || busy || adding} title="Cancel"><X size={13} /></button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <div style={panelStyles.factText}>{m.fact}</div>
                                <div style={panelStyles.rowFooter}>
                                    <span style={panelStyles.categoryChip}>{m.category}</span>
                                    {m.status === "candidate" && (
                                        <span style={{ ...panelStyles.categoryChip, borderStyle: "dashed" }} title="Unconfirmed work/study pattern - becomes a Known Fact when it repeats in another conversation">
                                            pattern {m.evidenceCount ?? 1}/{PROMOTE_EVIDENCE_COUNT}
                                        </span>
                                    )}
                                    <span style={panelStyles.rowMeta}>
                                        {m.projectId ? "project · " : ""}{new Date(m.updatedAt).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" })}
                                    </span>
                                    <span style={{ flex: 1 }} />
                                    <button style={panelStyles.iconBtn} onClick={() => { if (discardEdit()) { setEditingId(m.id); setEditText(m.fact); setEditOriginal(m.fact); } }} disabled={loading || busy || adding} title="Edit fact">
                                        <Pencil size={12} />
                                    </button>
                                    <button style={panelStyles.iconBtn} onClick={() => setForgetting(m)} disabled={loading || busy || adding} title="Forget fact">
                                        <Trash2 size={12} />
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                ))}
                {!loading && !error && memories.length === 0 && <div style={panelStyles.muted}>Nothing remembered yet - facts appear here as you chat.</div>}
            </div>
            {forgetting && <ConfirmModal title="Forget this fact?" body={`“${forgetting.fact}” will be removed from long-term memory. This cannot be undone.${editingId === forgetting.id && editDirty ? " Its unsaved edit will also be discarded." : ""}`}
                confirmLabel="Forget fact" busyText={busy ? "Forgetting fact…" : undefined}
                onConfirm={() => void remove(forgetting.id)} onCancel={() => setForgetting(null)} />}
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
    iconBtn: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        borderRadius: 9,
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
        background: "transparent",
        color: "var(--color-text-muted)",
        cursor: "pointer",
        flexShrink: 0,
    },
    addRow: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 },
    addInput: {
        flex: "1 1 180px",
        minWidth: 0,
        padding: "7px 10px",
        borderRadius: 12,
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
        background: "color-mix(in srgb, var(--color-background) 48%, transparent)",
        color: "var(--color-text-primary)",
        fontSize: 12.5,
        outline: "none",
    },
    categorySelect: {
        flex: "0 1 140px",
        padding: "7px 8px",
        borderRadius: 12,
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
        background: "color-mix(in srgb, var(--color-background) 48%, transparent)",
        color: "var(--color-text-primary)",
        fontSize: 12,
        outline: "none",
    },
    list: { display: "flex", flexDirection: "column", gap: 8, maxHeight: 340, overflowY: "auto" },
    row: {
        padding: "9px 11px",
        borderRadius: 14,
        background: "color-mix(in srgb, var(--color-background) 48%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 48%, transparent)",
    },
    factText: { overflowWrap: "anywhere", fontSize: 12.5, lineHeight: 1.45 },
    rowFooter: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 7, marginTop: 6 },
    categoryChip: {
        padding: "2px 7px",
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 750,
        color: "var(--color-text-muted)",
        background: "color-mix(in srgb, var(--color-background) 62%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 48%, transparent)",
    },
    rowMeta: { fontSize: 11, color: "var(--color-text-muted)" },
    editWrap: { display: "flex", flexDirection: "column", gap: 6 },
    editArea: {
        width: "100%",
        padding: "7px 9px",
        borderRadius: 10,
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
        background: "color-mix(in srgb, var(--color-background) 62%, transparent)",
        color: "var(--color-text-primary)",
        fontSize: 12.5,
        resize: "vertical",
        outline: "none",
        fontFamily: "inherit",
    },
    editActions: { display: "flex", gap: 6, justifyContent: "flex-end" },
    muted: { color: "var(--color-text-muted)", fontSize: 12.5, padding: 4 },
};
