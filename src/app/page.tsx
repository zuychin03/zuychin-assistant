"use client";

import { useState, useRef, useEffect, useCallback, useSyncExternalStore } from "react";
import { AppSidebar, SidebarToggle, ZuychinMark, useMediaQuery, useSidebarState, useStoredFlag } from "@/components/app-sidebar";
import { TODAY_DOCKED_QUERY, TodayPanel, TodayToggle, useDueCount } from "@/components/today-panel";
import { ArrowUp, Bot, Check, Circle, X, Paperclip, FileText, FileCode, FileArchive, Folder, Image as ImageIcon, LoaderCircle, Music, Video, File, Brain, Download, SlidersHorizontal, Database, Info, ArrowDown, ChevronRight, RotateCcw, Reply, Square, SquarePen, Mic, Volume2, BookOpen, CircleDollarSign } from "lucide-react";
import { SelectMenu, ParamRow, ModelInfoModal, ConfirmModal, modelSearchTerms, type ProviderInfo } from "./home/controls";
import { ConversationList, NewProjectButton, type ProjectItem } from "./home/conversation-list";
import { styles } from "./home/styles";
import chatModeStyles from "./home/chat-modes.module.css";
import ui from "./home/chat.module.css";
import { GenerationSettings, ModeToggle } from "./home/generation-settings";
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
import { eligibleChatProviders, resolveChatSelection } from "./home/chat-policy";
import { ReplyActivity, SourceChart } from "./home/reply-sources";
import { DayStarters } from "./home/day-starters-list";
import { BranchNavigation } from "./conversations/branch-navigation";
import { BranchMessageAction } from "./conversations/branch-message-action";
import type { ReplyTrace } from "@/lib/ai/reply-trace";

interface ChatMessage {
  id: string;
  persisted?: boolean;
  role: "user" | "assistant";
  content: string;
  fileName?: string;
  fileMimeType?: string;
  artifacts?: ArtifactDescriptor[];
  /** A council Zuychin drafted; the card under the reply is what launches it. */
  councilProposal?: CouncilProposal;
  /** Which model produced this reply (only known for messages sent this session). */
  modelLabel?: string;
  replyTrace?: ReplyTrace;
  /** ISO timestamp shown under assistant replies. */
  at?: string;
  /** Set on interruption notices: lets the user relaunch the agent run with prior progress. */
  resume?: { runId: string; text: string };
  /** Set on interruption notices without a resumable run: re-sends the original payload. */
  retry?: { payload: OutgoingPayload; userMsgId: string; knownIds: string[] };
  /** Quoted excerpt of the earlier message this one replies to. */
  replyTo?: { role: "user" | "assistant"; content: string };
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

interface OutgoingPayload {
  knowledgeOnly: boolean;
  freeOnly: boolean;
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
    knowledgeOnly?: boolean;
    historicalModels?: { providerId: string; modelId: string }[];
    replyTrace?: ReplyTrace;
    artifacts?: ArtifactDescriptor[];
    replyTo?: { role: "user" | "assistant"; content: string };
    councilProposal?: CouncilProposal;
  };
}

