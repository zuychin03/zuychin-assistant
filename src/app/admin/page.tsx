"use client";

import { useState, useEffect, useCallback } from "react";

interface BotStats {
    status: string;
    model: string;
    profile: { id: string; displayName: string } | null;
    stats: {
        totalMessages: number;
        totalEmbeddings: number;
        lastActivity: string | null;
        lastChannel: string | null;
        channelBreakdown: Record<string, number>;
    };
    uptime: number;
}

export default function AdminPage() {
    const [stats, setStats] = useState<BotStats | null>(null);
    const [systemPrompt, setSystemPrompt] = useState("");
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState("");
    const [loading, setLoading] = useState(true);

    const fetchStats = useCallback(async () => {
        try {
            const res = await fetch("/api/admin/status");
            const data = await res.json();
            setStats(data);
        } catch {
            setMessage("Failed to load stats.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchStats();
    }, [fetchStats]);

    const handleSavePrompt = async () => {
        if (!systemPrompt.trim()) return;
        setSaving(true);
        setMessage("");

        try {
            const res = await fetch("/api/admin/personality", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ systemPrompt }),
            });
            const data = await res.json();

            if (res.ok) {
                setMessage("✅ Personality updated!");
            } else {
                setMessage(`❌ ${data.error}`);
            }
        } catch {
            setMessage("❌ Failed to save.");
        } finally {
            setSaving(false);
        }
    };

    const formatUptime = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return `${h}h ${m}m`;
    };

    const formatDate = (dateStr: string | null) => {
        if (!dateStr) return "N/A";
        return new Date(dateStr).toLocaleString();
    };

    if (loading) {
        return (
            <div style={styles.container}>
                <div style={styles.loading}>Loading...</div>
            </div>
        );
    }

    return (
        <div style={styles.container}>
            <header style={styles.header}>
                <h1 style={styles.title}>Zuychin Admin</h1>
                <span
                    style={{
                        ...styles.badge,
                        backgroundColor: stats?.status === "online" ? "#22c55e" : "#ef4444",
                    }}
                >
                    {stats?.status ?? "unknown"}
                </span>
            </header>

            {/* Stats Grid */}
            <div style={styles.grid}>
                <div style={styles.card}>
                    <div style={styles.cardLabel}>Model</div>
                    <div style={styles.cardValue}>{stats?.model ?? "—"}</div>
                </div>
                <div style={styles.card}>
                    <div style={styles.cardLabel}>Messages</div>
                    <div style={styles.cardValue}>{stats?.stats.totalMessages ?? 0}</div>
                </div>
                <div style={styles.card}>
                    <div style={styles.cardLabel}>Memories</div>
                    <div style={styles.cardValue}>
                        {stats?.stats.totalEmbeddings ?? 0}
                    </div>
                </div>
                <div style={styles.card}>
                    <div style={styles.cardLabel}>Uptime</div>
                    <div style={styles.cardValue}>
                        {stats ? formatUptime(stats.uptime) : "—"}
                    </div>
                </div>
            </div>

            {/* Activity */}
            <div style={styles.section}>
                <h2 style={styles.sectionTitle}>Recent Activity</h2>
                <div style={styles.activityRow}>
                    <span style={styles.activityLabel}>Last Message:</span>
                    <span>{formatDate(stats?.stats.lastActivity ?? null)}</span>
                </div>
                <div style={styles.activityRow}>
                    <span style={styles.activityLabel}>Last Channel:</span>
                    <span style={styles.channelTag}>
                        {stats?.stats.lastChannel ?? "N/A"}
                    </span>
                </div>
            </div>

            {/* Channel Breakdown */}
            {stats?.stats.channelBreakdown &&
                Object.keys(stats.stats.channelBreakdown).length > 0 && (
                    <div style={styles.section}>
                        <h2 style={styles.sectionTitle}>Channels</h2>
                        <div style={styles.channelGrid}>
                            {Object.entries(stats.stats.channelBreakdown).map(
                                ([channel, count]) => (
                                    <div key={channel} style={styles.channelCard}>
                                        <div style={styles.channelName}>{channel}</div>
                                        <div style={styles.channelCount}>{count}</div>
                                    </div>
                                )
                            )}
                        </div>
                    </div>
                )}

            {/* Personality Editor */}
            <div style={styles.section}>
                <h2 style={styles.sectionTitle}>Bot Personality</h2>
                <textarea
                    style={styles.textarea}
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    placeholder="Enter the bot's system prompt / personality..."
                    rows={5}
                />
                <div style={styles.promptActions}>
                    <button
                        style={{
                            ...styles.saveButton,
                            opacity: saving ? 0.6 : 1,
                        }}
                        onClick={handleSavePrompt}
                        disabled={saving}
                    >
                        {saving ? "Saving..." : "Save Personality"}
                    </button>
                    {message && <span style={styles.message}>{message}</span>}
                </div>
            </div>

            {/* Refresh */}
            <button style={styles.refreshButton} onClick={fetchStats}>
                ↻ Refresh Stats
            </button>
        </div>
    );
}


