"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, FileKey, KeyRound, Trash2 } from "lucide-react";
import { remoteAgentSetup } from "./remote-setup";
import { publicBaseUrl } from "@/lib/public-url";
import { Dropdown } from "@/components/dropdown";
import { ConfirmModal } from "../home/controls";


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
    const [keyStatus, setKeyStatus] = useState<"loading" | "ready" | "error">("loading");
    const keysReady = useRef(false);
    const loadVersion = useRef(0);
    const [seat, setSeat] = useState("");
    const [minted, setMinted] = useState<{ seatName: string; token: string; expiresAt: string } | null>(null);
    const [copied, setCopied] = useState(false);
    const [copiedBrief, setCopiedBrief] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [revokeSeat, setRevokeSeat] = useState<string | null>(null);
    const [replaceKey, setReplaceKey] = useState(false);

    const load = useCallback(async () => {
        const version = ++loadVersion.current;
        keysReady.current = false;
        setKeyStatus("loading");
        try {
            const res = await fetch(`/api/council/${encodeURIComponent(code)}/seat-key`);
            if (!res.ok) throw new Error("Could not load seat keys. Try again.");
            const data = await res.json() as { keys?: SeatKey[] };
            if (!Array.isArray(data.keys)) throw new Error("Invalid seat key list.");
            if (version !== loadVersion.current) return;
            setKeys(data.keys);
            keysReady.current = true;
            setKeyStatus("ready");
        } catch {
            if (version !== loadVersion.current) return;
            setKeyStatus("error");
            setError("Could not load seat keys. Try again.");
        }
    }, [code]);

    useEffect(() => { void load(); }, [load]);

    async function mint() {
        const seatName = seat.trim();
        if (!keysReady.current || !agentNames.includes(seatName) || busy) return;
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
            setReplaceKey(false);
        }
    }

    async function revoke(seatName: string) {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
            const response = await fetch(`/api/council/${encodeURIComponent(code)}/seat-key?seatName=${encodeURIComponent(seatName)}`, {
                method: "DELETE",
            });
            if (!response.ok) throw new Error("Could not revoke the key. Try again.");
            if (minted?.seatName === seatName) setMinted(null);
            await load();
        } catch {
            setError("Could not revoke the key. Try again.");
        } finally {
            setBusy(false);
            setRevokeSeat(null);
        }
    }

    const replacesExisting = keys.some((key) => key.seatName === seat && !key.revokedAt);

    return (
        <div style={styles.wrap}>
            <div style={styles.head}><KeyRound size={15} /><span>Guest seat keys</span></div>
            <div style={styles.note}>
                For agents that are not yours. A seat key reaches one seat in this council and expires with it,
                so hand one of these to a collaborator instead of your MCP key. Councils with a campaign get a
                7 day key, because the campaign phase runs on after the council closes.
            </div>

            <div style={styles.mintRow}>
                <Dropdown
                    value={seat}
                    onChange={setSeat}
                    options={agentNames.map((name) => ({ value: name, label: keys.some((key) => key.seatName === name && !key.revokedAt) ? `${name} (replace key)` : name }))}
                    ariaLabel="Guest seat"
                    placeholder={agentNames.length ? "Choose a seat" : "No agent seats"}
                    disabled={busy || keyStatus !== "ready" || agentNames.length === 0}
                    style={styles.input}
                />
                <button type="button" onClick={() => { if (!keysReady.current) return; if (replacesExisting) setReplaceKey(true); else void mint(); }} disabled={busy || keyStatus !== "ready" || !agentNames.includes(seat)} style={styles.mint}>
                    {busy && !revokeSeat ? "Issuing…" : replacesExisting ? "Replace key" : "Issue"}
                </button>
            </div>

            {keyStatus === "loading" && <div role="status" style={styles.note}>Loading seat keys…</div>}
            {error && <div role="alert" style={styles.error}>{error} <button type="button" style={styles.copy} disabled={busy || keyStatus === "loading"} onClick={() => { setError(""); void load(); }}>Refresh keys</button></div>}

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
                                }).catch(() => setError("Could not copy the key. Select and copy it manually."));
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
                                }).catch(() => setError("Could not copy the brief. Try copying the key instead."));
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
                                <button type="button" aria-label={`Revoke key for ${k.seatName}`} onClick={() => setRevokeSeat(k.seatName)} disabled={busy} style={styles.revoke}>
                                    <Trash2 size={12} />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}
            {replaceKey && <ConfirmModal title="Replace seat key?" body={`The current key for ${seat} will stop working. Copy the replacement before leaving this council.`}
                confirmLabel="Replace key" busyText={busy ? "Issuing replacement…" : undefined}
                onConfirm={() => void mint()} onCancel={() => setReplaceKey(false)} />}
            {revokeSeat && <ConfirmModal title="Revoke seat key?" body={`The key for ${revokeSeat} will stop working. You can issue a replacement afterwards.`}
                confirmLabel="Revoke key" busyText={busy ? "Revoking key…" : undefined}
                onConfirm={() => void revoke(revokeSeat)} onCancel={() => setRevokeSeat(null)} />}
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
    mintRow: { display: "flex", gap: 8, flexWrap: "wrap" },
    input: {
        flex: "1 1 180px", minWidth: 0, padding: "7px 10px", borderRadius: 9, fontSize: 13,
        fontFamily: "var(--font-family)",
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-text-muted) 30%, transparent)",
        background: "var(--color-background)", color: "var(--color-text-primary)",
    },
    mint: {
        minHeight: 40, padding: "7px 14px", borderRadius: "var(--radius-sm)", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-secondary) 45%, transparent)",
        background: "color-mix(in srgb, var(--color-secondary) 16%, transparent)",
        color: "var(--color-text-primary)",
    },
    error: { fontSize: 12, color: "var(--council-error)" },
    mintedBox: {
        display: "flex", flexDirection: "column", gap: 7, padding: 10, borderRadius: 10,
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--council-good) 45%, transparent)",
        background: "color-mix(in srgb, var(--council-good) 8%, transparent)",
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
    rowName: { fontWeight: 600, color: "var(--color-text-primary)", overflowWrap: "anywhere", minWidth: 0 },
    rowMeta: { flex: 1, color: "var(--color-text-muted)", fontSize: 11.5 },
    revoke: {
        display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: 40, minWidth: 40, padding: 4, borderRadius: 7, cursor: "pointer",
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--council-error) 40%, transparent)",
        background: "transparent", color: "var(--council-error)",
    },
};
