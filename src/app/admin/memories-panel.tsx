"use client";

import { useState, useEffect } from "react";
import { Brain, Check, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";

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
    try {
        const res = await fetch("/api/admin/memories");
        if (!res.ok) return [];
        const data = await res.json();
        return data.memories ?? [];
    } catch {
        return [];
    }
}

export default function MemoriesPanel() {
    const [memories, setMemories] = useState<MemoryFact[]>([]);
    const [loading, setLoading] = useState(true);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editText, setEditText] = useState("");
    const [newFact, setNewFact] = useState("");
    const [newCategory, setNewCategory] = useState("fact");
    const [adding, setAdding] = useState(false);

    useEffect(() => {
        let cancelled = false;
        loadMemories().then((data) => {
            if (cancelled) return;
            setMemories(data);
            setLoading(false);
        });
        return () => { cancelled = true; };
    }, []);

    const refresh = () => {
        setLoading(true);
        loadMemories().then((data) => {
            setMemories(data);
            setLoading(false);
        });
    };

    const saveEdit = async (id: string) => {
        const fact = editText.trim();
        if (!fact) return;
        setEditingId(null);
        setMemories((m) => m.map((f) => (f.id === id ? { ...f, fact } : f)));
        await fetch("/api/admin/memories", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, fact }),
        }).catch(() => { });
    };

    const remove = async (id: string) => {
        setMemories((m) => m.filter((f) => f.id !== id));
        await fetch(`/api/admin/memories?id=${id}`, { method: "DELETE" }).catch(() => { });
    };

    const add = async () => {
        const fact = newFact.trim();
        if (!fact || adding) return;
        setAdding(true);
        try {
            const res = await fetch("/api/admin/memories", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fact, category: newCategory }),
            });
            if (res.ok) {
                setNewFact("");
                refresh();
            }
        } catch { }
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
                <button style={panelStyles.iconBtn} onClick={refresh} title="Refresh memories">
                    <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
                </button>
            </div>

            <div style={panelStyles.addRow}>
                <input
                    style={panelStyles.addInput}
                    value={newFact}
                    onChange={(e) => setNewFact(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") add(); }}
                    placeholder="Add a fact to remember…"
                />
                <select style={panelStyles.categorySelect} value={newCategory} onChange={(e) => setNewCategory(e.target.value)}>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <button style={panelStyles.iconBtn} onClick={add} disabled={adding} title="Save fact">
                    <Plus size={14} />
                </button>
            </div>

            <div style={panelStyles.list}>
                {memories.map((m) => (
                    <div key={m.id} style={panelStyles.row}>
                        {editingId === m.id ? (
                            <div style={panelStyles.editWrap}>
                                <textarea
                                    style={panelStyles.editArea}
                                    value={editText}
                                    onChange={(e) => setEditText(e.target.value)}
                                    rows={2}
                                    autoFocus
                                />
                                <div style={panelStyles.editActions}>
                                    <button style={panelStyles.iconBtn} onClick={() => saveEdit(m.id)} title="Save"><Check size={13} /></button>
                                    <button style={panelStyles.iconBtn} onClick={() => setEditingId(null)} title="Cancel"><X size={13} /></button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <div style={{ ...panelStyles.factText, ...(m.status === "candidate" ? { opacity: 0.6 } : {}) }}>{m.fact}</div>
                                <div style={panelStyles.rowFooter}>
                                    <span style={panelStyles.categoryChip}>{m.category}</span>
                                    {m.status === "candidate" && (
                                        <span style={{ ...panelStyles.categoryChip, borderStyle: "dashed" }} title="Unconfirmed work/study pattern — becomes a Known Fact when it repeats in another conversation">
                                            pattern {m.evidenceCount ?? 1}/2
                                        </span>
                                    )}
                                    <span style={panelStyles.rowMeta}>
                                        {m.projectId ? "project · " : ""}{new Date(m.updatedAt).toLocaleDateString()}
                                    </span>
                                    <span style={{ flex: 1 }} />
                                    <button style={panelStyles.iconBtn} onClick={() => { setEditingId(m.id); setEditText(m.fact); }} title="Edit fact">
                                        <Pencil size={12} />
                                    </button>
                                    <button style={panelStyles.iconBtn} onClick={() => remove(m.id)} title="Forget fact">
                                        <Trash2 size={12} />
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                ))}
                {!loading && memories.length === 0 && <div style={panelStyles.muted}>Nothing remembered yet — facts appear here as you chat.</div>}
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
    iconBtn: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 26,
        height: 26,
        borderRadius: 9,
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
        background: "transparent",
        color: "var(--color-text-muted)",
        cursor: "pointer",
        flexShrink: 0,
    },
    addRow: { display: "flex", gap: 6, marginBottom: 12 },
    addInput: {
        flex: 1,
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
    factText: { fontSize: 12.5, lineHeight: 1.45 },
    rowFooter: { display: "flex", alignItems: "center", gap: 7, marginTop: 6 },
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
