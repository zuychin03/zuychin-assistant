"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { WorkspaceShell } from "@/components/workspace-shell";
import ui from "./admin.module.css";
import { useUnsavedChanges } from "@/components/use-unsaved-changes";
import RunsPanel from "./runs-panel";
import MemoriesPanel from "./memories-panel";
import SkillsPanel from "./skills-panel";
import SecurityPanel from "./security-panel";
import AgentsPanel from "./agents-panel";
import ConversationCleanupPanel from "./conversation-cleanup-panel";
import NotificationsPanel from "./notifications-panel";
import ModelHealthPanel from "./model-health-panel";
import { clearOfflinePrivateData } from "@/lib/offline/storage";
import { Masonry } from "./masonry";
import { Activity, Bot, CheckCircle2, Clock, RefreshCw, Save, ShieldCheck, LogOut, Sparkles, Wifi, XCircle } from "lucide-react";

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
    unavailableReason?: string;
    unavailableChatModels?: { id: string; label: string; reason: string }[];
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

const DESCRIPTION = "Assistant status, providers, memory and access";

export default function DashboardPage() {
    const [loadError, setLoadError] = useState("");
    const [stats, setStats] = useState<BotStats | null>(null);
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [vaultHealth, setVaultHealth] = useState<VaultHealth | null>(null);
    const [systemPrompt, setSystemPrompt] = useState("");
    const [savedPrompt, setSavedPrompt] = useState("");
    const promptLoaded = useRef(false);
    const [memoriesDirty, setMemoriesDirty] = useState(false);
    const [skillsDirty, setSkillsDirty] = useState(false);
    const hasUnsavedChanges = memoriesDirty || skillsDirty || systemPrompt !== savedPrompt;
    useUnsavedChanges(() => hasUnsavedChanges);
    const [saving, setSaving] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);
    const [logoutError, setLogoutError] = useState("");
    const [message, setMessage] = useState("");
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);

    const fetchStats = useCallback(async () => {
        setRefreshing(true);
        try {
            const [statusRes, providersRes, vaultRes] = await Promise.all([
                fetch("/api/admin/status"),
                fetch("/api/providers"),
                fetch("/api/vault/health").catch(() => null),
            ]);

            if (!statusRes.ok) throw new Error();
            const statusData = await statusRes.json();
            if (!statusData.stats) throw new Error();
            setLoadError("");
            setStats(statusData);
            if (!promptLoaded.current) {
                promptLoaded.current = true;
                const initialPrompt = statusData.profile?.systemPrompt || "";
                setSystemPrompt(initialPrompt);
                setSavedPrompt(initialPrompt);
            }

            if (providersRes.ok) {
                const providerData = (await providersRes.json()) as ProvidersPayload;
                setProviders(providerData.providers ?? []);
            }

            if (vaultRes) {
                const health = await vaultRes.json();
                setVaultHealth(health);
            }
        } catch {
            setLoadError("Could not refresh dashboard status. Use Refresh to retry. Previously loaded data is shown where available.");
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        fetchStats();
    }, [fetchStats]);

    useEffect(() => {
        if (loading) return;
        const revealFragment = () => {
            const id = window.location.hash.slice(1);
            if (!["model-health", "security", "agents"].includes(id)) return;
            const section = document.getElementById(id);
            if (!section) return;
            section.setAttribute("tabindex", "-1");
            section.focus({ preventScroll: true });
            section.scrollIntoView({ block: "start", behavior: "auto" });
        };
        revealFragment();
        window.addEventListener("hashchange", revealFragment);
        return () => window.removeEventListener("hashchange", revealFragment);
    }, [loading]);

    const handleSavePrompt = async () => {
        if (!systemPrompt.trim() || saving) return;
        const submittedPrompt = systemPrompt;
        setSaving(true);
        setMessage("");

        try {
            const res = await fetch("/api/admin/personality", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ systemPrompt: submittedPrompt }),
            });
            const data = await res.json();

            if (res.ok) {
                setSavedPrompt(submittedPrompt);
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

    const handleLogout = async () => {
        if (loggingOut) return;
        setLoggingOut(true); setLogoutError("");
        try {
            await clearOfflinePrivateData();
            const response = await fetch("/api/auth", { method: "DELETE" });
            if (!response.ok) throw new Error("Sign-out was not confirmed. Please try again.");
            window.location.assign("/login");
        } catch (error) {
            setLogoutError(error instanceof Error ? error.message : "Could not clear offline data and sign out. Please try again.");
            setLoggingOut(false);
        }
    };

    const formatUptime = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return `${h}h ${m}m`;
    };

    const formatDate = (dateStr: string | null) => {
        if (!dateStr) return "No activity yet";
        return new Date(dateStr).toLocaleString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
    };

    const availableProviders = providers.filter((p) => p.available);
    const chatModelCount = availableProviders.reduce((sum, p) => sum + p.chatModels.length, 0);
    const embeddingModelCount = availableProviders.reduce((sum, p) => sum + p.embeddingModels.length, 0);
    const channels = stats?.stats.channelBreakdown ?? {};
    const topChannelCount = Math.max(1, ...Object.values(channels));

    const actions = <>
        <button onClick={fetchStats} disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? "animate-spin" : undefined} />
            <span className={ui.actionLabel}>Refresh</span>
        </button>
        <button onClick={() => void handleLogout()} disabled={loggingOut}>
            <LogOut size={15} />
            <span className={ui.actionLabel}>{loggingOut ? "Signing out…" : "Log out"}</span>
        </button>
    </>;

    if (loading) {
        return (
            <WorkspaceShell current="dashboard" title="Dashboard" description={DESCRIPTION} actions={actions}>
                <div className={ui.dashboard}>
                    <div className={ui.loading}>
                        <RefreshCw size={18} className="animate-spin" />
                        <span>Loading dashboard…</span>
                    </div>
                </div>
            </WorkspaceShell>
        );
    }

    return (
        <WorkspaceShell current="dashboard" title="Dashboard" description={DESCRIPTION} actions={actions}>
            <div className={ui.dashboard}>
                {loadError && <p role="alert" className={ui.alert}>{loadError}</p>}
                {logoutError && <p role="alert" className={ui.alert}>{logoutError}</p>}

                <section className={ui.overview}>
                    <div className={ui.model}>
                        <Bot size={18} />
                        <div className={ui.modelText}>
                            <div className={ui.modelLabel}>Default chat model</div>
                            <div className={ui.modelName}>{stats?.model ?? "Unknown"}</div>
                            <div className={ui.modelMeta}>
                                Profile: {stats?.profile?.displayName ?? "No profile"} · Uptime {stats ? formatUptime(stats.uptime) : "-"}
                            </div>
                        </div>
                    </div>
                    <div className={ui.overviewSide}>
                        <span className="pill" data-tone={stats?.status === "online" ? "success" : "danger"}>
                            <Wifi size={13} /> {stats?.status ?? "unknown"}
                        </span>
                        <a href="#security" className="btn"><ShieldCheck size={15} /> Security</a>
                        <a href="/api/vault/health" className="btn"><ShieldCheck size={15} /> Vault health</a>
                        <a href="/api/telegram/test" className="btn"><Activity size={15} /> Telegram test</a>
                    </div>
                </section>

                <dl className={ui.stats}>
                    <MetricCard label="Messages" value={stats?.stats.totalMessages ?? 0} note={`Last: ${stats?.stats.lastChannel ?? "none"}`} />
                    <MetricCard label="Memories" value={stats?.stats.totalEmbeddings ?? 0} note={`${embeddingModelCount} embedding model${embeddingModelCount === 1 ? "" : "s"} available`} />
                    <MetricCard label="Conversations" value={stats?.stats.totalConversations ?? 0} note={formatDate(stats?.stats.lastActivity ?? null)} />
                    <MetricCard label="Artifacts" value={stats?.stats.totalArtifacts ?? 0} note="Generated files" />
                    <MetricCard label="Vault pages" value={stats?.stats.totalVaultPages ?? 0} note={vaultHealth?.ok ? "Vault connected" : "Check vault setup"} />
                    <MetricCard label="Pending notes" value={stats?.stats.pendingTodos ?? 0} note={`${stats?.stats.totalTodos ?? 0} total checklist items`} />
                </dl>

                <section className={ui.panel} id="model-health">
                    <ModelHealthPanel />
                </section>

                <Masonry minColumnWidth={300} gap={16}>
                    <section className={ui.panel}>
                        <PanelHeader title="Provider status" description={`${availableProviders.length}/${providers.length || 0} providers configured`} icon={<Sparkles size={16} />} />
                        <div className="list">
                            {providers.map((provider) => (
                                <div key={provider.id} className="row">
                                    <div className={ui.providerHead}>
                                        <span className="row-title">{provider.label}</span>
                                        <span className="pill" data-tone={provider.available ? "success" : undefined}>
                                            {provider.available ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                                            {provider.available ? "Ready" : provider.unavailableReason ? "Unavailable" : "Missing key"}
                                        </span>
                                    </div>
                                    <div className="meta">
                                        {provider.chatModels.length} chat · {provider.embeddingModels.length} embedding
                                    </div>
                                    {!provider.available && provider.unavailableReason && (
                                        <div className="meta">{provider.unavailableReason}</div>
                                    )}
                                    {!!provider.unavailableChatModels?.length && (
                                        <details className={ui.providerDetails}>
                                            <summary>{provider.unavailableChatModels.length} unavailable model{provider.unavailableChatModels.length === 1 ? "" : "s"}</summary>
                                            {provider.unavailableChatModels.map((model) => (
                                                <p key={model.id}><strong>{model.label}</strong>: {model.reason}</p>
                                            ))}
                                        </details>
                                    )}
                                </div>
                            ))}
                            {providers.length === 0 && <div className="empty">No providers loaded.</div>}
                        </div>
                    </section>

                    <section className={ui.panel}>
                        <PanelHeader title="Integrations" description="Configured from environment variables" icon={<ShieldCheck size={16} />} />
                        <div className={ui.integrations}>
                            {Object.entries(stats?.integrations ?? {}).map(([name, enabled]) => (
                                <div key={name} className={ui.integration}>
                                    <span className="dot" data-tone={enabled ? "success" : undefined} />
                                    <span className={ui.integrationName}>{name}</span>
                                    <span className={ui.integrationState} data-on={enabled || undefined}>{enabled ? "on" : "off"}</span>
                                </div>
                            ))}
                        </div>
                        <div className={ui.vault}>
                            <div className={ui.vaultTitle}>Vault</div>
                            <div className={ui.vaultMessage}>
                                {vaultHealth?.ok ? "Connected and ready." : vaultHealth?.message ?? "Vault health unavailable."}
                            </div>
                            {vaultHealth?.repo && <div className={ui.vaultMeta}>{vaultHealth.repo}{vaultHealth.branch ? ` · ${vaultHealth.branch}` : ""}</div>}
                        </div>
                    </section>

                    <section className={ui.panel}>
                        <NotificationsPanel />
                    </section>

                    <section className={ui.panel}>
                        <PanelHeader title="Channel activity" description="Message distribution by channel" icon={<Activity size={16} />} />
                        <div className={ui.channels}>
                            {Object.entries(channels).map(([channel, count]) => (
                                <div key={channel}>
                                    <div className={ui.channelTop}>
                                        <span className={ui.channelName}>{channel}</span>
                                        <span className={ui.channelCount}>{count}</span>
                                    </div>
                                    <div className={ui.bar}>
                                        <div className={ui.barFill} style={{ width: `${Math.max(8, (count / topChannelCount) * 100)}%` }} />
                                    </div>
                                </div>
                            ))}
                            {Object.keys(channels).length === 0 && <div className="empty">No channel activity yet.</div>}
                        </div>
                    </section>

                    <section className={ui.panel}>
                        <PanelHeader title="Current capabilities" description={`${chatModelCount} chat models available`} icon={<Clock size={16} />} />
                        <div className="list">
                            <Capability label="Agent mode" enabled note="Plans, skills, sub-agents and artifacts" />
                            <Capability label="RAG memory" enabled note="Model-aware pgvector partitions" />
                            <Capability label="Second brain" enabled={!!vaultHealth?.ok} note="GitHub wiki vault + graph" />
                            <Capability label="Gmail/Calendar tools" enabled={!!stats?.integrations.google} note="OAuth-backed personal tools" />
                            <Capability label="External channels" enabled={!!(stats?.integrations.discord || stats?.integrations.telegram)} note="Discord and Telegram entry points" />
                        </div>
                    </section>

                    <section className={ui.panel} id="security">
                        <SecurityPanel />
                    </section>

                    <section className={ui.panel} id="agents">
                        <AgentsPanel />
                    </section>

                    <section className={ui.panel}>
                        <ConversationCleanupPanel />
                    </section>

                    <section className={ui.panel}>
                        <RunsPanel />
                    </section>

                    <section className={ui.panel}>
                        <MemoriesPanel onDirtyChange={setMemoriesDirty} />
                    </section>

                    <section className={ui.panel}>
                        <SkillsPanel onDirtyChange={setSkillsDirty} />
                    </section>
                </Masonry>

                <section className={ui.panel}>
                    <div className={ui.promptHead}>
                        <PanelHeader title="Assistant personality" description="System prompt used by the chat pipeline across channels" icon={<Bot size={16} />} />
                        <span className={ui.charCount}>{systemPrompt.length}/5000</span>
                    </div>
                    <textarea
                        aria-label="Assistant personality system prompt"
                        maxLength={5000}
                        className={`field ${ui.prompt}`}
                        value={systemPrompt}
                        onChange={(e) => setSystemPrompt(e.target.value)}
                        placeholder="Enter the bot's system prompt / personality..."
                        rows={5}
                    />
                    <div className={ui.promptActions}>
                        <button
                            className="btn"
                            data-tone="primary"
                            onClick={handleSavePrompt}
                            disabled={saving || !systemPrompt.trim()}
                        >
                            {saving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
                            {saving ? "Saving..." : "Save personality"}
                        </button>
                        {message && <span role="status" className="meta">{message}</span>}
                    </div>
                </section>
            </div>
        </WorkspaceShell>
    );
}

function MetricCard({ label, value, note }: {
    label: string;
    value: number | string;
    note: string;
}) {
    return (
        <div className={ui.stat}>
            <dt className={ui.statLabel}>{label}</dt>
            <dd className={ui.statValue}>{value}</dd>
            <dd className={ui.statNote}>{note}</dd>
        </div>
    );
}

function PanelHeader({ title, description, icon }: {
    title: string;
    description: string;
    icon: React.ReactNode;
}) {
    return (
        <div className="panel-head">
            {icon}
            <div className="panel-heading">
                <h2>{title}</h2>
                <p>{description}</p>
            </div>
        </div>
    );
}

function Capability({ label, enabled, note }: { label: string; enabled: boolean; note: string }) {
    return (
        <div className={`row ${ui.capability}`}>
            <div>
                <div className={ui.capabilityTitle}>{label}</div>
                <div className={ui.capabilityNote}>{note}</div>
            </div>
            <span className="pill" data-tone={enabled ? "success" : undefined}>
                {enabled ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                {enabled ? "Ready" : "Off"}
            </span>
        </div>
    );
}
