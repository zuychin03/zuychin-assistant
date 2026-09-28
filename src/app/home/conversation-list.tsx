"use client";

import { useState, useRef, useEffect, useLayoutEffect, useId } from "react";
import { createPortal } from "react-dom";
import { observeAnchoredMenu } from "@/components/anchored-menu";
import { useUnsavedChanges } from "@/components/use-unsaved-changes";
import { MessageSquare, Trash2, Folder, FolderPlus, FolderInput, ChevronDown, ChevronRight, Plus, MoreHorizontal, Check, X, LoaderCircle } from "lucide-react";
import { styles } from "./styles";
import ui from "./conversation-list.module.css";

export interface ConversationItem {
  id: string;
  title: string;
  updatedAt: string;
  projectId?: string | null;
}

export interface ProjectItem {
  id: string;
  name: string;
  instructions: string;
  color: string;
}

export function NewProjectButton({ onCreate }: { onCreate: (name: string) => Promise<boolean> }) {
  const [creating, setCreating] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  const submit = async () => {
    const name = nameDraft.trim();
    if (!name || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      if (await onCreate(name)) {
        setCreating(false);
        setNameDraft("");
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  if (creating) {
    return (
      <div className={ui.scope} aria-busy={pending} style={{ ...local.inlineForm, margin: "12px 12px 0", marginBottom: 0 }}>
        <input
          autoFocus
          aria-label="Project name"
          disabled={pending}
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void submit(); }
            if (e.key === "Escape" && !pending) { setCreating(false); setNameDraft(""); }
          }}
          placeholder="Project name"
          style={local.input}
        />
        <button style={local.iconBtn} disabled={pending || !nameDraft.trim()} onClick={submit} aria-label={pending ? "Creating project" : "Create project"}>{pending ? <LoaderCircle size={14} /> : <Check size={14} />}</button>
        <button style={local.iconBtn} disabled={pending} onClick={() => { setCreating(false); setNameDraft(""); }} aria-label="Cancel"><X size={14} /></button>
      </div>
    );
  }

  return (
    <button className={ui.focus} style={{ ...local.newProjectBtn, width: "auto", margin: "12px 12px 0" }} onClick={() => setCreating(true)}>
      <FolderPlus size={14} />
      <span>New Project</span>
    </button>
  );
}

