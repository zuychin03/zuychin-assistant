"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, ChevronDown, ChevronRight, Play, Plus, Sparkles, Trash2 } from "lucide-react";
import { Dropdown } from "@/components/dropdown";
import { PURPOSE_TAGS } from "@/lib/ai/models/tags";
import ui from "./council.module.css";

// Starts a debate whose seats are chat models run by the server, so it needs
// no local host and works from a phone.

interface SeatOption {
    key: string; label: string; provider: string; providerId: string; free: boolean;
    speed: "fast" | "medium" | "slow" | "unknown"; tags: string[]; status: "new" | "missing" | null;
}
interface Options {
    freeOnly: boolean; purpose: string; models: SeatOption[]; suggestion: string[];
    rounds: { default: number; min: number; max: number };
}
interface SeatDraft { id: number; modelKey: string; name: string; expertise: string; source: string }

const MIN_SEATS = 2;
const MAX_SEATS = 5;
const AUTO_PURPOSES = PURPOSE_TAGS.filter((tag) => tag !== "vision");
let nextSeatId = 1;
const emptySeat = (): SeatDraft => ({ id: nextSeatId++, modelKey: "", name: "", expertise: "", source: "picker" });

function optionLabel(m: SeatOption): string {
    const bits = [m.provider, m.free ? null : "paid", m.speed !== "unknown" ? m.speed : null, m.status === "missing" ? "missing" : null];
    return `${m.label} · ${bits.filter(Boolean).join(" · ")}`;
}

