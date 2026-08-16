"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, FileKey, KeyRound, Trash2 } from "lucide-react";
import { remoteAgentSetup } from "./remote-setup";
import { publicBaseUrl } from "@/lib/public-url";

// Mints the credential a guest agent pastes into the remote brief. The
// plaintext is shown once and never again - re-issue rather than trying to
// recover one - so the copy buttons are the only thing that matters here.

interface SeatKey {
    seatName: string;
    issuedAt: string;
    expiresAt: string;
    claimedAt: string | null;
    revokedAt: string | null;
}

function expiryLabel(iso: string): string {
    const ms = Date.parse(iso) - Date.now();
    if (!Number.isFinite(ms)) return "";
    if (ms <= 0) return "expired";
    const hours = Math.round(ms / 3600_000);
    if (hours < 48) return `expires in ${hours}h`;
    return `expires in ${Math.round(hours / 24)}d`;
}

export function SeatKeysPanel({ code, agentNames }: { code: string; agentNames: string[] }) {
    const [keys, setKeys] = useState<SeatKey[]>([]);
    const [seat, setSeat] = useState("");
    const [minted, setMinted] = useState<{ seatName: string; token: string; expiresAt: string } | null>(null);
    const [copied, setCopied] = useState(false);
    const [copiedBrief, setCopiedBrief] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/council/${encodeURIComponent(code)}/seat-key`);
            if (!res.ok) return;
            const data = await res.json() as { keys?: SeatKey[] };
            setKeys(data.keys ?? []);
        } catch { /* supplementary panel; a failed read must not break the page */ }
    }, [code]);

    useEffect(() => { void load(); }, [load]);

    async function mint() {
        const seatName = seat.trim();
        if (!seatName || busy) return;
        setBusy(true);
        setError("");
        try {
            const res = await fetch(`/api/council/${encodeURIComponent(code)}/seat-key`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ seatName }),
            });
            const data = await res.json() as { token?: string; seatName?: string; expiresAt?: string; error?: string };
            if (!res.ok || !data.token) {
                setError(data.error ?? "Could not issue a key.");
                return;
            }
            setMinted({
                seatName: data.seatName ?? seatName,
                token: data.token,
                expiresAt: data.expiresAt ?? "",
            });
            setSeat("");
            await load();
        } catch {
            setError("Could not issue a key.");
        } finally {
            setBusy(false);
        }
    }

    async function revoke(seatName: string) {
        if (busy) return;
        setBusy(true);
        try {
            await fetch(`/api/council/${encodeURIComponent(code)}/seat-key?seatName=${encodeURIComponent(seatName)}`, {
                method: "DELETE",
            });
            if (minted?.seatName === seatName) setMinted(null);
            await load();
        } finally {
            setBusy(false);
        }
    }

    const unkeyed = agentNames.filter((n) => !keys.some((k) => k.seatName === n && !k.revokedAt));

    return (
        <div style={styles.wrap}>
            <div style={styles.head}><KeyRound size={15} /><span>Guest seat keys</span></div>
            <div style={styles.note}>
                For agents that are not yours. A seat key reaches one seat in this council and expires with it,
                so hand one of these to a collaborator instead of your MCP key. Councils with a campaign get a
                7 day key, because the campaign phase runs on after the council closes.
            </div>

            <div style={styles.mintRow}>
                <input
                    value={seat}
                    onChange={(e) => setSeat(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void mint(); } }}
                    placeholder="Seat name on the roster"
                    list={`seats-${code}`}
                    style={styles.input}
                />
                <datalist id={`seats-${code}`}>
                    {unkeyed.map((n) => <option key={n} value={n} />)}
                </datalist>
                <button type="button" onClick={mint} disabled={busy || !seat.trim()} style={styles.mint}>
                    Issue
                </button>
            </div>

            {error && <div style={styles.error}>{error}</div>}

            {minted && (
                <div style={styles.mintedBox}>
                    <div style={styles.mintedHead}>
                        Key for <strong>{minted.seatName}</strong>, shown once. Copy it now.
                        {minted.expiresAt && <span style={styles.rowMeta}> {expiryLabel(minted.expiresAt)}</span>}
                    </div>
                    <code style={styles.token}>{minted.token}</code>
                    <div style={styles.mintedActions}>
                        <button
                            type="button"
                            onClick={() => {
                                void navigator.clipboard.writeText(minted.token).then(() => {
                                    setCopied(true);
                                    setTimeout(() => setCopied(false), 2000);
                                });
                            }}
                            style={styles.copy}
                        >
                            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy key"}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                const brief = remoteAgentSetup(
                                    `${publicBaseUrl(window.location.origin)}/api/mcp/mcp`, minted.token,
                                );
                                void navigator.clipboard.writeText(brief).then(() => {
                                    setCopiedBrief(true);
                                    setTimeout(() => setCopiedBrief(false), 2000);
                                });
                            }}
                            style={styles.copy}
                        >
                            {copiedBrief ? <Check size={13} /> : <FileKey size={13} />}
                            {copiedBrief ? "Copied" : "Copy brief with key"}
                        </button>
                    </div>
                </div>
            )}

            {keys.length > 0 && (
                <div style={styles.list}>
                    {keys.map((k) => (
                        <div key={k.seatName} style={styles.row}>
                            <span style={styles.rowName}>{k.seatName}</span>
                            <span style={styles.rowMeta}>
                                {k.revokedAt ? "revoked" : k.claimedAt ? "in use" : "not used yet"}
                                {!k.revokedAt && ` · ${expiryLabel(k.expiresAt)}`}
                            </span>
                            {!k.revokedAt && (
                                <button type="button" onClick={() => revoke(k.seatName)} disabled={busy} style={styles.revoke}>
                                    <Trash2 size={12} />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    wrap: {
        display: "flex", flexDirection: "column", gap: 9, padding: 14, borderRadius: 14,
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-text-muted) 25%, transparent)",
        background: "color-mix(in srgb, var(--color-text-muted) 5%, var(--color-surface))",
    },
    head: {
        display: "flex", alignItems: "center", gap: 7,
        fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)",
    },
    note: { fontSize: 11.5, color: "var(--color-text-muted)", lineHeight: 1.5 },
    mintRow: { display: "flex", gap: 8 },
    input: {
        flex: 1, padding: "7px 10px", borderRadius: 9, fontSize: 13,
        fontFamily: "var(--font-family)",
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-text-muted) 30%, transparent)",
        background: "var(--color-background)", color: "var(--color-text-primary)",
    },
    mint: {
        padding: "7px 14px", borderRadius: 999, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-secondary) 45%, transparent)",
        background: "color-mix(in srgb, var(--color-secondary) 16%, transparent)",
        color: "var(--color-text-primary)",
    },
    error: { fontSize: 12, color: "#e5484d" },
    mintedBox: {
        display: "flex", flexDirection: "column", gap: 7, padding: 10, borderRadius: 10,
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, #31d07f 45%, transparent)",
        background: "color-mix(in srgb, #31d07f 8%, transparent)",
    },
    mintedHead: { fontSize: 12, color: "var(--color-text-primary)" },
    mintedActions: { display: "flex", flexWrap: "wrap", gap: 7 },
    token: {
        fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 11.5,
        wordBreak: "break-all", lineHeight: 1.5, color: "var(--color-text-primary)",
    },
    copy: {
        alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 6,
        padding: "5px 11px", borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: "pointer",
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-text-muted) 35%, transparent)",
        background: "transparent", color: "var(--color-text-primary)",
    },
    list: { display: "flex", flexDirection: "column", gap: 5 },
    row: { display: "flex", alignItems: "center", gap: 9, fontSize: 12.5 },
    rowName: { fontWeight: 600, color: "var(--color-text-primary)" },
    rowMeta: { flex: 1, color: "var(--color-text-muted)", fontSize: 11.5 },
    revoke: {
        display: "inline-flex", alignItems: "center", padding: 4, borderRadius: 7, cursor: "pointer",
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, #e5484d 40%, transparent)",
        background: "transparent", color: "#e5484d",
    },
};