export function ConversationList({
  conversations, projects, activeConversationId, loaded,
  onSelect, onDelete, onNewChat, onUpdateProject, onDeleteProject, onMoveConversation, formatTime,
  runningConversationIds = [], deletingConversationIds = [],
}: {
  conversations: ConversationItem[];
  projects: ProjectItem[];
  activeConversationId: string | null;
  loaded: boolean;
  onSelect: (id: string) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  onNewChat: (projectId?: string) => void;
  onUpdateProject: (id: string, patch: { name?: string; instructions?: string }) => Promise<boolean>;
  onDeleteProject: (id: string) => Promise<boolean>;
  onMoveConversation: (convId: string, projectId: string | null) => Promise<boolean>;
  formatTime: (dateStr: string) => string;
  runningConversationIds?: readonly string[];
  deletingConversationIds?: readonly string[];
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [moveFor, setMoveFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [instructionsId, setInstructionsId] = useState<string | null>(null);
  const [instructionsDraft, setInstructionsDraft] = useState("");
  const [instructionsBase, setInstructionsBase] = useState("");
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const instructionsDirty = instructionsId !== null && instructionsDraft !== instructionsBase;
  useUnsavedChanges(() => instructionsDirty || pendingAction?.startsWith("instructions:") === true);

  const perform = async (key: string, action: () => Promise<boolean>, complete: () => void) => {
    if (pendingRef.current) return;
    pendingRef.current = key;
    setPendingAction(key);
    try {
      if (await action()) complete();
    } finally {
      pendingRef.current = null;
      setPendingAction(null);
    }
  };

  useLayoutEffect(() => {
    if ((!menuFor && !moveFor) || !menuAnchorRef.current || !menuRef.current) return;
    return observeAnchoredMenu(menuAnchorRef.current, menuRef.current, { align: "end", minWidth: 180, maxHeight: 280 });
  }, [menuFor, moveFor]);

  useEffect(() => {
    if (!menuFor && !moveFor) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    const onDoc = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node) && !menuAnchorRef.current?.contains(e.target as Node)) {
        setMenuFor(null);
        setMoveFor(null);
      }
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("focusin", onDoc);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("focusin", onDoc);
    };
  }, [menuFor, moveFor]);

  const closeMenu = () => {
    setMenuFor(null);
    setMoveFor(null);
    menuAnchorRef.current?.focus({ preventScroll: true });
  };

  const renderMenu = (label: string, children: React.ReactNode) => createPortal(
    <div ref={menuRef} id={menuId} className={ui.menu} role="menu" aria-label={label} style={local.menu} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
      if (event.key === "Tab") { closeMenu(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[index]?.focus();
    }}>{children}</div>, document.body,
  );

  const grouped = new Map<string, ConversationItem[]>();
  for (const p of projects) grouped.set(p.id, []);
  const ungrouped: ConversationItem[] = [];
  for (const c of conversations) {
    if (c.projectId && grouped.has(c.projectId)) grouped.get(c.projectId)!.push(c);
    else ungrouped.push(c);
  }

  const submitRename = async () => {
    const id = renamingId;
    const name = renameDraft.trim();
    if (id && name) await perform(`rename:${id}`, () => onUpdateProject(id, { name }), () => setRenamingId(null));
  };

  const submitInstructions = async () => {
    const id = instructionsId;
    if (id) await perform(`instructions:${id}`, () => onUpdateProject(id, { instructions: instructionsDraft.trim() }), () => setInstructionsId(null));
  };

  function openInstructions(project: ProjectItem) {
    if (pendingRef.current) return;
    setMenuFor(null);
    if (instructionsId === project.id) { instructionsRef.current?.focus(); return; }
    if (instructionsDirty && !window.confirm("Discard your unsaved project instructions and switch projects?")) {
      instructionsRef.current?.focus();
      return;
    }
    setInstructionsId(project.id);
    setInstructionsBase(project.instructions);
    setInstructionsDraft(project.instructions);
  }

  function closeInstructions() {
    if (pendingRef.current) return;
    if (instructionsDirty && !window.confirm("Discard your unsaved project instructions?")) return;
    setInstructionsId(null);
    setInstructionsDraft("");
    setInstructionsBase("");
  }

  const renderRow = (conv: ConversationItem, indented: boolean) => (
    <div key={conv.id} style={{ position: "relative", ...(indented ? { marginLeft: 14 } : {}) }}>
      <div
        style={{
          ...styles.conversationItem,
          ...(activeConversationId === conv.id ? styles.conversationItemActive : {}),
        }}
      >
        <button type="button" onClick={() => onSelect(conv.id)} style={local.rowSelect} aria-current={activeConversationId === conv.id ? "page" : undefined}>
          <MessageSquare size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <span style={styles.conversationInfo}>
            <span style={styles.conversationTitle}>{conv.title}</span>
            <span style={styles.conversationTime}>{runningConversationIds.includes(conv.id) ? "Replying…" : formatTime(conv.updatedAt)}</span>
          </span>
        </button>
        {projects.length > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              menuAnchorRef.current = e.currentTarget;
              setMoveFor(moveFor === conv.id ? null : conv.id);
              setMenuFor(null);
            }}
            style={styles.deleteBtn}
            disabled={!!pendingAction || deletingConversationIds.includes(conv.id)}
            aria-label={`Move to project: ${conv.title}`}
            aria-haspopup="menu"
            aria-expanded={moveFor === conv.id}
            aria-controls={moveFor === conv.id ? menuId : undefined}
            title="Move to project"
          >
            <FolderInput size={13} />
          </button>
        )}
        <button
          onClick={(e) => onDelete(e, conv.id)}
          style={styles.deleteBtn}
          disabled={deletingConversationIds.includes(conv.id) || runningConversationIds.includes(conv.id)}
          title={runningConversationIds.includes(conv.id) ? "Stop the reply before deleting this conversation." : "Delete conversation"}
          aria-label={`Delete conversation: ${conv.title}`}
        >
          <Trash2 size={13} />
        </button>
      </div>
      {moveFor === conv.id && renderMenu(`Move ${conv.title} to project`, <>
          <button
            role="menuitem"
            style={local.menuItem}
            onClick={() => void perform(`move:${conv.id}`, () => onMoveConversation(conv.id, null), closeMenu)}
            disabled={!!pendingAction || !conv.projectId}
          >
            Ungrouped
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              role="menuitem"
              style={local.menuItem}
              onClick={() => void perform(`move:${conv.id}`, () => onMoveConversation(conv.id, p.id), closeMenu)}
              disabled={!!pendingAction || conv.projectId === p.id}
            >
              {p.name}
            </button>
          ))}
        </>)}
    </div>
  );

  return (
    <div ref={rootRef} className={ui.scope} aria-busy={!!pendingAction} aria-owns={menuFor || moveFor ? menuId : undefined} style={styles.conversationList}>
      {projects.map((p) => {
        const convs = grouped.get(p.id) ?? [];
        const isCollapsed = collapsed[p.id] ?? false;
        return (
          <div key={p.id} style={{ position: "relative" }}>
            <div
              style={local.projectHeader}
            >
              <button type="button" style={{ ...local.rowSelect, gap: 6, ...(renamingId === p.id ? { flex: "0 0 auto" } : {}) }} onClick={() => setCollapsed((prev) => ({ ...prev, [p.id]: !isCollapsed }))} aria-label={`${isCollapsed ? "Expand" : "Collapse"} project: ${p.name}`} aria-expanded={!isCollapsed}>
              {isCollapsed ? <ChevronRight size={13} style={{ flexShrink: 0 }} /> : <ChevronDown size={13} style={{ flexShrink: 0 }} />}
              <Folder size={13} style={{ flexShrink: 0 }} />
              {renamingId !== p.id && <span style={local.projectName}>{p.name}</span>}
              </button>
              {renamingId === p.id && (
                <input
                  autoFocus
                  aria-label={`Rename project: ${p.name}`}
                  disabled={!!pendingAction}
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") { e.preventDefault(); void submitRename(); }
                    if (e.key === "Escape" && !pendingAction) setRenamingId(null);
                  }}
                  style={{ ...local.input, flex: 1 }}
                />
              )}
              {renamingId === p.id && <>
                <button style={local.iconBtn} disabled={!!pendingAction || !renameDraft.trim()} onClick={(e) => { e.stopPropagation(); void submitRename(); }} aria-label="Save project name"><Check size={14} /></button>
                <button style={local.iconBtn} disabled={!!pendingAction} onClick={(e) => { e.stopPropagation(); setRenamingId(null); }} aria-label="Cancel rename"><X size={14} /></button>
              </>}
              <span style={local.projectCount}>{convs.length}</span>
              <button
                style={styles.deleteBtn}
                onClick={(e) => { e.stopPropagation(); onNewChat(p.id); }}
                aria-label={`New chat in ${p.name}`}
                title="New chat in project"
              >
                <Plus size={13} />
              </button>
              <button
                style={styles.deleteBtn}
                disabled={!!pendingAction}
                onClick={(e) => {
                  e.stopPropagation();
                  menuAnchorRef.current = e.currentTarget;
                  setMenuFor(menuFor === p.id ? null : p.id);
                  setMoveFor(null);
                }}
                aria-label={`Project options: ${p.name}`}
                aria-haspopup="menu"
                aria-expanded={menuFor === p.id}
                aria-controls={menuFor === p.id ? menuId : undefined}
              >
                <MoreHorizontal size={13} />
              </button>
            </div>

            {menuFor === p.id && renderMenu(`Options for ${p.name}`, <>
                <button
                  role="menuitem"
                  style={local.menuItem}
                  disabled={!!pendingAction}
                  onClick={() => { setMenuFor(null); setRenamingId(p.id); setRenameDraft(p.name); }}
                >
                  Rename
                </button>
                <button
                  role="menuitem"
                  style={local.menuItem}
                  disabled={!!pendingAction}
                  onClick={() => openInstructions(p)}
                >
                  Instructions
                </button>
                <button
                  role="menuitem"
                  style={{ ...local.menuItem, color: "var(--color-danger, #d5484f)" }}
                  disabled={!!pendingAction}
                  onClick={() => {
                    closeMenu();
                    void perform(`delete-project:${p.id}`, () => onDeleteProject(p.id), () => setMenuFor(null));
                  }}
                >
                  Delete
                </button>
              </>)}

            {instructionsId === p.id && (
              <div style={local.instructionsBox}>
                <textarea
                  ref={instructionsRef}
                  autoFocus
                  aria-label={`Instructions for ${p.name}`}
                  disabled={!!pendingAction}
                  value={instructionsDraft}
                  onChange={(e) => setInstructionsDraft(e.target.value)}
                  placeholder="Instructions injected into every chat in this project…"
                  rows={4}
                  style={local.textarea}
                />
                <div style={local.instructionsActions}>
                  <button style={{ ...local.iconBtn, ...local.instructionButton }} disabled={!!pendingAction} onClick={submitInstructions} aria-label="Save instructions"><Check size={14} /> Save instructions</button>
                  <button style={{ ...local.iconBtn, ...local.instructionButton }} disabled={!!pendingAction} onClick={closeInstructions} aria-label="Cancel instructions"><X size={14} /> Cancel</button>
                </div>
              </div>
            )}

            {!isCollapsed && convs.map((c) => renderRow(c, true))}
            {!isCollapsed && convs.length === 0 && (
              <p style={local.emptyProject}>No chats yet</p>
            )}
          </div>
        );
      })}

      {projects.length > 0 && ungrouped.length > 0 && (
        <p style={local.groupLabel}>Ungrouped</p>
      )}

      {!loaded && conversations.length === 0 &&
        [0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="animate-pulse-soft"
            style={{ ...styles.convSkeleton, animationDelay: `${i * 0.12}s` }}
          />
        ))}
      {loaded && conversations.length === 0 && projects.length === 0 && (
        <p style={styles.noConversations}>No conversations yet</p>
      )}
      {ungrouped.map((c) => renderRow(c, false))}
    </div>
  );
}

