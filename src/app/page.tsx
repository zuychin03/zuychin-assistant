"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import { Send, Bot, User, Plus, History, X, Paperclip, FileText, FileCode, FileArchive, Image as ImageIcon, Music, Video, File, Brain, LogOut, Download, SlidersHorizontal, Cpu, Database, Sun, Moon, Info, ListTodo, Waypoints, Mail, CalendarDays, Globe, Code2, Lightbulb, ArrowDown, RotateCcw } from "lucide-react";
import { SelectMenu, ParamRow, ModelInfoModal, type ProviderInfo } from "./home/controls";
import { ConversationList, NewProjectButton, type ProjectItem } from "./home/conversation-list";
import { styles } from "./home/styles";
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
  /** Set on interruption notices: lets the user relaunch the agent run with prior progress. */
  resume?: { runId: string; text: string };
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
  projectId?: string | null;
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

interface GenParamsState {
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
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
  const [convTitleSpace, setConvTitleSpace] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const headerLeftRef = useRef<HTMLDivElement>(null);
  const headerRightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // The centered conversation title is absolutely positioned, so on narrow
  // screens it can overlap the model selectors / header buttons. Measure the
  // free gap around the header midpoint (headerLeft is flex:1, so its children,
  // not its own box, mark where the content ends) and hide the title when the
  // gap is too tight to render it legibly.
  useEffect(() => {
    const measure = () => {
      const left = headerLeftRef.current;
      const right = headerRightRef.current;
      const container = left?.parentElement;
      if (!left || !right || !container) return;
      const c = container.getBoundingClientRect();
      const mid = c.left + c.width / 2;
      let contentRight = c.left;
      for (const child of Array.from(left.children)) {
        contentRight = Math.max(contentRight, child.getBoundingClientRect().right);
      }
      const half = Math.min(mid - contentRight, right.getBoundingClientRect().left - mid);
      setConvTitleSpace(Math.max(0, Math.floor((half - 12) * 2)));
    };
    const raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
    };
  }, [isDesktop, providers, chatSel, embedSel]);

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

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      if (data.projects) {
        setProjects(data.projects);
      }
    } catch (err) {
      console.error("Failed to load projects:", err);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

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

  const handleNewChat = async (projectId?: string) => {
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        ...(projectId && {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        }),
      });
      const data = await res.json();
      setActiveConversationId(data.id);
      setMessages([]);
      setSidebarOpen(false);
      await loadConversations();
    } catch (err) {
      console.error("Failed to create conversation:", err);
    }
  };

  const handleCreateProject = async (name: string) => {
    try {
      await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await loadProjects();
    } catch (err) {
      console.error("Failed to create project:", err);
    }
  };

  const handleUpdateProject = async (id: string, patch: { name?: string; instructions?: string }) => {
    try {
      await fetch("/api/projects", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      await loadProjects();
    } catch (err) {
      console.error("Failed to update project:", err);
    }
  };

  const handleDeleteProject = async (id: string) => {
    try {
      await fetch(`/api/projects?id=${id}`, { method: "DELETE" });
      await Promise.all([loadProjects(), loadConversations()]);
    } catch (err) {
      console.error("Failed to delete project:", err);
    }
  };

  const handleMoveConversation = async (convId: string, projectId: string | null) => {
    try {
      await fetch("/api/conversations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: convId, projectId }),
      });
      await loadConversations();
    } catch (err) {
      console.error("Failed to move conversation:", err);
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

  const handleSubmit = async (e: React.FormEvent | null, resume?: { runId: string; text: string }) => {
    e?.preventDefault();
    const text = resume?.text ?? input.trim();
    if ((!text && !pendingFile) || isLoading) return;

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
      content: text || (pendingFile && !resume ? `[Sent ${pendingFile.name}]` : ""),
      fileName: resume ? undefined : pendingFile?.name,
      fileMimeType: resume ? undefined : pendingFile?.mimeType,
    };

    const fileToSend = resume ? null : pendingFile;
    setMessages((prev) => [...prev, userMessage]);
    if (!resume) {
      setInput("");
      setPendingFile(null);
    }
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
          agent: resume ? true : agentEnabled,
          ...(resume && { resumeRunId: resume.runId }),
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
      let runId = "";

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

          if (evt.type === "run") {
            runId = evt.runId;
          } else if (evt.type === "status") {
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

      // A dead stream without a done event (e.g. the serverless function was
      // killed mid-run) gets an interruption notice with a Resume affordance
      // when we know the run id.
      if (streamError || !done) {
        const notice: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: streamError ? `⚠️ ${streamError}` : "⚠️ The run was interrupted before finishing.",
          ...(runId ? { resume: { runId, text: userMessage.content } } : {}),
        };
        setMessages((prev) => [...prev, notice]);
        await loadConversations();
        return;
      }

      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: done.reply,
        artifacts: done.artifacts,
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

        <NewProjectButton onCreate={handleCreateProject} />

        <button onClick={() => handleNewChat()} style={{ ...styles.newChatBtn, marginTop: 8 }}>
          <Plus size={16} />
          <span>New Chat</span>
        </button>

        <ConversationList
          conversations={conversations}
          projects={projects}
          activeConversationId={activeConversationId}
          loaded={convosLoaded}
          onSelect={loadConversation}
          onDelete={handleDeleteConversation}
          onNewChat={handleNewChat}
          onUpdateProject={handleUpdateProject}
          onDeleteProject={handleDeleteProject}
          onMoveConversation={handleMoveConversation}
          formatTime={formatTime}
        />

        <button onClick={handleLogout} style={styles.logoutBtn}>
          <LogOut size={15} />
          <span>Log out</span>
        </button>
      </aside>

      <div style={isDesktop ? styles.containerDesktop : styles.container}>
        <header style={styles.header}>
          <div style={styles.headerContent}>
            <div style={styles.headerLeft} ref={headerLeftRef}>
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

            {isDesktop && activeConvTitle && messages.length > 0 && convTitleSpace >= 120 && (
              <div style={{ ...styles.headerConvTitle, maxWidth: Math.min(convTitleSpace, 420) }} title={activeConvTitle}>
                {activeConvTitle}
              </div>
            )}

            <div style={styles.headerRight} ref={headerRightRef}>
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
              <button onClick={() => handleNewChat()} style={styles.iconBtn} aria-label="New conversation" title="New conversation">
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
                {msg.role === "assistant" && msg.resume && (
                  <div style={styles.exportRow}>
                    <button
                      onClick={() => handleSubmit(null, msg.resume)}
                      style={{ ...styles.exportBtn, opacity: isLoading ? 0.5 : 1 }}
                      disabled={isLoading}
                      title="Relaunch this run — the agent continues from its recorded progress"
                    >
                      <RotateCcw size={12} />
                      <span>Resume run</span>
                    </button>
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
