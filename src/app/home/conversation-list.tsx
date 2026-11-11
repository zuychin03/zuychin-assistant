"use client";

import { useState, useRef, useEffect, useLayoutEffect, useId } from "react";
import { createPortal } from "react-dom";
import { observeAnchoredMenu } from "@/components/anchored-menu";
import { useUnsavedChanges } from "@/components/use-unsaved-changes";
import { Trash2, FolderPlus, FolderInput, ChevronDown, ChevronRight, Plus, MoreHorizontal, Check, X, LoaderCircle } from "lucide-react";
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

export function sidebarTime(value: string, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= startOfToday) return date.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.getTime() >= startOfToday - 6 * 86_400_000) return date.toLocaleDateString("en-AU", { weekday: "short" });
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "2-digit" }) });
}

const normalise = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

export function matchesTitle(title: string, filter: string) {
  const terms = normalise(filter).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = normalise(title);
  return terms.every((term) => haystack.includes(term));
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
      <div className={`${ui.scope} ${ui.inlineForm}`} aria-busy={pending}>
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
          className={ui.input}
        />
        <button type="button" className={ui.formButton} disabled={pending || !nameDraft.trim()} onClick={submit} aria-label={pending ? "Creating project" : "Create project"}>{pending ? <LoaderCircle size={14} className={ui.spin} /> : <Check size={14} />}</button>
        <button type="button" className={ui.formButton} disabled={pending} onClick={() => { setCreating(false); setNameDraft(""); }} aria-label="Cancel"><X size={14} /></button>
      </div>
    );
  }

  return (
    <button type="button" className={ui.newProject} onClick={() => setCreating(true)}>
      <FolderPlus size={14} aria-hidden="true" />
      <span>New project</span>
    </button>
  );
}

