"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { NotebookPen, RotateCcw, Send } from "lucide-react";
import { Dropdown } from "@/components/dropdown";
import ui from "./council.module.css";

interface OwnerNote {
    id: string;
    agentName: string | null;
    body: string;
    createdAt: string;
    delivered: Record<string, string>;
}

const ALL_SEATS = "";
const REFRESH_MS = 15_000;

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// Notes reach seats only through the work campaign (heartbeat, task claim and the
// host's campaign prompt). They are never debate messages.
export function OwnerNotesPanel({ code, seats }: { code: string; seats: string[] }) {
    const [notes, setNotes] = useState<OwnerNote[]>([]);
    const [text, setText] = useState("");
    const [target, setTarget] = useState(ALL_SEATS);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const endRef = useRef<HTMLDivElement | null>(null);
    const count = useRef(0);

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/council/${encodeURIComponent(code)}/notes`);
            const data = await res.json().catch(() => ({})) as { installed?: boolean; notes?: OwnerNote[] };
            if (!res.ok) return;
            setNotes(data.notes ?? []);
            if (data.installed === false) setError("Owner notes need scripts/migrations/council-owner-notes.sql applied in Supabase first.");
        } catch { /* supplementary; a failed read must not break the page */ }
    }, [code]);

    // Delivery happens on the seats' own schedule, so the state is polled.
    useEffect(() => {
        void load();
        const id = setInterval(() => { void load(); }, REFRESH_MS);
        return () => clearInterval(id);
    }, [load]);
    useEffect(() => {
        if (notes.length > count.current) endRef.current?.scrollIntoView({ block: "nearest" });
        count.current = notes.length;
    }, [notes]);

    async function send() {
        const body = text.trim();
        if (!body || busy) return;
        setBusy(true);
        setError("");
        try {
            const res = await fetch(`/api/council/${encodeURIComponent(code)}/notes`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: body, agent: target || null }),
            });
            const data = await res.json().catch(() => ({})) as { notes?: OwnerNote[]; error?: string };
            if (!res.ok) {
                setError(data.error ?? "That note did not send.");
                return;
            }
            setText("");
            setNotes(data.notes ?? []);
        } catch {
            setError("That note did not send.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={ui.subBlock}>
            <div className={ui.subHead}>
                <span className={ui.subTitle}>
                    <NotebookPen size={15} />
                    <span>Note to agents</span>
                </span>
            </div>
            <div className={ui.subNote}>
                A seat reads it at its next heartbeat, task claim or campaign prompt, marked as coming from you through the server.
            </div>

            <div className={ui.thread}>
                {notes.length === 0 && (
                    <div className={ui.emptyText}>
                        Steer the campaign without reopening the debate: a correction, a priority, a file to leave alone.
                    </div>
                )}
                {notes.map((note) => {
                    const targets = note.agentName ? [note.agentName] : seats;
                    return (
                        <div key={note.id} className={ui.bubble} data-role="owner">
                            <div className={ui.bubbleBody}>{note.body}</div>
                            <div className={ui.relayed}>
                                {[
                                    note.agentName ? `To ${note.agentName}` : "To all seats",
                                    clock(note.createdAt),
                                    targets.map((seat) => `${seat} ${note.delivered[seat] ? `read ${clock(note.delivered[seat])}` : "waiting"}`).join(", "),
                                ].join(" · ")}
                            </div>
                        </div>
                    );
                })}
                <div ref={endRef} />
            </div>

            {error && <div className={ui.errorText} role="alert">{error}</div>}

            <div className={`${ui.composer} ${ui.composerWrap}`}>
                <Dropdown
                    ariaLabel="Note recipient"
                    value={target}
                    onChange={setTarget}
                    options={[{ value: ALL_SEATS, label: "All seats" }, ...seats.map((seat) => ({ value: seat }))]}
                    style={{ flex: "0 1 140px" }}
                />
                <textarea aria-label="Note to agents"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void send();
                        }
                    }}
                    placeholder="Write a note for the seats…"
                    maxLength={4000}
                    rows={2}
                    className={`${ui.input} ${ui.textarea}`}
                />
                <button type="button" aria-label="Send note to agents" onClick={send} disabled={busy || !text.trim()} className={`${ui.btn} ${ui.iconOnly}`}>
                    <Send size={14} />
                </button>
            </div>
        </div>
    );
}

export function RequeueButton({ code, itemId, onDone }: { code: string; itemId: string; onDone: () => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function requeue() {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
            const res = await fetch(`/api/council/${encodeURIComponent(code)}/work/${encodeURIComponent(itemId)}/requeue`, { method: "POST" });
            const data = await res.json().catch(() => ({})) as { error?: string };
            if (!res.ok) {
                setError(data.error ?? "Could not requeue the task.");
                return;
            }
            onDone();
        } catch {
            setError("Could not requeue the task.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <button type="button" onClick={requeue} disabled={busy} className={`${ui.btn} ${ui.small}`}
                title="Send this task back to its seat with a fresh set of attempts. A seat the host gave up on restarts.">
                <RotateCcw size={14} /> {busy ? "Requeueing…" : "Requeue"}
            </button>
            {error && <span className={`${ui.detail} ${ui.errorText}`} role="alert">{error}</span>}
        </>
    );
}
