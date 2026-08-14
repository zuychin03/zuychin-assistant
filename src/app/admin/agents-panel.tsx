"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import { Dropdown } from "@/components/dropdown";

// Every agent installation and the credentials it holds. The panel never shows
// a durable key: adding an agent produces a short-lived claim inside a brief,
// and the key itself only exists after the agent exchanges it.

type AccessLevel = "read" | "notes" | "full";
type ClientKind = "local_host" | "remote_agent" | "owner_tool";

interface AgentKey {
    id: string;
    purpose: "knowledge" | "council_seat";
    accessLevel: AccessLevel | null;
    scopes: string[];
    issuedAt: string;
    expiresAt: string | null;
    lastUsedAt: string | null;
    seatName: string | null;
}

interface AgentClient {
    id: string;
    displayName: string;
    kind: ClientKind;
    providerHint: string | null;
    note: string | null;
    createdAt: string;
    lastSeenAt: string | null;
    keys: AgentKey[];
}

const KIND_OPTIONS = [
    { value: "remote_agent", label: "Remote agent" },
    { value: "local_host", label: "Local host" },
    { value: "owner_tool", label: "Owner tool" },
];

const ACCESS_OPTIONS = [
    { value: "read", label: "Read-only" },
    { value: "notes", label: "Notes read/write" },
    { value: "full", label: "Full read/write" },
];

const ACCESS_LABELS: Record<AccessLevel, string> = {
    read: "read-only", notes: "notes read/write", full: "full read/write",
};

