"use client";

import { useState, useRef, useEffect, useCallback, useSyncExternalStore } from "react";
import Link from "next/link";
import { Send, Bot, User, Plus, History, X, Paperclip, FileText, FileCode, FileArchive, Image as ImageIcon, Music, Video, File, Brain, Download, SlidersHorizontal, Cpu, Database, Sun, Moon, Info, ListTodo, Waypoints, Mail, CalendarDays, Globe, Code2, Lightbulb, ArrowDown, ChevronRight, RotateCcw, Reply, Square, Mic, Volume2, Gavel, ShieldCheck } from "lucide-react";
import { SelectMenu, ParamRow, ModelInfoModal, ConfirmModal, modelSearchTerms, type ProviderInfo } from "./home/controls";
import { ConversationList, NewProjectButton, type ProjectItem } from "./home/conversation-list";
import { styles } from "./home/styles";
import { chatMarkdownComponents } from "./home/markdown";
import { isSupportedAttachment, UPLOAD_ACCEPT, MAX_FILE_SIZE_MB, MAX_FILE_SIZE_BYTES } from "@/lib/types";
import { matchSlashCommands, type SlashCommand } from "@/lib/commands";
import { CouncilProposalCard } from "./home/council-card";
import type { ArtifactDescriptor, CouncilProposal } from "@/lib/types";
import type { AgentEvent } from "@/lib/ai/agent/events";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatWorkspace, NEW_CHAT, completedRetry, emptyDraft, sameDraft, type ChatDraft, type ChatSession } from "./home/chat-state";
import { readChatDrafts, writeChatDraft } from "./home/chat-drafts";
import { safeReturnTo, documentDestination, withReturnTo } from "@/lib/document-navigation";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  fileName?: string;
  fileMimeType?: string;
  artifacts?: ArtifactDescriptor[];
  /** A council Zuychin drafted; the card under the reply is what launches it. */
  councilProposal?: CouncilProposal;
  /** Which model produced this reply (only known for messages sent this session). */
  modelLabel?: string;
  /** ISO timestamp shown under assistant replies. */
  at?: string;
  /** Set on interruption notices: lets the user relaunch the agent run with prior progress. */
  resume?: { runId: string; text: string };
  /** Set on interruption notices without a resumable run: re-sends the original payload. */
  retry?: { payload: OutgoingPayload; userMsgId: string; knownIds: string[] };
  /** Quoted excerpt of the earlier message this one replies to. */
  replyTo?: { role: "user" | "assistant"; content: string };
}

interface TodayData {
  dueTodos: { id: string; title: string; priority: string; dueDate: string | null }[];
  todos: { id: string; title: string; priority: string; dueDate: string | null }[];
  events: { id?: string; summary: string; start: string; end?: string; location?: string }[];
}

// Minimal surface of the (webkit-prefixed) SpeechRecognition API used for the
// voice-loop stop phrase; lib.dom has no types for it.
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: { length: number; [i: number]: { 0: { transcript: string } } } }) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

// Date-only strings (all-day events, bare due dates) skip the time part.
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const dayPart = d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
  if (!iso.includes("T")) return dayPart;
  return `${dayPart}, ${d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}`;
}

interface OutgoingPayload {
  text: string;
  file: { name: string; mimeType: string; base64: string; size: number } | null;
  replyTo: { role: "user" | "assistant"; content: string } | null;
  resume?: { runId: string; text: string };
}

interface ServerMessage {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
  metadata?: {
    artifacts?: ArtifactDescriptor[];
    replyTo?: { role: "user" | "assistant"; content: string };
    councilProposal?: CouncilProposal;
  };
}

const mapServerMessages = (msgs: ServerMessage[]): ChatMessage[] =>
  msgs.map((m) => ({
    id: m.id,
    role: m.role as "user" | "assistant",
    content: m.content,
    artifacts: m.metadata?.artifacts,
    councilProposal: m.metadata?.councilProposal,
    replyTo: m.metadata?.replyTo,
    at: m.createdAt,
  }));

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

type Session = ChatSession<ChatMessage, OutgoingPayload, AgentRun>;
const chats = new ChatWorkspace<ChatMessage, OutgoingPayload, AgentRun>();
let draftsLoaded: Promise<void> | undefined;
let unloadProtectionInstalled = false;
const unsavedDrafts = new Map<string, ChatDraft>();
const persistDraft = async (key: string, draft: ChatDraft) => {
  unsavedDrafts.set(key, draft);
  try {
    await writeChatDraft(key, draft);
    if (unsavedDrafts.get(key) === draft) unsavedDrafts.delete(key);
  } catch {
    chats.storageError = "Your draft is kept in this tab, but browser storage could not save it. Keep this tab open and try saving again.";
    chats.notify();
    throw new Error("Draft storage is unavailable.");
  }
};
chats.onDraftChange = (key, draft) => { void persistDraft(key, draft).catch(() => {}); };

function conversationUrl(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("c", id);
  else url.searchParams.delete("c");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(response.status === 401 ? "Please sign in again." : `Request failed (${response.status}).`);
  return response.json() as Promise<T>;
}

