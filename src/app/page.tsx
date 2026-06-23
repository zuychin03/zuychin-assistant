"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Bot, User, Plus, MessageSquare, Trash2, History, X, Paperclip, FileText, Image as ImageIcon, Music, Video, File, Brain, LogOut, Download, ChevronDown, Check, SlidersHorizontal, Cpu, Database, Sun, Moon } from "lucide-react";
import { ALL_SUPPORTED_MIME_TYPES, MAX_FILE_SIZE_MB, MAX_FILE_SIZE_BYTES } from "@/lib/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  fileName?: string;
  fileMimeType?: string;
}

interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

interface ProviderModel {
  id: string;
  label: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsThinking?: boolean;
  supportsSearch?: boolean;
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

// Custom dropdown with provider-grouped options (replaces native <select>).
function SelectMenu({
  icon, groups, value, onChange, ariaLabel, align = "left", compact = false,
}: {
  icon: React.ReactNode;
  groups: { label: string; options: { value: string; label: string }[] }[];
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  align?: "left" | "right";
  compact?: boolean;
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
    <div ref={ref} style={{ ...dropdown.wrap, ...(compact ? { flex: 1, maxWidth: "none" } : {}) }}>
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
          style={{ flexShrink: 0, opacity: 0.5, transform: open ? "rotate(180deg)" : "none", transition: "transform .18s ease" }}
        />
      </button>
      {open && (
        <div
          style={{ ...dropdown.menu, ...(align === "right" ? { right: 0 } : { left: 0 }) }}
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

// A single hyperparameter row: checkbox enables a custom value, else "Auto".
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

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<{ name: string; mimeType: string; base64: string; size: number } | null>(null);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  // "providerId::modelId" for chat; embedding model id for embeddings.
  const [chatSel, setChatSel] = useState("");
  const [embedSel, setEmbedSel] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [genParams, setGenParams] = useState<GenParamsState>({ temperature: null, topP: null, maxTokens: null });
  const [theme, setTheme] = useState<"light" | "dark">("light");
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

  // Load conversations on mount
  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      const data = await res.json();
      if (data.conversations) {
        setConversations(data.conversations);
      }
    } catch (err) {
      console.error("Failed to load conversations:", err);
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Restore thinking toggle from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("zuychin-think-mode");
    if (saved === "true") setThinkingEnabled(true);
  }, []);

  // Sync theme state with the attribute set by the no-flash init script
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

  // Load available providers/models + restore saved selection
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

  // Restore generation hyperparameters
  useEffect(() => {
    try {
      const saved = localStorage.getItem("zuychin-gen-params");
      if (saved) setGenParams({ temperature: null, topP: null, maxTokens: null, ...JSON.parse(saved) });
    } catch { /* ignore */ }
  }, []);

  const updateGenParams = (next: GenParamsState) => {
    setGenParams(next);
    localStorage.setItem("zuychin-gen-params", JSON.stringify(next));
  };

  // Capabilities of the currently selected chat model
  const currentChatModel = (() => {
    const sep = chatSel.indexOf("::");
    if (sep === -1) return undefined;
    const pid = chatSel.slice(0, sep);
    const mid = chatSel.slice(sep + 2);
    return providers.find((p) => p.id === pid)?.chatModels.find((m) => m.id === mid);
  })();
  const canThink = !!currentChatModel?.supportsThinking;

  const toggleThinking = () => {
    setThinkingEnabled((prev) => {
      const next = !prev;
      localStorage.setItem("zuychin-think-mode", String(next));
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

  // Load messages for a conversation
  const loadConversation = async (convId: string) => {
    try {
      const res = await fetch(`/api/conversations?id=${convId}`);
      const data = await res.json();
      if (data.messages) {
        setMessages(
          data.messages.map((m: { id: string; role: string; content: string }) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
          }))
        );
      }
      setActiveConversationId(convId);
      setSidebarOpen(false);
    } catch (err) {
      console.error("Failed to load conversation:", err);
    }
  };

  // Create new conversation
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

  // Delete conversation
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

    // Auto-create conversation if none active
    let convId = activeConversationId;
    if (!convId) {
      try {
        const res = await fetch("/api/conversations", { method: "POST" });
        const data = await res.json();
        convId = data.id;
        setActiveConversationId(data.id);
      } catch {
        // proceed without conversation
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

    // Auto-resize textarea back to default
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessage.content,
          conversationId: convId,
          thinking: thinkingEnabled && canThink,
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

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to get response.");
      }

      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: data.reply,
      };

      setMessages((prev) => [...prev, assistantMessage]);
      // Refresh conversation list to update title
      await loadConversations();
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
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    // Auto-resize
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

  // File handling
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!ALL_SUPPORTED_MIME_TYPES.includes(file.type)) {
      alert(`Unsupported file type: ${file.type}\n\nSupported: images, audio, video, PDF, text/code files.`);
      return;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      alert(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max ${MAX_FILE_SIZE_MB} MB.`);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1]; // strip data:...;base64, prefix
      setPendingFile({
        name: file.name,
        mimeType: file.type,
        base64,
        size: file.size,
      });
    };
    reader.readAsDataURL(file);

    // Reset input so same file can be re-selected
    e.target.value = "";
  };

  const getFileIcon = (mimeType?: string) => {
    if (!mimeType) return <File size={14} />;
    if (mimeType.startsWith("image/")) return <ImageIcon size={14} />;
    if (mimeType.startsWith("audio/")) return <Music size={14} />;
    if (mimeType.startsWith("video/")) return <Video size={14} />;
    if (mimeType === "application/pdf") return <FileText size={14} />;
    return <FileText size={14} />;
  };

  const handleExport = async (content: string, format: "docx" | "pdf") => {
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

  const renderModelSelectors = (compact: boolean) =>
    providers.length > 0 ? (
      <>
        <SelectMenu
          compact={compact}
          ariaLabel="Chat model"
          icon={<Cpu size={14} color="var(--color-primary)" />}
          value={chatSel}
          onChange={handleChatSelChange}
          groups={providers.map((p) => ({
            label: p.label,
            options: p.chatModels.map((m) => ({ value: `${p.id}::${m.id}`, label: m.label })),
          }))}
        />
        {providers.some((p) => p.embeddingModels.length > 0) && (
          <SelectMenu
            compact={compact}
            align="right"
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
        )}
      </>
    ) : null;

  return (
    <div style={styles.wrapper}>
      {/* Sidebar overlay (mobile only) */}
      {!isDesktop && sidebarOpen && (
        <div
          style={styles.overlay}
          className="animate-overlay-in"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
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
          {conversations.length === 0 && (
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

      {/* Main Chat */}
      <div style={isDesktop ? styles.containerDesktop : styles.container}>
        {/* Header */}
        <header style={styles.header}>
          <div style={styles.headerContent}>
            <div style={styles.headerLeft}>
              <div style={styles.avatar} title="Zuychin">
                <Bot size={18} color="#fff" />
              </div>
              {isDesktop && (
                <div style={styles.brandText}>
                  <h1 style={styles.title}>Zuychin</h1>
                  <div style={styles.statusRow}>
                    <span style={styles.statusDot} className="animate-pulse-glow" />
                    <span style={styles.statusText}>Online</span>
                  </div>
                </div>
              )}

              {isDesktop && (
                <div style={styles.headerCenter}>
                  {renderModelSelectors(false)}
                </div>
              )}
            </div>

            <div style={styles.headerRight}>
              <button
                onClick={toggleTheme}
                style={styles.iconBtn}
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                title={theme === "dark" ? "Light mode" : "Dark mode"}
              >
                {theme === "dark"
                  ? <Sun size={19} color="var(--color-text-primary)" />
                  : <Moon size={19} color="var(--color-text-primary)" />}
              </button>
              <button onClick={handleNewChat} style={styles.iconBtn} aria-label="New conversation" title="New conversation">
                <Plus size={20} color="var(--color-text-primary)" />
              </button>
              <button onClick={() => setSidebarOpen(true)} style={styles.iconBtn} aria-label="Conversation history" title="History">
                <History size={19} color="var(--color-text-primary)" />
              </button>
            </div>
          </div>

          {!isDesktop && providers.length > 0 && (
            <div style={styles.headerSelectorsRow}>
              {renderModelSelectors(true)}
            </div>
          )}
        </header>

        {/* Messages */}
        <main style={isDesktop ? styles.messages : { ...styles.messages, padding: "16px 14px 8px" }}>
          {messages.length === 0 && (
            <div style={styles.emptyState} className="animate-fade-in-scale">
              <div style={styles.emptyIcon} className="animate-float">
                <Bot size={32} color="var(--color-text-muted)" />
              </div>
              <p style={styles.emptyTitle}>Hi, I&apos;m Zuychin</p>
              <p style={styles.emptySubtitle}>
                Your personal AI assistant. Ask me anything.
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
                  <Bot size={14} color="#fff" />
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
                <Bot size={14} color="#fff" />
              </div>
              <div style={{ ...styles.bubble, ...styles.aiBubble }}>
                <div style={styles.typingRow}>
                  <span style={styles.typingDot} className="animate-bounce-dot" />
                  <span style={styles.typingDot} className="animate-bounce-dot-2" />
                  <span style={styles.typingDot} className="animate-bounce-dot-3" />
                  {thinkingEnabled && (
                    <span style={styles.typingLabel}>Thinking deeply...</span>
                  )}
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </main>

        {/* Input */}
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

          <form onSubmit={handleSubmit} style={styles.inputRow}>
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleFileSelect}
              style={{ display: "none" }}
              accept="image/*,audio/*,video/*,.pdf,.txt,.csv,.js,.ts,.py,.json,.xml,.html,.css"
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
              <Send size={18} color="#fff" />
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
  },

  // Overlay
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0, 0, 0, 0.4)",
    backdropFilter: "blur(2px)",
    WebkitBackdropFilter: "blur(2px)",
    zIndex: 20,
  },

  // Sidebar (mobile: fixed overlay, slides in from the right)
  sidebar: {
    position: "fixed",
    top: 0,
    right: 0,
    bottom: 0,
    width: 280,
    background: "var(--color-surface)",
    borderLeft: "1px solid var(--color-border)",
    zIndex: 30,
    display: "flex",
    flexDirection: "column",
    transition: "transform 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
  },

  // Sidebar (desktop: static in-flow on the right, collapsible)
  sidebarDesktop: {
    order: 2,
    background: "var(--color-surface)",
    borderLeft: "1px solid var(--color-border)",
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    overflow: "hidden",
    transition: "width 0.25s cubic-bezier(0.23, 1, 0.32, 1), min-width 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
  },
  sidebarHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px",
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
    color: "#fff",
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

  // Main container (mobile)
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    flex: 1,
    maxWidth: 720,
    margin: "0 auto",
    background: "var(--color-background)",
    width: "100%",
  },

  // Main container (desktop: fills remaining space)
  containerDesktop: {
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    flex: 1,
    background: "var(--color-background)",
    width: "100%",
  },

  // Header
  header: {
    position: "sticky",
    top: 0,
    zIndex: 10,
    background: "var(--color-background)",
    borderBottom: "1px solid var(--color-border)",
  },
  headerContent: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "12px 16px",
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
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
  },
  headerSelectorsRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 12px 10px",
  },
  brandText: {
    display: "flex",
    flexDirection: "column",
    marginRight: 4,
    flexShrink: 0,
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
  avatar: {
    width: 34,
    height: 34,
    borderRadius: "50%",
    background: "var(--color-primary)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  title: {
    fontSize: 17,
    fontWeight: 600,
    letterSpacing: "-0.3px",
    color: "var(--color-text-primary)",
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: 5,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: "var(--color-success)",
  },
  statusText: {
    fontSize: 12,
    color: "var(--color-text-muted)",
  },

  // Messages
  messages: {
    flex: 1,
    overflowY: "auto",
    padding: "20px 24px 8px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    maxWidth: 900,
    width: "100%",
    margin: "0 auto",
  },

  // Empty state
  emptyState: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    opacity: 0.7,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: "50%",
    background: "var(--color-surface)",
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

  // Message Bubbles
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
    color: "#fff",
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

  // Typing indicator
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

  // Footer / Input
  footer: {
    position: "sticky",
    bottom: 0,
    background: "var(--color-background)",
    borderTop: "1px solid var(--color-border)",
    padding: "10px 24px calc(env(safe-area-inset-bottom, 0px) + 10px)",
    maxWidth: 900,
    width: "100%",
    margin: "0 auto",
  },

  // File preview strip
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

  // File tag in bubbles
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
    background: "var(--color-surface)",
    borderRadius: 24,
    padding: "8px 8px 8px 16px",
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
    width: 36,
    height: 36,
    borderRadius: "50%",
    background: "var(--color-primary)",
    border: "none",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "opacity 0.15s ease",
    flexShrink: 0,
  },

  // Export buttons
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

  // Generation settings panel
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
};

// Custom dropdown styling
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

// Hyperparameter row styling
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
    color: "#fff",
  },
  slider: {
    width: "100%",
    accentColor: "var(--color-primary)",
    cursor: "pointer",
  },
};