export function OnlineCouncilPanel({ onStarted }: { onStarted: (code: string) => void }) {
    const [open, setOpen] = useState(false);
    const [options, setOptions] = useState<Options | null>(null);
    const [loadError, setLoadError] = useState("");
    const [purpose, setPurpose] = useState("reasoning");
    const [topic, setTopic] = useState("");
    const [brief, setBrief] = useState("");
    const [rounds, setRounds] = useState(4);
    const [allowPaid, setAllowPaid] = useState(false);
    const [seats, setSeats] = useState<SeatDraft[]>(() => [emptySeat(), emptySeat(), emptySeat()]);
    const [closerId, setCloserId] = useState<number | null>(null);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState("");
    const [started, setStarted] = useState("");

    const load = useCallback(async (forPurpose: string) => {
        setLoadError("");
        try {
            const res = await fetch(`/api/council/online/options?purpose=${encodeURIComponent(forPurpose)}`, { cache: "no-store" });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Could not list the models.");
            setOptions(data);
            setRounds((current) => current || data.rounds.default);
        } catch (reason) {
            setLoadError(reason instanceof Error ? reason.message : "Could not list the models.");
        }
    }, []);

    useEffect(() => { if (open) void load(purpose); }, [open, purpose, load]);

    const paidAllowed = allowPaid && options?.freeOnly === false;
    const choices = (options?.models ?? []).filter((m) => m.free || paidAllowed);
    const usable = new Set(choices.map((m) => m.key));
    const closer = seats.find((s) => s.id === closerId) ?? seats[0];

    const patch = (id: number, change: Partial<SeatDraft>) => setSeats((list) => list.map((s) => (s.id === id ? { ...s, ...change } : s)));

    const autoFill = () => {
        if (!options) return;
        const taken = new Set(seats.map((s) => s.modelKey).filter(Boolean));
        const picks = options.suggestion.filter((key) => !taken.has(key) && usable.has(key));
        const anyEmpty = seats.some((s) => !s.modelKey);
        setSeats((list) => list.map((s) => {
            if (anyEmpty && s.modelKey) return s;
            const key = picks.shift();
            return key ? { ...s, modelKey: key, source: `auto:${options.purpose}` } : s;
        }));
    };

    const start = async () => {
        const filled = seats.filter((s) => s.modelKey);
        if (!topic.trim() || !brief.trim()) { setError("An online council needs a topic and a brief."); return; }
        if (filled.length < MIN_SEATS) { setError(`Choose a model for at least ${MIN_SEATS} seats.`); return; }
        if (filled.some((s) => !usable.has(s.modelKey))) { setError("A chosen model is no longer offered. Pick another, or tick Allow paid for a paid one."); return; }
        const closerIndex = Math.max(0, filled.findIndex((s) => s.id === closer?.id));
        setError("");
        setStarting(true);
        try {
            const res = await fetch("/api/council/online", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    topic: topic.trim(), brief: brief.trim(), maxRounds: rounds, allowPaid: paidAllowed, closerIndex,
                    seats: filled.map((s) => ({
                        modelKey: s.modelKey, name: s.name.trim() || undefined, expertise: s.expertise.trim() || undefined, source: s.source,
                    })),
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "The online council could not be started.");
            setStarted(`${data.code} is running with ${data.seats.map((s: { name: string }) => s.name).join(", ")}; ${data.closerName} closes.`);
            setTopic(""); setBrief(""); setSeats([emptySeat(), emptySeat(), emptySeat()]); setCloserId(null);
            onStarted(data.code);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "The online council could not be started.");
        } finally {
            setStarting(false);
        }
    };

    const roundOptions = options ? Array.from({ length: options.rounds.max - options.rounds.min + 1 }, (_, i) => String(options.rounds.min + i)) : ["4"];

    return (
        <section className={ui.panel}>
            <div className={ui.panelHeadRow}>
                <div className={ui.panelHeader}>
                    <span className={ui.panelIcon}><Bot size={16} /></span>
                    <div className={ui.panelHeading}>
                        <h2 className={ui.panelTitle}>Online council</h2>
                        <p className={ui.panelDescription}>A debate between chat models, run by the server. No local host needed.</p>
                    </div>
                </div>
                <button type="button" onClick={() => setOpen((v) => !v)} className={ui.btn} aria-expanded={open}>
                    {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    {open ? "Hide" : "New online council"}
                </button>
            </div>

            {started && <p className={ui.formNote} role="status">{started}</p>}

            {open && (
                <div className={ui.conveneForm}>
                    {loadError && <div className={ui.notice} role="alert">{loadError} <button type="button" className={ui.btn} onClick={() => void load(purpose)}>Retry</button></div>}
                    <input aria-label="Online council topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="One decidable question" className={ui.input} maxLength={300} />
                    <textarea aria-label="Online council brief" value={brief} onChange={(e) => setBrief(e.target.value)}
                        placeholder="Everything the models need: constraints, what has been tried, what a good answer looks like"
                        className={`${ui.input} ${ui.textarea}`} maxLength={6000} />
                    <div className={ui.conveneRow}>
                        <label className={ui.fieldLabel}>Rounds
                            <Dropdown ariaLabel="Rounds" value={String(rounds)} onChange={(v) => setRounds(Number(v))} options={roundOptions} />
                        </label>
                        <label className={ui.fieldLabel}>Auto-fill for
                            <Dropdown ariaLabel="Auto-fill purpose" value={purpose} onChange={setPurpose} options={AUTO_PURPOSES.map((tag) => ({ value: tag }))} />
                        </label>
                        <button type="button" onClick={autoFill} disabled={!options} className={ui.btn} title="Fill empty seats with the best free models for this purpose, from different vendors">
                            <Sparkles size={15} /> Auto-fill
                        </button>
                        <label className={ui.checkLabel} title={options?.freeOnly ? "Free only is on in chat settings, so paid models stay off." : undefined}>
                            <input type="checkbox" checked={paidAllowed} disabled={!options || options.freeOnly} onChange={(e) => setAllowPaid(e.target.checked)} />
                            Allow paid{options?.freeOnly ? " (Free only is on)" : ""}
                        </label>
                    </div>

                    <div className={ui.seatGrid} role="group" aria-label="Seats">
                        {seats.map((seat, index) => (
                            <div key={seat.id} className={ui.seatRow}>
                                <Dropdown ariaLabel={`Model for seat ${index + 1}`} value={seat.modelKey}
                                    onChange={(modelKey) => patch(seat.id, { modelKey, source: "picker" })}
                                    options={[{ value: "", label: options ? "Choose a model" : "Loading models…" }, ...choices.map((m) => ({ value: m.key, label: optionLabel(m) }))]} />
                                <input aria-label={`Name for seat ${index + 1}`} value={seat.name} onChange={(e) => patch(seat.id, { name: e.target.value })}
                                    placeholder="Name" title="Defaults to the model's short name" className={ui.input} maxLength={40} />
                                <input aria-label={`Angle for seat ${index + 1}`} value={seat.expertise} onChange={(e) => patch(seat.id, { expertise: e.target.value })}
                                    placeholder="Angle" title="The view this seat argues from; each seat gets a different default" className={ui.input} maxLength={300} />
                                <label className={ui.checkLabel}>
                                    <input type="radio" name="online-closer" checked={closer?.id === seat.id} onChange={() => setCloserId(seat.id)} />
                                    Closer
                                </label>
                                <button type="button" className={`${ui.btn} ${ui.iconOnly}`} aria-label={`Remove seat ${index + 1}`}
                                    disabled={seats.length <= MIN_SEATS} onClick={() => setSeats((list) => list.filter((s) => s.id !== seat.id))}>
                                    <Trash2 size={15} />
                                </button>
                            </div>
                        ))}
                    </div>

                    <div className={ui.buttonRow}>
                        <button type="button" className={ui.btn} disabled={seats.length >= MAX_SEATS} onClick={() => setSeats((list) => [...list, emptySeat()])}>
                            <Plus size={15} /> Add seat
                        </button>
                        <button type="button" onClick={() => void start()} disabled={starting || !options} className={`${ui.btn} ${ui.primary}`}>
                            <Play size={15} /> {starting ? "Starting…" : "Start online council"}
                        </button>
                    </div>
                    {error && <div className={ui.notice} role="alert">{error}</div>}
                    <p className={ui.formNote}>
                        Round 1 openings are written blind and at the same time; later rounds take turns, one post per seat. The closer then writes the
                        verdict, and nothing is filed until you accept it. Seats only see the brief and the transcript: no tools, files or knowledge base.
                    </p>
                </div>
            )}
        </section>
    );
}
