"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import { Send, Bot, User, Plus, MessageSquare, Trash2, History, X, Paperclip, FileText, FileCode, FileArchive, Image as ImageIcon, Music, Video, File, Brain, LogOut, Download, ChevronDown, Check, SlidersHorizontal, Cpu, Database, Sun, Moon, Info, ListTodo, Waypoints, Mail, CalendarDays, Globe, Code2, Lightbulb, ArrowDown } from "lucide-react";
import { isSupportedAttachment, UPLOAD_ACCEPT, MAX_FILE_SIZE_MB, MAX_FILE_SIZE_BYTES } from "@/lib/types";
import { matchSlashCommands, type SlashCommand } from "@/lib/commands";
import type { ArtifactDescriptor } from "@/lib/types";
import type { AgentEvent } from "@/lib/ai/agent/events";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  fileName?: string;
  fileMimeType?: string;
  artifacts?: ArtifactDescriptor[];
  /** Which model produced this reply (only known for messages sent this session). */
  modelLabel?: string;
  /** ISO timestamp shown under assistant replies. */
  at?: string;
}

// Starter suggestions on the empty state. Each fills the input with a command
// (trailing space keeps the slash menu closed so Enter sends right away).
const STARTER_SUGGESTIONS: { icon: React.ReactNode; label: string; fill: string }[] = [
  { icon: <CalendarDays size={15} />, label: "Plan my day", fill: "/plan_day " },
  { icon: <Mail size={15} />, label: "Triage my inbox", fill: "/triage_emails " },
  { icon: <Globe size={15} />, label: "Research a topic", fill: "/research " },
  { icon: <Code2 size={15} />, label: "Write some code", fill: "/code " },
  { icon: <Lightbulb size={15} />, label: "Explain a concept", fill: "/explain " },
];

interface AgentRun {
  status: string;
  steps: { title: string; status: string }[];
  lines: string[];
}

const FRIENDLY_TOOL: Record<string, string> = {
  search_web: "Searching the web",
  search_knowledge: "Searching memory",
  save_note: "Saving a note",
  get_recent_conversations: "Reviewing recent chats",
  list_calendar_events: "Checking the calendar",
  manage_calendar_event: "Updating the calendar",
  list_unread_emails: "Checking email",
  list_recent_emails: "Checking email",
  read_email: "Reading an email",
  send_email: "Sending an email",
  draft_gmail_reply: "Drafting a reply",
  manage_todo_list: "Updating the to-do list",
  get_current_time: "Checking the time",
  create_document: "Writing a document",
  create_code_file: "Writing a code file",
  create_code_bundle: "Bundling files",
  use_skill: "Consulting a skill",
  vault_search: "Searching the second brain",
  vault_read: "Reading a vault page",
  vault_ingest: "Saving to the second brain",
  vault_write: "Updating a vault page",
  vault_lint: "Tidying the vault",
};
const friendlyTool = (name: string) => FRIENDLY_TOOL[name] ?? name;

interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

interface NoteItem {
  id: string;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "done";
  priority: "low" | "medium" | "high";
  dueDate: string | null;
  createdAt: string;
}

interface ModelMeta {
  developer: string;
  description: string;
  inputs: string[];
  context?: string;
  maxOutput?: string;
  params?: string;
  strengths: string[];
}
interface ProviderModel {
  id: string;
  label: string;
  dimension?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsThinking?: boolean;
  supportsSearch?: boolean;
  meta?: ModelMeta | null;
}
interface ProviderInfo {
  id: string;
  label: string;
  available: boolean;
  chatModels: ProviderModel[];
  embeddingModels: ProviderModel[];
}

interface GenParamsState {
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
}