export default function Home() {
  useSyncExternalStore(chats.subscribe, chats.snapshot, chats.serverSnapshot);
  const session = chats.get();
  const messages = session.messages;
  const input = session.draft.text;
  const pendingFile = session.draft.file;
  const replyTo = session.draft.replyTo;
  const queuedView = session.queue;
  const isLoading = !!session.run;
  const agentRun = session.progress;
  const activeConversationId = session.key === NEW_CHAT ? null : session.key;
  const setInput = (text: string) => chats.setDraft(chats.get(), { ...chats.get().draft, text });
  const setPendingFile = (file: ChatDraft["file"]) => {
    const target = chats.get();
    target.fileRequest++;
    chats.setDraft(target, { ...target.draft, file });
  };
  const setReplyTo = (reply: ChatDraft["replyTo"]) => chats.setDraft(chats.get(), { ...chats.get().draft, replyTo: reply });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [today, setToday] = useState<TodayData | null>(null);
  // status: "confirm" shows the warning buttons; anything else is progress text.
  const [embedModal, setEmbedModal] = useState<{ target: string; status: string } | null>(null);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [actionError, setActionError] = useState<{ message: string; retry?: () => void } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ kind: "chat" | "project"; id: string; title: string; resolve: (ok: boolean) => void } | null>(null);
  const [pendingActions, setPendingActions] = useState<string[]>([]);
  const pendingActionsRef = useRef(new Set<string>());
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [documentLinks, setDocumentLinks] = useState({ knowledge: "/knowledge", graph: "/graph" });
  const [isDesktop, setIsDesktop] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);

  const [chatSel, setChatSel] = useState("");
  const [embedSel, setEmbedSel] = useState("");
  const [generationOpen, setGenerationOpen] = useState(false);
  const [genParams, setGenParams] = useState<GenParamsState>({ temperature: null, topP: null, maxTokens: null });
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [modelInfoOpen, setModelInfoOpen] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // Message id whose export formats (DOCX/PDF/MD) are expanded.
  const [exportMenuFor, setExportMenuFor] = useState<string | null>(null);
  const [convosLoaded, setConvosLoaded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const ttsPlayerRef = useRef<{ stop: () => void } | null>(null);
  // Guards a stale TTS fetch from playing over a newer one.
  const speakSeqRef = useRef(0);
  // Hands-free voice conversation mode (see startVoiceRecording).
  const [voiceLoop, setVoiceLoop] = useState(false);
  const voiceLoopRef = useRef(false);
  const voiceRequestRef = useRef(0);
  const srRef = useRef<SpeechRecognitionLike | null>(null);
  const vadCleanupRef = useRef<(() => void) | null>(null);
  const discardRecordingRef = useRef(false);
  const voicePrefsRef = useRef<{ replyWithVoice: string; voiceName: string }>({ replyWithVoice: "onVoiceInput", voiceName: "Kore" });

  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    const voiceRequest = voiceRequestRef;
    const speakingSequence = speakSeqRef;
    const protectUnsavedWork = (event: BeforeUnloadEvent) => {
      if (!chats.hasPendingWork((message) => !!message.retry) && !chats.storageError && !unsavedDrafts.size) return;
      event.preventDefault();
      event.returnValue = "";
    };
    if (!unloadProtectionInstalled) {
      window.addEventListener("beforeunload", protectUnsavedWork);
      unloadProtectionInstalled = true;
    }
    return () => {
      voiceRequest.current++;
      voiceLoopRef.current = false;
      discardRecordingRef.current = true;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      try { srRef.current?.stop(); } catch {}
      vadCleanupRef.current?.();
      speakingSequence.current++;
      ttsPlayerRef.current?.stop();
    };
  }, []);

  const retryDraftStorage = async () => {
    try {
      for (const [key, draft] of await readChatDrafts()) chats.hydrateDraft(key, draft);
      await Promise.all([...unsavedDrafts].map(([key, draft]) => persistDraft(key, draft)));
      chats.storageError = "";
      chats.notify();
    } catch {
      chats.storageError = "Browser storage is still unavailable. Your drafts remain in this tab.";
      chats.notify();
    }
  };

  useEffect(() => {
    if (!draftsLoaded) {
      draftsLoaded = readChatDrafts().then((drafts) => {
        for (const [key, draft] of drafts) chats.hydrateDraft(key, draft);
      }).catch(() => {
        draftsLoaded = undefined;
        chats.storageError = "Saved drafts could not be opened. New edits remain in this tab; try saving again before leaving.";
        chats.notify();
      });
    }
  }, []);

  useEffect(() => {
    fetch("/api/tts")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.voice) voicePrefsRef.current = d.voice; })
      .catch(() => { });
  }, []);

  // Push delivery has no offline cache, so register this worker for the browser session.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("SW registration failed:", err));
  }, []);

  // Today card on the empty state; dismissing it lasts for the browser session.
  useEffect(() => {
    if (sessionStorage.getItem("zuychin-today-dismissed") === "1") return;
    fetch("/api/today")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TodayData | null) => {
        if (d && (d.dueTodos.length > 0 || d.todos.length > 0 || d.events.length > 0)) setToday(d);
      })
      .catch(() => { });
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, queuedView]);

  // Show the jump-to-bottom button once the user scrolls up during a long chat.
  const handleMessagesScroll = (e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget;
    setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 280);
  };

  const loadConversations = useCallback(async () => {
    try {
      const data = await requestJson<{ conversations: Conversation[] }>("/api/conversations");
      if (!Array.isArray(data.conversations)) throw new Error("Invalid conversation response.");
      setConversations(data.conversations);
      return true;
    } catch {
      return false;
    } finally {
      setConvosLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadConversations().then((ok) => {
      if (!ok) setActionError({ message: "Your chats could not be loaded.", retry: () => { void loadConversations().then((loaded) => { if (loaded) setActionError(null); }); } });
    });
  }, [loadConversations]);

  const loadProjects = useCallback(async () => {
    try {
      const data = await requestJson<{ projects: ProjectItem[] }>("/api/projects");
      if (!Array.isArray(data.projects)) throw new Error("Invalid project response.");
      setProjects(data.projects);
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    void loadProjects().then((ok) => {
      if (!ok) setActionError({ message: "Your projects could not be loaded.", retry: () => { void loadProjects().then((loaded) => { if (loaded) setActionError(null); }); } });
    });
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

        let savedChat = localStorage.getItem("zuychin-chat-model");
        const savedProvider = avail.find((p) => savedChat?.startsWith(`${p.id}::`));
        const savedModel = savedChat?.slice((savedProvider?.id.length ?? 0) + 2);
        const replacement = savedModel && savedProvider?.chatModelAliases?.[savedModel];
        if (replacement && savedProvider?.chatModels.some((m) => m.id === replacement)) {
          savedChat = `${savedProvider.id}::${replacement}`;
          localStorage.setItem("zuychin-chat-model", savedChat);
        }
        const validChat = avail.some((p) =>
          savedChat?.startsWith(p.id + "::") && p.chatModels.some((m) => `${p.id}::${m.id}` === savedChat)
        );
        if (validChat && savedChat) {
          setChatSel(savedChat);
        } else if (data.defaults?.chat) {
          setChatSel(`${data.defaults.chat.providerId}::${data.defaults.chat.modelId}`);
        }

        // The selector mirrors the server's ACTIVE knowledge partition (which
        // the re-embed flow can change at runtime), never a local preference.
        try {
          const activeRes = await fetch("/api/admin/reembed");
          const active = activeRes.ok ? (await activeRes.json()).active : null;
          if (active) setEmbedSel(active);
          else if (data.defaults?.embedding) setEmbedSel(data.defaults.embedding.modelId);
        } catch {
          if (data.defaults?.embedding) setEmbedSel(data.defaults.embedding.modelId);
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
  // Switching the embedding model re-embeds the whole knowledge store, so it
  // goes through a confirm modal + chunked /api/admin/reembed loop; embedSel
  // only flips once the server has fully migrated.
  const handleEmbedSelChange = (val: string) => {
    if (val === embedSel) return;
    setEmbedModal({ target: val, status: "confirm" });
  };

  const runReembed = async (target: string) => {
    setEmbedModal({ target, status: "Starting…" });
    try {
      for (let round = 0; round < 100; round++) {
        const res = await fetch("/api/admin/reembed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? `Re-embed failed (${res.status})`);
        if (data.done) {
          setEmbedSel(target);
          setEmbedModal(null);
          return;
        }
        setEmbedModal({ target, status: `Re-embedding… ${data.remaining} rows left` });
      }
      throw new Error("Still not finished after many rounds - confirm again to resume.");
    } catch (err) {
      setEmbedModal(null);
      alert(`Embedding switch failed: ${err instanceof Error ? err.message : err}\n\nProgress is kept - confirming again resumes where it stopped.`);
    }
  };

  useEffect(() => {
    try {
      const saved = localStorage.getItem("zuychin-gen-params");
      if (saved) setGenParams({ temperature: null, topP: null, maxTokens: null, ...JSON.parse(saved) });
    } catch { }
  }, []);

  const updateGenParams = useCallback((next: GenParamsState) => {
    setGenParams(next);
    localStorage.setItem("zuychin-gen-params", JSON.stringify(next));
  }, []);

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
  // Each model publishes its own output ceiling, so the slider is bounded per
  // model rather than by one global cap. Coarser steps once the range is large.
  const maxTokenCeiling = currentChatModel?.maxOutputTokens ?? 8192;
  const maxTokenStep = maxTokenCeiling > 32768 ? 2048 : maxTokenCeiling > 8192 ? 1024 : 256;

  useEffect(() => {
    if (!canThink && thinkingEnabled) setThinkingEnabled(false);
  }, [canThink, thinkingEnabled]);

  // Switching to a model with a lower ceiling must not leave the slider holding a
  // value it cannot represent; the server clamps too, but the UI should agree.
  useEffect(() => {
    if (typeof genParams.maxTokens === "number" && genParams.maxTokens > maxTokenCeiling) {
      updateGenParams({ ...genParams, maxTokens: maxTokenCeiling });
    }
  }, [maxTokenCeiling, genParams, updateGenParams]);

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

  const selectSession = (target: Session) => {
    chats.select(target.key);
    conversationUrl(target.key === NEW_CHAT ? null : target.key);
    setSidebarOpen(false);
    exitVoiceLoop();
    if (inputRef.current) inputRef.current.style.height = "auto";
  };

  const loadConversation = async (convId: string) => {
    const target = chats.get(convId);
    selectSession(target);
    if (target.loaded || target.run) return;
    const ticket = chats.beginHistory(target);
    try {
      const data = await requestJson<{ messages: ServerMessage[] }>(`/api/conversations?id=${encodeURIComponent(convId)}`);
      if (!Array.isArray(data.messages)) throw new Error("Invalid conversation response.");
      chats.acceptHistory(target, ticket, mapServerMessages(data.messages));
    } catch {
      if (chats.get() === target && target.historyRequest === ticket.request) {
        setActionError({ message: "This conversation could not be loaded. Your draft is safe.", retry: () => { setActionError(null); void loadConversation(convId); } });
      }
    } finally {
      chats.finishHistory(target, ticket.request);
    }
  };

  const deepLinkDone = useRef(false);
  const initialConversationLoader = useRef(loadConversation);
  useEffect(() => {
    if (deepLinkDone.current) return;
    deepLinkDone.current = true;
    const params = new URLSearchParams(window.location.search);
    const previous = safeReturnTo(params.get("returnTo"));
    setReturnTo(previous);
    setDocumentLinks({
      knowledge: previous?.startsWith("/knowledge") ? previous : documentDestination("/knowledge"),
      graph: previous?.startsWith("/graph") ? previous : documentDestination("/graph"),
    });
    const id = params.get("c");
    if (id) void initialConversationLoader.current(id);
    else if (chats.activeKey !== NEW_CHAT) conversationUrl(chats.activeKey);
  }, []);

  const dismissToday = () => {
    sessionStorage.setItem("zuychin-today-dismissed", "1");
    setToday(null);
  };

  const refreshLists = async () => (await Promise.all([loadProjects(), loadConversations()])).every(Boolean);
  const runAction = async (key: string, label: string, write: () => Promise<void>, refresh: () => Promise<boolean>, retryInPlace = true): Promise<boolean> => {
    if (pendingActionsRef.current.has(key)) return false;
    pendingActionsRef.current.add(key);
    setPendingActions([...pendingActionsRef.current]);
    setActionError(null);
    try {
      await write();
    } catch (error) {
      setActionError({
        message: `Could not ${label}. ${error instanceof Error ? error.message : "Please try again."}${retryInPlace ? "" : " Your form is still open; use its button to try again."}`,
        ...(retryInPlace ? { retry: () => { void runAction(key, label, write, refresh); } } : {}),
      });
      return false;
    } finally {
      pendingActionsRef.current.delete(key);
      setPendingActions([...pendingActionsRef.current]);
    }
    if (!await refresh()) {
      setActionError({ message: "Your change was saved, but the list could not refresh.", retry: () => { void refresh().then((ok) => { if (ok) setActionError(null); }); } });
    }
    return true;
  };

  const handleNewChat = async (projectId?: string) => {
    const origin = chats.get();
    return runAction("new-chat", "create the conversation", async () => {
      const data = await requestJson<{ id: string }>("/api/conversations", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }),
      });
      if (!data.id) throw new Error("The server did not return a conversation.");
      const target = chats.get(data.id);
      target.loaded = true;
      if (chats.get() === origin) selectSession(target);
    }, loadConversations);
  };

  const handleCreateProject = (name: string) => runAction("create-project", "create the project", async () => {
    await requestJson("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  }, loadProjects, false);

  const handleUpdateProject = (id: string, patch: { name?: string; instructions?: string }) => runAction(`project:${id}`, "save the project", async () => {
    await requestJson("/api/projects", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...patch }) });
  }, loadProjects, false);

  const handleDeleteProject = (id: string): Promise<boolean> => new Promise((resolve) => {
    setDeleteConfirm({ kind: "project", id, title: projects.find((project) => project.id === id)?.name ?? "this project", resolve });
  });

  const handleMoveConversation = (convId: string, projectId: string | null) => runAction(`move:${convId}`, "move the conversation", async () => {
    await requestJson("/api/conversations", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: convId, projectId }) });
  }, loadConversations, false);

  const handleDeleteConversation = (event: React.MouseEvent, convId: string) => {
    event.stopPropagation();
    const target = chats.get(convId);
    if (target.run || target.queue.length) {
      setActionError({ message: "Finish or stop this conversation’s reply and clear its queued messages before deleting it." });
      return;
    }
    setDeleteConfirm({ kind: "chat", id: convId, title: conversations.find((chat) => chat.id === convId)?.title ?? "this conversation", resolve: () => {} });
  };

  const confirmDeletion = async () => {
    if (!deleteConfirm) return;
    const confirmation = deleteConfirm;
    const ok = await runAction(`delete:${confirmation.id}`, `delete the ${confirmation.kind === "chat" ? "conversation" : "project"}`, async () => {
      if (confirmation.kind === "chat") {
        const target = chats.get(confirmation.id);
        if (target.run || target.queue.length) throw new Error("Finish or stop its reply and clear queued messages first.");
      }
      await requestJson(`/api/${confirmation.kind === "chat" ? "conversations" : "projects"}?id=${encodeURIComponent(confirmation.id)}`, { method: "DELETE" });
      if (confirmation.kind === "chat") {
        const wasActive = chats.activeKey === confirmation.id;
        chats.remove(chats.get(confirmation.id));
        if (wasActive) { conversationUrl(null); exitVoiceLoop(); }
      }
    }, refreshLists);
    confirmation.resolve(ok);
    setDeleteConfirm(null);
  };

  const handleSubmit = (e: React.FormEvent | null, resume?: { runId: string; text: string }) => {
    e?.preventDefault();
    const target = chats.get();
    if (!target.loaded || target.historyLoading) return;
    const text = resume?.text ?? target.draft.text.trim();
    if (!text && !target.draft.file) return;

    const payload: OutgoingPayload = {
      text,
      file: resume ? null : target.draft.file,
      replyTo: resume ? null : target.draft.replyTo,
      resume,
    };
    if (!resume) {
      chats.setDraft(target, emptyDraft());
      if (inputRef.current) inputRef.current.style.height = "auto";
    }

    if (target.run || target.queue.length) {
      chats.enqueue(target, payload);
      if (!target.run) resumeQueue(target);
      return;
    }
    void sendPayload(payload, target);
  };

  const removeQueued = (id: string) => {
    chats.removeQueued(chats.get(), id);
  };

  const resumeQueue = (target: Session) => {
    if (target.run || !target.loaded || target.historyLoading) return;
    const next = chats.shift(target);
    if (next) void sendPayload(next.payload, target);
  };

  const sendPayload = async (p: OutgoingPayload, target = chats.get(), retryMessage?: ChatMessage) => {
    const run = chats.beginRun(target);
    if (!run) { if (!retryMessage) chats.enqueue(target, p); return; }
    const controller = run.controller;
    const recoverDraft = () => {
      if (!p.resume) chats.restoreDraftIfEmpty(target, { text: p.text, file: p.file, replyTo: p.replyTo });
    };
    const knownIds = retryMessage?.retry?.knownIds ?? target.messages.map((message) => message.id);
    const setMessages = (update: (messages: ChatMessage[]) => ChatMessage[]) => {
      if (chats.ownsRun(target, run)) chats.updateMessages(target, update);
    };
    const setAgentRun = (update: (progress: AgentRun | null) => AgentRun) => {
      if (!chats.ownsRun(target, run)) return;
      target.progress = update(target.progress);
      chats.notify();
    };
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: p.text || (p.file ? `[Sent ${p.file.name}]` : ""),
      fileName: p.file?.name,
      fileMimeType: p.file?.mimeType,
      ...(p.replyTo ? { replyTo: p.replyTo } : {}),
    };
    let streamId = "";
    let started = false;
    let canDrain = false;

    try {
      if (retryMessage?.retry && target.key !== NEW_CHAT) {
        const data = await requestJson<{ messages: ServerMessage[] }>(`/api/conversations?id=${encodeURIComponent(target.key)}`, { signal: controller.signal });
        if (!Array.isArray(data.messages)) throw new Error("Could not check whether the reply was saved. Please retry.");
        controller.signal.throwIfAborted();
        if (completedRetry(data.messages, userMessage.content, knownIds)) {
          setMessages(() => mapServerMessages(data.messages));
          if (sameDraft(target.draft, { text: p.text, file: p.file, replyTo: p.replyTo })) chats.setDraft(target, emptyDraft());
          canDrain = true;
          return;
        }
      }
      if (retryMessage?.retry) {
        const { userMsgId } = retryMessage.retry;
        setMessages((previous) => previous.filter((message) => message.id !== retryMessage.id && message.id !== userMsgId));
        if (sameDraft(target.draft, { text: p.text, file: p.file, replyTo: p.replyTo })) chats.setDraft(target, emptyDraft());
      }
      setMessages((previous) => [...previous, userMessage]);
      started = true;
      if (target.key === NEW_CHAT) {
        const data = await requestJson<{ id: string }>("/api/conversations", { method: "POST", signal: controller.signal });
        controller.signal.throwIfAborted();
        if (!data.id) throw new Error("The conversation could not be created. Please retry.");
        chats.adopt(target, data.id);
        if (chats.get() === target) conversationUrl(data.id);
      }
      const convId = target.key;
      setConversations((previous) => {
        const item = previous.find((conversation) => conversation.id === convId);
        return item ? [{ ...item, updatedAt: new Date().toISOString() }, ...previous.filter((conversation) => conversation.id !== convId)] : previous;
      });
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          message: userMessage.content,
          conversationId: convId,
          thinking: thinkingEnabled && canThink,
          agent: p.resume ? true : agentEnabled,
          ...(p.resume && { resumeRunId: p.resume.runId }),
          ...(p.replyTo && { replyTo: p.replyTo }),
          genParams: {
            ...(genParams.temperature !== null && { temperature: genParams.temperature }),
            ...(genParams.topP !== null && { topP: genParams.topP }),
            ...(genParams.maxTokens !== null && { maxTokens: genParams.maxTokens }),
          },
          ...(chatSel.includes("::") && {
            provider: chatSel.split("::")[0],
            model: chatSel.split("::").slice(1).join("::"),
          }),
          ...(p.file && {
            file: {
              name: p.file.name,
              mimeType: p.file.mimeType,
              base64: p.file.base64,
              size: p.file.size,
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
      let done: { reply: string; messageId: string; artifacts?: ArtifactDescriptor[]; councilProposal?: CouncilProposal } | null = null;
      let streamError = "";
      let runId = "";

      const base = (): AgentRun => ({ status: "", steps: [], lines: [] });

      for (; ;) {
        const { done: finished, value } = await reader.read();
        controller.signal.throwIfAborted();
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
          } else if (evt.type === "token") {
            if (!streamId) {
              streamId = `stream-${run.id}`;
              const sid = streamId;
              const text = evt.text;
              setMessages((prev) => [...prev, { id: sid, role: "assistant", content: text }]);
            } else {
              const sid = streamId;
              const { text, reset } = evt;
              setMessages((prev) => prev.map((m) => (m.id === sid ? { ...m, content: reset ? text : m.content + text } : m)));
            }
          } else if (evt.type === "done") {
            done = { reply: evt.reply, messageId: evt.messageId, artifacts: evt.artifacts, councilProposal: evt.councilProposal };
          } else if (evt.type === "error") {
            streamError = evt.message;
          }
        }
      }

      // A dead stream without a done event (e.g. the serverless function was
      // killed mid-run) gets an interruption notice with a Resume affordance
      // when we know the run id, or a Retry affordance when we don't.
      if (streamError || !done) {
        const notice: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: streamError ? `⚠️ ${streamError}` : "⚠️ The run was interrupted before finishing.",
          ...(runId
            ? { resume: { runId, text: userMessage.content } }
            : { retry: { payload: p, userMsgId: userMessage.id, knownIds } }),
        };
        setMessages((prev) => [...prev.filter((m) => !streamId || m.id !== streamId), notice]);
        recoverDraft();
        void loadConversations();
        return;
      }

      const assistantMessage: ChatMessage = {
        id: done.messageId || crypto.randomUUID(),
        role: "assistant",
        content: done.reply,
        artifacts: done.artifacts,
        councilProposal: done.councilProposal,
        modelLabel: currentChatModel?.label,
        at: new Date().toISOString(),
      };
      // The forming bubble becomes the final message in place (citations and
      // server post-processing can differ from the streamed text).
      setMessages((prev) =>
        streamId && prev.some((m) => m.id === streamId)
          ? prev.map((m) => (m.id === streamId ? assistantMessage : m))
          : [...prev, assistantMessage]
      );
      // Voice turns get the reply spoken back (TTS fires ONLY on voice input);
      // toggleSpeak's completion restarts the mic while the loop is active.
      const micTurn = !!p.file && p.file.name.startsWith("voice-note.") && p.file.mimeType.startsWith("audio/");
      if (chats.get() === target && micTurn && done.reply && (voiceLoopRef.current || voicePrefsRef.current.replyWithVoice !== "off")) {
        void toggleSpeak(assistantMessage);
      }
      canDrain = true;
      void loadConversations();
      void loadNotes();
    } catch (error: unknown) {
      // Full drop on cancel: the server deletes the errant user message and
      // saves no reply, so remove the optimistic user bubble (and any
      // partially streamed reply) to match.
      if (controller.signal.aborted) {
        setMessages((prev) => prev.filter((m) => m.id !== userMessage.id && (!streamId || m.id !== streamId)));
        return;
      }
      // Network drops (mobile browsers kill the fetch when the app is
      // backgrounded) surface as TypeErrors; the server saw a disconnect and
      // dropped the turn, so offer a clean re-send.
      const netDrop = error instanceof TypeError;
      const errorMsg = netDrop
        ? "Connection lost before the reply arrived (this can happen when the app goes to the background)."
        : error instanceof Error ? error.message : "Something went wrong.";
      const errorMessage: ChatMessage = {
        id: retryMessage && !started ? retryMessage.id : crypto.randomUUID(),
        role: "assistant",
        content: `⚠️ ${errorMsg}`,
        retry: { payload: p, userMsgId: retryMessage && !started ? retryMessage.retry!.userMsgId : userMessage.id, knownIds },
      };
      setMessages((prev) => [...prev.filter((m) => m.id !== errorMessage.id && (!streamId || m.id !== streamId)), errorMessage]);
      recoverDraft();
    } finally {
      if (chats.finishRun(target, run) && canDrain && !controller.signal.aborted) resumeQueue(target);
    }
  };

  const handleRetry = (msg: ChatMessage) => {
    const target = chats.get();
    if (!msg.retry || target.run || !target.messages.includes(msg)) return;
    void sendPayload(msg.retry.payload, target, msg);
  };

  const handleCancel = () => {
    // Stop means stop everything: drop the in-flight turn, the queue, and
    // any running voice conversation.
    exitVoiceLoop();
    chats.cancel(chats.get());
  };

  const startReply = (msg: ChatMessage) => {
    setReplyTo({ role: msg.role, content: msg.content });
    inputRef.current?.focus();
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
    // Mobile keyboards use Enter as the newline key; only the send button
    // submits there. Desktop keeps Enter-to-send, Shift+Enter for newline.
    // Ctrl/Cmd+Enter always sends: the chord implies a physical keyboard,
    // even in a sub-768px window where the mobile layout kicks in.
    if (e.key === "Enter" && !e.shiftKey && (isDesktop || e.ctrlKey || e.metaKey)) {
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

  const stopSpeaking = () => {
    speakSeqRef.current++;
    ttsPlayerRef.current?.stop();
    ttsPlayerRef.current = null;
    setSpeakingId(null);
  };

  // Streams raw PCM from /api/tts into the Web Audio API, scheduling each
  // chunk sample-accurately after the last: sound starts ~2.5s after the
  // click instead of waiting for the whole clip to be synthesized.
  const toggleSpeak = async (msg: ChatMessage) => {
    if (speakingId === msg.id) {
      stopSpeaking();
      return;
    }
    stopSpeaking();
    const seq = speakSeqRef.current;
    setSpeakingId(msg.id);

    const abort = new AbortController();
    let ctx: AudioContext | null = null;
    ttsPlayerRef.current = {
      stop: () => {
        abort.abort();
        if (ctx) void ctx.close().catch(() => { });
      },
    };

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: msg.content, stream: true }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`TTS failed (${res.status})`);
      if (seq !== speakSeqRef.current) return;

      const sampleRate = Number(res.headers.get("X-Sample-Rate") ?? 24000);
      ctx = new AudioContext();
      if (ctx.state === "suspended") await ctx.resume();
      let playhead = ctx.currentTime + 0.1;

      // Coalesce tiny network chunks into ≥0.2s buffers (first one smaller so
      // sound starts immediately); PCM is 16-bit so buffers must stay even.
      const scheduleChunk = (bytes: Uint8Array) => {
        if (!ctx || bytes.length < 2) return;
        const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
        const buf = ctx.createBuffer(1, int16.length, sampleRate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        if (playhead < ctx.currentTime + 0.05) playhead = ctx.currentTime + 0.05;
        src.start(playhead);
        playhead += buf.duration;
      };

      const reader = res.body.getReader();
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;
      let started = false;
      const flush = () => {
        const even = pendingBytes - (pendingBytes % 2);
        if (even === 0) return;
        const merged = new Uint8Array(pendingBytes);
        let off = 0;
        for (const p of pending) { merged.set(p, off); off += p.length; }
        scheduleChunk(merged.subarray(0, even));
        pending = pendingBytes > even ? [merged.subarray(even)] : [];
        pendingBytes -= even;
        started = true;
      };
      const minBytes = () => (started ? sampleRate * 0.4 : sampleRate * 0.1); // 0.2s / 50ms of 16-bit audio

      for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (seq !== speakSeqRef.current) return;
        pending.push(value);
        pendingBytes += value.length;
        if (pendingBytes >= minBytes()) flush();
      }
      flush();

      // The last buffer is scheduled but still playing; hold the state until then.
      const remainingMs = Math.max(0, (playhead - ctx.currentTime) * 1000);
      await new Promise((r) => setTimeout(r, remainingMs + 150));
      if (seq === speakSeqRef.current) {
        setSpeakingId(null);
        ttsPlayerRef.current = null;
        void ctx.close().catch(() => { });
        // Voice conversation: the reply has been spoken - listen again.
        if (voiceLoopRef.current) void startVoiceRecording();
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        console.error("TTS playback failed:", err);
      }
      if (seq === speakSeqRef.current) {
        setSpeakingId(null);
        ttsPlayerRef.current = null;
        if (ctx) void ctx.close().catch(() => { });
        // A TTS hiccup must not kill the conversation loop.
        if (voiceLoopRef.current) void startVoiceRecording();
      }
    }
  };

  // ---- Voice conversation mode ----
  // The mic button starts a hands-free loop: record → silence auto-sends →
  // reply is spoken → recording restarts. Saying "Zuychin, stop" (detected
  // via SpeechRecognition where available), tapping the chip's ✕, or leaving
  // the conversation ends it.

  const exitVoiceLoop = () => {
    voiceRequestRef.current++;
    voiceLoopRef.current = false;
    setVoiceLoop(false);
    try { srRef.current?.stop(); } catch { }
    srRef.current = null;
    if (recorderRef.current) {
      discardRecordingRef.current = true;
      recorderRef.current.stop();
    }
    stopSpeaking();
  };

  const startVoiceRecording = async () => {
    if (recorderRef.current) return;
    const origin = chats.get();
    if (!origin.loaded || origin.historyLoading) return;
    const request = ++voiceRequestRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (request !== voiceRequestRef.current || chats.get() !== origin) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      voiceLoopRef.current = true;
      setVoiceLoop(true);

      const recorder = new MediaRecorder(stream);
      recordChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) recordChunksRef.current.push(e.data); };

      // Voice activity detection: a stretch of silence after speech sends the
      // note; sustained silence with no speech at all ends the loop.
      const ac = new AudioContext();
      // Loop restarts run outside a user gesture; a suspended context would
      // read silence forever and false-trigger the no-speech exit.
      if (ac.state === "suspended") void ac.resume().catch(() => { });
      const source = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let spoke = false;
      let silenceSince = 0;
      const startedAt = Date.now();
      const SPEECH_RMS = 0.02;
      const SILENCE_RMS = 0.012;
      const SILENCE_SEND_MS = 1800;
      const NO_SPEECH_EXIT_MS = 10000;
      const vadTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);
        if (rms > SPEECH_RMS) {
          spoke = true;
          silenceSince = 0;
        } else if (spoke && rms < SILENCE_RMS) {
          if (!silenceSince) silenceSince = Date.now();
          else if (Date.now() - silenceSince > SILENCE_SEND_MS) recorder.stop();
        }
        if (!spoke && Date.now() - startedAt > NO_SPEECH_EXIT_MS) exitVoiceLoop();
      }, 150);
      vadCleanupRef.current = () => {
        clearInterval(vadTimer);
        void ac.close().catch(() => { });
      };

      // Best-effort stop-phrase watcher (Chrome). Without it the chip ✕ and
      // the no-speech timeout still end the loop.
      const w = window as unknown as {
        SpeechRecognition?: new () => SpeechRecognitionLike;
        webkitSpeechRecognition?: new () => SpeechRecognitionLike;
      };
      const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
      if (SR) {
        try {
          const rec = new SR();
          rec.continuous = true;
          rec.interimResults = true;
          rec.lang = "en-AU";
          rec.onresult = (e) => {
            let transcript = "";
            for (let i = e.resultIndex; i < e.results.length; i++) {
              transcript += e.results[i][0].transcript;
            }
            if (/zuychin[\s,.!]*stop/i.test(transcript)) exitVoiceLoop();
          };
          rec.onerror = () => { };
          rec.start();
          srRef.current = rec;
        } catch { }
      }

      recorder.onstop = () => {
        vadCleanupRef.current?.();
        vadCleanupRef.current = null;
        try { srRef.current?.stop(); } catch { }
        srRef.current = null;
        stream.getTracks().forEach((t) => t.stop());
        setIsRecording(false);
        recorderRef.current = null;

        const discard = discardRecordingRef.current;
        discardRecordingRef.current = false;
        const blob = new Blob(recordChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        recordChunksRef.current = [];
        if (discard || blob.size === 0) return;
        if (blob.size > MAX_FILE_SIZE_BYTES) {
          alert(`Recording too large (${(blob.size / 1024 / 1024).toFixed(1)} MB). Max ${MAX_FILE_SIZE_MB} MB.`);
          exitVoiceLoop();
          return;
        }
        // Codec suffixes ("audio/webm;codecs=opus") fail the whitelist check.
        const mimeType = (blob.type.split(";")[0] || "audio/webm").trim();
        const ext = mimeType === "audio/mp4" ? "m4a" : mimeType.split("/")[1] || "webm";
        const reader = new FileReader();
        reader.onload = () => {
          if (!chats.contains(origin)) return;
          const base64 = (reader.result as string).split(",")[1] ?? "";
          const file = { name: `voice-note.${ext}`, mimeType, base64, size: blob.size };
          if (voiceLoopRef.current && chats.get() === origin) {
            void sendPayload({ text: "", file, replyTo: null }, origin);
          } else {
            chats.setDraft(origin, { ...origin.draft, file });
            if (chats.get() === origin) inputRef.current?.focus();
          }
        };
        reader.readAsDataURL(blob);
      };

      recorder.start();
      recorderRef.current = recorder;
      setIsRecording(true);
    } catch (err) {
      console.error("Mic capture failed:", err);
      voiceLoopRef.current = false;
      setVoiceLoop(false);
      alert("Couldn't access the microphone. Check the browser permission.");
    }
  };

  const toggleRecording = () => {
    // Tapping mid-recording sends what's captured so far (the loop continues);
    // the chip's ✕ or "Zuychin, stop" ends the conversation.
    if (recorderRef.current) {
      recorderRef.current.stop();
      return;
    }
    void startVoiceRecording();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const origin = chats.get();
    const request = ++origin.fileRequest;

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
      if (!chats.contains(origin) || request !== origin.fileRequest) return;
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      chats.setDraft(origin, { ...origin.draft, file: {
        name: file.name,
        mimeType: file.type,
        base64,
        size: file.size,
      } });
    };
    reader.onerror = () => setActionError({ message: `Could not read ${file.name}. Please attach it again.`, retry: () => { setActionError(null); fileInputRef.current?.click(); } });
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

  // On mobile these own a row of their own, so they share it evenly instead of
  // being pushed off the edge by the model selectors.
  const renderNavLinks = (compact: boolean) => {
    const linkStyle: React.CSSProperties = compact
      ? { ...styles.graphBtn, flex: 1, minWidth: 0, justifyContent: "center" }
      : styles.graphBtn;
    return (
      <>
        <Link href={withReturnTo(returnTo?.startsWith("/graph") ? returnTo : documentLinks.knowledge, activeConversationId ? `/?c=${encodeURIComponent(activeConversationId)}` : "/")} style={linkStyle} aria-label={returnTo?.startsWith("/graph") ? "Return to cosmos" : "Knowledge workspace"} title={returnTo?.startsWith("/graph") ? "Return to cosmos" : "Knowledge workspace"}>
          <Waypoints size={14} color="var(--color-text-muted)" />
          <span>{returnTo?.startsWith("/graph") ? "Cosmos" : "Knowledge"}</span>
        </Link>
        <Link href="/council" style={linkStyle} aria-label="Council" title="Council">
          <Gavel size={14} color="var(--color-text-muted)" />
          <span>Council</span>
        </Link>
        <Link href="/admin" style={linkStyle} aria-label="Dashboard" title="Dashboard">
          <ShieldCheck size={14} color="var(--color-text-muted)" />
          <span>Dashboard</span>
        </Link>
      </>
    );
  };

  const renderModelSelectors = (compact: boolean) =>
    providers.length > 0 ? (
      <div style={styles.modelControlCluster}>
        <SelectMenu
          searchable
          compact={compact}
          integrated
          align="right"
          ariaLabel="Chat model"
          icon={<Cpu size={14} color="var(--color-primary)" />}
          value={chatSel}
          onChange={handleChatSelChange}
          groups={providers.map((p) => ({
            label: p.label,
            options: p.chatModels.map((m) => ({ value: `${p.id}::${m.id}`, label: m.label, searchTerms: modelSearchTerms(m) })),
          }))}
        />
        <button
          type="button"
          onClick={() => setModelInfoOpen(true)}
          style={styles.modelClusterButton}
          aria-label="Model details"
          title="Model details"
          disabled={!currentChatModel}
        >
          <Info size={17} />
        </button>
        <button
          type="button"
          onClick={() => setGenerationOpen((open) => !open)}
          style={{ ...styles.modelClusterButton, ...(generationOpen ? styles.modelClusterButtonActive : {}) }}
          aria-label="Generation settings"
          title="Generation settings"
        >
          <SlidersHorizontal size={16} />
        </button>
        {generationOpen && (
          <div style={styles.modelSettingsPopover} className="animate-fade-in-scale">
            <div style={styles.settingsHeader}>
              <span style={styles.settingsTitle}>Generation</span>
              <button onClick={() => setGenerationOpen(false)} style={styles.filePreviewRemove} aria-label="Close generation settings">
                <X size={14} />
              </button>
            </div>
            <ParamRow label="Temperature" min={0} max={2} step={0.1} def={0.7} value={genParams.temperature} onChange={(v) => updateGenParams({ ...genParams, temperature: v })} />
            <ParamRow label="Top P" min={0} max={1} step={0.05} def={0.9} value={genParams.topP} onChange={(v) => updateGenParams({ ...genParams, topP: v })} />
            <ParamRow label="Max tokens" min={256} max={maxTokenCeiling} step={maxTokenStep} def={2048} value={genParams.maxTokens} onChange={(v) => updateGenParams({ ...genParams, maxTokens: v })} />
            <p style={styles.settingsNote}>
              Auto uses the selected model&apos;s provider default. Ceiling is {maxTokenCeiling.toLocaleString()} for {currentChatModel?.label ?? "this model"}.
            </p>
            {providers.some((p) => p.embeddingModels.length > 0) && (
              <div style={styles.settingsEmbedRow}>
                <span style={styles.settingsEmbedLabel}>Embedding</span>
                <SelectMenu
                  wide
                  compact
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
              </div>
            )}
            <div style={styles.settingsToggleRow}>
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
      </div>
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

      {embedModal && (
        <ConfirmModal
          title="Switch embedding model?"
          body={`This re-embeds the ENTIRE knowledge store - every message, note, document and remembered fact - with ${providers.flatMap((p) => p.embeddingModels).find((m) => m.id === embedModal.target)?.label ?? embedModal.target}. It runs in batches, can take a few minutes and uses embedding API quota. Keep this tab open until it finishes.`}
          confirmLabel="Re-embed everything"
          busyText={embedModal.status === "confirm" ? undefined : embedModal.status}
          onConfirm={() => void runReembed(embedModal.target)}
          onCancel={() => setEmbedModal(null)}
        />
      )}

      {deleteConfirm && (
        <ConfirmModal
          title={`Delete ${deleteConfirm.kind === "chat" ? "conversation" : "project"}?`}
          body={deleteConfirm.kind === "chat"
            ? `Delete “${deleteConfirm.title}” and its messages? This cannot be undone.`
            : `Delete “${deleteConfirm.title}”? Its conversations will remain in Ungrouped.`}
          confirmLabel="Delete"
          busyText={pendingActions.includes(`delete:${deleteConfirm.id}`) ? "Deleting…" : undefined}
          onConfirm={() => { void confirmDeletion(); }}
          onCancel={() => { deleteConfirm.resolve(false); setDeleteConfirm(null); }}
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

        <button onClick={() => handleNewChat()} disabled={pendingActions.includes("new-chat")} style={{ ...styles.newChatBtn, marginTop: 8 }}>
          <Plus size={16} />
          <span>New Chat</span>
        </button>

        <ConversationList
          conversations={conversations}
          projects={projects}
          activeConversationId={activeConversationId}
          loaded={convosLoaded}
          runningConversationIds={chats.runningKeys()}
          deletingConversationIds={[...(deleteConfirm?.kind === "chat" ? [deleteConfirm.id] : []), ...pendingActions.filter((key) => key.startsWith("delete:")).map((key) => key.slice(7))]}
          onSelect={loadConversation}
          onDelete={handleDeleteConversation}
          onNewChat={handleNewChat}
          onUpdateProject={handleUpdateProject}
          onDeleteProject={handleDeleteProject}
          onMoveConversation={handleMoveConversation}
          formatTime={formatTime}
        />

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
                  {renderNavLinks(false)}
                  {renderModelSelectors(false)}
                </div>
              )}
            </div>

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
              <button onClick={() => handleNewChat()} disabled={pendingActions.includes("new-chat")} style={styles.iconBtn} aria-label="New conversation" title="New conversation">
                <Plus size={20} color="var(--color-text-primary)" />
              </button>
            </div>
          </div>

          {!isDesktop && (
            <div style={styles.headerNavRow}>
              {renderNavLinks(true)}
            </div>
          )}

          {!isDesktop && providers.length > 0 && (
            <div style={styles.headerSelectorsRow}>
              {renderModelSelectors(true)}
            </div>
          )}
        </header>

        {actionError && (
          <div role="alert" style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 16px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)", fontSize: 13 }}>
            <span style={{ flex: 1 }}>{actionError.message}</span>
            {actionError.retry && <button type="button" onClick={actionError.retry} style={styles.exportBtn}>Retry</button>}
            <button type="button" onClick={() => setActionError(null)} style={styles.iconBtn} aria-label="Dismiss error"><X size={15} /></button>
          </div>
        )}
        {chats.storageError && (
          <div role="alert" style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 16px", color: "var(--color-text-primary)", fontSize: 13 }}>
            <span style={{ flex: 1 }}>{chats.storageError}</span>
            <button type="button" onClick={() => { void retryDraftStorage(); }} style={styles.exportBtn}>Save again</button>
          </div>
        )}
        {chats.runningKeys().some((key) => key !== session.key) && (
          <div role="status" style={{ padding: "6px 16px" }}>
            <button type="button" style={styles.exportBtn} onClick={() => { const key = chats.runningKeys().find((id) => id !== session.key); if (key) void loadConversation(key); }}>
              Reply running in another chat
            </button>
          </div>
        )}

        <main
          onScroll={handleMessagesScroll}
          style={isDesktop ? styles.messages : { ...styles.messages, padding: "16px 14px 8px" }}
        >
          {session.historyLoading && <p role="status" style={styles.emptySubtitle}>Loading conversation…</p>}
          {!session.loaded && !session.historyLoading && <p role="status" style={styles.emptySubtitle}>Load this conversation before sending a message. Your draft is safe.</p>}
          {messages.length === 0 && session.loaded && (
            <div style={styles.emptyState} className="animate-fade-in-scale">
              <div style={styles.emptyIcon} className="animate-float">
                <Bot size={32} color="var(--color-primary-foreground)" />
              </div>
              <p style={styles.emptyTitle}>Hi, I&apos;m Zuychin</p>
              <p style={styles.emptySubtitle}>
                Your personal AI assistant for research, coding and planning.
              </p>
              {today ? (
                <div style={styles.todayCard} className="animate-fade-in-scale">
                  <div style={styles.todayHeader}>
                    <span style={styles.todayTitle}>
                      <CalendarDays size={15} color="var(--color-primary)" />
                      Today
                    </span>
                    <button
                      type="button"
                      onClick={dismissToday}
                      style={styles.todayDismiss}
                      aria-label="Dismiss the Today card"
                      title="Dismiss"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {today.dueTodos.length > 0 && (
                    <>
                      <span style={styles.todaySectionLabel}>Due soon</span>
                      {today.dueTodos.map((t) => (
                        <div key={t.id} style={styles.todayItem}>
                          <span>⚠️ {t.title}</span>
                          {t.dueDate && <span style={styles.todayItemMeta}>{fmtWhen(t.dueDate)}</span>}
                        </div>
                      ))}
                    </>
                  )}
                  {today.events.length > 0 && (
                    <>
                      <span style={styles.todaySectionLabel}>Next 48 hours</span>
                      {today.events.map((e, i) => (
                        <div key={e.id ?? i} style={styles.todayItem}>
                          <span>{e.summary}</span>
                          <span style={styles.todayItemMeta}>{fmtWhen(e.start)}</span>
                        </div>
                      ))}
                    </>
                  )}
                  {today.todos.length > 0 && (
                    <>
                      <span style={styles.todaySectionLabel}>Pending</span>
                      {today.todos.map((t) => (
                        <div key={t.id} style={styles.todayItem}>
                          <span>• {t.title}</span>
                          {t.dueDate && <span style={styles.todayItemMeta}>{fmtWhen(t.dueDate)}</span>}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              ) : (
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
              )}
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
              {msg.role === "user" && (
                <button
                  type="button"
                  onClick={() => startReply(msg)}
                  style={styles.replyMsgBtn}
                  aria-label="Reply to this message"
                  title="Reply to this message"
                >
                  <Reply size={15} />
                </button>
              )}
              <div
                style={{
                  ...styles.bubble,
                  ...(msg.role === "user" ? styles.userBubble : styles.aiBubble),
                }}
              >
                {msg.replyTo && (
                  <div style={styles.replyQuote}>
                    <span style={styles.replyQuoteRole}>
                      {msg.replyTo.role === "user" ? "You" : "Zuychin"}
                    </span>
                    <span style={styles.replyQuoteText}>{msg.replyTo.content}</span>
                  </div>
                )}
                {msg.fileName && (
                  <div style={styles.fileTag}>
                    {getFileIcon(msg.fileMimeType)}
                    <span style={styles.fileTagName}>{msg.fileName}</span>
                  </div>
                )}
                {msg.role === "assistant" ? (
                  <div className="markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={chatMarkdownComponents}>{msg.content}</ReactMarkdown>
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
                {msg.role === "assistant" && msg.councilProposal && (
                  <CouncilProposalCard proposal={msg.councilProposal} />
                )}
                {msg.role === "assistant" && msg.resume && (
                  <div style={styles.exportRow}>
                    <button
                      onClick={() => handleSubmit(null, msg.resume)}
                      style={{ ...styles.exportBtn, opacity: isLoading ? 0.5 : 1 }}
                      disabled={isLoading}
                      title="Relaunch this run - the agent continues from its recorded progress"
                    >
                      <RotateCcw size={12} />
                      <span>Resume run</span>
                    </button>
                  </div>
                )}
                {msg.role === "assistant" && msg.retry && (
                  <div style={styles.exportRow}>
                    <button
                      onClick={() => void handleRetry(msg)}
                      style={{ ...styles.exportBtn, opacity: isLoading ? 0.5 : 1 }}
                      disabled={isLoading}
                      title="Send this message again"
                    >
                      <RotateCcw size={12} />
                      <span>Retry</span>
                    </button>
                  </div>
                )}
                {msg.role === "assistant" && !msg.retry && msg.content.length > 80 && (
                  <div style={styles.exportRow}>
                    <button
                      onClick={() => setExportMenuFor(exportMenuFor === msg.id ? null : msg.id)}
                      style={{
                        ...styles.exportBtn,
                        ...(exportMenuFor === msg.id ? styles.exportBtnActive : {}),
                      }}
                      title="Download this reply as a document"
                      aria-expanded={exportMenuFor === msg.id}
                    >
                      <span>Generate</span>
                      <ChevronRight
                        size={12}
                        style={{
                          transform: exportMenuFor === msg.id ? "rotate(180deg)" : "none",
                          transition: "transform 0.15s ease",
                        }}
                      />
                    </button>
                    {exportMenuFor === msg.id &&
                      (["docx", "pdf", "md"] as const).map((fmt) => (
                        <button
                          key={fmt}
                          onClick={() => {
                            handleExport(msg.content, fmt);
                            setExportMenuFor(null);
                          }}
                          style={styles.exportBtn}
                          title={`Download as ${fmt.toUpperCase()}`}
                        >
                          <Download size={12} />
                          <span>{fmt.toUpperCase()}</span>
                        </button>
                      ))}
                  </div>
                )}
                {msg.role === "assistant" && (msg.modelLabel || msgClock(msg.at)) && (
                  <div style={styles.msgMeta}>
                    {[msg.modelLabel, msgClock(msg.at)].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
              {msg.role === "assistant" && !msg.resume && !msg.retry && (
                <button
                  type="button"
                  onClick={() => startReply(msg)}
                  style={styles.replyMsgBtn}
                  aria-label="Reply to this message"
                  title="Reply to this message"
                >
                  <Reply size={15} />
                </button>
              )}
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

          {queuedView.length > 0 && !isLoading && (
            <div role="status" style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13, color: "var(--color-text-secondary)" }}>
              <span>Queued messages are paused.</span>
              <button type="button" style={styles.exportBtn} onClick={() => resumeQueue(chats.get())}>Send next</button>
            </div>
          )}
          {queuedView.map((q) => (
            <div
              key={q.id}
              style={{ ...styles.messageBubbleWrapper, justifyContent: "flex-end", opacity: 0.55 }}
              className="animate-slide-right"
            >
              <button
                type="button"
                onClick={() => removeQueued(q.id)}
                style={styles.replyMsgBtn}
                aria-label="Remove queued message"
                title="Remove queued message"
              >
                <X size={15} />
              </button>
              <div style={{ ...styles.bubble, ...styles.userBubble }}>
                {q.payload.file && (
                  <div style={styles.fileTag}>
                    {getFileIcon(q.payload.file.mimeType)}
                    <span style={styles.fileTagName}>{q.payload.file.name}</span>
                  </div>
                )}
                <p style={styles.bubbleText}>{q.payload.text || (q.payload.file ? `[Sent ${q.payload.file.name}]` : "")}</p>
                <div style={{ ...styles.msgMeta, color: "inherit", opacity: 0.75 }}>Queued</div>
              </div>
            </div>
          ))}

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
          {voiceLoop && (
            <div style={styles.replyPreview} className="animate-fade-in">
              {isRecording
                ? <Mic size={14} color="#ef4444" style={{ flexShrink: 0 }} />
                : <Volume2 size={14} color="var(--color-primary)" style={{ flexShrink: 0 }} />}
              <span style={styles.replyPreviewLabel}>
                Voice chat{isRecording ? " - listening" : speakingId ? " - speaking" : isLoading ? " - thinking" : ""}
              </span>
              <span style={styles.replyPreviewText}>say &ldquo;Zuychin, stop&rdquo; to end</span>
              <button
                onClick={exitVoiceLoop}
                style={styles.filePreviewRemove}
                aria-label="End voice chat"
                title="End voice chat"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {replyTo && (
            <div style={styles.replyPreview} className="animate-fade-in">
              <Reply size={14} color="var(--color-primary)" style={{ flexShrink: 0 }} />
              <span style={styles.replyPreviewLabel}>
                Replying to {replyTo.role === "user" ? "you" : "Zuychin"}
              </span>
              <span style={styles.replyPreviewText}>{replyTo.content}</span>
              <button
                onClick={() => setReplyTo(null)}
                style={styles.filePreviewRemove}
                aria-label="Cancel reply"
              >
                <X size={14} />
              </button>
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
            <button
              type="button"
              onClick={toggleRecording}
              disabled={!session.loaded || session.historyLoading}
              style={styles.attachBtn}
              aria-label={isRecording ? "Send what was captured" : "Start a voice chat"}
              title={isRecording ? "Send what was captured (silence sends automatically)" : "Start a voice chat - replies are spoken, say “Zuychin, stop” to end"}
              className={isRecording ? "animate-fade-in" : undefined}
            >
              <Mic size={18} color={isRecording ? "#ef4444" : "var(--color-text-muted)"} />
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
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder="Message Zuychin..."
              rows={1}
              style={styles.textarea}
            />
            {isLoading && (
              <button
                type="button"
                onClick={handleCancel}
                style={{ ...styles.sendButton, background: "var(--color-surface)" }}
                aria-label="Stop generating"
                title="Stop generating (also clears queued messages)"
              >
                <Square size={15} color="var(--color-text-primary)" fill="var(--color-text-primary)" />
              </button>
            )}
            <button
              type="submit"
              disabled={(!input.trim() && !pendingFile) || !session.loaded || session.historyLoading}
              style={{
                ...styles.sendButton,
                opacity: (!input.trim() && !pendingFile) || !session.loaded || session.historyLoading ? 0.3 : 1,
              }}
              aria-label={isLoading ? "Queue message" : "Send message"}
              title={isLoading ? "Queue message (sends after the current reply)" : "Send message"}
            >
              <Send size={20} color="var(--color-primary-foreground)" />
            </button>
          </form>
        </footer>
      </div>
    </div>
  );
}
