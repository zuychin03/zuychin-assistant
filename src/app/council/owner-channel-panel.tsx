"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, Pause, Play, Send, Megaphone } from "lucide-react";
import ui from "./council.module.css";

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
        <div className={ui.subBlock}>
            <div className={`${ui.subHead} ${ui.subHeadSpread}`}>
                <span className={ui.subTitle}>
                    <MessageSquare size={15} />
                    <span>You and Zuychin</span>
                </span>
                <button type="button" onClick={togglePause} disabled={busy} className={`${ui.btn} ${ui.small}`}>
                    {paused ? <Play size={14} /> : <Pause size={14} />}
                    {paused ? "Resume" : "Stall"}
                </button>
            </div>
            <div className={ui.subNote}>
                Private. The agents never see this — only what Zuychin decides to relay.
                {paused && <strong> The council is stalled.</strong>}
            </div>

            <div className={ui.thread}>
                {thread.length === 0 && (
                    <div className={ui.emptyText}>
                        Ask what it makes of the debate, or tell it to stall the room while you think.
                    </div>
                )}
                {thread.map((m) => (
                    <div key={m.id} className={ui.bubble} data-role={m.role}>
                        <div className={ui.bubbleBody}>{m.body}</div>
                        {m.relayedSeq !== null && (
                            <div className={ui.relayed}>
                                <Megaphone size={11} /> Relayed to the council as seq {m.relayedSeq}
                            </div>
                        )}
                    </div>
                ))}
                <div ref={endRef} />
            </div>

            {error && <div className={ui.errorText} role="alert">{error}</div>}

            <div className={ui.composer}>
                <textarea aria-label="Private message to Zuychin"
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
                    className={`${ui.input} ${ui.textarea}`}
                />
                <button type="button" aria-label="Send private message" onClick={send} disabled={busy || !text.trim()} className={`${ui.btn} ${ui.iconOnly}`}>
                    <Send size={14} />
                </button>
            </div>
        </div>
    );
}
