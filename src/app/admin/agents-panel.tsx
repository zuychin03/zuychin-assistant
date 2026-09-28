"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import { Dropdown } from "@/components/dropdown";
import { ConfirmModal } from "../home/controls";

// Every agent installation and the credentials it holds. The panel never shows
// a durable key: adding an agent produces a short-lived claim inside a brief,
// and the key itself only exists after the agent exchanges it.

type AccessLevel = "read" | "notes" | "full" | "council";
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

type Revocation = { kind: "agent"; id: string; name: string } | { kind: "key"; id: string; name: string; credential: string };

const KIND_OPTIONS = [
    { value: "remote_agent", label: "Remote agent" },
    { value: "local_host", label: "Local host" },
    { value: "owner_tool", label: "Owner tool" },
];

const ACCESS_OPTIONS = [
    { value: "read", label: "Read-only" },
    { value: "notes", label: "Notes read/write" },
    { value: "full", label: "Full read/write" },
    { value: "council", label: "Full + convene councils" },
];

const ACCESS_LABELS: Record<AccessLevel, string> = {
    read: "read-only", notes: "notes read/write", full: "full read/write",
    council: "full read/write + convene",
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
    const [brief, setBrief] = useState<{ clientId: string; name: string; text: string; expiresAt: string } | null>(null);
    const [copied, setCopied] = useState(false);
    const [revocation, setRevocation] = useState<Revocation | null>(null);
    const [revokeError, setRevokeError] = useState("");
    const revocationLock = useRef(false);

    const load = async (clearError = true) => {
        setLoading(true);
        try {
            const res = await fetch("/api/agents");
            if (!res.ok) throw new Error();
            if (res.ok) {
                const data = await res.json() as { clients?: AgentClient[] };
                setClients(data.clients ?? []);
                if (clearError) setError("");
            }
        } catch { setError("Could not load agents. Use Refresh to retry."); }
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
            setName(current => current === displayName || current.trim() === displayName ? "" : current);
            await load(false);
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
        setBrief({ clientId, name: displayName, text: data.brief, expiresAt: data.expiresAt ?? "" });
    };

    const reissue = async (client: AgentClient) => {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
            await mintClaim(client.id, client.displayName);
        } catch { setError("Could not issue a fresh claim. Please retry."); } finally {
            setBusy(false);
        }
    };

    const revoke = async () => {
        if (!revocation || busy || revocationLock.current) return;
        revocationLock.current = true;
        setBusy(true); setRevokeError(""); setError("");
        try {
            const path = revocation.kind === "agent" ? `/api/agents?id=${encodeURIComponent(revocation.id)}` : `/api/agents/keys?keyId=${encodeURIComponent(revocation.id)}`;
            const response = await fetch(path, { method: "DELETE" });
            if (!response.ok) throw new Error();
            if (revocation.kind === "agent") {
                setBrief(current => current?.clientId === revocation.id ? null : current);
                setClients(current => current.filter(client => client.id !== revocation.id));
            } else setClients(current => current.map(client => ({ ...client, keys: client.keys.filter(key => key.id !== revocation.id) })));
            await load(false);
            setRevocation(null);
        } catch { setRevokeError("Revocation was not confirmed. Please retry."); } finally {
            revocationLock.current = false;
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
                <button style={styles.iconBtn} onClick={() => void load()} disabled={loading || busy} title="Refresh agents">
                    <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
                </button>
            </div>

            <div style={styles.addRow}>
                <input
                    style={styles.addInput}
                    disabled={busy}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
                    aria-label="Agent name"
                    placeholder="Agent name, such as codex-laptop"
                />
                <Dropdown ariaLabel="Kind" style={styles.select} value={kind} disabled={busy}
                    onChange={(v) => setKind(v as ClientKind)} options={KIND_OPTIONS} />
                <Dropdown ariaLabel="Access level" style={styles.select} value={access} disabled={busy}
                    onChange={(v) => setAccess(v as AccessLevel)} options={ACCESS_OPTIONS} />
                <button style={styles.iconBtn} onClick={add} disabled={busy || !name.trim()} title="Add agent">
                    <Plus size={14} />
                </button>
            </div>

            {error && <div role="alert" style={styles.error}>{error}</div>}

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
                            }).catch(() => setError("Could not copy the setup brief. Check clipboard access and retry."));
                        }}
                    >
                        {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy brief"}
                    </button>
                </div>
            )}

            {loading && <p role="status" style={styles.muted}>Loading agents…</p>}
            <div style={styles.list}>
                {clients.length === 0 && !loading && !error && (
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
                            <button style={styles.dangerBtn} onClick={() => { setRevokeError(""); setRevocation({ kind: "agent", id: c.id, name: c.displayName }); }} disabled={busy}
                                aria-label={`Revoke agent ${c.displayName} and all its credentials`}
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
                                    {k.expiresAt ? `expires ${new Date(k.expiresAt).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" })}` : "no expiry"}
                                </span>
                                <button style={styles.dangerBtn} onClick={() => { setRevokeError(""); setRevocation({ kind: "key", id: k.id, name: c.displayName, credential: k.purpose === "council_seat" ? `seat key for ${k.seatName ?? "this council"}` : `${ACCESS_LABELS[k.accessLevel ?? "read"]} credential` }); }} disabled={busy}
                                    aria-label={`Revoke credential for ${c.displayName}`}
                                    title="Revoke this credential">
                                    <Trash2 size={11} />
                                </button>
                            </div>
                        ))}
                    </div>
                ))}
            </div>
            {revocation && <ConfirmModal title={revocation.kind === "agent" ? "Revoke this agent?" : "Revoke this credential?"}
                body={revocation.kind === "agent" ? `“${revocation.name}” and every credential it holds will be revoked. Connected agents using them will lose access. This cannot be undone.` : `The ${revocation.credential} for “${revocation.name}” will stop working immediately. Its other credentials will stay active. This cannot be undone.`}
                confirmLabel={revocation.kind === "agent" ? "Revoke agent and keys" : "Revoke credential"}
                busyText={busy ? "Revoking access…" : undefined} error={revokeError}
                onConfirm={revoke} onCancel={() => { if (!revocationLock.current) { setRevocation(null); setRevokeError(""); } }} />}
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
        display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32,
        borderRadius: 9, cursor: "pointer", flexShrink: 0, background: "transparent",
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
        color: "var(--color-text-muted)",
    },
    dangerBtn: {
        display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32,
        borderRadius: 9, cursor: "pointer", flexShrink: 0, background: "transparent",
        border: "1px solid color-mix(in srgb, var(--admin-danger) 40%, transparent)", color: "var(--admin-danger)",
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
    error: { fontSize: 12, color: "var(--admin-danger)", marginBottom: 10 },
    briefBox: {
        display: "flex", flexDirection: "column", gap: 8, padding: 11, borderRadius: 14, marginBottom: 12,
        border: "1px solid color-mix(in srgb, var(--admin-success) 45%, transparent)",
        background: "color-mix(in srgb, var(--admin-success) 8%, transparent)",
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
    rowHead: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 7 },
    rowName: { overflowWrap: "anywhere", minWidth: 0, fontSize: 12.5, fontWeight: 700, color: "var(--color-text-primary)" },
    rowMeta: { flex: 1, fontSize: 11, color: "var(--color-text-muted)" },
    keyRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 7, paddingLeft: 4 },
    chip: {
        padding: "2px 7px", borderRadius: 999, fontSize: 10.5, fontWeight: 750, maxWidth: "100%", overflowWrap: "anywhere",
        color: "var(--color-text-muted)",
        background: "color-mix(in srgb, var(--color-background) 62%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 48%, transparent)",
    },
    muted: { color: "var(--color-text-muted)", fontSize: 12.5, padding: 4 },
};
