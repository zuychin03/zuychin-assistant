"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Bot, User, Plus, MessageSquare, Trash2, Menu, X, Paperclip, FileText, Image, Music, Video, File, Brain, LogOut } from "lucide-react";
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
          thinking: thinkingEnabled,
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
    if (mimeType.startsWith("image/")) return <Image size={14} />;
    if (mimeType.startsWith("audio/")) return <Music size={14} />;
    if (mimeType.startsWith("video/")) return <Video size={14} />;
    if (mimeType === "application/pdf") return <FileText size={14} />;
    return <FileText size={14} />;
  };

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
          ...(!isDesktop && { transform: sidebarOpen ? "translateX(0)" : "translateX(-100%)" }),
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
              <button
                onClick={() => setSidebarOpen(true)}
                style={styles.menuBtn}
                aria-label="Open sidebar"
              >
                <Menu size={20} color="var(--color-text-primary)" />
              </button>
              <div style={styles.avatar}>
                <Bot size={20} color="#fff" />
              </div>
              <div>
                <h1 style={styles.title}>Zuychin</h1>
                <div style={styles.statusRow}>
                  <span style={styles.statusDot} className="animate-pulse-glow" />
                  <span style={styles.statusText}>Online</span>
                </div>
              </div>
            </div>
            <button onClick={handleNewChat} style={styles.headerNewBtn} aria-label="New chat">
              <Plus size={20} color="var(--color-text-primary)" />
            </button>
          </div>
        </header>

        {/* Messages */}
        <main style={styles.messages}>
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
        <footer style={styles.footer}>
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
            <button
              type="button"
              onClick={toggleThinking}
              style={{
                ...styles.attachBtn,
                color: thinkingEnabled ? "var(--color-primary)" : "var(--color-text-muted)",
                opacity: thinkingEnabled ? 1 : 0.5,
              }}
              aria-label={thinkingEnabled ? "Disable deep thinking" : "Enable deep thinking"}
              title={thinkingEnabled ? "Think mode ON" : "Think mode OFF"}
            >
              <Brain size={18} color={thinkingEnabled ? "var(--color-primary)" : "var(--color-text-muted)"} />
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

  // Sidebar (mobile — fixed overlay)
  sidebar: {
    position: "fixed",
    top: 0,
    left: 0,
    bottom: 0,
    width: 280,
    background: "var(--color-surface)",
    borderRight: "1px solid var(--color-border)",
    zIndex: 30,
    display: "flex",
    flexDirection: "column",
    transition: "transform 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
  },

  // Sidebar (desktop — static in-flow, collapsible)
  sidebarDesktop: {
    background: "var(--color-surface)",
    borderRight: "1px solid var(--color-border)",
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

  // Main container (desktop — fills remaining space)
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
    padding: "14px 16px",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  menuBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 4,
    display: "flex",
  },
  headerNewBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 4,
    display: "flex",
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: "50%",
    background: "var(--color-primary)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
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
    background: "#f0f0f5",
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
};