const styles: Record<string, React.CSSProperties> = {
    container: {
        maxWidth: 720,
        margin: "0 auto",
        padding: "32px 20px",
        fontFamily: "'Inter', sans-serif",
        color: "#e5e5e5",
        backgroundColor: "#0a0a0a",
        minHeight: "100vh",
    },
    loading: {
        textAlign: "center",
        padding: "60px 0",
        color: "#888",
        fontSize: 14,
    },
    header: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 32,
        borderBottom: "1px solid #222",
        paddingBottom: 16,
    },
    title: {
        fontSize: 22,
        fontWeight: 600,
        color: "#fff",
        margin: 0,
    },
    badge: {
        padding: "4px 12px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        textTransform: "uppercase" as const,
    },
    grid: {
        display: "grid",
        gridTemplateColumns: "repeat(2, 1fr)",
        gap: 12,
        marginBottom: 28,
    },
    card: {
        backgroundColor: "#141414",
        border: "1px solid #222",
        borderRadius: 10,
        padding: "16px 18px",
    },
    cardLabel: {
        fontSize: 11,
        color: "#888",
        textTransform: "uppercase" as const,
        letterSpacing: "0.5px",
        marginBottom: 4,
    },
    cardValue: {
        fontSize: 18,
        fontWeight: 600,
        color: "#fff",
    },
    section: {
        backgroundColor: "#141414",
        border: "1px solid #222",
        borderRadius: 10,
        padding: "18px 20px",
        marginBottom: 16,
    },
    sectionTitle: {
        fontSize: 14,
        fontWeight: 600,
        color: "#ccc",
        marginTop: 0,
        marginBottom: 14,
        textTransform: "uppercase" as const,
        letterSpacing: "0.5px",
    },
    activityRow: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "6px 0",
        fontSize: 13,
        color: "#aaa",
    },
    activityLabel: {
        color: "#666",
    },
    channelTag: {
        backgroundColor: "#222",
        padding: "2px 10px",
        borderRadius: 4,
        fontSize: 12,
        color: "#ccc",
    },
    channelGrid: {
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
        gap: 8,
    },
    channelCard: {
        backgroundColor: "#1a1a1a",
        borderRadius: 8,
        padding: "12px 14px",
        textAlign: "center" as const,
    },
    channelName: {
        fontSize: 11,
        color: "#888",
        textTransform: "capitalize" as const,
        marginBottom: 4,
    },
    channelCount: {
        fontSize: 20,
        fontWeight: 700,
        color: "#fff",
    },
    textarea: {
        width: "100%",
        backgroundColor: "#0a0a0a",
        border: "1px solid #333",
        borderRadius: 8,
        padding: "12px 14px",
        color: "#e5e5e5",
        fontSize: 13,
        fontFamily: "'Inter', sans-serif",
        resize: "vertical" as const,
        outline: "none",
        boxSizing: "border-box" as const,
    },
    promptActions: {
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginTop: 12,
    },
    saveButton: {
        backgroundColor: "#fff",
        color: "#000",
        border: "none",
        borderRadius: 8,
        padding: "10px 20px",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
    },
    message: {
        fontSize: 12,
        color: "#aaa",
    },
    refreshButton: {
        width: "100%",
        backgroundColor: "transparent",
        border: "1px solid #333",
        borderRadius: 8,
        padding: "10px 0",
        color: "#888",
        fontSize: 13,
        cursor: "pointer",
        marginTop: 4,
    },
};
