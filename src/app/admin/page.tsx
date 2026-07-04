"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import RunsPanel from "./runs-panel";
import MemoriesPanel from "./memories-panel";
import {
    Activity, Bot, Brain, CheckCircle2, Clock, Database, FileText,
    GitBranch, MessageSquare, RefreshCw, Save, ShieldCheck,
    Sparkles, Wifi, XCircle,
} from "lucide-react";

interface BotStats {
    status: string;
    model: string;
    profile: { id: string; displayName: string; systemPrompt?: string } | null;
    stats: {
        totalMessages: number;
        totalEmbeddings: number;
        totalConversations: number;
        totalTodos: number;
        pendingTodos: number;
        totalArtifacts: number;
        totalVaultPages: number;
        lastActivity: string | null;
        lastChannel: string | null;
        channelBreakdown: Record<string, number>;
    };
    integrations: Record<string, boolean>;
    uptime: number;
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

interface ProvidersPayload {
    providers: ProviderInfo[];
}

interface VaultHealth {
    ok: boolean;
    message?: string;
    repo?: string;
    branch?: string;
}

export default function AdminPage() {
    const [stats, setStats] = useState<BotStats | null>(null);
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [vaultHealth, setVaultHealth] = useState<VaultHealth | null>(null);
    const [systemPrompt, setSystemPrompt] = useState("");
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState("");
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [isNarrow, setIsNarrow] = useState(false);

    useEffect(() => {
        const check = () => setIsNarrow(window.innerWidth < 640);
        check();
        window.addEventListener("resize", check);
        return () => window.removeEventListener("resize", check);
    }, []);

    const fetchStats = useCallback(async () => {
        setRefreshing(true);
        try {
            const [statusRes, providersRes, vaultRes] = await Promise.all([
                fetch("/api/admin/status"),
                fetch("/api/providers"),
                fetch("/api/vault/health").catch(() => null),
            ]);

            const statusData = await statusRes.json();
            setStats(statusData);
            setSystemPrompt((current) => current || statusData.profile?.systemPrompt || "");

            if (providersRes.ok) {
                const providerData = (await providersRes.json()) as ProvidersPayload;
                setProviders(providerData.providers ?? []);
            }

            if (vaultRes) {
                const health = await vaultRes.json();
                setVaultHealth(health);
            }
        } catch {
            setMessage("Failed to load stats.");
        } finally {
            setLoading(false);
            setRefreshing(false);
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
                setMessage("Personality updated.");
                fetchStats();
            } else {
                setMessage(data.error ?? "Failed to save.");
            }
        } catch {
            setMessage("Failed to save.");
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
        if (!dateStr) return "No activity yet";
        return new Date(dateStr).toLocaleString();
    };

    const availableProviders = providers.filter((p) => p.available);
    const chatModelCount = availableProviders.reduce((sum, p) => sum + p.chatModels.length, 0);
    const embeddingModelCount = availableProviders.reduce((sum, p) => sum + p.embeddingModels.length, 0);
    const channels = stats?.stats.channelBreakdown ?? {};
    const topChannelCount = Math.max(1, ...Object.values(channels));

    if (loading) {
        return (
            <div style={styles.shell}>
                <div style={styles.loadingCard}>
                    <RefreshCw size={22} className="animate-spin" />
                    <span>Loading admin dashboard...</span>
                </div>
            </div>
        );
    }

    return (
        <div style={styles.shell}>
            <div style={styles.ambientOne} />
            <div style={styles.ambientTwo} />

            <header style={styles.header}>
                <div>
                    <div style={styles.kicker}>Control Center</div>
                    <h1 style={styles.title}>Zuychin Admin</h1>
                    <p style={styles.subtitle}>
                        Monitor the assistant, model providers, memory, vault and channel activity from one place.
                    </p>
                </div>
                <div style={styles.headerActions}>
                    <span style={{ ...styles.statusPill, ...(stats?.status === "online" ? styles.statusGood : styles.statusBad) }}>
                        <Wifi size={13} /> {stats?.status ?? "unknown"}
                    </span>
                    <button style={styles.refreshButton} onClick={fetchStats} disabled={refreshing}>
                        <RefreshCw size={14} className={refreshing ? "animate-spin" : undefined} />
                        Refresh
                    </button>
                </div>
            </header>

            <section style={{ ...styles.hero, ...(isNarrow ? styles.heroNarrow : {}) }}>
                <div style={styles.heroMain}>
                    <div style={styles.heroIcon}><Bot size={22} /></div>
                    <div style={{ minWidth: 0 }}>
                        <div style={styles.heroLabel}>Default chat model</div>
                        <div style={styles.heroTitle}>{stats?.model ?? "Unknown"}</div>
                        <div style={styles.heroMeta}>
                            Profile: {stats?.profile?.displayName ?? "No profile"} · Uptime {stats ? formatUptime(stats.uptime) : "—"}
                        </div>
                    </div>
                </div>
                <div style={{ ...styles.quickActions, ...(isNarrow ? { justifyContent: "flex-start" } : {}) }}>
                    <Link href="/" style={styles.quickLink}><MessageSquare size={15} /> Chat</Link>
                    <Link href="/graph" style={styles.quickLink}><GitBranch size={15} /> Graph</Link>
                    <a href="/api/vault/health" style={styles.quickLink}><ShieldCheck size={15} /> Vault health</a>
                    <a href="/api/telegram/test" style={styles.quickLink}><Activity size={15} /> Telegram test</a>
                </div>
            </section>

            <div style={styles.metricGrid}>
                <MetricCard icon={<MessageSquare size={18} />} label="Messages" value={stats?.stats.totalMessages ?? 0} note={`Last: ${stats?.stats.lastChannel ?? "none"}`} />
                <MetricCard icon={<Brain size={18} />} label="Memories" value={stats?.stats.totalEmbeddings ?? 0} note={`${embeddingModelCount} embedding model${embeddingModelCount === 1 ? "" : "s"} available`} />
                <MetricCard icon={<Database size={18} />} label="Conversations" value={stats?.stats.totalConversations ?? 0} note={formatDate(stats?.stats.lastActivity ?? null)} />
                <MetricCard icon={<FileText size={18} />} label="Artifacts" value={stats?.stats.totalArtifacts ?? 0} note="Generated files" />
                <MetricCard icon={<GitBranch size={18} />} label="Vault Pages" value={stats?.stats.totalVaultPages ?? 0} note={vaultHealth?.ok ? "Vault connected" : "Check vault setup"} />
                <MetricCard icon={<CheckCircle2 size={18} />} label="Pending Notes" value={stats?.stats.pendingTodos ?? 0} note={`${stats?.stats.totalTodos ?? 0} total checklist items`} />
            </div>

            <div style={styles.layoutGrid}>
                <section style={styles.panel}>
                    <PanelHeader title="Provider Status" description={`${availableProviders.length}/${providers.length || 0} providers configured`} icon={<Sparkles size={16} />} />
                    <div style={styles.providerList}>
                        {providers.map((provider) => (
                            <div key={provider.id} style={styles.providerRow}>
                                <div style={styles.providerHead}>
                                    <span style={styles.providerName}>{provider.label}</span>
                                    <span style={{ ...styles.smallPill, ...(provider.available ? styles.pillGood : styles.pillMuted) }}>
                                        {provider.available ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                                        {provider.available ? "Ready" : "Missing key"}
                                    </span>
                                </div>
                                <div style={styles.providerMeta}>
                                    {provider.chatModels.length} chat · {provider.embeddingModels.length} embedding
                                </div>
                            </div>
                        ))}
                        {providers.length === 0 && <div style={styles.emptyText}>No providers loaded.</div>}
                    </div>
                </section>

                <section style={styles.panel}>
                    <PanelHeader title="Integrations" description="Configured from environment variables" icon={<ShieldCheck size={16} />} />
                    <div style={styles.integrationGrid}>
                        {Object.entries(stats?.integrations ?? {}).map(([name, enabled]) => (
                            <div key={name} style={styles.integrationItem}>
                                <span style={{ ...styles.dot, background: enabled ? "#31d07f" : "#5f6368" }} />
                                <span style={styles.integrationName}>{name}</span>
                                <span style={enabled ? styles.integrationOn : styles.integrationOff}>{enabled ? "on" : "off"}</span>
                            </div>
                        ))}
                    </div>
                    <div style={styles.vaultBox}>
                        <div style={styles.vaultTitle}>Vault</div>
                        <div style={styles.vaultMessage}>
                            {vaultHealth?.ok ? "Connected and ready." : vaultHealth?.message ?? "Vault health unavailable."}
                        </div>
                        {vaultHealth?.repo && <div style={styles.vaultMeta}>{vaultHealth.repo}{vaultHealth.branch ? ` · ${vaultHealth.branch}` : ""}</div>}
                    </div>
                </section>

                <section style={styles.panel}>
                    <PanelHeader title="Channel Activity" description="Message distribution by channel" icon={<Activity size={16} />} />
                    <div style={styles.channelList}>
                        {Object.entries(channels).map(([channel, count]) => (
                            <div key={channel} style={styles.channelRow}>
                                <div style={styles.channelTop}>
                                    <span style={styles.channelName}>{channel}</span>
                                    <span style={styles.channelCount}>{count}</span>
                                </div>
                                <div style={styles.barTrack}>
                                    <div style={{ ...styles.barFill, width: `${Math.max(8, (count / topChannelCount) * 100)}%` }} />
                                </div>
                            </div>
                        ))}
                        {Object.keys(channels).length === 0 && <div style={styles.emptyText}>No channel activity yet.</div>}
                    </div>
                </section>

                <section style={styles.panel}>
                    <PanelHeader title="Current Capabilities" description={`${chatModelCount} chat models available`} icon={<Clock size={16} />} />
                    <div style={styles.capabilityList}>
                        <Capability label="Agent mode" enabled note="Plans, skills, sub-agents and artifacts" />
                        <Capability label="RAG memory" enabled note="Model-aware pgvector partitions" />
                        <Capability label="Second brain" enabled={!!vaultHealth?.ok} note="GitHub wiki vault + graph" />
                        <Capability label="Gmail/Calendar tools" enabled={!!stats?.integrations.google} note="OAuth-backed personal tools" />
                        <Capability label="External channels" enabled={!!(stats?.integrations.discord || stats?.integrations.telegram)} note="Discord and Telegram entry points" />
                    </div>
                </section>

                <section style={styles.panel}>
                    <RunsPanel />
                </section>

                <section style={styles.panel}>
                    <MemoriesPanel />
                </section>
            </div>

            <section style={styles.promptPanel}>
                <div style={styles.promptHeader}>
                    <PanelHeader title="Assistant Personality" description="System prompt used by the chat pipeline across channels" icon={<Bot size={16} />} />
                    <span style={styles.charCount}>{systemPrompt.length}/5000</span>
                </div>
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
                        {saving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
                        {saving ? "Saving..." : "Save Personality"}
                    </button>
                    {message && <span style={styles.message}>{message}</span>}
                </div>
            </section>
        </div>
    );
}

function MetricCard({ icon, label, value, note }: {
    icon: React.ReactNode;
    label: string;
    value: number | string;
    note: string;
}) {
    return (
        <div style={styles.metricCard}>
            <div style={styles.metricIcon}>{icon}</div>
            <div style={styles.cardLabel}>{label}</div>
            <div style={styles.cardValue}>{value}</div>
            <div style={styles.cardNote}>{note}</div>
        </div>
    );
}

function PanelHeader({ title, description, icon }: {
    title: string;
    description: string;
    icon: React.ReactNode;
}) {
    return (
        <div style={styles.panelHeader}>
            <div style={styles.panelIcon}>{icon}</div>
            <div>
                <h2 style={styles.sectionTitle}>{title}</h2>
                <p style={styles.sectionDescription}>{description}</p>
            </div>
        </div>
    );
}

function Capability({ label, enabled, note }: { label: string; enabled: boolean; note: string }) {
    return (
        <div style={styles.capabilityRow}>
            <span style={{ ...styles.smallPill, ...(enabled ? styles.pillGood : styles.pillMuted) }}>
                {enabled ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                {enabled ? "Ready" : "Off"}
            </span>
            <div>
                <div style={styles.capabilityTitle}>{label}</div>
                <div style={styles.capabilityNote}>{note}</div>
            </div>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    shell: {
        position: "relative",
        minHeight: "100vh",
        overflow: "hidden",
        maxWidth: 1240,
        margin: "0 auto",
        padding: "36px 24px 56px",
        fontFamily: "var(--font-family)",
        color: "var(--color-text-primary)",
        background: "radial-gradient(circle at 12% 0%, color-mix(in srgb, var(--color-secondary) 18%, transparent), transparent 30%), radial-gradient(circle at 95% 20%, color-mix(in srgb, #7aa2ff 13%, transparent), transparent 28%), var(--color-background)",
    },
    ambientOne: {
        position: "fixed",
        width: 520,
        height: 520,
        top: -180,
        left: -160,
        borderRadius: "50%",
        background: "color-mix(in srgb, var(--color-secondary) 18%, transparent)",
        filter: "blur(90px)",
        pointerEvents: "none",
    },
    ambientTwo: {
        position: "fixed",
        width: 460,
        height: 460,
        right: -160,
        top: 80,
        borderRadius: "50%",
        background: "color-mix(in srgb, #7aa2ff 14%, transparent)",
        filter: "blur(95px)",
        pointerEvents: "none",
    },
    loadingCard: {
        minHeight: "70vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        color: "var(--color-text-muted)",
    },
    header: {
        position: "relative",
        zIndex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 20,
        marginBottom: 22,
    },
    kicker: {
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: 1.2,
        textTransform: "uppercase",
        color: "var(--color-text-muted)",
        marginBottom: 6,
    },
    title: {
        fontSize: 34,
        lineHeight: 1.05,
        fontWeight: 850,
        letterSpacing: "-0.05em",
        margin: 0,
    },
    subtitle: {
        maxWidth: 640,
        margin: "10px 0 0",
        color: "var(--color-text-muted)",
        fontSize: 14,
        lineHeight: 1.55,
    },
    headerActions: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" },
    statusPill: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 11px",
        borderRadius: 999,
        fontSize: 12.5,
        fontWeight: 750,
    },
    statusGood: { color: "#31d07f", background: "color-mix(in srgb, #31d07f 13%, transparent)", border: "1px solid color-mix(in srgb, #31d07f 28%, transparent)" },
    statusBad: { color: "#ff6b5a", background: "color-mix(in srgb, #ff6b5a 12%, transparent)", border: "1px solid color-mix(in srgb, #ff6b5a 28%, transparent)" },
    hero: {
        position: "relative",
        zIndex: 1,
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 18,
        alignItems: "center",
        padding: 20,
        borderRadius: 28,
        background: "linear-gradient(135deg, color-mix(in srgb, var(--color-surface) 94%, transparent), color-mix(in srgb, var(--color-surface) 74%, transparent))",
        border: "1px solid color-mix(in srgb, var(--color-border) 68%, transparent)",
        boxShadow: "0 24px 80px rgba(0, 0, 0, 0.24)",
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        marginBottom: 16,
    },
    heroNarrow: {
        gridTemplateColumns: "1fr",
        gap: 14,
    },
    heroMain: { display: "flex", alignItems: "center", gap: 15, minWidth: 0 },
    heroIcon: {
        width: 48,
        height: 48,
        flexShrink: 0,
        borderRadius: 18,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--color-background)",
        background: "var(--color-text-primary)",
    },
    heroLabel: { fontSize: 11, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 750 },
    heroTitle: { fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", marginTop: 2, overflowWrap: "anywhere" },
    heroMeta: { color: "var(--color-text-muted)", fontSize: 13, marginTop: 4 },
    quickActions: { display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" },
    quickLink: {
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "9px 11px",
        borderRadius: 14,
        textDecoration: "none",
        color: "var(--color-text-primary)",
        background: "color-mix(in srgb, var(--color-background) 58%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 62%, transparent)",
        fontSize: 12.5,
        fontWeight: 650,
    },
    metricGrid: {
        position: "relative",
        zIndex: 1,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
        gap: 12,
        marginBottom: 16,
    },
    metricCard: {
        padding: 16,
        borderRadius: 22,
        background: "color-mix(in srgb, var(--color-surface) 86%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 66%, transparent)",
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
    },
    metricIcon: {
        width: 34,
        height: 34,
        borderRadius: 13,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        marginBottom: 12,
        color: "var(--color-text-primary)",
        background: "color-mix(in srgb, var(--color-background) 58%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
    },
    cardLabel: {
        fontSize: 11,
        color: "var(--color-text-muted)",
        textTransform: "uppercase",
        letterSpacing: 0.7,
        fontWeight: 750,
        marginBottom: 4,
    },
    cardValue: {
        fontSize: 28,
        lineHeight: 1,
        fontWeight: 850,
        letterSpacing: "-0.05em",
    },
    cardNote: {
        marginTop: 8,
        minHeight: 28,
        fontSize: 11.5,
        lineHeight: 1.35,
        color: "var(--color-text-muted)",
    },
    // Masonry-style columns: panels pack vertically so a short panel doesn't
    // leave a hole in its row (grid rows all align to the tallest panel).
    layoutGrid: {
        position: "relative",
        zIndex: 1,
        columns: "300px",
        columnGap: 16,
    },
    panel: {
        breakInside: "avoid",
        marginBottom: 16,
        padding: 18,
        borderRadius: 24,
        background: "color-mix(in srgb, var(--color-surface) 88%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 66%, transparent)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        boxShadow: "0 18px 60px rgba(0, 0, 0, 0.18)",
    },
    panelHeader: { display: "flex", gap: 11, alignItems: "flex-start", marginBottom: 14 },
    panelIcon: {
        width: 32,
        height: 32,
        borderRadius: 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in srgb, var(--color-background) 58%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
        flexShrink: 0,
    },
    sectionTitle: {
        fontSize: 15,
        fontWeight: 800,
        letterSpacing: "-0.02em",
        margin: 0,
    },
    sectionDescription: {
        margin: "3px 0 0",
        fontSize: 12,
        color: "var(--color-text-muted)",
    },
    providerList: { display: "flex", flexDirection: "column", gap: 9 },
    providerRow: {
        padding: "11px 12px",
        borderRadius: 16,
        background: "color-mix(in srgb, var(--color-background) 48%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 48%, transparent)",
    },
    providerHead: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 },
    providerName: { fontWeight: 750, fontSize: 13.5 },
    providerMeta: { marginTop: 5, color: "var(--color-text-muted)", fontSize: 12 },
    smallPill: {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 7px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 750,
        whiteSpace: "nowrap",
    },
    pillGood: { color: "#31d07f", background: "color-mix(in srgb, #31d07f 12%, transparent)" },
    pillMuted: { color: "var(--color-text-muted)", background: "color-mix(in srgb, var(--color-background) 55%, transparent)" },
    integrationGrid: {
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: 8,
        marginBottom: 16,
    },
    integrationItem: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 10px",
        borderRadius: 14,
        background: "color-mix(in srgb, var(--color-background) 44%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 44%, transparent)",
    },
    dot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
    integrationName: { flex: 1, fontSize: 12.5, textTransform: "capitalize" },
    integrationOn: { color: "#31d07f", fontSize: 11.5, fontWeight: 750 },
    integrationOff: { color: "var(--color-text-muted)", fontSize: 11.5, fontWeight: 750 },
    vaultBox: {
        padding: 12,
        borderRadius: 16,
        background: "color-mix(in srgb, var(--color-background) 48%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 48%, transparent)",
    },
    vaultTitle: { fontSize: 12, fontWeight: 800, marginBottom: 4 },
    vaultMessage: { color: "var(--color-text-muted)", fontSize: 12.5, lineHeight: 1.4 },
    vaultMeta: { marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-muted)" },
    channelList: { display: "flex", flexDirection: "column", gap: 11 },
    channelRow: { display: "flex", flexDirection: "column", gap: 6 },
    channelTop: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
    },
    channelName: { fontSize: 12.5, fontWeight: 750, textTransform: "capitalize" },
    channelCount: { fontSize: 12, color: "var(--color-text-muted)" },
    barTrack: { height: 8, borderRadius: 999, background: "color-mix(in srgb, var(--color-background) 70%, transparent)", overflow: "hidden" },
    barFill: { height: "100%", borderRadius: 999, background: "linear-gradient(90deg, var(--color-secondary), #7aa2ff)" },
    emptyText: { color: "var(--color-text-muted)", fontSize: 13, padding: 12 },
    capabilityList: { display: "flex", flexDirection: "column", gap: 12 },
    capabilityRow: { display: "grid", gridTemplateColumns: "74px 1fr", gap: 10, alignItems: "start" },
    capabilityTitle: { fontSize: 13.5, fontWeight: 750 },
    capabilityNote: { marginTop: 2, color: "var(--color-text-muted)", fontSize: 12, lineHeight: 1.35 },
    promptPanel: {
        position: "relative",
        zIndex: 1,
        padding: 20,
        borderRadius: 26,
        background: "linear-gradient(180deg, color-mix(in srgb, var(--color-surface) 92%, transparent), color-mix(in srgb, var(--color-surface) 78%, transparent))",
        border: "1px solid color-mix(in srgb, var(--color-border) 66%, transparent)",
        boxShadow: "0 22px 70px rgba(0, 0, 0, 0.2)",
        backdropFilter: "blur(22px)",
        WebkitBackdropFilter: "blur(22px)",
    },
    promptHeader: { display: "flex", justifyContent: "space-between", gap: 14, alignItems: "flex-start" },
    charCount: {
        padding: "5px 8px",
        borderRadius: 999,
        background: "color-mix(in srgb, var(--color-background) 55%, transparent)",
        color: "var(--color-text-muted)",
        fontSize: 11.5,
        fontWeight: 700,
    },
    textarea: {
        width: "100%",
        minHeight: 170,
        background: "color-mix(in srgb, var(--color-background) 76%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
        borderRadius: 18,
        padding: "14px 15px",
        color: "var(--color-text-primary)",
        fontSize: 13.5,
        lineHeight: 1.55,
        fontFamily: "var(--font-family)",
        resize: "vertical",
        outline: "none",
        boxSizing: "border-box",
    },
    promptActions: {
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginTop: 12,
    },
    saveButton: {
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        background: "var(--color-text-primary)",
        color: "var(--color-background)",
        border: "none",
        borderRadius: 14,
        padding: "10px 14px",
        fontSize: 13,
        fontWeight: 750,
        cursor: "pointer",
    },
    message: {
        fontSize: 12.5,
        color: "var(--color-text-muted)",
    },
    refreshButton: {
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        background: "color-mix(in srgb, var(--color-surface) 72%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
        borderRadius: 14,
        padding: "9px 12px",
        color: "var(--color-text-primary)",
        fontSize: 12.5,
        fontWeight: 700,
        cursor: "pointer",
    },
};
