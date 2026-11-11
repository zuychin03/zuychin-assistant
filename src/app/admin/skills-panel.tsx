"use client";

import { useState, useEffect } from "react";
import { BookOpen, Check, ChevronDown, ChevronRight, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { ConfirmModal } from "../home/controls";

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
    const res = await fetch("/api/admin/skills");
    if (!res.ok) throw new Error("Could not load skills. Please retry.");
    const data = await res.json();
    return { custom: data.custom ?? [], builtIn: data.builtIn ?? [] };
}

export default function SkillsPanel({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
    const [custom, setCustom] = useState<CustomSkill[]>([]);
    const [builtIn, setBuiltIn] = useState<BuiltInSkill[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editText, setEditText] = useState("");
    const [editOriginal, setEditOriginal] = useState("");
    const [showBuiltIn, setShowBuiltIn] = useState(false);
    const [busy, setBusy] = useState(false);
    const [deleting, setDeleting] = useState<CustomSkill | null>(null);

    useEffect(() => {
        let cancelled = false;
        loadSkills().then((data) => {
            if (cancelled) return;
            setCustom(data.custom);
            setBuiltIn(data.builtIn);
            setError("");
        }).catch(() => { if (!cancelled) setError("Could not load skills. Use Refresh to retry."); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, []);

    const editDirty = editingId !== null && editText !== editOriginal;
    useEffect(() => { onDirtyChange?.(editDirty); }, [editDirty, onDirtyChange]);
    const discardEdit = () => !editDirty || window.confirm("Discard your unsaved skill edit?");
    const refresh = () => {
        if (loading || busy || !discardEdit()) return;
        setEditingId(null);
        setLoading(true);
        loadSkills().then((data) => {
            setCustom(data.custom);
            setBuiltIn(data.builtIn);
            setError("");
        }).catch(() => setError("Could not load skills. Use Refresh to retry."))
            .finally(() => setLoading(false));
    };

    const mutate = async (id: string, change: { action: "approve" } | { instructions: string } | null) => {
        if (loading || busy) return;
        setBusy(true); setError("");
        try {
            const response = await fetch(change ? "/api/admin/skills" : "/api/admin/skills?id=" + encodeURIComponent(id), {
                method: change ? "PUT" : "DELETE",
                ...(change ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...change }) } : {}),
            });
            if (!response.ok) throw new Error();
            setCustom((items) => change ? items.map((item) => item.id === id ? { ...item, ...("action" in change ? { status: "active" as const } : change) } : item) : items.filter((item) => item.id !== id));
            if (change && "instructions" in change) setEditingId(null);
            if (!change && editingId === id) setEditingId(null);
        } catch { setError("Could not update this skill. Your current content is preserved; please retry."); }
        finally { setBusy(false); setDeleting(null); }
    };
    const approve = (id: string) => mutate(id, { action: "approve" });
    const saveEdit = (id: string) => editText.trim() ? mutate(id, { instructions: editText.trim() }) : undefined;
    const remove = (id: string) => mutate(id, null);

    const drafts = custom.filter((c) => c.status === "draft");
    const active = custom.filter((c) => c.status === "active");

    const renderSkill = (skill: CustomSkill) => {
        const expanded = expandedId === skill.id;
        return (
            <div key={skill.id} className="row">
                <button type="button" className="row-toggle" aria-expanded={expanded} aria-controls={"skill-" + skill.id} style={styles.rowHead} onClick={() => setExpandedId(expanded ? null : skill.id)}>
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span className="row-title" style={styles.skillName}>{skill.name}</span>
                    <span style={styles.slug}>{skill.slug}</span>
                    <span style={{ flex: 1 }} />
                    {skill.status === "draft"
                        ? <span className="pill">draft</span>
                        : <span className="pill" data-tone="success">active</span>}
                </button>
                {expanded && (
                    <div id={"skill-" + skill.id} style={styles.detail}>
                        <div className="meta">{skill.whenToUse}</div>
                        {editingId === skill.id ? (
                            <div style={styles.editWrap}>
                                <textarea
                                    aria-label="Skill instructions"
                                    className="field"
                                    style={styles.editArea}
                                    disabled={loading || busy}
                                    value={editText}
                                    onChange={(e) => setEditText(e.target.value)}
                                    rows={8}
                                    autoFocus
                                />
                                <div style={styles.actions}>
                                    <button className="icon-btn" onClick={() => saveEdit(skill.id)} disabled={loading || busy || !editText.trim()} title="Save"><Check size={15} /></button>
                                    <button className="icon-btn" onClick={() => { if (discardEdit()) setEditingId(null); }} disabled={loading || busy} title="Cancel"><X size={15} /></button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <pre className="inset" style={styles.instructions}>{skill.instructions}</pre>
                                <div style={styles.actions}>
                                    {skill.status === "draft" && (
                                        <button className="btn" onClick={() => approve(skill.id)} disabled={loading || busy}>
                                            <Check size={14} /> Approve
                                        </button>
                                    )}
                                    <button className="icon-btn" onClick={() => { if (discardEdit()) { setEditingId(skill.id); setEditText(skill.instructions); setEditOriginal(skill.instructions); } }} disabled={loading || busy} title="Edit instructions">
                                        <Pencil size={14} />
                                    </button>
                                    <button className="icon-btn" data-tone="danger" onClick={() => setDeleting(skill)} disabled={loading || busy} title="Delete skill">
                                        <Trash2 size={14} />
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
            <div className="panel-head">
                <BookOpen size={16} />
                <div className="panel-heading">
                    <h2>Skills</h2>
                    <p>Playbooks the agent can load; drafts it authored await your approval</p>
                </div>
                <button className="icon-btn" onClick={refresh} disabled={loading || busy} title="Refresh skills">
                    <RefreshCw size={15} className={loading ? "animate-spin" : undefined} />
                </button>
            </div>

            {error && <p role="alert" className="error" style={{ marginBottom: 12 }}>{error}</p>}
            {loading && <p role="status" className="empty">Loading skills…</p>}
            <div className="list scroll" style={{ maxHeight: 340 }}>
                {drafts.length > 0 && <div style={styles.groupLabel}>Drafts pending review</div>}
                {drafts.map(renderSkill)}

                {active.length > 0 && <div style={styles.groupLabel}>Active custom skills</div>}
                {active.map(renderSkill)}

                {!loading && !error && custom.length === 0 && (
                    <div className="empty">No custom skills yet - the agent saves drafts here after novel multi-step tasks.</div>
                )}

                <button className="link-btn" style={styles.builtInToggle} aria-expanded={showBuiltIn} onClick={() => setShowBuiltIn((v) => !v)}>
                    {showBuiltIn ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {builtIn.length} built-in skills
                </button>
                {showBuiltIn && builtIn.map((s) => (
                    <div key={s.id} className="row">
                        <div className="row-head">
                            <span className="row-title" style={styles.skillName}>{s.name}</span>
                            <span style={styles.slug}>{s.id}</span>
                        </div>
                    </div>
                ))}
            </div>
            {deleting && <ConfirmModal title="Delete this skill?" body={`“${deleting.name}” and its instructions will be permanently deleted.${editingId === deleting.id && editDirty ? " Its unsaved edit will also be discarded." : ""}`}
                confirmLabel="Delete skill" busyText={busy ? "Deleting skill…" : undefined}
                onConfirm={() => void remove(deleting.id)} onCancel={() => setDeleting(null)} />}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    groupLabel: { padding: "10px 0 6px", color: "var(--muted)", fontSize: 13, fontWeight: 600 },
    rowHead: { flexWrap: "wrap" },
    skillName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    slug: { minWidth: 0, color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 12, overflowWrap: "anywhere" },
    detail: { display: "flex", flexDirection: "column", gap: 8, marginTop: 8 },
    instructions: { maxHeight: 180, overflowY: "auto", fontFamily: "inherit", fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
    actions: { display: "flex", gap: 4, justifyContent: "flex-end", alignItems: "center" },
    editWrap: { display: "flex", flexDirection: "column", gap: 6 },
    editArea: { width: "100%", fontFamily: "var(--font-mono)", fontSize: 13 },
    builtInToggle: { alignSelf: "flex-start", padding: "10px 0 6px" },
};