const mapServerMessages = (msgs: ServerMessage[]): ChatMessage[] =>
  msgs.map((m) => ({
    id: m.id,
    persisted: true,
    role: m.role as "user" | "assistant",
    content: m.content,
    artifacts: m.metadata?.artifacts,
    councilProposal: m.metadata?.councilProposal,
    replyTo: m.metadata?.replyTo,
    at: m.createdAt,
    modelLabel: m.metadata?.knowledgeOnly ? "Saved sources" : m.metadata?.historicalModels?.map((model) => `${model.providerId} / ${model.modelId}`).join(", "),
    replyTrace: m.metadata?.replyTrace,
  }));

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
  const sidebar = useSidebarState();
  const [chatSearch, setChatSearch] = useState("");
  const todayDocked = useMediaQuery(TODAY_DOCKED_QUERY, false);
  const [todayHidden, setTodayHidden] = useStoredFlag("zuychin-today", "hidden");
  const [todaySheetOpen, setTodaySheetOpen] = useState(false);
  const [todayRefresh, setTodayRefresh] = useState(0);
  const [dueCount, setDueCount] = useDueCount();
  const closeToday = useCallback(() => {
    if (todayDocked) setTodayHidden(true);
    else setTodaySheetOpen(false);
  }, [todayDocked, setTodayHidden]);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  // status: "confirm" shows the warning buttons; anything else is progress text.
  const [embedModal, setEmbedModal] = useState<{ target: string; status: string } | null>(null);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [knowledgeOnly, setKnowledgeOnly] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [preferencesSaving, setPreferencesSaving] = useState(false);
  const [preferencesError, setPreferencesError] = useState<{ message: string; attempted?: boolean } | null>(null);
  const chatPolicyRef = useRef({ freeOnly: false, ready: false });
  const [actionError, setActionError] = useState<{ message: string; retry?: () => void } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ kind: "chat" | "project"; id: string; title: string; resolve: (ok: boolean) => void } | null>(null);
  const [pendingActions, setPendingActions] = useState<string[]>([]);
  const pendingActionsRef = useRef(new Set<string>());
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [documentLinks, setDocumentLinks] = useState({ knowledge: "/knowledge", graph: "/graph" });
  const [isDesktop, setIsDesktop] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [providersError, setProvidersError] = useState("");
  const providerRequest = useRef(0);

  const [chatSel, setChatSel] = useState("");
  const [embedSel, setEmbedSel] = useState("");
  const [generationOpen, setGenerationOpen] = useState(false);
  const generationTriggerRef = useRef<HTMLButtonElement>(null);
  const closeGeneration = useCallback(() => setGenerationOpen(false), []);
  const [genParams, setGenParams] = useState<GenParamsState>({ temperature: null, topP: null, maxTokens: null });
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

  const loadChatPreferences = useCallback(async () => {
    chatPolicyRef.current.ready = false;
    setPreferencesError(null);
    setPreferencesLoaded(false);
    try {
      const data = await requestJson<{ freeOnly: boolean }>("/api/chat/preferences", { cache: "no-store" });
      if (typeof data.freeOnly !== "boolean") throw new Error("Invalid preference response.");
      chatPolicyRef.current = { freeOnly: data.freeOnly, ready: true };
      setFreeOnly(data.freeOnly);
      setPreferencesLoaded(true);
    } catch {
      setPreferencesError({ message: "Could not load Free only. Retry before sending." });
    }
  }, []);

  useEffect(() => { void loadChatPreferences(); }, [loadChatPreferences]);

  const saveFreeOnly = async (next: boolean) => {
    if (preferencesSaving) return;
    chatPolicyRef.current.ready = false;
    exitVoiceLoop();
    setPreferencesSaving(true);
    setPreferencesError(null);
    try {
      const data = await requestJson<{ freeOnly: boolean }>("/api/chat/preferences", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ freeOnly: next }),
      });
      if (typeof data.freeOnly !== "boolean" || data.freeOnly !== next) throw new Error("The preference was not confirmed.");
      chatPolicyRef.current = { freeOnly: data.freeOnly, ready: true };
      setFreeOnly(data.freeOnly);
      setPreferencesLoaded(true);
    } catch {
      setPreferencesError({ message: "Could not confirm the change. Your last confirmed setting is shown. Retry before sending.", attempted: next });
    } finally {
      setPreferencesSaving(false);
    }
  };

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

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
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

  useEffect(() => {
    const saved = localStorage.getItem("zuychin-think-mode");
    if (saved === "true") setThinkingEnabled(true);
  }, []);

  const loadProviders = useCallback(async () => {
    const requestId = ++providerRequest.current;
    const current = () => requestId === providerRequest.current;
    setProvidersLoading(true);
    setProvidersError("");
    try {
      const res = await fetch("/api/providers", { cache: "no-store" });
      if (!res.ok) throw new Error(`Request failed (${res.status}).`);
      const data = await res.json();
      if (!Array.isArray(data.providers)) throw new Error("Invalid provider response.");
      if (!current()) return;
      const avail: ProviderInfo[] = data.providers.filter((p: ProviderInfo) => p.available);
      let savedChat: string | null = null;
      try { savedChat = localStorage.getItem("zuychin-chat-model"); } catch {}
      const savedProvider = avail.find((p) => savedChat?.startsWith(`${p.id}::`));
      const savedModel = savedChat?.slice((savedProvider?.id.length ?? 0) + 2);
      const replacement = savedModel && savedProvider?.chatModelAliases?.[savedModel];
      if (replacement && savedProvider?.chatModels.some((m) => m.id === replacement)) {
        savedChat = `${savedProvider.id}::${replacement}`;
        try { localStorage.setItem("zuychin-chat-model", savedChat); } catch {}
      }
      const validChat = (value: string | null) => avail.some((p) => p.chatModels.some((m) => `${p.id}::${m.id}` === value));
      const defaultChat = data.defaults?.chat ? `${data.defaults.chat.providerId}::${data.defaults.chat.modelId}` : "";
      setChatSel(value => validChat(value) ? value : validChat(savedChat) ? savedChat! : defaultChat);
      setProviders(avail);
      setProvidersLoaded(true);
      setProvidersLoading(false);

      // Embedding selection follows the server's active knowledge partition.
      try {
        const activeRes = await fetch("/api/admin/reembed");
        const active = activeRes.ok ? (await activeRes.json()).active : null;
        if (!current()) return;
        if (active) setEmbedSel(active);
        else if (data.defaults?.embedding) setEmbedSel(data.defaults.embedding.modelId);
      } catch {
        if (current() && data.defaults?.embedding) setEmbedSel(data.defaults.embedding.modelId);
      }
    } catch {
      if (current()) setProvidersError("Could not load chat models. Try again.");
    } finally {
      if (current()) setProvidersLoading(false);
    }
  }, []);

  useEffect(() => {
    const request = providerRequest;
    void loadProviders();
    return () => { request.current++; };
  }, [loadProviders]);

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

  const chatProviders = eligibleChatProviders(providers, freeOnly);
  const effectiveChatSel = resolveChatSelection(providers, chatSel, freeOnly);
  const preferencesBlocked = !preferencesLoaded || preferencesSaving || !!preferencesError;
  const noFreeChatModel = providersLoaded && freeOnly && !effectiveChatSel;
  const sendBlocked = preferencesBlocked || (!knowledgeOnly && (!providersLoaded || noFreeChatModel));
  const currentChatProvider = (() => {
    const sep = effectiveChatSel.indexOf("::");
    if (sep === -1) return undefined;
    return providers.find((p) => p.id === effectiveChatSel.slice(0, sep));
  })();
  const currentChatModel = (() => {
    const sep = effectiveChatSel.indexOf("::");
    if (sep === -1) return undefined;
    const mid = effectiveChatSel.slice(sep + 2);
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
    if (!sidebar.docked) sidebar.setOpen(false);
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

  const refreshLists = async () => (await Promise.all([loadProjects(), loadConversations()])).every(Boolean);
  const runAction = async (key: string, label: string, write: () => Promise<void>, refresh: () => Promise<boolean>, retryInPlace = true, retryControl?: string): Promise<boolean> => {
    if (pendingActionsRef.current.has(key)) return false;
    pendingActionsRef.current.add(key);
    setPendingActions([...pendingActionsRef.current]);
    setActionError(null);
    try {
      await write();
    } catch (error) {
      setActionError({
        message: `Could not ${label}. ${error instanceof Error ? error.message : "Please try again."}${retryInPlace ? "" : ` Your form is still open; ${retryControl ? `choose ${retryControl}` : "use its button"} to try again.`}`,
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
  }, loadProjects, false, patch.instructions === undefined ? undefined : "Save instructions");

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
    if (sendBlocked || !chatPolicyRef.current.ready) return;
    const target = chats.get();
    if (!target.loaded || target.historyLoading) return;
    const text = resume?.text ?? target.draft.text.trim();
    if (!text && !target.draft.file) return;
    if (knowledgeOnly && (resume || target.draft.file)) {
      setActionError({ message: resume
        ? "Turn Knowledge only off to resume an agent run."
        : "Remove the attachment or turn Knowledge only off. This mode uses saved sources." });
      return;
    }

    const payload: OutgoingPayload = {
      knowledgeOnly,
      freeOnly: chatPolicyRef.current.freeOnly,
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
    if (!chatPolicyRef.current.ready || target.run || !target.loaded || target.historyLoading) return;
    const next = chats.shift(target);
    if (next) void sendPayload(next.payload, target);
  };

  const sendPayload = async (p: OutgoingPayload, target = chats.get(), retryMessage?: ChatMessage) => {
    if (!chatPolicyRef.current.ready) return;
    p = { ...p, freeOnly: p.freeOnly || chatPolicyRef.current.freeOnly };
    const requestChatSel = resolveChatSelection(providers, chatSel, p.freeOnly);
    const requestProvider = providers.find((provider) => requestChatSel.startsWith(`${provider.id}::`));
    const requestModel = requestProvider?.chatModels.find((model) => `${requestProvider.id}::${model.id}` === requestChatSel);
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
      if (p.freeOnly && !p.knowledgeOnly && !requestChatSel) throw new Error("No eligible free chat model is available. Configure a free provider, or turn Free only off and send a new message.");
      if (p.freeOnly && p.file?.mimeType.startsWith("audio/")) throw new Error("Audio is unavailable with Free only. Remove the audio attachment before sending.");
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
      if (p.knowledgeOnly) setAgentRun(() => ({ status: "Searching saved sources…", steps: [], lines: [] }));
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
          knowledgeOnly: p.knowledgeOnly,
          freeOnly: p.freeOnly,
          thinking: thinkingEnabled && canThink,
          agent: p.resume ? true : agentEnabled,
          ...(p.resume && { resumeRunId: p.resume.runId }),
          ...(p.replyTo && { replyTo: p.replyTo }),
          genParams: {
            ...(genParams.temperature !== null && { temperature: genParams.temperature }),
            ...(genParams.topP !== null && { topP: genParams.topP }),
            ...(genParams.maxTokens !== null && { maxTokens: genParams.maxTokens }),
          },
          ...(requestChatSel.includes("::") && {
            provider: requestChatSel.split("::")[0],
            model: requestChatSel.split("::").slice(1).join("::"),
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
      let done: { reply: string; messageId: string; userMessageId?: string; artifacts?: ArtifactDescriptor[]; councilProposal?: CouncilProposal; replyTrace?: ReplyTrace } | null = null;
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
            done = { reply: evt.reply, messageId: evt.messageId, userMessageId: evt.userMessageId, artifacts: evt.artifacts, councilProposal: evt.councilProposal, replyTrace: evt.replyTrace };
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

      const userMessageId = done.userMessageId;
      if (userMessageId) setMessages((previous) => previous.map((item) => item.id === userMessage.id ? { ...item, id: userMessageId, persisted: true } : item));
      const assistantMessage: ChatMessage = {
        id: done.messageId || crypto.randomUUID(),
        persisted: !!done.messageId,
        role: "assistant",
        content: done.reply,
        artifacts: done.artifacts,
        councilProposal: done.councilProposal,
        modelLabel: p.knowledgeOnly ? "Saved sources" : requestModel?.label,
        replyTrace: done.replyTrace,
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
      if (!p.freeOnly && !chatPolicyRef.current.freeOnly && chats.get() === target && micTurn && done.reply && (voiceLoopRef.current || voicePrefsRef.current.replyWithVoice !== "off")) {
        void toggleSpeak(assistantMessage);
      }
      canDrain = true;
      void loadConversations();
      setTodayRefresh((value) => value + 1);
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
    return isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
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
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
    if (!chatPolicyRef.current.ready || chatPolicyRef.current.freeOnly) return;
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
        body: JSON.stringify({ text: msg.content, stream: true, freeOnly: chatPolicyRef.current.freeOnly }),
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
    if (!chatPolicyRef.current.ready || chatPolicyRef.current.freeOnly) return;
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
            void sendPayload({ text: "", file, replyTo: null, knowledgeOnly: false, freeOnly: chatPolicyRef.current.freeOnly }, origin);
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
    if (kind === "code") return <FileCode size={15} />;
    if (kind === "archive") return <FileArchive size={15} />;
    return <FileText size={15} />;
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

  const chatHref = activeConversationId ? `/?c=${encodeURIComponent(activeConversationId)}` : "/";
  const sidebarLinks = {
    library: withReturnTo(documentLinks.knowledge, chatHref),
    cosmos: withReturnTo(returnTo?.startsWith("/graph") ? returnTo : documentLinks.graph, chatHref),
  };
  const vaultHref = (path: string) => withReturnTo(`/knowledge?path=${encodeURIComponent(path)}`, chatHref);
  const cosmosHrefFor = (sources: NonNullable<ReplyTrace["sources"]>) => {
    const page = sources.find((source) => source.kind === "vault" && source.ref)?.ref;
    if (!page) return undefined;
    const node = encodeURIComponent(page);
    return withReturnTo(`/graph?node=${node}&root=${node}&local=1`, chatHref);
  };
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const activeProject = projects.find((project) => project.id === activeConversation?.projectId);
  const chatTitle = activeConversation?.title ?? (activeConversationId ? "Conversation" : "New chat");
  const todayOpen = todayDocked ? !todayHidden : todaySheetOpen;
  const toggleToday = () => {
    if (todayDocked) setTodayHidden(!todayHidden);
    else setTodaySheetOpen((open) => !open);
  };
  const overlayOpen = (!sidebar.docked && sidebar.open) || (!todayDocked && todaySheetOpen);
  const sendDisabled = sendBlocked || (!input.trim() && !pendingFile) || !session.loaded || session.historyLoading;

  const renderModelSelectors = (compact: boolean) =>
    providers.length > 0 ? (
      <div className={ui.modelCluster}>
        <SelectMenu
          searchable
          compact={compact}
          dropUp={compact}
          align={compact ? "left" : "right"}
          ariaLabel="Chat model"
          icon={null}
          value={effectiveChatSel}
          onChange={handleChatSelChange}
          groups={chatProviders.map((p) => ({
            label: p.label,
            options: p.chatModels.map((m) => ({ value: `${p.id}::${m.id}`, label: m.label, searchTerms: modelSearchTerms(m) })),
          }))}
        />
        {!compact && <button
          type="button"
          onClick={() => setModelInfoOpen(true)}
          className={ui.iconButton}
          aria-label="Model details"
          title="Model details"
          disabled={!currentChatModel}
        >
          <Info size={16} aria-hidden="true" />
        </button>}
        <button
          type="button"
          ref={generationTriggerRef}
          onClick={() => setGenerationOpen((open) => !open)}
          aria-expanded={generationOpen}
          aria-haspopup="dialog"
          aria-controls={generationOpen ? "generation-settings" : undefined}
          className={ui.iconButton}
          aria-label="Generation settings"
          title="Generation settings"
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
        </button>
        {generationOpen && (
          <GenerationSettings triggerRef={generationTriggerRef} onClose={closeGeneration}>
            <section className={chatModeStyles.modes} aria-label="Modes">
              <h3>Modes</h3>
              <ModeToggle label="Agent mode" icon={<Bot size={15} aria-hidden="true" />} checked={agentEnabled && !knowledgeOnly} disabled={knowledgeOnly}
                onChange={toggleAgent} title={knowledgeOnly ? "Unavailable while Knowledge only is on" : "Plan and complete multi-step tasks"} />
              <ModeToggle label="Free only" icon={<CircleDollarSign size={15} aria-hidden="true" />} checked={freeOnly}
                disabled={!preferencesLoaded || preferencesSaving || !!preferencesError} onChange={() => { void saveFreeOnly(!freeOnly); }}
                title="Use free models for interactive chat. Voice is unavailable. Scheduled tasks use paid models." />
              <ModeToggle label="Knowledge only" icon={<BookOpen size={15} aria-hidden="true" />} checked={knowledgeOnly}
                onChange={() => { if (!knowledgeOnly) exitVoiceLoop(); setKnowledgeOnly(!knowledgeOnly); }}
                title="Return saved source passages. Agent and thinking modes are unavailable." />
              {(preferencesSaving || !preferencesLoaded) && !preferencesError && <p role="status" className={chatModeStyles.feedback}>{preferencesSaving ? "Saving preference…" : "Loading preferences…"}</p>}
              {preferencesError && <div className={chatModeStyles.feedback} role="alert">{preferencesError.message}
                <button type="button" onClick={() => { if (preferencesError.attempted === undefined) void loadChatPreferences(); else void saveFreeOnly(preferencesError.attempted); }}>Retry</button>
              </div>}
              {providersLoading && <p role="status" className={chatModeStyles.feedback}>{providersLoaded ? "Refreshing chat models…" : "Loading chat models…"}</p>}
              {providersError && <div className={chatModeStyles.feedback} role="alert">{providersError} {providersLoaded && "Previously loaded models are still available."}
                <button type="button" disabled={providersLoading} onClick={() => void loadProviders()}>Retry models</button>
              </div>}
              {noFreeChatModel && !knowledgeOnly && !providersError && !providersLoading && <p role="status" className={chatModeStyles.feedback}>No free model is available. Configure a free provider or turn Free only off.</p>}
            </section>
            {compact && currentChatModel && <button type="button" className={ui.textButton} onClick={() => { setGenerationOpen(false); setModelInfoOpen(true); }}>
              <Info size={14} aria-hidden="true" /> Model details
            </button>}
            {!knowledgeOnly && <>
              <ParamRow label="Temperature" min={0} max={2} step={0.1} def={0.7} value={genParams.temperature} onChange={(v) => updateGenParams({ ...genParams, temperature: v })} />
              <ParamRow label="Top P" min={0} max={1} step={0.05} def={0.9} value={genParams.topP} onChange={(v) => updateGenParams({ ...genParams, topP: v })} />
              <ParamRow label="Max tokens" min={256} max={maxTokenCeiling} step={maxTokenStep} def={2048} value={genParams.maxTokens} onChange={(v) => updateGenParams({ ...genParams, maxTokens: v })} />
              <p style={styles.settingsNote}>
                Auto uses the selected model&apos;s provider default. Ceiling is {maxTokenCeiling.toLocaleString()} for {currentChatModel?.label ?? "this model"}.
              </p>
            </>}
            {providers.some((p) => p.embeddingModels.length > 0) && (
              <div style={styles.settingsEmbedRow}>
                <span style={styles.settingsEmbedLabel}>Embedding</span>
                <SelectMenu
                  wide
                  compact
                  ariaLabel="Embedding model"
                  icon={<Database size={14} aria-hidden="true" />}
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
          </GenerationSettings>
        )}
      </div>
    ) : null;

  const renderBubbleExtras = (quote: ChatMessage["replyTo"] | null, file?: { name?: string; mimeType?: string }) => <>
    {quote && (
      <div className={ui.replyQuote}>
        <strong>{quote.role === "user" ? "You" : "Zuychin"}</strong>
        <span>{quote.content}</span>
      </div>
    )}
    {file?.name && (
      <div className={ui.fileTag}>
        {getFileIcon(file.mimeType)}
        <span>{file.name}</span>
      </div>
    )}
  </>;

  const branchAction = (msg: ChatMessage) => <BranchMessageAction
    conversationId={session.key} messageId={msg.id} disabled={isLoading}
    onCreated={(branchId, parentId) => {
      void loadConversations();
      if (chats.get().key === parentId) void loadConversation(branchId);
    }}
  />;

  return (
    <div className={ui.app}>
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
            : `Delete “${deleteConfirm.title}”? Its conversations will move to No project.`}
          confirmLabel="Delete"
          busyText={pendingActions.includes(`delete:${deleteConfirm.id}`) ? "Deleting…" : undefined}
          onConfirm={() => { void confirmDeletion(); }}
          onCancel={() => { deleteConfirm.resolve(false); setDeleteConfirm(null); }}
        />
      )}

      <AppSidebar
        current="chat"
        hrefs={sidebarLinks}
        onNewChat={() => { void handleNewChat(); }}
        newChatDisabled={pendingActions.includes("new-chat")}
        search={chatSearch}
        onSearch={setChatSearch}
        docked={sidebar.docked}
        open={sidebar.open}
        onClose={sidebar.close}
      >
        <ConversationList
          conversations={conversations}
          projects={projects}
          activeConversationId={activeConversationId}
          loaded={convosLoaded}
          filter={chatSearch}
          runningConversationIds={chats.runningKeys()}
          deletingConversationIds={[...(deleteConfirm?.kind === "chat" ? [deleteConfirm.id] : []), ...pendingActions.filter((key) => key.startsWith("delete:")).map((key) => key.slice(7))]}
          onSelect={(id) => { void loadConversation(id); }}
          onDelete={handleDeleteConversation}
          onNewChat={(projectId) => { void handleNewChat(projectId); }}
          onUpdateProject={handleUpdateProject}
          onDeleteProject={handleDeleteProject}
          onMoveConversation={handleMoveConversation}
        />
        <NewProjectButton onCreate={handleCreateProject} />
      </AppSidebar>

      <div className={ui.main} inert={overlayOpen || undefined}>
        {sidebar.docked ? (
          <header className={ui.topbar} data-toggle={!sidebar.open || undefined}>
            {!sidebar.open && <SidebarToggle open={false} onToggle={() => sidebar.setOpen(true)} />}
            <div className={ui.crumbs}>
              {activeProject && <>
                <span className={ui.crumbProject}><Folder size={15} aria-hidden="true" /><span>{activeProject.name}</span></span>
                <span className={ui.slash} aria-hidden="true">/</span>
              </>}
              <h1 className={ui.crumbTitle} data-new={!activeConversationId || undefined}>{chatTitle}</h1>
            </div>
            <div className={ui.controls}>
              {renderModelSelectors(false)}
              <button
                type="button"
                role="switch"
                className={ui.agent}
                aria-checked={agentEnabled && !knowledgeOnly}
                disabled={knowledgeOnly}
                onClick={toggleAgent}
                title={knowledgeOnly ? "Unavailable while Knowledge only is on" : "Agent mode plans and completes multi-step tasks"}
              >
                <Bot size={16} aria-hidden="true" /><span>Agent</span><span className={ui.switch} aria-hidden="true" />
              </button>
              <span className={ui.vsep} aria-hidden="true" />
              <TodayToggle open={todayOpen} onToggle={toggleToday} due={dueCount} compact />
            </div>
          </header>
        ) : (
          <header className={ui.topbar} data-toggle>
            <SidebarToggle open={sidebar.open} onToggle={() => sidebar.setOpen(!sidebar.open)} />
            <div className={ui.titles}>
              <h1 className={ui.title} data-new={!activeConversationId || undefined}>{chatTitle}</h1>
              {activeProject && <p className={ui.subtitle}>{activeProject.name}</p>}
            </div>
            <TodayToggle open={todayOpen} onToggle={toggleToday} due={dueCount} />
            <button type="button" onClick={() => { void handleNewChat(); }} disabled={pendingActions.includes("new-chat")} className={ui.iconButton} aria-label="New chat" title="New chat">
              <SquarePen size={18} aria-hidden="true" />
            </button>
          </header>
        )}

        {actionError && (
          <div role="alert" className={ui.notice} data-tone="danger">
            <span>{actionError.message}</span>
            {actionError.retry && <button type="button" onClick={actionError.retry} className={ui.textButton}>Retry</button>}
            <button type="button" onClick={() => setActionError(null)} className={ui.iconButton} aria-label="Dismiss error"><X size={15} aria-hidden="true" /></button>
          </div>
        )}
        {chats.storageError && (
          <div role="alert" className={ui.notice} data-tone="danger">
            <span>{chats.storageError}</span>
            <button type="button" onClick={() => { void retryDraftStorage(); }} className={ui.textButton}>Save again</button>
          </div>
        )}
        {chats.runningKeys().some((key) => key !== session.key) && (
          <div role="status" className={ui.notice}>
            <span>A reply is still running in another chat.</span>
            <button type="button" className={ui.textButton} onClick={() => { const key = chats.runningKeys().find((id) => id !== session.key); if (key) void loadConversation(key); }}>
              Open it
            </button>
          </div>
        )}

        <div className={ui.threadWrap}>
          <main onScroll={handleMessagesScroll} className={ui.thread}>
            <div className={ui.column}>
              <BranchNavigation conversationId={session.key === NEW_CHAT ? null : session.key} onSelect={(id) => { void loadConversation(id); }} />
              {session.historyLoading && <p role="status" className={ui.status}>Loading conversation…</p>}
              {!session.loaded && !session.historyLoading && <p role="status" className={ui.status}>Load this conversation before sending a message. Your draft is safe.</p>}
              {messages.length === 0 && session.loaded && (
                <div className={ui.empty}>
                  <ZuychinMark size={34} className={ui.emptyMark} />
                  <h2>What should we work on?</h2>
                  <p>Ask about your day, your notes or what you are studying. Zuychin can plan, research and keep track of things for you.</p>
                  <DayStarters onFill={applySuggestion} />
                  <p className={ui.hint}>Type <kbd>/</kbd> for commands. Attach files up to {MAX_FILE_SIZE_MB} MB.</p>
                </div>
              )}

              {messages.map((msg) => msg.role === "user" ? (
                <div key={msg.id} className={ui.userRow}>
                  {msg.persisted && session.key !== NEW_CHAT && <span className={ui.hoverAction}>{branchAction(msg)}</span>}
                  <button type="button" onClick={() => startReply(msg)} className={`${ui.iconButton} ${ui.hoverAction}`} aria-label="Reply to this message" title="Reply to this message">
                    <Reply size={15} aria-hidden="true" />
                  </button>
                  <div className={ui.bubble}>
                    {renderBubbleExtras(msg.replyTo, { name: msg.fileName, mimeType: msg.fileMimeType })}
                    <p className={ui.bubbleText}>{msg.content}</p>
                  </div>
                </div>
              ) : (
                <article key={msg.id} className={ui.aiRow} aria-label="Zuychin">
                  <ZuychinMark size={18} className={ui.aiMark} />
                  <div className={ui.aiBody}>
                    {msg.replyTrace && <ReplyActivity trace={msg.replyTrace} />}
                    {msg.replyTo && renderBubbleExtras(msg.replyTo)}
                    <div className="markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={chatMarkdownComponents}>{msg.content}</ReactMarkdown>
                    </div>
                    {msg.artifacts && msg.artifacts.length > 0 && (
                      <div className={ui.artifactRow}>
                        {msg.artifacts.map((art) => (
                          <button key={art.id} type="button" onClick={() => downloadArtifact(art)} className={ui.artifactChip} title={`Download ${art.name}`}>
                            {getArtifactIcon(art.kind)}
                            <span>{art.name}</span>
                            <span className={ui.artifactSize}>{formatBytes(art.size)}</span>
                            <Download size={14} aria-hidden="true" />
                          </button>
                        ))}
                      </div>
                    )}
                    {msg.councilProposal && <CouncilProposalCard proposal={msg.councilProposal} />}
                    {!!msg.replyTrace?.sources?.length && <SourceChart sources={msg.replyTrace.sources} vaultHref={vaultHref} cosmosHref={cosmosHrefFor(msg.replyTrace.sources)} />}
                    <div className={ui.msgActions}>
                      {msg.resume && (
                        <button type="button" onClick={() => handleSubmit(null, msg.resume)} className={ui.textButton} disabled={isLoading} title="Relaunch this run. The agent continues from its recorded progress.">
                          <RotateCcw size={14} aria-hidden="true" /> Resume run
                        </button>
                      )}
                      {msg.retry && (
                        <button type="button" onClick={() => void handleRetry(msg)} className={ui.textButton} disabled={isLoading} title="Send this message again">
                          <RotateCcw size={14} aria-hidden="true" /> Retry
                        </button>
                      )}
                      {!msg.resume && !msg.retry && (
                        <button type="button" onClick={() => startReply(msg)} className={ui.iconButton} aria-label="Reply to this message" title="Reply to this message">
                          <Reply size={15} aria-hidden="true" />
                        </button>
                      )}
                      {!msg.retry && msg.content.length > 80 && <>
                        <button
                          type="button"
                          onClick={() => setExportMenuFor(exportMenuFor === msg.id ? null : msg.id)}
                          className={ui.iconButton}
                          aria-label="Download this reply as a document"
                          title="Download as a document"
                          aria-expanded={exportMenuFor === msg.id}
                        >
                          <Download size={15} aria-hidden="true" />
                        </button>
                        {exportMenuFor === msg.id && <span className={ui.exportFormats}>
                          {(["docx", "pdf", "md"] as const).map((fmt) => (
                            <button key={fmt} type="button" onClick={() => { handleExport(msg.content, fmt); setExportMenuFor(null); }} title={`Download as ${fmt.toUpperCase()}`}>
                              {fmt.toUpperCase()}
                            </button>
                          ))}
                        </span>}
                      </>}
                      {msg.persisted && session.key !== NEW_CHAT && !msg.retry && !msg.resume && branchAction(msg)}
                      {(msg.modelLabel || msgClock(msg.at)) && <span className={ui.msgMeta}>{[msg.modelLabel, msgClock(msg.at)].filter(Boolean).join(" · ")}</span>}
                    </div>
                  </div>
                </article>
              ))}

              {isLoading && (
                <article className={ui.aiRow} aria-label="Zuychin is replying">
                  <ZuychinMark size={18} className={ui.aiMark} />
                  <div className={ui.aiBody}>
                    {agentRun ? (
                      <div className={ui.agentRun} role="status">
                        <div className={ui.agentHead}>
                          <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                          <span>{agentRun.status || "Working…"}</span>
                        </div>
                        {agentRun.steps.length > 0 && (
                          <ol className={ui.agentSteps}>
                            {agentRun.steps.map((s, i) => (
                              <li key={i} data-status={s.status}>
                                {s.status === "done" ? <Check size={14} aria-hidden="true" /> : s.status === "in_progress" ? <ChevronRight size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}
                                <span>{s.title}</span>
                              </li>
                            ))}
                          </ol>
                        )}
                        {agentRun.lines.slice(-4).map((l, i) => (
                          <div key={i} className={ui.agentLine}>{l}</div>
                        ))}
                      </div>
                    ) : (
                      <div className={ui.typing} role="status" aria-label={thinkingEnabled ? "Thinking" : "Replying"}>
                        <i className="animate-typing-dot" />
                        <i className="animate-typing-dot-2" />
                        <i className="animate-typing-dot-3" />
                        {thinkingEnabled && <span>Thinking it through…</span>}
                      </div>
                    )}
                  </div>
                </article>
              )}

              {queuedView.length > 0 && !isLoading && (
                <div role="status" className={ui.queuedNote}>
                  <span>Queued messages are paused.</span>
                  <button type="button" className={ui.textButton} disabled={preferencesBlocked} onClick={() => resumeQueue(chats.get())}>Send next</button>
                </div>
              )}
              {queuedView.map((q) => (
                <div key={q.id} className={ui.userRow} data-queued>
                  <button type="button" onClick={() => removeQueued(q.id)} className={ui.iconButton} aria-label="Remove queued message" title="Remove queued message">
                    <X size={15} aria-hidden="true" />
                  </button>
                  <div className={ui.bubble}>
                    {renderBubbleExtras(null, q.payload.file ? { name: q.payload.file.name, mimeType: q.payload.file.mimeType } : undefined)}
                    <p className={ui.bubbleText}>{q.payload.text || (q.payload.file ? `[Sent ${q.payload.file.name}]` : "")}</p>
                    <div className={ui.bubbleMeta}>Queued</div>
                  </div>
                </div>
              ))}

              <div ref={messagesEndRef} />
            </div>
          </main>

          {showScrollBtn && (
            <button type="button" onClick={scrollToBottom} className={`${ui.scrollDown} animate-fade-in`} aria-label="Scroll to latest message" title="Jump to latest">
              <ArrowDown size={16} aria-hidden="true" />
            </button>
          )}
        </div>

        <footer className={ui.composerWrap}>
          <div className={ui.composerStack}>
            {voiceLoop && (
              <div className={ui.chip} data-tone="live">
                {isRecording ? <Mic size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
                <strong>Voice chat{isRecording ? ", listening" : speakingId ? ", speaking" : isLoading ? ", thinking" : ""}</strong>
                <span>Say &ldquo;Zuychin, stop&rdquo; to end</span>
                <button type="button" onClick={exitVoiceLoop} className={ui.iconButton} aria-label="End voice chat" title="End voice chat">
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            )}

            {replyTo && (
              <div className={ui.chip}>
                <Reply size={14} aria-hidden="true" />
                <strong>Replying to {replyTo.role === "user" ? "you" : "Zuychin"}</strong>
                <span>{replyTo.content}</span>
                <button type="button" onClick={() => setReplyTo(null)} className={ui.iconButton} aria-label="Cancel reply">
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            )}

            {pendingFile && (
              <div className={ui.chip}>
                {getFileIcon(pendingFile.mimeType)}
                <strong>{pendingFile.name}</strong>
                <span>{(pendingFile.size / 1024).toFixed(0)} KB</span>
                <button type="button" onClick={() => setPendingFile(null)} className={ui.iconButton} aria-label="Remove file">
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            )}

            {slashMatches.length > 0 && (
              <div id="chat-command-list" role="listbox" aria-label="Commands" className={`${ui.cmdMenu} animate-fade-in-scale`}>
                {slashMatches.map((c, i) => (
                  <button
                    key={c.id}
                    type="button"
                    id={`chat-command-${i}`}
                    role="option"
                    aria-selected={i === cmdSel}
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyCommand(c)}
                    onMouseEnter={() => setCmdIndex(i)}
                    className={ui.cmdItem}
                  >
                    <span className={ui.cmdUsage}>{c.usage}</span>
                    <span className={ui.cmdDesc}>{c.description}</span>
                  </button>
                ))}
              </div>
            )}

            {!knowledgeOnly && providersLoading && !providersLoaded && <p className={chatModeStyles.feedback} role="status">Loading chat models…</p>}
            {!knowledgeOnly && providersError && <div className={chatModeStyles.composerError} role="alert">
              <span>{providersError} {providersLoaded && "Previously loaded models are still available."}</span>
              <button type="button" disabled={providersLoading} onClick={() => void loadProviders()}>Retry models</button>
            </div>}
            {(preferencesError || (noFreeChatModel && !knowledgeOnly && !providersError && !providersLoading)) && <div className={chatModeStyles.composerError} role="status">
              <span>{preferencesError ? "Chat preferences need attention." : "No free chat model is available."}</span>
              <button type="button" onClick={() => setGenerationOpen(true)}>Open settings</button>
            </div>}

            <form onSubmit={handleSubmit} className={ui.composer}>
              <input ref={fileInputRef} type="file" onChange={handleFileSelect} hidden accept={UPLOAD_ACCEPT} />
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleTextareaChange}
                onKeyDown={handleKeyDown}
                aria-label={knowledgeOnly ? "Search your saved sources" : "Message Zuychin"}
                aria-autocomplete="list"
                aria-controls={slashMatches.length ? "chat-command-list" : undefined}
                aria-activedescendant={slashMatches.length ? `chat-command-${cmdSel}` : undefined}
                placeholder={knowledgeOnly ? "Search your saved sources" : "Message Zuychin"}
                rows={1}
              />
              <div className={ui.tools}>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className={ui.iconButton}
                  aria-label="Attach file"
                  disabled={knowledgeOnly}
                  title={knowledgeOnly ? "Turn Knowledge only off to attach files" : "Attach file"}
                >
                  <Paperclip size={18} aria-hidden="true" />
                </button>
                {canThink && !knowledgeOnly && (
                  <button
                    type="button"
                    onClick={toggleThinking}
                    className={ui.iconButton}
                    aria-pressed={thinkingEnabled}
                    aria-label="Deep thinking"
                    title={thinkingEnabled ? "Deep thinking is on" : "Deep thinking is off"}
                  >
                    <Brain size={18} aria-hidden="true" />
                  </button>
                )}
                {!sidebar.docked && <div className={ui.toolsModels}>{renderModelSelectors(true)}</div>}
                <span className={ui.spacer} />
                <button
                  type="button"
                  onClick={toggleRecording}
                  disabled={knowledgeOnly || freeOnly || preferencesBlocked || !session.loaded || session.historyLoading}
                  className={ui.iconButton}
                  data-live={isRecording || undefined}
                  aria-label={isRecording ? "Send what was captured" : "Start a voice chat"}
                  title={freeOnly ? "Voice is unavailable with Free only" : preferencesBlocked ? "Load or save your chat preference before recording" : knowledgeOnly ? "Turn Knowledge only off to record audio" : isRecording ? "Send what was captured (silence sends automatically)" : "Start a voice chat. Replies are spoken; say “Zuychin, stop” to end."}
                >
                  <Mic size={18} aria-hidden="true" />
                </button>
                {isLoading && (
                  <button
                    type="button"
                    onClick={handleCancel}
                    className={ui.stop}
                    aria-label={queuedView.length ? "Stop generating and clear queued messages" : "Stop generating"}
                    title={queuedView.length ? "Stop generating and clear queued messages" : "Stop generating"}
                  >
                    <Square size={12} fill="currentColor" aria-hidden="true" />
                  </button>
                )}
                <button
                  type="submit"
                  disabled={sendDisabled}
                  className={ui.send}
                  aria-label={isLoading ? "Queue message" : "Send message"}
                  title={isLoading ? "Queue message (sends after the current reply)" : "Send message"}
                >
                  <ArrowUp size={18} strokeWidth={2.25} aria-hidden="true" />
                </button>
              </div>
            </form>
          </div>
        </footer>
      </div>

      {todayOpen && <TodayPanel variant={todayDocked ? "docked" : "sheet"} onClose={closeToday} refreshToken={todayRefresh} onDueCount={setDueCount} />}
    </div>
  );
}
