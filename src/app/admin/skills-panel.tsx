"use client";

import { useState, useEffect } from "react";
import { BookOpen, Check, ChevronDown, ChevronRight, Pencil, RefreshCw, Trash2, X } from "lucide-react";

interface CustomSkill {
    id: string;
    slug: string;
    name: string;
    whenToUse: string;
    instructions: string;
    status: "draft" | "active";
    createdBy: "agent" | "user";
    updatedAt: string;
}

interface BuiltInSkill {
    id: string;
    name: string;
    whenToUse: string;
}

async function loadSkills(): Promise<{ custom: CustomSkill[]; builtIn: BuiltInSkill[] }> {
    try {
        const res = await fetch("/api/admin/skills");
        if (!res.ok) return { custom: [], builtIn: [] };
        const data = await res.json();
        return { custom: data.custom ?? [], builtIn: data.builtIn ?? [] };
    } catch {
        return { custom: [], builtIn: [] };
    }
}

export default function SkillsPanel() {
    const [custom, setCustom] = useState<CustomSkill[]>([]);
    const [builtIn, setBuiltIn] = useState<BuiltInSkill[]>([]);
    const [loading, setLoading] = useState(true);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editText, setEditText] = useState("");
    const [showBuiltIn, setShowBuiltIn] = useState(false);

    useEffect(() => {
        let cancelled = false;
        loadSkills().then((data) => {
            if (cancelled) return;
            setCustom(data.custom);
            setBuiltIn(data.builtIn);
            setLoading(false);
        });
        return () => { cancelled = true; };
    }, []);

    const refresh = () => {
        setLoading(true);
        loadSkills().then((data) => {
            setCustom(data.custom);
            setBuiltIn(data.builtIn);
            setLoading(false);
        });
    };

    const approve = async (id: string) => {
        setCustom((s) => s.map((c) => (c.id === id ? { ...c, status: "active" } : c)));
        await fetch("/api/admin/skills", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, action: "approve" }),
        }).catch(() => { });
    };

    const saveEdit = async (id: string) => {
        const instructions = editText.trim();
        if (!instructions) return;
        setEditingId(null);
        setCustom((s) => s.map((c) => (c.id === id ? { ...c, instructions } : c)));
        await fetch("/api/admin/skills", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, instructions }),
        }).catch(() => { });
    };

    const remove = async (id: string) => {
        setCustom((s) => s.filter((c) => c.id !== id));
        await fetch(`/api/admin/skills?id=${id}`, { method: "DELETE" }).catch(() => { });
    };

    const drafts = custom.filter((c) => c.status === "draft");
    const active = custom.filter((c) => c.status === "active");

    const renderSkill = (skill: CustomSkill) => {
        const expanded = expandedId === skill.id;
        return (
            <div key={skill.id} style={panelStyles.row}>
                <div style={panelStyles.rowHead} onClick={() => setExpandedId(expanded ? null : skill.id)}>
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span style={panelStyles.skillName}>{skill.name}</span>
                    <span style={panelStyles.slug}>{skill.slug}</span>
                    <span style={{ flex: 1 }} />
                    {skill.status === "draft"
                        ? <span style={{ ...panelStyles.statusChip, ...panelStyles.draftChip }}>draft</span>
                        : <span style={{ ...panelStyles.statusChip, ...panelStyles.activeChip }}>active</span>}
                </div>
                {expanded && (
                    <div style={panelStyles.detail}>
                        <div style={panelStyles.whenToUse}>{skill.whenToUse}</div>
                        {editingId === skill.id ? (
                            <div style={panelStyles.editWrap}>
                                <textarea
                                    style={panelStyles.editArea}
                                    value={editText}
                                    onChange={(e) => setEditText(e.target.value)}
                                    rows={8}
                                    autoFocus
                                />
                                <div style={panelStyles.actions}>
                                    <button style={panelStyles.iconBtn} onClick={() => saveEdit(skill.id)} title="Save"><Check size={13} /></button>
                                    <button style={panelStyles.iconBtn} onClick={() => setEditingId(null)} title="Cancel"><X size={13} /></button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <pre style={panelStyles.instructions}>{skill.instructions}</pre>
                                <div style={panelStyles.actions}>
                                    {skill.status === "draft" && (
                                        <button style={panelStyles.approveBtn} onClick={() => approve(skill.id)}>
                                            <Check size={12} /> Approve
                                        </button>
                                    )}
                                    <button style={panelStyles.iconBtn} onClick={() => { setEditingId(skill.id); setEditText(skill.instructions); }} title="Edit instructions">
                                        <Pencil size={12} />
                                    </button>
                                    <button style={panelStyles.iconBtn} onClick={() => remove(skill.id)} title="Delete skill">
                                        <Trash2 size={12} />
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div>
            <div style={panelStyles.header}>
                <div style={panelStyles.headerIcon}><BookOpen size={16} /></div>
                <div style={{ flex: 1 }}>
                    <h2 style={panelStyles.title}>Skills</h2>
                    <p style={panelStyles.description}>Playbooks the agent can load; drafts it authored await your approval</p>
                </div>
                <button style={panelStyles.iconBtn} onClick={refresh} title="Refresh skills">
                    <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
                </button>
            </div>

            <div style={panelStyles.list}>
                {drafts.length > 0 && <div style={panelStyles.groupLabel}>Drafts pending review</div>}
                {drafts.map(renderSkill)}

                {active.length > 0 && <div style={panelStyles.groupLabel}>Active custom skills</div>}
                {active.map(renderSkill)}

                {!loading && custom.length === 0 && (
                    <div style={panelStyles.muted}>No custom skills yet — the agent saves drafts here after novel multi-step tasks.</div>
                )}

                <button style={panelStyles.builtInToggle} onClick={() => setShowBuiltIn((v) => !v)}>
                    {showBuiltIn ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {builtIn.length} built-in skills
                </button>
                {showBuiltIn && builtIn.map((s) => (
                    <div key={s.id} style={{ ...panelStyles.row, opacity: 0.6 }}>
                        <div style={panelStyles.rowHead}>
                            <span style={panelStyles.skillName}>{s.name}</span>
                            <span style={panelStyles.slug}>{s.id}</span>
                        </div>
                    </div>
                ))}
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
    list: { display: "flex", flexDirection: "column", gap: 8, maxHeight: 340, overflowY: "auto" },
    groupLabel: {
        fontSize: 10.5,
        fontWeight: 800,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--color-text-muted)",
        marginTop: 2,
    },
    row: {
        padding: "9px 11px",
        borderRadius: 14,
        background: "color-mix(in srgb, var(--color-background) 48%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 48%, transparent)",
    },
    rowHead: { display: "flex", alignItems: "center", gap: 7, cursor: "pointer", minWidth: 0 },
    skillName: { fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
    slug: { fontSize: 11, color: "var(--color-text-muted)", fontFamily: "monospace", whiteSpace: "nowrap" },
    statusChip: {
        padding: "2px 7px",
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 750,
        border: "1px solid color-mix(in srgb, var(--color-border) 48%, transparent)",
        flexShrink: 0,
    },
    draftChip: { color: "#e8b33d", background: "color-mix(in srgb, #e8b33d 12%, transparent)" },
    activeChip: { color: "#31d07f", background: "color-mix(in srgb, #31d07f 12%, transparent)" },
    detail: { marginTop: 8, display: "flex", flexDirection: "column", gap: 7 },
    whenToUse: { fontSize: 12, color: "var(--color-text-muted)", fontStyle: "italic" },
    instructions: {
        margin: 0,
        padding: "8px 10px",
        borderRadius: 10,
        fontSize: 11.5,
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        fontFamily: "inherit",
        background: "color-mix(in srgb, var(--color-background) 62%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 48%, transparent)",
        maxHeight: 180,
        overflowY: "auto",
    },
    actions: { display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" },
    approveBtn: {
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "5px 11px",
        borderRadius: 9,
        border: "1px solid color-mix(in srgb, #31d07f 45%, transparent)",
        background: "color-mix(in srgb, #31d07f 12%, transparent)",
        color: "#31d07f",
        fontSize: 11.5,
        fontWeight: 750,
        cursor: "pointer",
    },
    editWrap: { display: "flex", flexDirection: "column", gap: 6 },
    editArea: {
        width: "100%",
        padding: "7px 9px",
        borderRadius: 10,
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
        background: "color-mix(in srgb, var(--color-background) 62%, transparent)",
        color: "var(--color-text-primary)",
        fontSize: 12,
        resize: "vertical",
        outline: "none",
        fontFamily: "monospace",
    },
    builtInToggle: {
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "4px 2px",
        border: "none",
        background: "transparent",
        color: "var(--color-text-muted)",
        fontSize: 11.5,
        fontWeight: 700,
        cursor: "pointer",
        alignSelf: "flex-start",
    },
    muted: { color: "var(--color-text-muted)", fontSize: 12.5, padding: 4 },
};