const local: Record<string, React.CSSProperties> = {
  rowSelect: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flex: 1,
    minWidth: 0,
    minHeight: 36,
    padding: 0,
    border: "none",
    borderRadius: 6,
    background: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  newProjectBtn: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "8px 12px",
    marginBottom: 4,
    background: "none",
    border: "1px dashed var(--color-border)",
    borderRadius: 8,
    cursor: "pointer",
    color: "var(--color-text-muted)",
    fontSize: 12.5,
    fontFamily: "var(--font-family)",
  },
  projectHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 8px 8px 6px",
    borderRadius: 8,
    cursor: "pointer",
    color: "var(--color-text-primary)",
    fontSize: 13,
    userSelect: "none",
  },
  projectName: {
    flex: 1,
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  projectCount: {
    fontSize: 11,
    color: "var(--color-text-muted)",
    flexShrink: 0,
  },
  menu: {
    position: "fixed",
    zIndex: 1000,
    visibility: "hidden",
    width: "max-content",
    boxSizing: "border-box",
    overflowY: "auto",
    overscrollBehavior: "contain",
    background: "var(--color-background)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-md)",
    boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
    padding: 4,
    display: "flex",
    flexDirection: "column",
  },
  menuItem: {
    display: "block",
    width: "100%",
    minHeight: 44,
    padding: "7px 10px",
    background: "none",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    textAlign: "left",
    overflowWrap: "anywhere",
    color: "var(--color-text-primary)",
    fontSize: 12.5,
    fontFamily: "var(--font-family)",
  },
  inlineForm: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    marginBottom: 4,
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: "6px 8px",
    background: "var(--color-background)",
    border: "1px solid var(--color-border)",
    borderRadius: 6,
    color: "var(--color-text-primary)",
    fontSize: 16,
    fontFamily: "var(--font-family)",
  },
  textarea: {
    width: "100%",
    padding: "6px 8px",
    background: "var(--color-background)",
    border: "1px solid var(--color-border)",
    borderRadius: 6,
    color: "var(--color-text-primary)",
    fontSize: 16,
    fontFamily: "var(--font-family)",
    resize: "vertical",
  },
  instructionsBox: {
    margin: "2px 4px 6px 24px",
  },
  instructionsActions: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 4,
    marginTop: 2,
  },
  instructionButton: {
    minWidth: 44,
    minHeight: 44,
    padding: "6px 10px",
    gap: 6,
    fontSize: 13,
  },
  iconBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 5,
    background: "none",
    border: "1px solid var(--color-border)",
    borderRadius: 6,
    cursor: "pointer",
    color: "var(--color-text-primary)",
  },
  emptyProject: {
    margin: "2px 0 6px 34px",
    fontSize: 11.5,
    color: "var(--color-text-muted)",
  },
  groupLabel: {
    margin: "10px 4px 2px",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    color: "var(--color-text-muted)",
  },
};