function ago(iso: string | null): string {
    if (!iso) return "never used";
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return "never used";
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return `used ${Math.max(minutes, 1)}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `used ${hours}h ago`;
    return `used ${Math.round(hours / 24)}d ago`;
}

export default function AgentsPanel() {
    const [clients, setClients] = useState<AgentClient[]>([]);
    const [loading, setLoading] = useState(true);
    const [name, setName] = useState("");
    const [kind, setKind] = useState<ClientKind>("remote_agent");
    const [access, setAccess] = useState<AccessLevel>("notes");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [brief, setBrief] = useState<{ name: string; text: string; expiresAt: string } | null>(null);
    const [copied, setCopied] = useState(false);

    const load = async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/agents");
            if (res.ok) {
                const data = await res.json() as { clients?: AgentClient[] };
                setClients(data.clients ?? []);
            }
        } catch { /* supplementary panel; a failed read must not break the page */ }
        setLoading(false);
    };

    useEffect(() => { void load(); }, []);

    const add = async () => {
        const displayName = name.trim();
        if (!displayName || busy) return;
        setBusy(true);
        setError("");
        try {
            const created = await fetch("/api/agents", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ displayName, kind }),
            });
            const client = await created.json() as { id?: string; error?: string };
            if (!created.ok || !client.id) {
                setError(client.error ?? "Could not add that agent.");
                return;
            }
            await mintClaim(client.id, displayName);
            setName("");
            await load();
        } catch {
            setError("Could not add that agent.");
        } finally {
            setBusy(false);
        }
    };

    const mintClaim = async (clientId: string, displayName: string) => {
        const res = await fetch("/api/agents/claim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientId, accessLevel: access }),
        });
        const data = await res.json() as { brief?: string; expiresAt?: string; error?: string };
        if (!res.ok || !data.brief) {
            setError(data.error ?? "Could not mint a claim.");
            return;
        }
        setBrief({ name: displayName, text: data.brief, expiresAt: data.expiresAt ?? "" });
    };

    const reissue = async (client: AgentClient) => {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
            await mintClaim(client.id, client.displayName);
        } finally {
            setBusy(false);
        }
    };

    const revokeClient = async (id: string) => {
        if (busy) return;
        setBusy(true);
        try {
            await fetch(`/api/agents?id=${encodeURIComponent(id)}`, { method: "DELETE" });
            setBrief(null);
            await load();
        } finally {
            setBusy(false);
        }
    };

    const revokeKey = async (keyId: string) => {
        if (busy) return;
        setBusy(true);
        try {
            await fetch(`/api/agents/keys?keyId=${encodeURIComponent(keyId)}`, { method: "DELETE" });
            await load();
        } finally {
            setBusy(false);
        }
    };

    return (
        <div>
            <div style={styles.header}>
                <div style={styles.headerIcon}><Users size={16} /></div>
                <div style={{ flex: 1 }}>
                    <h2 style={styles.title}>Agents</h2>
                    <p style={styles.description}>Per-agent credentials, their access level and last use</p>
                </div>
                <button style={styles.iconBtn} onClick={load} title="Refresh agents">
                    <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
                </button>
            </div>

            <div style={styles.addRow}>
                <input
                    style={styles.addInput}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
                    placeholder="Agent name, such as codex-laptop"
                />
                <Dropdown ariaLabel="Kind" style={styles.select} value={kind}
                    onChange={(v) => setKind(v as ClientKind)} options={KIND_OPTIONS} />
                <Dropdown ariaLabel="Access level" style={styles.select} value={access}
                    onChange={(v) => setAccess(v as AccessLevel)} options={ACCESS_OPTIONS} />
                <button style={styles.iconBtn} onClick={add} disabled={busy || !name.trim()} title="Add agent">
                    <Plus size={14} />
                </button>
            </div>

            {error && <div style={styles.error}>{error}</div>}

            {brief && (
                <div style={styles.briefBox}>
                    <div style={styles.briefHead}>
                        Setup brief for <strong>{brief.name}</strong>. The claim inside it expires in 15 minutes
                        and is exchanged for the durable key by the agent itself.
                    </div>
                    <button
                        type="button"
                        style={styles.copyBtn}
                        onClick={() => {
                            void navigator.clipboard.writeText(brief.text).then(() => {
                                setCopied(true);
                                setTimeout(() => setCopied(false), 2000);
                            });
                        }}
                    >
                        {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy brief"}
                    </button>
                </div>
            )}

            <div style={styles.list}>
                {clients.length === 0 && !loading && (
                    <div style={styles.muted}>No agents yet. Add one to issue it a credential of its own.</div>
                )}
                {clients.map((c) => (
                    <div key={c.id} style={styles.row}>
                        <div style={styles.rowHead}>
                            <span style={styles.rowName}>{c.displayName}</span>
                            <span style={styles.chip}>{c.kind.replace("_", " ")}</span>
                            <span style={styles.rowMeta}>{c.lastSeenAt ? ago(c.lastSeenAt) : "never seen"}</span>
                            <button style={styles.iconBtn} onClick={() => reissue(c)} disabled={busy}
                                title="Issue a fresh claim">
                                <RefreshCw size={12} />
                            </button>
                            <button style={styles.dangerBtn} onClick={() => revokeClient(c.id)} disabled={busy}
                                title="Revoke this agent and every key it holds">
                                <Trash2 size={12} />
                            </button>
                        </div>
                        {c.keys.length === 0 && (
                            <div style={styles.rowMeta}>No live credentials. Its claim has not been exchanged yet.</div>
                        )}
                        {c.keys.map((k) => (
                            <div key={k.id} style={styles.keyRow}>
                                <span style={styles.chip}>
                                    {k.purpose === "council_seat"
                                        ? `seat: ${k.seatName ?? "?"}`
                                        : ACCESS_LABELS[k.accessLevel ?? "read"]}
                                </span>
                                <span style={styles.rowMeta}>{ago(k.lastUsedAt)}</span>
                                <span style={styles.rowMeta}>
                                    {k.expiresAt ? `expires ${new Date(k.expiresAt).toLocaleDateString()}` : "no expiry"}
                                </span>
                                <button style={styles.dangerBtn} onClick={() => revokeKey(k.id)} disabled={busy}
                                    title="Revoke this credential">
                                    <Trash2 size={11} />
                                </button>
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    header: { display: "flex", gap: 11, alignItems: "flex-start", marginBottom: 14 },
    headerIcon: {
        width: 32, height: 32, borderRadius: 12, display: "flex", alignItems: "center",
        justifyContent: "center", flexShrink: 0,
        background: "color-mix(in srgb, var(--color-background) 58%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
    },
    title: { fontSize: 15, fontWeight: 800, letterSpacing: "-0.02em", margin: 0 },
    description: { margin: "3px 0 0", fontSize: 12, color: "var(--color-text-muted)" },
    iconBtn: {
        display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26,
        borderRadius: 9, cursor: "pointer", flexShrink: 0, background: "transparent",
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
        color: "var(--color-text-muted)",
    },
    dangerBtn: {
        display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26,
        borderRadius: 9, cursor: "pointer", flexShrink: 0, background: "transparent",
        border: "1px solid color-mix(in srgb, #e5484d 40%, transparent)", color: "#e5484d",
    },
    addRow: { display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" },
    addInput: {
        flex: "1 1 160px", minWidth: 0, padding: "7px 10px", borderRadius: 12, fontSize: 12.5,
        outline: "none", color: "var(--color-text-primary)",
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
        background: "color-mix(in srgb, var(--color-background) 48%, transparent)",
    },
    select: {
        flex: "0 1 140px", padding: "7px 8px", borderRadius: 12, fontSize: 12,
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
        background: "color-mix(in srgb, var(--color-background) 48%, transparent)",
    },
    error: { fontSize: 12, color: "#e5484d", marginBottom: 10 },
    briefBox: {
        display: "flex", flexDirection: "column", gap: 8, padding: 11, borderRadius: 14, marginBottom: 12,
        border: "1px solid color-mix(in srgb, #31d07f 45%, transparent)",
        background: "color-mix(in srgb, #31d07f 8%, transparent)",
    },
    briefHead: { fontSize: 12, lineHeight: 1.5, color: "var(--color-text-primary)" },
    copyBtn: {
        alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 6,
        padding: "5px 11px", borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: "pointer",
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
        background: "transparent", color: "var(--color-text-primary)",
    },
    list: { display: "flex", flexDirection: "column", gap: 8, maxHeight: 340, overflowY: "auto" },
    row: {
        display: "flex", flexDirection: "column", gap: 6, padding: "9px 11px", borderRadius: 14,
        background: "color-mix(in srgb, var(--color-background) 48%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 48%, transparent)",
    },
    rowHead: { display: "flex", alignItems: "center", gap: 7 },
    rowName: { fontSize: 12.5, fontWeight: 700, color: "var(--color-text-primary)" },
    rowMeta: { flex: 1, fontSize: 11, color: "var(--color-text-muted)" },
    keyRow: { display: "flex", alignItems: "center", gap: 7, paddingLeft: 4 },
    chip: {
        padding: "2px 7px", borderRadius: 999, fontSize: 10.5, fontWeight: 750, flexShrink: 0,
        color: "var(--color-text-muted)",
        background: "color-mix(in srgb, var(--color-background) 62%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 48%, transparent)",
    },
    muted: { color: "var(--color-text-muted)", fontSize: 12.5, padding: 4 },
};