export function ConversationList({
  conversations, projects, activeConversationId, loaded, filter = "",
  onSelect, hrefFor, onDelete, onNewChat, onUpdateProject, onDeleteProject, onMoveConversation, formatTime = sidebarTime,
  runningConversationIds = [], deletingConversationIds = [],
}: {
  conversations: ConversationItem[];
  projects: ProjectItem[];
  activeConversationId: string | null;
  loaded: boolean;
  filter?: string;
  onSelect?: (id: string) => void;
  hrefFor?: (id: string) => string;
  onDelete?: (e: React.MouseEvent, id: string) => void;
  onNewChat?: (projectId?: string) => void;
  onUpdateProject?: (id: string, patch: { name?: string; instructions?: string }) => Promise<boolean>;
  onDeleteProject?: (id: string) => Promise<boolean>;
  onMoveConversation?: (convId: string, projectId: string | null) => Promise<boolean>;
  formatTime?: (dateStr: string) => string;
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
  const menuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const instructionsDirty = instructionsId !== null && instructionsDraft !== instructionsBase;
  const filtering = filter.trim().length > 0;
  const manageProjects = Boolean(onUpdateProject && onDeleteProject);
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
    <div ref={menuRef} id={menuId} className={ui.menu} role="menu" aria-label={label} onKeyDown={(event) => {
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

  const visible = filtering ? conversations.filter((c) => matchesTitle(c.title, filter)) : conversations;
  const grouped = new Map<string, ConversationItem[]>();
  for (const p of projects) grouped.set(p.id, []);
  const ungrouped: ConversationItem[] = [];
  for (const c of visible) {
    if (c.projectId && grouped.has(c.projectId)) grouped.get(c.projectId)!.push(c);
    else ungrouped.push(c);
  }
  const shownProjects = filtering ? projects.filter((p) => (grouped.get(p.id)?.length ?? 0) > 0) : projects;

  const submitRename = async () => {
    const id = renamingId;
    const name = renameDraft.trim();
    if (id && name && onUpdateProject) await perform(`rename:${id}`, () => onUpdateProject(id, { name }), () => setRenamingId(null));
  };

  const submitInstructions = async () => {
    const id = instructionsId;
    if (id && onUpdateProject) await perform(`instructions:${id}`, () => onUpdateProject(id, { instructions: instructionsDraft.trim() }), () => setInstructionsId(null));
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

  const renderRow = (conv: ConversationItem, inGroup: boolean) => {
    const active = activeConversationId === conv.id;
    const running = runningConversationIds.includes(conv.id);
    const deleting = deletingConversationIds.includes(conv.id);
    const href = hrefFor?.(conv.id) ?? `/?c=${encodeURIComponent(conv.id)}`;
    const hasActions = Boolean(onDelete || (onMoveConversation && projects.length > 0));
    return (
      <div key={conv.id} className={ui.row} data-active={active || undefined} data-grouped={inGroup || undefined} data-actions={hasActions || undefined}>
        <a
          href={href}
          className={ui.rowLink}
          aria-current={active ? "page" : undefined}
          onClick={(event) => {
            if (!onSelect || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onSelect(conv.id);
          }}
        >
          <span className={ui.rowTitle}>{conv.title}</span>
          {running
            ? <span className={ui.rowTime}><LoaderCircle size={13} className={ui.spin} aria-label="Replying" /></span>
            : <time className={ui.rowTime} dateTime={conv.updatedAt}>{formatTime(conv.updatedAt)}</time>}
        </a>
        {hasActions && <span className={ui.rowActions}>
          {onMoveConversation && projects.length > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                menuAnchorRef.current = e.currentTarget;
                setMoveFor(moveFor === conv.id ? null : conv.id);
                setMenuFor(null);
              }}
              className={ui.rowButton}
              disabled={!!pendingAction || deleting}
              aria-label={`Move to project: ${conv.title}`}
              aria-haspopup="menu"
              aria-expanded={moveFor === conv.id}
              aria-controls={moveFor === conv.id ? menuId : undefined}
              title="Move to project"
            >
              <FolderInput size={14} aria-hidden="true" />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={(e) => onDelete(e, conv.id)}
              className={ui.rowButton}
              disabled={deleting || running}
              title={running ? "Stop the reply before deleting this conversation." : "Delete conversation"}
              aria-label={`Delete conversation: ${conv.title}`}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          )}
        </span>}
        {moveFor === conv.id && onMoveConversation && renderMenu(`Move ${conv.title} to project`, <>
          <button
            type="button"
            role="menuitem"
            onClick={() => void perform(`move:${conv.id}`, () => onMoveConversation(conv.id, null), closeMenu)}
            disabled={!!pendingAction || !conv.projectId}
          >
            No project
          </button>
          {projects.map((p) => (
            <button
              type="button"
              key={p.id}
              role="menuitem"
              onClick={() => void perform(`move:${conv.id}`, () => onMoveConversation(conv.id, p.id), closeMenu)}
              disabled={!!pendingAction || conv.projectId === p.id}
            >
              {p.name}
            </button>
          ))}
        </>)}
      </div>
    );
  };

  return (
    <div ref={rootRef} className={`${ui.scope} ${ui.list}`} aria-busy={!!pendingAction} aria-owns={menuFor || moveFor ? menuId : undefined}>
      {shownProjects.map((p) => {
        const convs = grouped.get(p.id) ?? [];
        const isCollapsed = !filtering && (collapsed[p.id] ?? false);
        return (
          <section key={p.id} className={ui.group} aria-label={p.name}>
            <div className={ui.groupHead}>
              {renamingId === p.id ? (
                <div className={ui.inlineForm}>
                  <input
                    autoFocus
                    aria-label={`Rename project: ${p.name}`}
                    disabled={!!pendingAction}
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") { e.preventDefault(); void submitRename(); }
                      if (e.key === "Escape" && !pendingAction) setRenamingId(null);
                    }}
                    className={ui.input}
                  />
                  <button type="button" className={ui.formButton} disabled={!!pendingAction || !renameDraft.trim()} onClick={() => void submitRename()} aria-label="Save project name"><Check size={14} /></button>
                  <button type="button" className={ui.formButton} disabled={!!pendingAction} onClick={() => setRenamingId(null)} aria-label="Cancel rename"><X size={14} /></button>
                </div>
              ) : <>
                <button
                  type="button"
                  className={ui.groupToggle}
                  onClick={() => setCollapsed((prev) => ({ ...prev, [p.id]: !isCollapsed }))}
                  aria-expanded={!isCollapsed}
                  disabled={filtering}
                  title={`${isCollapsed ? "Expand" : "Collapse"} ${p.name}`}
                >
                  {isCollapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                  <span className={ui.groupName}>{p.name}</span>
                </button>
                {(onNewChat || manageProjects) && <span className={ui.groupActions}>
                  {onNewChat && <button
                    type="button"
                    className={ui.rowButton}
                    onClick={() => onNewChat(p.id)}
                    aria-label={`New chat in ${p.name}`}
                    title="New chat in project"
                  >
                    <Plus size={14} aria-hidden="true" />
                  </button>}
                  {manageProjects && <button
                    type="button"
                    className={ui.rowButton}
                    disabled={!!pendingAction}
                    onClick={(e) => {
                      menuAnchorRef.current = e.currentTarget;
                      setMenuFor(menuFor === p.id ? null : p.id);
                      setMoveFor(null);
                    }}
                    aria-label={`Project options: ${p.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === p.id}
                    aria-controls={menuFor === p.id ? menuId : undefined}
                  >
                    <MoreHorizontal size={14} aria-hidden="true" />
                  </button>}
                </span>}
              </>}
            </div>

            {menuFor === p.id && onDeleteProject && renderMenu(`Options for ${p.name}`, <>
              <button
                type="button"
                role="menuitem"
                disabled={!!pendingAction}
                onClick={() => { setMenuFor(null); setRenamingId(p.id); setRenameDraft(p.name); }}
              >
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!!pendingAction}
                onClick={() => openInstructions(p)}
              >
                Instructions
              </button>
              <button
                type="button"
                role="menuitem"
                data-danger
                disabled={!!pendingAction}
                onClick={() => {
                  closeMenu();
                  void perform(`delete-project:${p.id}`, () => onDeleteProject(p.id), () => setMenuFor(null));
                }}
              >
                <Trash2 size={14} aria-hidden="true" /> Delete project
              </button>
            </>)}

            {instructionsId === p.id && (
              <div className={ui.instructions}>
                <textarea
                  ref={instructionsRef}
                  autoFocus
                  aria-label={`Instructions for ${p.name}`}
                  disabled={!!pendingAction}
                  value={instructionsDraft}
                  onChange={(e) => setInstructionsDraft(e.target.value)}
                  placeholder="Instructions added to every chat in this project"
                  rows={4}
                  className={ui.textarea}
                />
                <div className={ui.instructionsActions}>
                  <button type="button" className={ui.textButton} disabled={!!pendingAction} onClick={closeInstructions}>Cancel</button>
                  <button type="button" className={ui.textButton} data-primary disabled={!!pendingAction} onClick={submitInstructions}>Save instructions</button>
                </div>
              </div>
            )}

            {!isCollapsed && convs.map((c) => renderRow(c, true))}
            {!isCollapsed && convs.length === 0 && <p className={ui.empty} data-grouped>No chats yet</p>}
          </section>
        );
      })}

      {ungrouped.length > 0 && (
        <section className={ui.group} aria-label={shownProjects.length > 0 ? "No project" : "Chats"}>
          {shownProjects.length > 0 && <div className={ui.groupHead}><span className={ui.groupLabel}>No project</span></div>}
          {ungrouped.map((c) => renderRow(c, shownProjects.length > 0))}
        </section>
      )}

      {!loaded && conversations.length === 0 && [0, 1, 2, 3].map((i) => (
        <div key={i} className={`${ui.skeleton} animate-pulse-soft`} style={{ animationDelay: `${i * 0.12}s` }} aria-hidden="true" />
      ))}
      {loaded && conversations.length === 0 && projects.length === 0 && <p className={ui.empty}>No conversations yet</p>}
      {loaded && filtering && visible.length === 0 && conversations.length > 0 && <p className={ui.empty} role="status">No chats match “{filter.trim()}”</p>}
    </div>
  );
}