function SelectMenu({
  icon, groups, value, onChange, ariaLabel, align = "left", compact = false, dropUp = false, wide = false,
}: {
  icon: React.ReactNode;
  groups: { label: string; options: { value: string; label: string }[] }[];
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  align?: "left" | "right";
  compact?: boolean;
  dropUp?: boolean;
  /** Lifts the trigger/menu width caps so long labels are not truncated. */
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = groups.flatMap((g) => g.options).find((o) => o.value === value);

  return (
    <div ref={ref} style={{ ...dropdown.wrap, ...(compact ? { flex: 1, maxWidth: "none" } : {}), ...(wide ? { maxWidth: "none" } : {}) }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ ...dropdown.trigger, ...(compact ? { width: "100%" } : {}), ...(open ? dropdown.triggerOpen : {}) }}
        aria-label={ariaLabel}
        title={current?.label}
      >
        <span style={dropdown.triggerIcon}>{icon}</span>
        <span style={dropdown.triggerLabel}>{current?.label ?? "Select"}</span>
        <ChevronDown
          size={14}
          style={{ flexShrink: 0, opacity: 0.5, transform: (dropUp ? !open : open) ? "rotate(180deg)" : "none", transition: "transform .18s ease" }}
        />
      </button>
      {open && (
        <div
          style={{
            ...dropdown.menu,
            ...(align === "right" ? { right: 0 } : { left: 0 }),
            ...(dropUp ? { top: "auto", bottom: "calc(100% + 6px)" } : {}),
            ...(wide ? { maxWidth: "min(380px, calc(100vw - 20px))" } : {}),
          }}
          className="animate-fade-in-scale"
        >
          {groups.map((g) => (
            <div key={g.label} style={dropdown.group}>
              <div style={dropdown.groupLabel}>{g.label}</div>
              {g.options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => { onChange(o.value); setOpen(false); }}
                  style={{ ...dropdown.item, ...(o.value === value ? dropdown.itemActive : {}) }}
                >
                  <span style={dropdown.itemLabel}>{o.label}</span>
                  {o.value === value && <Check size={14} style={{ flexShrink: 0 }} />}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ParamRow({
  label, value, min, max, step, def, onChange,
}: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  step: number;
  def: number;
  onChange: (v: number | null) => void;
}) {
  const active = value !== null;
  return (
    <div style={paramRow.wrap}>
      <div style={paramRow.top}>
        <span style={paramRow.label}>{label}</span>
        <div style={paramRow.right}>
          <span style={{ ...paramRow.value, opacity: active ? 1 : 0.5 }}>
            {active ? value : "Auto"}
          </span>
          <button
            type="button"
            onClick={() => onChange(active ? null : def)}
            style={{ ...paramRow.toggle, ...(active ? paramRow.toggleOn : {}) }}
          >
            {active ? "Custom" : "Auto"}
          </button>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={active ? value : def}
        disabled={!active}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ ...paramRow.slider, opacity: active ? 1 : 0.4 }}
      />
    </div>
  );
}

const STRENGTH_COLORS: Record<string, string> = {
  Coding: "#8b5cf6", Code: "#8b5cf6", Reasoning: "#3b82f6", Agentic: "#ec4899",
  Math: "#f59e0b", Science: "#10b981", Multimodal: "#a855f7", Vision: "#06b6d4",
  Multilingual: "#14b8a6", "Long context": "#6366f1", "Tool use": "#0ea5e9",
  Fast: "#22c55e", Video: "#f43f5e", Knowledge: "#eab308", Research: "#d946ef",
  "Document RAG": "#f97316", Retrieval: "#0ea5e9", "High throughput": "#84cc16",
  "Visual documents": "#f97316",
};
const strengthColor = (s: string) => STRENGTH_COLORS[s] ?? "#94a3b8";

function ModelInfoModal({
  model, providerLabel, onClose,
}: {
  model: ProviderModel;
  providerLabel: string;
  onClose: () => void;
}) {
  const meta = model.meta;
  const specs: { label: string; value: string }[] = [];
  if (meta?.context) specs.push({ label: "Context", value: meta.context });
  if (meta?.maxOutput) specs.push({ label: "Max output", value: meta.maxOutput });
  if (meta?.params) specs.push({ label: "Parameters", value: meta.params });
  if (model.dimension) specs.push({ label: "Dimensions", value: String(model.dimension) });

  const caps: string[] = [];
  if (model.supportsTools) caps.push("Tools");
  if (model.supportsVision) caps.push("Vision");
  if (model.supportsThinking) caps.push("Reasoning toggle");
  if (model.supportsSearch) caps.push("Web search");

  return (
    <div style={modal.overlay} className="animate-overlay-in" onClick={onClose}>
      <div style={modal.card} className="animate-fade-in-scale" onClick={(e) => e.stopPropagation()}>
        <div style={modal.header}>
          <div style={{ minWidth: 0 }}>
            <h2 style={modal.title}>{model.label}</h2>
            <p style={modal.subtitle}>
              {providerLabel}{meta?.developer ? ` · ${meta.developer}` : ""}
            </p>
          </div>
          <button onClick={onClose} style={styles.iconBtn} aria-label="Close">
            <X size={18} color="var(--color-text-muted)" />
          </button>
        </div>

        {meta?.description && <p style={modal.desc}>{meta.description}</p>}

        {!meta && <p style={modal.desc}>No details available for this model yet.</p>}

        {specs.length > 0 && (
          <div style={modal.specGrid}>
            {specs.map((s) => (
              <div key={s.label} style={modal.spec}>
                <span style={modal.specLabel}>{s.label}</span>
                <span style={modal.specValue}>{s.value}</span>
              </div>
            ))}
          </div>
        )}

        {meta?.inputs && meta.inputs.length > 0 && (
          <div style={modal.section}>
            <span style={modal.sectionLabel}>Inputs</span>
            <div style={modal.tagRow}>
              {meta.inputs.map((i) => (
                <span key={i} style={modal.plainTag}>{i}</span>
              ))}
            </div>
          </div>
        )}

        {caps.length > 0 && (
          <div style={modal.section}>
            <span style={modal.sectionLabel}>Capabilities</span>
            <div style={modal.tagRow}>
              {caps.map((c) => (
                <span key={c} style={modal.plainTag}>{c}</span>
              ))}
            </div>
          </div>
        )}

        {meta?.strengths && meta.strengths.length > 0 && (
          <div style={modal.section}>
            <span style={modal.sectionLabel}>Excels at</span>
            <div style={modal.tagRow}>
              {meta.strengths.map((s) => (
                <span key={s} style={modal.strengthTag}>
                  <span style={{ ...modal.dot, background: strengthColor(s) }} />
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const [pendingFile, setPendingFile] = useState<{ name: string; mimeType: string; base64: string; size: number } | null>(null);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [agentRun, setAgentRun] = useState<AgentRun | null>(null);
  const [isDesktop, setIsDesktop] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);

  const [chatSel, setChatSel] = useState("");
  const [embedSel, setEmbedSel] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [genParams, setGenParams] = useState<GenParamsState>({ temperature: null, topP: null, maxTokens: null });
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [modelInfoOpen, setModelInfoOpen] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [convosLoaded, setConvosLoaded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Show the jump-to-bottom button once the user scrolls up during a long chat.
  const handleMessagesScroll = (e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget;
    setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 280);
  };

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      const data = await res.json();
      if (data.conversations) {
        setConversations(data.conversations);
      }
    } catch (err) {
      console.error("Failed to load conversations:", err);
    } finally {
      setConvosLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const loadNotes = useCallback(async () => {
    try {
      const res = await fetch("/api/todos");
      const data = await res.json();
      if (data.todos) {
        // Undated notes first (newest on top), then dated ones by due date.
        const items = data.todos as NoteItem[];
        const undated = items.filter((n) => !n.dueDate);
        const dated = items
          .filter((n) => n.dueDate)
          .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
        setNotes([...undated, ...dated]);
      }
    } catch (err) {
      console.error("Failed to load notes:", err);
    }
  }, []);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  const completeNote = async (id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    try {
      const res = await fetch("/api/todos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: "done" }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
    } catch (err) {
      console.error("Failed to complete note:", err);
      loadNotes();
    }
  };

  const toggleNotes = () => {
    setNotesOpen((prev) => {
      const next = !prev;
      localStorage.setItem("zuychin-notes-open", String(next));
      if (next) loadNotes();
      return next;
    });
  };

  useEffect(() => {
    const saved = localStorage.getItem("zuychin-think-mode");
    if (saved === "true") setThinkingEnabled(true);
    if (localStorage.getItem("zuychin-notes-open") === "true" && window.innerWidth >= 768) {
      setNotesOpen(true);
    }
  }, []);

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "dark" ? "dark" : "light");
  }, []);

  const toggleTheme = () => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("zuychin-theme", next);
      return next;
    });
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/providers");
        const data = await res.json();
        const avail: ProviderInfo[] = (data.providers ?? []).filter((p: ProviderInfo) => p.available);
        setProviders(avail);

        const savedChat = localStorage.getItem("zuychin-chat-model");
        const validChat = avail.some((p) =>
          savedChat?.startsWith(p.id + "::") && p.chatModels.some((m) => `${p.id}::${m.id}` === savedChat)
        );
        if (validChat && savedChat) {
          setChatSel(savedChat);
        } else if (data.defaults?.chat) {
          setChatSel(`${data.defaults.chat.providerId}::${data.defaults.chat.modelId}`);
        }

        const embedProviders = avail.filter((p) => p.embeddingModels.length > 0);
        const savedEmbed = localStorage.getItem("zuychin-embed-model");
        const validEmbed = embedProviders.some((p) => p.embeddingModels.some((m) => m.id === savedEmbed));
        if (validEmbed && savedEmbed) {
          setEmbedSel(savedEmbed);
        } else if (data.defaults?.embedding) {
          setEmbedSel(data.defaults.embedding.modelId);
        }
      } catch (err) {
        console.error("Failed to load providers:", err);
      }
    })();
  }, []);

  const handleChatSelChange = (val: string) => {
    setChatSel(val);
    localStorage.setItem("zuychin-chat-model", val);
  };
  const handleEmbedSelChange = (val: string) => {
    setEmbedSel(val);
    localStorage.setItem("zuychin-embed-model", val);
  };

  useEffect(() => {
    try {
      const saved = localStorage.getItem("zuychin-gen-params");
      if (saved) setGenParams({ temperature: null, topP: null, maxTokens: null, ...JSON.parse(saved) });
    } catch { }
  }, []);

  const updateGenParams = (next: GenParamsState) => {
    setGenParams(next);
    localStorage.setItem("zuychin-gen-params", JSON.stringify(next));
  };

  const currentChatProvider = (() => {
    const sep = chatSel.indexOf("::");
    if (sep === -1) return undefined;
    return providers.find((p) => p.id === chatSel.slice(0, sep));
  })();
  const currentChatModel = (() => {
    const sep = chatSel.indexOf("::");
    if (sep === -1) return undefined;
    const mid = chatSel.slice(sep + 2);
    return currentChatProvider?.chatModels.find((m) => m.id === mid);
  })();
  const canThink = !!currentChatModel?.supportsThinking;

  useEffect(() => {
    if (!canThink && thinkingEnabled) setThinkingEnabled(false);
  }, [canThink, thinkingEnabled]);

  const toggleThinking = () => {
    setThinkingEnabled((prev) => {
      const next = !prev;
      localStorage.setItem("zuychin-think-mode", String(next));
      return next;
    });
  };

  const toggleAgent = () => {
    setAgentEnabled((prev) => {
      const next = !prev;
      localStorage.setItem("zuychin-agent-mode", String(next));
      return next;
    });
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth", { method: "DELETE" });
    } finally {
      window.location.href = "/login";
    }
  };

  const loadConversation = async (convId: string) => {
    try {
      const res = await fetch(`/api/conversations?id=${convId}`);
      const data = await res.json();
      if (data.messages) {
        setMessages(
          data.messages.map((m: { id: string; role: string; content: string; createdAt?: string; metadata?: { artifacts?: ArtifactDescriptor[] } }) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            artifacts: m.metadata?.artifacts,
            at: m.createdAt,
          }))
        );
      }
      setActiveConversationId(convId);
      setSidebarOpen(false);
    } catch (err) {
      console.error("Failed to load conversation:", err);
    }
  };

  const handleNewChat = async () => {
    try {
      const res = await fetch("/api/conversations", { method: "POST" });
      const data = await res.json();
      setActiveConversationId(data.id);
      setMessages([]);
      setSidebarOpen(false);
      await loadConversations();
    } catch (err) {
      console.error("Failed to create conversation:", err);
    }
  };

  const handleDeleteConversation = async (e: React.MouseEvent, convId: string) => {
    e.stopPropagation();
    try {
      await fetch(`/api/conversations?id=${convId}`, { method: "DELETE" });
      if (activeConversationId === convId) {
        setActiveConversationId(null);
        setMessages([]);
      }
      await loadConversations();
    } catch (err) {
      console.error("Failed to delete conversation:", err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && !pendingFile) || isLoading) return;

    let convId = activeConversationId;
    if (!convId) {
      try {
        const res = await fetch("/api/conversations", { method: "POST" });
        const data = await res.json();
        convId = data.id;
        setActiveConversationId(data.id);
      } catch {
      }
    }

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim() || (pendingFile ? `[Sent ${pendingFile.name}]` : ""),
      fileName: pendingFile?.name,
      fileMimeType: pendingFile?.mimeType,
    };

    const fileToSend = pendingFile;
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setPendingFile(null);
    setIsLoading(true);

    if (convId) {
      const bumpedId = convId;
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === bumpedId);
        if (idx <= 0) return prev;
        const next = [...prev];
        const [conv] = next.splice(idx, 1);
        next.unshift({ ...conv, updatedAt: new Date().toISOString() });
        return next;
      });
    }

    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessage.content,
          conversationId: convId,
          thinking: thinkingEnabled && canThink,
          agent: agentEnabled,
          genParams: {
            ...(genParams.temperature !== null && { temperature: genParams.temperature }),
            ...(genParams.topP !== null && { topP: genParams.topP }),
            ...(genParams.maxTokens !== null && { maxTokens: genParams.maxTokens }),
          },
          ...(chatSel.includes("::") && {
            provider: chatSel.split("::")[0],
            model: chatSel.split("::").slice(1).join("::"),
          }),
          ...(embedSel && { embeddingModel: embedSel }),
          ...(fileToSend && {
            file: {
              name: fileToSend.name,
              mimeType: fileToSend.mimeType,
              base64: fileToSend.base64,
              size: fileToSend.size,
            },
          }),
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done: { reply: string; artifacts?: ArtifactDescriptor[] } | null = null;
      let streamError = "";

      const base = (): AgentRun => ({ status: "", steps: [], lines: [] });

      for (; ;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const json = dataLine.slice(5).trim();
          if (!json) continue;
          let evt: AgentEvent;
          try { evt = JSON.parse(json) as AgentEvent; } catch { continue; }

          if (evt.type === "status") {
            setAgentRun((r) => ({ ...(r ?? base()), status: evt.message }));
          } else if (evt.type === "plan") {
            setAgentRun((r) => ({ ...(r ?? base()), steps: evt.steps }));
          } else if (evt.type === "tool") {
            if (evt.phase === "start") {
              setAgentRun((r) => ({ ...(r ?? base()), lines: [...(r ?? base()).lines, `${friendlyTool(evt.name)}…`] }));
            }
          } else if (evt.type === "subagent") {
            if (evt.phase === "start") {
              setAgentRun((r) => ({ ...(r ?? base()), lines: [...(r ?? base()).lines, `Delegating to ${evt.model}: ${evt.objective}`] }));
            }
          } else if (evt.type === "artifact") {
            setAgentRun((r) => ({ ...(r ?? base()), lines: [...(r ?? base()).lines, `Created ${evt.artifact.name}`] }));
          } else if (evt.type === "done") {
            done = { reply: evt.reply, artifacts: evt.artifacts };
          } else if (evt.type === "error") {
            streamError = evt.message;
          }
        }
      }

      if (streamError) throw new Error(streamError);

      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: done?.reply ?? "(No response.)",
        artifacts: done?.artifacts,
        modelLabel: currentChatModel?.label,
        at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
      await loadConversations();
      loadNotes();
    } catch (error: unknown) {
      const errorMsg =
        error instanceof Error ? error.message : "Something went wrong.";
      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: `⚠️ ${errorMsg}`,
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
      setAgentRun(null);
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    setCmdDismissed(false);
    setCmdIndex(0);

    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
  };

  const applySuggestion = (fill: string) => {
    setInput(fill);
    inputRef.current?.focus();
  };

  const msgClock = (iso?: string) => {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };

  // Command suggestions show while the first token is being typed ("/dra…").
  const slashMatches = cmdDismissed ? [] : matchSlashCommands(input);
  const cmdSel = Math.min(cmdIndex, Math.max(0, slashMatches.length - 1));

  const applyCommand = (c: SlashCommand) => {
    setInput(`/${c.id} `);
    setCmdIndex(0);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCmdIndex((cmdSel + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCmdIndex((cmdSel - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        applyCommand(slashMatches[cmdSel]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCmdDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!isSupportedAttachment(file.type, file.name)) {
      alert(`Unsupported file type: ${file.type || file.name}\n\nSupported: images, audio, video, PDF, and text/data files (Markdown, YAML, CSV, JSON, code, …).`);
      return;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      alert(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max ${MAX_FILE_SIZE_MB} MB.`);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      setPendingFile({
        name: file.name,
        mimeType: file.type,
        base64,
        size: file.size,
      });
    };
    reader.readAsDataURL(file);

    e.target.value = "";
  };

  const getFileIcon = (mimeType?: string) => {
    if (!mimeType) return <File size={14} />;
    if (mimeType.startsWith("image/")) return <ImageIcon size={14} />;
    if (mimeType.startsWith("audio/")) return <Music size={14} />;
    if (mimeType.startsWith("video/")) return <Video size={14} />;
    return <FileText size={14} />;
  };

  const getArtifactIcon = (kind: ArtifactDescriptor["kind"]) => {
    if (kind === "code") return <FileCode size={15} color="var(--color-primary)" />;
    if (kind === "archive") return <FileArchive size={15} color="var(--color-primary)" />;
    return <FileText size={15} color="var(--color-primary)" />;
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const downloadArtifact = async (art: ArtifactDescriptor) => {
    try {
      const res = await fetch(`/api/artifacts/${art.id}`);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = art.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Artifact download error:", err);
      alert(`Could not download ${art.name}. ${err instanceof Error ? err.message : ""}`);
    }
  };

  const handleExport = async (content: string, format: "docx" | "pdf" | "md") => {
    try {
      const title = content.substring(0, 40).replace(/[^a-zA-Z0-9\s]/g, "").trim() || "Document";
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, format, title }),
      });

      if (!res.ok) throw new Error("Export failed");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export error:", err);
      alert("Failed to export document.");
    }
  };

  const activeConvTitle = (() => {
    const title = conversations.find((c) => c.id === activeConversationId)?.title;
    return title && title !== "New Chat" ? title : undefined;
  })();

  const renderModelSelectors = (compact: boolean) =>
    providers.length > 0 ? (
      <>
        <Link
          href="/graph"
          style={{ ...styles.graphBtn, flexShrink: 0 }}
          aria-label="Knowledge graph"
          title="Knowledge graph"
        >
          <Waypoints size={14} color="var(--color-text-muted)" />
          <span>Knowledge Graph</span>
        </Link>
        <SelectMenu
          compact={compact}
          align="right"
          ariaLabel="Chat model"
          icon={<Cpu size={14} color="var(--color-primary)" />}
          value={chatSel}
          onChange={handleChatSelChange}
          groups={providers.map((p) => ({
            label: p.label,
            options: p.chatModels.map((m) => ({ value: `${p.id}::${m.id}`, label: m.label })),
          }))}
        />
        <button
          type="button"
          onClick={() => setModelInfoOpen(true)}
          style={styles.infoBtn}
          aria-label="Model details"
          title="Model details"
          disabled={!currentChatModel}
        >
          <Info size={17} color="var(--color-text-muted)" />
        </button>
      </>
    ) : null;

  return (
    <div style={styles.wrapper}>
      {!isDesktop && sidebarOpen && (
        <div
          style={styles.overlay}
          className="animate-overlay-in"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {!isDesktop && notesOpen && (
        <div
          style={styles.overlay}
          className="animate-overlay-in"
          onClick={() => setNotesOpen(false)}
        />
      )}

      {modelInfoOpen && currentChatModel && (
        <ModelInfoModal
          model={currentChatModel}
          providerLabel={currentChatProvider?.label ?? ""}
          onClose={() => setModelInfoOpen(false)}
        />
      )}

      <aside
        style={{
          ...(isDesktop ? {
            ...styles.notesPanelDesktop,
            width: notesOpen ? 280 : 0,
            minWidth: notesOpen ? 280 : 0,
          } : styles.notesPanel),
          ...(!isDesktop && { transform: notesOpen ? "translateX(0)" : "translateX(100%)" }),
        }}
      >
        <div style={styles.sidebarHeader}>
          <h2 style={styles.sidebarTitle}>Notes</h2>
          <button
            onClick={() => setNotesOpen(false)}
            style={styles.closeBtn}
            aria-label="Close notes"
          >
            <X size={18} color="var(--color-text-muted)" />
          </button>
        </div>

        <div style={styles.notesList}>
          {notes.length === 0 && (
            <p style={styles.noConversations}>
              Nothing pending. Ask me to remember a task and it will show up here.
            </p>
          )}
          {notes.map((note) => (
            <div key={note.id} style={styles.noteItem}>
              <button
                onClick={() => completeNote(note.id)}
                style={styles.noteCheckbox}
                aria-label={`Mark "${note.title}" as done`}
                title="Mark as done"
              />
              <div style={styles.noteInfo}>
                <span style={styles.noteTitle}>{note.title}</span>
                {note.description && (
                  <span style={styles.noteDesc}>{note.description}</span>
                )}
                {note.dueDate && (
                  <span style={styles.noteDue}>
                    {new Date(note.dueDate).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </aside>

      <aside
        style={{
          ...(isDesktop ? {
            ...styles.sidebarDesktop,
            width: sidebarOpen ? 300 : 0,
            minWidth: sidebarOpen ? 300 : 0,
          } : styles.sidebar),
          ...(!isDesktop && { transform: sidebarOpen ? "translateX(0)" : "translateX(100%)" }),
        }}
      >
        <div style={styles.sidebarHeader}>
          <h2 style={styles.sidebarTitle}>Chats</h2>
          <button
            onClick={() => setSidebarOpen(false)}
            style={styles.closeBtn}
            aria-label="Close sidebar"
          >
            <X size={18} color="var(--color-text-muted)" />
          </button>
        </div>

        <button onClick={handleNewChat} style={styles.newChatBtn}>
          <Plus size={16} />
          <span>New Chat</span>
        </button>

        <div style={styles.conversationList}>
          {!convosLoaded && conversations.length === 0 &&
            [0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="animate-pulse-soft"
                style={{ ...styles.convSkeleton, animationDelay: `${i * 0.12}s` }}
              />
            ))}
          {convosLoaded && conversations.length === 0 && (
            <p style={styles.noConversations}>No conversations yet</p>
          )}
          {conversations.map((conv) => (
            <div
              key={conv.id}
              onClick={() => loadConversation(conv.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && loadConversation(conv.id)}
              style={{
                ...styles.conversationItem,
                ...(activeConversationId === conv.id
                  ? styles.conversationItemActive
                  : {}),
              }}
            >
              <MessageSquare size={14} style={{ flexShrink: 0, marginTop: 2 }} />
              <div style={styles.conversationInfo}>
                <span style={styles.conversationTitle}>{conv.title}</span>
                <span style={styles.conversationTime}>
                  {formatTime(conv.updatedAt)}
                </span>
              </div>
              <button
                onClick={(e) => handleDeleteConversation(e, conv.id)}
                style={styles.deleteBtn}
                aria-label="Delete conversation"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>

        <button onClick={handleLogout} style={styles.logoutBtn}>
          <LogOut size={15} />
          <span>Log out</span>
        </button>
      </aside>

      <div style={isDesktop ? styles.containerDesktop : styles.container}>
        <header style={styles.header}>
          <div style={styles.headerContent}>
            <div style={styles.headerLeft}>
              <span aria-hidden style={isDesktop ? styles.logoMark : styles.logoMarkMobile} />
              <div style={isDesktop ? styles.brandText : styles.brandTextMobile}>
                <h1 style={styles.title}>Zuychin</h1>
                <span style={isDesktop ? styles.subtitle : styles.subtitleMobile}>Assistant</span>
              </div>

              {isDesktop && (
                <div style={styles.headerCenter}>
                  {renderModelSelectors(false)}
                </div>
              )}
            </div>

            {isDesktop && activeConvTitle && messages.length > 0 && (
              <div style={styles.headerConvTitle} title={activeConvTitle}>
                {activeConvTitle}
              </div>
            )}

            <div style={styles.headerRight}>
              <button type="button"
                onClick={toggleTheme}
                style={styles.iconBtn}
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                title={theme === "dark" ? "Light mode" : "Dark mode"}
              >
                {theme === "dark"
                  ? <Sun size={19} color="var(--color-text-primary)" />
                  : <Moon size={19} color="var(--color-text-primary)" />}
              </button>
              <button
                onClick={toggleNotes}
                style={{ ...styles.iconBtn, position: "relative" }}
                aria-label={notesOpen ? "Close notes" : `Open notes (${notes.length} pending)`}
                title="Notes & tasks"
              >
                <ListTodo size={19} color={notesOpen ? "var(--color-primary)" : "var(--color-text-primary)"} />
                {!notesOpen && notes.length > 0 && (
                  <span style={styles.noteBadge}>{notes.length > 9 ? "9+" : notes.length}</span>
                )}
              </button>
              <button onClick={() => setSidebarOpen((prev) => !prev)} style={styles.iconBtn} aria-label="Conversation history" title="History">
                <History size={19} color="var(--color-text-primary)" />
              </button>
              <button onClick={handleNewChat} style={styles.iconBtn} aria-label="New conversation" title="New conversation">
                <Plus size={20} color="var(--color-text-primary)" />
              </button>
            </div>
          </div>

          {!isDesktop && providers.length > 0 && (
            <div style={styles.headerSelectorsRow}>
              {renderModelSelectors(true)}
            </div>
          )}
        </header>

        <main
          onScroll={handleMessagesScroll}
          style={isDesktop ? styles.messages : { ...styles.messages, padding: "16px 14px 8px" }}
        >
          {messages.length === 0 && (
            <div style={styles.emptyState} className="animate-fade-in-scale">
              <div style={styles.emptyIcon} className="animate-float">
                <Bot size={32} color="var(--color-primary-foreground)" />
              </div>
              <p style={styles.emptyTitle}>Hi, I&apos;m Zuychin</p>
              <p style={styles.emptySubtitle}>
                Your personal AI assistant for research, coding and planning.
              </p>
              <div style={styles.suggestionRow}>
                {STARTER_SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    style={styles.suggestionChip}
                    onClick={() => applySuggestion(s.fill)}
                  >
                    <span style={styles.suggestionIcon}>{s.icon}</span>
                    {s.label}
                  </button>
                ))}
              </div>
              <p style={styles.emptyHint}>
                Type <code style={styles.hintKbd}>/</code> for {`all commands · attach files up to ${MAX_FILE_SIZE_MB} MB · switch models from the header`}
              </p>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              style={{
                ...styles.messageBubbleWrapper,
                justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
              }}
              className={msg.role === "user" ? "animate-slide-right" : "animate-slide-left"}
            >
              {msg.role === "assistant" && (
                <div style={styles.msgAvatar}>
                  <Bot size={14} color="var(--color-primary-foreground)" />
                </div>
              )}
              <div
                style={{
                  ...styles.bubble,
                  ...(msg.role === "user" ? styles.userBubble : styles.aiBubble),
                }}
              >
                {msg.fileName && (
                  <div style={styles.fileTag}>
                    {getFileIcon(msg.fileMimeType)}
                    <span style={styles.fileTagName}>{msg.fileName}</span>
                  </div>
                )}
                {msg.role === "assistant" ? (
                  <div className="markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  <p style={styles.bubbleText}>{msg.content}</p>
                )}
                {msg.role === "assistant" && msg.artifacts && msg.artifacts.length > 0 && (
                  <div style={styles.artifactRow}>
                    {msg.artifacts.map((art) => (
                      <button
                        key={art.id}
                        type="button"
                        onClick={() => downloadArtifact(art)}
                        style={styles.artifactChip}
                        title={`Download ${art.name}`}
                      >
                        {getArtifactIcon(art.kind)}
                        <span style={styles.artifactName}>{art.name}</span>
                        <span style={styles.artifactSize}>{formatBytes(art.size)}</span>
                        <Download size={13} color="var(--color-primary)" />
                      </button>
                    ))}
                  </div>
                )}
                {msg.role === "assistant" && msg.content.length > 80 && (
                  <div style={styles.exportRow}>
                    <button
                      onClick={() => handleExport(msg.content, "docx")}
                      style={styles.exportBtn}
                      title="Download as DOCX"
                    >
                      <Download size={12} />
                      <span>DOCX</span>
                    </button>
                    <button
                      onClick={() => handleExport(msg.content, "pdf")}
                      style={styles.exportBtn}
                      title="Download as PDF"
                    >
                      <Download size={12} />
                      <span>PDF</span>
                    </button>
                    <button
                      onClick={() => handleExport(msg.content, "md")}
                      style={styles.exportBtn}
                      title="Download as Markdown"
                    >
                      <Download size={12} />
                      <span>MD</span>
                    </button>
                  </div>
                )}
                {msg.role === "assistant" && (msg.modelLabel || msgClock(msg.at)) && (
                  <div style={styles.msgMeta}>
                    {[msg.modelLabel, msgClock(msg.at)].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
              {msg.role === "user" && (
                <div style={{ ...styles.msgAvatar, ...styles.userAvatar }}>
                  <User size={14} color="var(--color-text-muted)" />
                </div>
              )}
            </div>
          ))}

          {isLoading && (
            <div style={styles.messageBubbleWrapper} className="animate-fade-in">
              <div style={styles.msgAvatar}>
                <Bot size={14} color="var(--color-primary-foreground)" />
              </div>
              <div style={{ ...styles.bubble, ...styles.aiBubble }}>
                {agentRun ? (
                  <div style={styles.agentTracker}>
                    <div style={styles.agentHeader}>
                      <Bot size={14} color="var(--color-primary)" />
                      <span>{agentRun.status || "Working…"}</span>
                    </div>
                    {agentRun.steps.length > 0 && (
                      <div style={styles.agentSteps}>
                        {agentRun.steps.map((s, i) => (
                          <div key={i} style={styles.agentStep}>
                            <span style={styles.agentStepMark}>
                              {s.status === "done" ? "✓" : s.status === "in_progress" ? "▸" : "○"}
                            </span>
                            <span style={{ opacity: s.status === "done" ? 0.6 : 1 }}>{s.title}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {agentRun.lines.slice(-4).map((l, i) => (
                      <div key={i} style={styles.agentLine}>{l}</div>
                    ))}
                  </div>
                ) : (
                  <div style={styles.typingRow}>
                    <span style={styles.typingDot} className="animate-bounce-dot" />
                    <span style={styles.typingDot} className="animate-bounce-dot-2" />
                    <span style={styles.typingDot} className="animate-bounce-dot-3" />
                    {thinkingEnabled && (
                      <span style={styles.typingLabel}>Thinking deeply...</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </main>

        {showScrollBtn && (
          <button
            type="button"
            onClick={scrollToBottom}
            style={styles.scrollDownBtn}
            className="animate-fade-in"
            aria-label="Scroll to latest message"
            title="Jump to latest"
          >
            <ArrowDown size={16} />
          </button>
        )}

        <footer style={isDesktop ? styles.footer : { ...styles.footer, padding: "10px 12px calc(env(safe-area-inset-bottom, 0px) + 10px)" }}>
          {settingsOpen && (
            <div style={styles.settingsPanel} className="animate-fade-in-scale">
              <div style={styles.settingsHeader}>
                <span style={styles.settingsTitle}>Generation settings</span>
                <button onClick={() => setSettingsOpen(false)} style={styles.filePreviewRemove} aria-label="Close settings">
                  <X size={14} />
                </button>
              </div>
              <ParamRow
                label="Temperature" min={0} max={2} step={0.1} def={0.7}
                value={genParams.temperature}
                onChange={(v) => updateGenParams({ ...genParams, temperature: v })}
              />
              <ParamRow
                label="Top P" min={0} max={1} step={0.05} def={0.9}
                value={genParams.topP}
                onChange={(v) => updateGenParams({ ...genParams, topP: v })}
              />
              <ParamRow
                label="Max tokens" min={256} max={8192} step={256} def={2048}
                value={genParams.maxTokens}
                onChange={(v) => updateGenParams({ ...genParams, maxTokens: v })}
              />
              <p style={styles.settingsNote}>
                Unset = provider default. Applied to the selected model where supported.
              </p>
              <div style={styles.settingsEmbedRow}>
                {providers.some((p) => p.embeddingModels.length > 0) && (
                  <>
                    <span style={styles.settingsEmbedLabel}>Embedding</span>
                    <SelectMenu
                      dropUp
                      wide
                      ariaLabel="Embedding model"
                      icon={<Database size={14} color="var(--color-text-muted)" />}
                      value={embedSel}
                      onChange={handleEmbedSelChange}
                      groups={providers
                        .filter((p) => p.embeddingModels.length > 0)
                        .map((p) => ({
                          label: p.label,
                          options: p.embeddingModels.map((m) => ({ value: m.id, label: m.label })),
                        }))}
                    />
                  </>
                )}
                <div style={styles.agentSwitchWrap}>
                  <span style={styles.settingsEmbedLabel}>Agent mode</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={agentEnabled}
                    onClick={toggleAgent}
                    style={{
                      ...styles.switchTrack,
                      ...(agentEnabled ? styles.switchTrackOn : {}),
                    }}
                    aria-label={agentEnabled ? "Disable agent mode" : "Enable agent mode"}
                    title={agentEnabled ? "Agent mode ON (multi-step + files)" : "Agent mode OFF (auto-detects complex tasks)"}
                  >
                    <span
                      style={{
                        ...styles.switchKnob,
                        transform: agentEnabled ? "translateX(16px)" : "translateX(0)",
                      }}
                    />
                  </button>
                </div>
              </div>
            </div>
          )}

          {pendingFile && (
            <div style={styles.filePreview} className="animate-fade-in">
              <div style={styles.filePreviewInfo}>
                {getFileIcon(pendingFile.mimeType)}
                <span style={styles.filePreviewName}>{pendingFile.name}</span>
                <span style={styles.filePreviewSize}>
                  {(pendingFile.size / 1024).toFixed(0)} KB
                </span>
              </div>
              <button
                onClick={() => setPendingFile(null)}
                style={styles.filePreviewRemove}
                aria-label="Remove file"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {slashMatches.length > 0 && (
            <div style={styles.cmdMenu} className="animate-fade-in-scale">
              {slashMatches.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); applyCommand(c); }}
                  onMouseEnter={() => setCmdIndex(i)}
                  style={{ ...styles.cmdItem, ...(i === cmdSel ? styles.cmdItemActive : {}) }}
                >
                  <span style={styles.cmdUsage}>{c.usage}</span>
                  <span style={styles.cmdDesc}>{c.description}</span>
                </button>
              ))}
            </div>
          )}

          <form onSubmit={handleSubmit} style={styles.inputRow}>
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleFileSelect}
              style={{ display: "none" }}
              accept={UPLOAD_ACCEPT}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={styles.attachBtn}
              aria-label="Attach file"
            >
              <Paperclip size={18} color="var(--color-text-muted)" />
            </button>
            {canThink && (
              <button
                type="button"
                onClick={toggleThinking}
                style={{
                  ...styles.attachBtn,
                  opacity: thinkingEnabled ? 1 : 0.5,
                }}
                aria-label={thinkingEnabled ? "Disable deep thinking" : "Enable deep thinking"}
                title={thinkingEnabled ? "Think mode ON" : "Think mode OFF"}
              >
                <Brain size={18} color={thinkingEnabled ? "var(--color-primary)" : "var(--color-text-muted)"} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setSettingsOpen((o) => !o)}
              style={{
                ...styles.attachBtn,
                opacity: (genParams.temperature ?? genParams.topP ?? genParams.maxTokens) !== null ? 1 : 0.5,
              }}
              aria-label="Generation settings"
              title="Generation settings"
            >
              <SlidersHorizontal size={18} color={(genParams.temperature ?? genParams.topP ?? genParams.maxTokens) !== null ? "var(--color-primary)" : "var(--color-text-muted)"} />
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder="Message Zuychin..."
              rows={1}
              style={styles.textarea}
            />
            <button
              type="submit"
              disabled={(!input.trim() && !pendingFile) || isLoading}
              style={{
                ...styles.sendButton,
                opacity: (!input.trim() && !pendingFile) || isLoading ? 0.3 : 1,
              }}
              aria-label="Send message"
            >
              <Send size={20} color="var(--color-primary-foreground)" />
            </button>
          </form>
        </footer>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: "flex",
    height: "100dvh",
    position: "relative",
    overflow: "hidden",
    background: "radial-gradient(circle at 15% 0%, color-mix(in srgb, var(--color-secondary) 14%, transparent), transparent 32%), radial-gradient(circle at 90% 100%, color-mix(in srgb, #7aa2ff 10%, transparent), transparent 34%), var(--color-background)",
  },

  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0, 0, 0, 0.4)",
    backdropFilter: "blur(2px)",
    WebkitBackdropFilter: "blur(2px)",
    zIndex: 20,
  },

  sidebar: {
    position: "fixed",
    top: 0,
    right: 0,
    bottom: 0,
    width: 280,
    background: "color-mix(in srgb, var(--color-surface) 94%, transparent)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    borderLeft: "1px solid var(--color-border)",
    zIndex: 30,
    display: "flex",
    flexDirection: "column",
    transition: "transform 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
  },

  sidebarDesktop: {
    order: 2,
    background: "color-mix(in srgb, var(--color-surface) 88%, transparent)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    borderLeft: "1px solid var(--color-border)",
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    overflow: "hidden",
    transition: "width 0.25s cubic-bezier(0.23, 1, 0.32, 1), min-width 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
  },

  notesPanel: {
    position: "fixed",
    top: 0,
    right: 0,
    bottom: 0,
    width: 280,
    background: "color-mix(in srgb, var(--color-surface) 94%, transparent)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    borderLeft: "1px solid var(--color-border)",
    zIndex: 30,
    display: "flex",
    flexDirection: "column",
    transition: "transform 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
  },
  notesPanelDesktop: {
    order: 1,
    background: "color-mix(in srgb, var(--color-surface) 88%, transparent)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    borderLeft: "1px solid var(--color-border)",
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    overflow: "hidden",
    transition: "width 0.25s cubic-bezier(0.23, 1, 0.32, 1), min-width 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
  },
  notesList: {
    flex: 1,
    overflowY: "auto",
    padding: "8px 10px",
  },
  noteItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "9px 10px",
    borderRadius: 8,
  },
  noteCheckbox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    border: "1.5px solid var(--color-text-muted)",
    background: "transparent",
    cursor: "pointer",
    flexShrink: 0,
    marginTop: 1,
    padding: 0,
  },
  noteInfo: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
  },
  noteTitle: {
    fontSize: 13,
    fontWeight: 500,
    color: "var(--color-text-primary)",
    lineHeight: 1.35,
    overflowWrap: "anywhere",
  },
  noteDesc: {
    fontSize: 12,
    color: "var(--color-text-muted)",
    lineHeight: 1.35,
  },
  noteDue: {
    fontSize: 11,
    fontWeight: 500,
    color: "var(--color-primary)",
  },
  noteBadge: {
    position: "absolute",
    top: 2,
    right: 2,
    minWidth: 15,
    height: 15,
    padding: "0 3px",
    borderRadius: 8,
    background: "var(--color-primary)",
    color: "var(--color-primary-foreground)",
    fontSize: 9.5,
    fontWeight: 700,
    lineHeight: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  sidebarHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 16px",
    height: 69,
    borderBottom: "1px solid var(--color-border)",
  },
  sidebarTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: "var(--color-text-primary)",
  },
  closeBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 4,
    display: "flex",
  },
  newChatBtn: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    margin: "12px 12px 8px",
    padding: "10px 14px",
    background: "var(--color-primary)",
    color: "var(--color-primary-foreground)",
    border: "none",
    borderRadius: "var(--radius-md)",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 500,
    fontFamily: "var(--font-family)",
  },
  conversationList: {
    flex: 1,
    overflowY: "auto",
    padding: "4px 8px",
  },
  noConversations: {
    textAlign: "center",
    color: "var(--color-text-muted)",
    fontSize: 13,
    padding: "20px 0",
  },
  conversationItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    width: "100%",
    padding: "10px 12px",
    background: "transparent",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    textAlign: "left",
    color: "var(--color-text-primary)",
    fontSize: 13,
    fontFamily: "var(--font-family)",
    transition: "background 0.15s ease",
  },
  conversationItemActive: {
    background: "var(--color-background)",
  },
  conversationInfo: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
  },
  conversationTitle: {
    fontSize: 13,
    fontWeight: 500,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  conversationTime: {
    fontSize: 11,
    color: "var(--color-text-muted)",
  },
  deleteBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 4,
    color: "var(--color-text-muted)",
    opacity: 0.5,
    flexShrink: 0,
    display: "flex",
  },
  logoutBtn: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    margin: "8px 12px 16px",
    padding: "10px 14px",
    background: "none",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-md)",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    fontFamily: "var(--font-family)",
    color: "var(--color-text-muted)",
    transition: "background 0.15s ease, color 0.15s ease",
  },

  container: {
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    flex: 1,
    maxWidth: 720,
    margin: "0 auto",
    background: "transparent",
    width: "100%",
    position: "relative",
  },

  containerDesktop: {
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    flex: 1,
    background: "transparent",
    width: "100%",
    position: "relative",
  },

  header: {
    position: "sticky",
    top: 0,
    zIndex: 10,
    background: "color-mix(in srgb, var(--color-background) 82%, transparent)",
    backdropFilter: "blur(18px) saturate(1.15)",
    WebkitBackdropFilter: "blur(18px) saturate(1.15)",
    borderBottom: "1px solid color-mix(in srgb, var(--color-border) 80%, transparent)",
  },
  headerContent: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "12px 16px 12px 26px",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  headerCenter: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
    flexShrink: 1,

    marginLeft: 16,
    paddingLeft: 26,
    borderLeft: "1px solid var(--color-border)",
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
    padding: 3,
    borderRadius: 999,
    background: "color-mix(in srgb, var(--color-surface) 80%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
  },
  headerConvTitle: {
    flex: 1,
    minWidth: 0,
    textAlign: "center",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-text-muted)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    padding: "0 14px",
  },
  headerSelectorsRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 12px 10px",
  },

  logoMark: {
    width: 46,
    height: 36,
    flexShrink: 0,
    backgroundColor: "var(--color-text-primary)",
    WebkitMaskImage: "url('/zuychin-logo.svg')",
    maskImage: "url('/zuychin-logo.svg')",
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    maskPosition: "center",
    WebkitMaskSize: "contain",
    maskSize: "contain",
  },

  logoMarkMobile: {
    width: 35,
    height: 27,
    flexShrink: 0,
    backgroundColor: "var(--color-text-primary)",
    WebkitMaskImage: "url('/zuychin-logo.svg')",
    maskImage: "url('/zuychin-logo.svg')",
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    maskPosition: "center",
    WebkitMaskSize: "contain",
    maskSize: "contain",
  },
  brandText: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    flexShrink: 0,
  },
  brandTextMobile: {
    display: "flex",
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    minWidth: 0,
  },
  iconBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    flexShrink: 0,
    transition: "background 0.15s ease",
  },
  title: {
    fontSize: 17,
    fontWeight: 600,
    letterSpacing: "-0.3px",
    color: "var(--color-text-primary)",
    lineHeight: 1.1,
  },
  subtitle: {
    fontSize: 12,
    fontWeight: 500,
    color: "var(--color-text-muted)",
    letterSpacing: "0.2px",
  },

  subtitleMobile: {
    fontSize: 17,
    fontWeight: 500,
    color: "var(--color-text-muted)",
    letterSpacing: "-0.2px",
  },
  infoBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 6,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    flexShrink: 0,
    transition: "background 0.15s ease",
  },
  graphBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 11px",
    fontSize: 12.5,
    fontWeight: 500,
    borderRadius: 10,
    border: "1px solid var(--color-border)",
    background: "var(--color-surface)",
    color: "var(--color-text-primary)",
    textDecoration: "none",
    flexShrink: 0,
    transition: "background 0.15s ease",
  },

  messages: {
    flex: 1,
    overflowY: "auto",
    padding: "20px 24px 8px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    maxWidth: 820,
    width: "100%",
    margin: "0 auto",
  },

  emptyState: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "0 16px",
  },
  suggestionRow: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginTop: 18,
    maxWidth: 520,
  },
  suggestionChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    padding: "9px 14px",
    fontSize: 13,
    fontWeight: 550,
    fontFamily: "var(--font-family)",
    color: "var(--color-text-primary)",
    background: "color-mix(in srgb, var(--color-surface) 88%, transparent)",
    border: "1px solid var(--color-border)",
    borderRadius: 999,
    cursor: "pointer",
    boxShadow: "0 4px 18px rgba(0, 0, 0, 0.06)",
    transition: "background 0.15s ease, transform 0.15s ease",
  },
  suggestionIcon: {
    display: "flex",
    alignItems: "center",
    color: "var(--color-text-muted)",
  },
  emptyHint: {
    marginTop: 16,
    fontSize: 12,
    color: "var(--color-text-muted)",
    textAlign: "center",
    lineHeight: 1.6,
  },
  hintKbd: {
    padding: "1px 6px",
    borderRadius: 6,
    fontSize: 11.5,
    fontFamily: "var(--font-mono)",
    background: "color-mix(in srgb, var(--color-surface) 90%, transparent)",
    border: "1px solid var(--color-border)",
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: "50%",
    background: "var(--color-primary)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: 600,
    color: "var(--color-text-primary)",
  },
  emptySubtitle: {
    fontSize: 14,
    color: "var(--color-text-muted)",
  },

  messageBubbleWrapper: {
    display: "flex",
    alignItems: "flex-end",
    gap: 8,
  },
  msgAvatar: {
    width: 24,
    height: 24,
    borderRadius: "50%",
    background: "var(--color-primary)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  userAvatar: {
    background: "var(--color-surface)",
  },
  bubble: {
    maxWidth: "78%",
    padding: "10px 14px",
    borderRadius: "var(--radius-md)",
    lineHeight: 1.45,
  },
  userBubble: {
    background: "var(--color-primary)",
    color: "var(--color-primary-foreground)",
    borderBottomRightRadius: 4,
  },
  aiBubble: {
    background: "var(--color-bubble-ai)",
    color: "var(--color-text-primary)",
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    fontSize: 15,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },

  typingRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 2px",
  },
  typingDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: "var(--color-text-muted)",
  },
  typingLabel: {
    fontSize: 12,
    color: "var(--color-text-muted)",
    marginLeft: 6,
  },

  footer: {
    position: "sticky",
    bottom: 0,
    background: "transparent",
    padding: "14px 24px calc(env(safe-area-inset-bottom, 0px) + 14px)",
    maxWidth: 820,
    width: "100%",
    margin: "0 auto",
  },

  filePreview: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "var(--color-surface)",
    borderRadius: 8,
    padding: "8px 12px",
    marginBottom: 8,
  },
  filePreviewInfo: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    color: "var(--color-text-primary)",
    fontSize: 13,
    minWidth: 0,
  },
  filePreviewName: {
    fontWeight: 500,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  filePreviewSize: {
    color: "var(--color-text-muted)",
    fontSize: 12,
    flexShrink: 0,
  },
  filePreviewRemove: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 4,
    color: "var(--color-text-muted)",
    display: "flex",
    flexShrink: 0,
  },

  fileTag: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 8px",
    borderRadius: 6,
    background: "rgba(255,255,255,0.15)",
    marginBottom: 6,
    fontSize: 12,
  },
  fileTagName: {
    fontWeight: 500,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 180,
  },

  inputRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "color-mix(in srgb, var(--color-surface) 92%, transparent)",
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    border: "1px solid color-mix(in srgb, var(--color-border) 85%, transparent)",
    borderRadius: 999,
    padding: "10px 10px 10px 18px",
    boxShadow: "0 10px 40px rgba(0, 0, 0, 0.12)",
  },
  attachBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
  },
  textarea: {
    flex: 1,
    border: "none",
    outline: "none",
    background: "transparent",
    fontSize: 15,
    fontFamily: "var(--font-family)",
    color: "var(--color-text-primary)",
    resize: "none",
    lineHeight: 1.4,
    paddingTop: 6,
    paddingBottom: 6,
  },
  sendButton: {
    width: 42,
    height: 42,
    borderRadius: "50%",
    background: "var(--color-primary)",
    border: "none",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "opacity 0.15s ease",
    flexShrink: 0,
    boxShadow: "0 4px 14px rgba(0, 0, 0, 0.18)",
  },

  msgMeta: {
    marginTop: 8,
    fontSize: 10.5,
    color: "var(--color-text-muted)",
    letterSpacing: 0.1,
  },

  scrollDownBtn: {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    bottom: 96,
    zIndex: 9,
    width: 36,
    height: 36,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "color-mix(in srgb, var(--color-surface) 94%, transparent)",
    color: "var(--color-text-primary)",
    border: "1px solid var(--color-border)",
    boxShadow: "0 8px 26px rgba(0, 0, 0, 0.2)",
    cursor: "pointer",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
  },

  convSkeleton: {
    height: 46,
    margin: "6px 4px",
    borderRadius: 10,
    background: "color-mix(in srgb, var(--color-text-muted) 14%, transparent)",
  },

  exportRow: {
    display: "flex",
    gap: 6,
    marginTop: 8,
    paddingTop: 8,
    borderTop: "1px solid var(--color-border)",
  },
  exportBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 10px",
    fontSize: 11,
    fontWeight: 500,
    fontFamily: "var(--font-family)",
    color: "var(--color-text-muted)",
    background: "var(--color-background)",
    border: "1px solid var(--color-border)",
    borderRadius: 6,
    cursor: "pointer",
    transition: "background 0.15s ease, color 0.15s ease",
  },

  artifactRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 12,
  },
  artifactChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    fontSize: 13,
    fontWeight: 500,
    fontFamily: "var(--font-family)",
    color: "var(--color-text)",
    background: "var(--color-surface)",
    border: "1px solid var(--color-primary)",
    borderRadius: 8,
    cursor: "pointer",
    textDecoration: "none",
    maxWidth: "100%",
  },
  artifactName: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 220,
  },
  artifactSize: {
    fontSize: 11,
    color: "var(--color-text-muted)",
  },

  agentTracker: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    minWidth: 220,
  },
  agentHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-text)",
  },
  agentSteps: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    marginTop: 2,
  },
  agentStep: {
    display: "flex",
    alignItems: "flex-start",
    gap: 6,
    fontSize: 12.5,
    color: "var(--color-text)",
  },
  agentStepMark: {
    color: "var(--color-primary)",
    width: 12,
    flexShrink: 0,
  },
  agentLine: {
    fontSize: 11.5,
    color: "var(--color-text-muted)",
    fontStyle: "italic",
  },

  settingsPanel: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 14,
    padding: "14px 16px",
    marginBottom: 10,
    display: "flex",
    flexDirection: "column",
    gap: 14,
    boxShadow: "0 6px 24px rgba(0,0,0,0.10)",
  },

  cmdMenu: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 14,
    padding: 6,
    marginBottom: 10,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    maxHeight: 280,
    overflowY: "auto",
    boxShadow: "0 6px 24px rgba(0,0,0,0.10)",
  },
  cmdItem: {
    display: "flex",
    flexDirection: "column",
    gap: 1,
    padding: "8px 10px",
    background: "transparent",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "var(--font-family)",
  },
  cmdItemActive: {
    background: "var(--color-background)",
  },
  cmdUsage: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-primary)",
  },
  cmdDesc: {
    fontSize: 12,
    color: "var(--color-text-muted)",
  },
  settingsHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  settingsTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-text-primary)",
  },
  settingsNote: {
    fontSize: 11,
    color: "var(--color-text-muted)",
    lineHeight: 1.4,
  },
  settingsEmbedRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
    paddingTop: 10,
    borderTop: "1px solid var(--color-border)",
  },
  settingsEmbedLabel: {
    fontSize: 12,
    color: "var(--color-text-muted)",
    flexShrink: 0,
  },
  agentSwitchWrap: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginLeft: 22,
    flexShrink: 0,
  },
  switchTrack: {
    position: "relative",
    width: 40,
    height: 24,
    padding: 2,
    borderRadius: 999,
    border: "none",
    background: "var(--color-border)",
    cursor: "pointer",
    flexShrink: 0,
    transition: "background 0.2s ease",
  },
  switchTrackOn: {
    background: "var(--color-text-primary)",
  },
  switchKnob: {
    display: "block",
    width: 20,
    height: 20,
    borderRadius: "50%",
    background: "var(--color-background)",
    boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
    transition: "transform 0.2s ease",
  },
};

const dropdown: Record<string, React.CSSProperties> = {
  wrap: {
    position: "relative",
    minWidth: 0,
    flexShrink: 1,
    maxWidth: 220,
  },
  trigger: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
    maxWidth: "100%",
    padding: "7px 10px",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 10,
    cursor: "pointer",
    color: "var(--color-text-primary)",
    fontSize: 12.5,
    fontWeight: 500,
    fontFamily: "var(--font-family)",
    transition: "border-color 0.15s ease, background 0.15s ease",
  },
  triggerOpen: {
    border: "1px solid var(--color-primary)",
  },
  triggerIcon: {
    display: "flex",
    flexShrink: 0,
  },
  triggerLabel: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  menu: {
    position: "absolute",
    top: "calc(100% + 6px)",
    zIndex: 50,
    minWidth: 200,
    maxWidth: "min(280px, calc(100vw - 20px))",
    maxHeight: 360,
    overflowY: "auto",
    background: "var(--color-background)",
    border: "1px solid var(--color-border)",
    borderRadius: 12,
    padding: 6,
    boxShadow: "0 12px 32px rgba(0,0,0,0.16)",
  },
  group: {
    marginBottom: 2,
  },
  groupLabel: {
    fontSize: 10.5,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--color-text-muted)",
    padding: "8px 10px 4px",
  },
  item: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    width: "100%",
    padding: "8px 10px",
    background: "transparent",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    color: "var(--color-text-primary)",
    fontSize: 13,
    fontFamily: "var(--font-family)",
    textAlign: "left",
    transition: "background 0.12s ease",
  },
  itemActive: {
    background: "var(--color-surface)",
    color: "var(--color-text-primary)",
    fontWeight: 600,
  },
  itemLabel: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
};

const paramRow: Record<string, React.CSSProperties> = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  top: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  label: {
    fontSize: 12.5,
    fontWeight: 500,
    color: "var(--color-text-primary)",
  },
  right: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  value: {
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
    color: "var(--color-text-muted)",
    minWidth: 36,
    textAlign: "right",
  },
  toggle: {
    fontSize: 11,
    fontWeight: 500,
    fontFamily: "var(--font-family)",
    padding: "3px 9px",
    borderRadius: 999,
    border: "1px solid var(--color-border)",
    background: "transparent",
    color: "var(--color-text-muted)",
    cursor: "pointer",
  },
  toggleOn: {
    background: "var(--color-primary)",
    border: "1px solid var(--color-primary)",
    color: "var(--color-primary-foreground)",
  },
  slider: {
    width: "100%",
    accentColor: "var(--color-primary)",
    cursor: "pointer",
  },
};

const modal: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 60,
    background: "rgba(0, 0, 0, 0.45)",
    backdropFilter: "blur(3px)",
    WebkitBackdropFilter: "blur(3px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  card: {
    width: "100%",
    maxWidth: 460,
    maxHeight: "85dvh",
    overflowY: "auto",
    background: "var(--color-background)",
    border: "1px solid var(--color-border)",
    borderRadius: 18,
    padding: 22,
    display: "flex",
    flexDirection: "column",
    gap: 16,
    boxShadow: "0 20px 60px rgba(0,0,0,0.30)",
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  title: {
    fontSize: 18,
    fontWeight: 700,
    color: "var(--color-text-primary)",
    letterSpacing: "-0.2px",
  },
  subtitle: {
    fontSize: 12.5,
    color: "var(--color-text-muted)",
    marginTop: 2,
  },
  desc: {
    fontSize: 13.5,
    lineHeight: 1.55,
    color: "var(--color-text-primary)",
    opacity: 0.9,
  },
  specGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
    gap: 8,
  },
  spec: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: "10px 12px",
    background: "var(--color-surface)",
    borderRadius: 10,
  },
  specLabel: {
    fontSize: 10.5,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--color-text-muted)",
  },
  specValue: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-text-primary)",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  sectionLabel: {
    fontSize: 10.5,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--color-text-muted)",
  },
  tagRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 7,
  },
  plainTag: {
    display: "inline-flex",
    alignItems: "center",
    fontSize: 12,
    fontWeight: 500,
    color: "var(--color-text-primary)",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 999,
    padding: "4px 11px",
  },
  strengthTag: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    fontSize: 12,
    fontWeight: 500,
    color: "var(--color-text-primary)",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 999,
    padding: "4px 11px 4px 9px",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },
};
