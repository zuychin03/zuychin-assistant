"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, Pause, Play, Send, Megaphone } from "lucide-react";

interface OwnerMessage {
    id: string;
    role: "owner" | "zuychin";
    body: string;
    relayedSeq: number | null;
    createdAt: string;
}

interface TurnResponse {
    reply?: string;
    action?: string;
    relay?: { addressedTo: string; directive: string; seq?: number } | null;
    paused?: boolean;
    thread?: OwnerMessage[];
    error?: string;
}

export function OwnerChannelPanel({ code, paused, onStateChange }: {
    code: string;
    paused: boolean;
    onStateChange: () => void;
}) {
    const [thread, setThread] = useState<OwnerMessage[]>([]);
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const endRef = useRef<HTMLDivElement | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/council/${encodeURIComponent(code)}/owner`);
            if (!res.ok) return;
            const data = await res.json() as { thread?: OwnerMessage[] };
            setThread(data.thread ?? []);
        } catch { /* the panel is supplementary; a failed read must not break the page */ }
    }, [code]);

    useEffect(() => { void load(); }, [load]);
    useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [thread]);

    async function send() {
        const body = text.trim();
        if (!body || busy) return;
        setBusy(true);
        setError("");
        // Optimistic so the input clears immediately; the server's copy replaces
        // this as soon as the turn returns.
        setThread((t) => [...t, {
            id: `pending-${Date.now()}`, role: "owner", body, relayedSeq: null,
            createdAt: new Date().toISOString(),
        }]);
        setText("");
        try {
            const res = await fetch(`/api/council/${encodeURIComponent(code)}/owner`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: body }),
            });
            const data = await res.json() as TurnResponse;
            if (!res.ok) {
                setError(data.error ?? "That did not send.");
                await load();
                return;
            }
            setThread(data.thread ?? []);
            onStateChange();
        } catch {
            setError("That did not send.");
            await load();
        } finally {
            setBusy(false);
        }
    }

    async function togglePause() {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
            const res = await fetch(`/api/council/${encodeURIComponent(code)}/pause`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ resume: paused }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({})) as { error?: string };
                setError(data.error ?? "Could not change the council.");
                return;
            }
            onStateChange();
        } catch {
            setError("Could not change the council.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div style={styles.wrap}>
            <div style={styles.head}>
                <div style={styles.headTitle}>
                    <MessageSquare size={15} />
                    <span>You and Zuychin</span>
                </div>
                <button type="button" onClick={togglePause} disabled={busy} style={{ ...styles.action, ...(paused ? styles.resumeAction : {}) }}>
                    {paused ? <Play size={14} /> : <Pause size={14} />}
                    {paused ? "Resume" : "Stall"}
                </button>
            </div>
            <div style={styles.note}>
                Private. The agents never see this — only what Zuychin decides to relay.
                {paused && <strong style={styles.pausedNote}> The council is stalled.</strong>}
            </div>

            <div style={styles.thread}>
                {thread.length === 0 && (
                    <div style={styles.empty}>
                        Ask what it makes of the debate, or tell it to stall the room while you think.
                    </div>
                )}
                {thread.map((m) => (
                    <div key={m.id} style={{ ...styles.bubble, ...(m.role === "owner" ? styles.mine : styles.theirs) }}>
                        <div style={styles.bubbleBody}>{m.body}</div>
                        {m.relayedSeq !== null && (
                            <div style={styles.relayed}>
                                <Megaphone size={11} /> Relayed to the council as seq {m.relayedSeq}
                            </div>
                        )}
                    </div>
                ))}
                <div ref={endRef} />
            </div>

            {error && <div style={styles.error}>{error}</div>}

            <div style={styles.composer}>
                <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void send();
                        }
                    }}
                    placeholder="Tell Zuychin what you think…"
                    rows={2}
                    style={styles.input}
                />
                <button type="button" onClick={send} disabled={busy || !text.trim()} style={styles.send}>
                    <Send size={14} />
                </button>
            </div>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    wrap: {
        display: "flex", flexDirection: "column", gap: 10, padding: 14,
        borderRadius: 14,
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-secondary) 28%, transparent)",
        background: "color-mix(in srgb, var(--color-secondary) 6%, var(--color-surface))",
    },
    head: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 },
    headTitle: {
        display: "flex", alignItems: "center", gap: 7,
        fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)",
    },
    action: {
        display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px",
        borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: "pointer",
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-text-muted) 35%, transparent)",
        background: "transparent", color: "var(--color-text-primary)",
    },
    resumeAction: { color: "#31d07f", borderColor: "color-mix(in srgb, #31d07f 45%, transparent)" },
    note: { fontSize: 11.5, color: "var(--color-text-muted)", lineHeight: 1.5 },
    pausedNote: { color: "#e0a33e" },
    thread: {
        display: "flex", flexDirection: "column", gap: 8,
        maxHeight: 300, overflowY: "auto", paddingRight: 4,
    },
    empty: { fontSize: 12.5, color: "var(--color-text-muted)", padding: "10px 2px", lineHeight: 1.5 },
    bubble: { maxWidth: "88%", padding: "8px 11px", borderRadius: 12, fontSize: 13, lineHeight: 1.5 },
    mine: {
        alignSelf: "flex-end",
        background: "color-mix(in srgb, var(--color-secondary) 20%, transparent)",
    },
    theirs: {
        alignSelf: "flex-start",
        background: "color-mix(in srgb, var(--color-text-muted) 12%, transparent)",
    },
    bubbleBody: { whiteSpace: "pre-wrap", wordBreak: "break-word" },
    relayed: {
        display: "flex", alignItems: "center", gap: 5, marginTop: 5,
        fontSize: 11, color: "var(--color-text-muted)",
    },
    error: { fontSize: 12, color: "#e5484d" },
    composer: { display: "flex", gap: 8, alignItems: "flex-end" },
    input: {
        flex: 1, resize: "none", padding: "8px 10px", borderRadius: 10, fontSize: 13,
        fontFamily: "var(--font-family)", lineHeight: 1.5,
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-text-muted) 30%, transparent)",
        background: "var(--color-background)", color: "var(--color-text-primary)",
    },
    send: {
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 34, height: 34, borderRadius: 10, cursor: "pointer",
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-secondary) 45%, transparent)",
        background: "color-mix(in srgb, var(--color-secondary) 18%, transparent)",
        color: "var(--color-text-primary)",
    },
};
