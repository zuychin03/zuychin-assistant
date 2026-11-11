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
            <div className="panel-head">
                <Users size={16} />
                <div className="panel-heading">
                    <h2>Agents</h2>
                    <p>Per-agent credentials, their access level and last use</p>
                </div>
                <button className="icon-btn" onClick={() => void load()} disabled={loading || busy} title="Refresh agents">
                    <RefreshCw size={15} className={loading ? "animate-spin" : undefined} />
                </button>
            </div>

            <div style={styles.addRow}>
                <input
                    className="field"
                    style={styles.addInput}
                    disabled={busy}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
                    aria-label="Agent name"
                    placeholder="Agent name, such as codex-laptop"
                />
                <Dropdown ariaLabel="Kind" className="field" style={styles.select} value={kind} disabled={busy}
                    onChange={(v) => setKind(v as ClientKind)} options={KIND_OPTIONS} />
                <Dropdown ariaLabel="Access level" className="field" style={styles.select} value={access} disabled={busy}
                    onChange={(v) => setAccess(v as AccessLevel)} options={ACCESS_OPTIONS} />
                <button className="btn" style={styles.square} onClick={add} disabled={busy || !name.trim()} title="Add agent">
                    <Plus size={15} />
                </button>
            </div>

            {error && <div role="alert" className="error" style={{ marginBottom: 10 }}>{error}</div>}

            {brief && (
                <div className="inset" style={styles.briefBox}>
                    <div style={styles.briefHead}>
                        Setup brief for <strong>{brief.name}</strong>. The claim inside it expires in 15 minutes
                        and is exchanged for the durable key by the agent itself.
                    </div>
                    <button
                        type="button"
                        className="btn"
                        style={{ alignSelf: "flex-start" }}
                        onClick={() => {
                            void navigator.clipboard.writeText(brief.text).then(() => {
                                setCopied(true);
                                setTimeout(() => setCopied(false), 2000);
                            }).catch(() => setError("Could not copy the setup brief. Check clipboard access and retry."));
                        }}
                    >
                        {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy brief"}
                    </button>
                </div>
            )}

            {loading && <p role="status" className="empty">Loading agents…</p>}
            <div className="list scroll" style={{ maxHeight: 340 }}>
                {clients.length === 0 && !loading && !error && (
                    <div className="empty">No agents yet. Add one to issue it a credential of its own.</div>
                )}
                {clients.map((c) => (
                    <div key={c.id} className="row" style={styles.row}>
                        <div className="row-head">
                            <span className="row-title">{c.displayName}</span>
                            <span className="pill">{c.kind.replace("_", " ")}</span>
                            <span className="meta" style={styles.grow}>{c.lastSeenAt ? ago(c.lastSeenAt) : "never seen"}</span>
                            <button className="icon-btn" onClick={() => reissue(c)} disabled={busy}
                                title="Issue a fresh claim">
                                <RefreshCw size={14} />
                            </button>
                            <button className="icon-btn" data-tone="danger" onClick={() => { setRevokeError(""); setRevocation({ kind: "agent", id: c.id, name: c.displayName }); }} disabled={busy}
                                aria-label={`Revoke agent ${c.displayName} and all its credentials`}
                                title="Revoke this agent and every key it holds">
                                <Trash2 size={14} />
                            </button>
                        </div>
                        {c.keys.length === 0 && (
                            <div className="meta">No live credentials. Its claim has not been exchanged yet.</div>
                        )}
                        {c.keys.map((k) => (
                            <div key={k.id} className="row-head" style={styles.keyRow}>
                                <span className="pill">
                                    {k.purpose === "council_seat"
                                        ? `seat: ${k.seatName ?? "?"}`
                                        : ACCESS_LABELS[k.accessLevel ?? "read"]}
                                </span>
                                <span className="meta">{ago(k.lastUsedAt)}</span>
                                <span className="meta" style={styles.grow}>
                                    {k.expiresAt ? `expires ${new Date(k.expiresAt).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" })}` : "no expiry"}
                                </span>
                                <button className="icon-btn" data-tone="danger" onClick={() => { setRevokeError(""); setRevocation({ kind: "key", id: k.id, name: c.displayName, credential: k.purpose === "council_seat" ? `seat key for ${k.seatName ?? "this council"}` : `${ACCESS_LABELS[k.accessLevel ?? "read"]} credential` }); }} disabled={busy}
                                    aria-label={`Revoke credential for ${c.displayName}`}
                                    title="Revoke this credential">
                                    <Trash2 size={14} />
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
    addRow: { display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" },
    addInput: { flex: "1 1 160px" },
    select: { flex: "0 1 150px", padding: "0 10px", background: "var(--surface)" },
    square: { width: 34, height: 34, padding: 0 },
    briefBox: { display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 },
    briefHead: { fontSize: 13, lineHeight: 1.5, color: "var(--ink)" },
    row: { display: "flex", flexDirection: "column", gap: 6 },
    grow: { flex: 1, minWidth: 0 },
    keyRow: { paddingLeft: 4 },
};
