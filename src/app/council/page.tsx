"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    CheckCircle2, ChevronDown, Clock, Gavel, Maximize2, MessageSquare, Minimize2, RefreshCw, Users, XCircle,
} from "lucide-react";
import { WorkspaceShell } from "@/components/workspace-shell";
import { OwnerChannelPanel } from "./owner-channel-panel";
import { DecisionPanel } from "./decision-panel";
import { OnlineCouncilPanel } from "./online-council-panel";
import { RESEARCH_MARKER } from "@/lib/council/online/research";
import { ExecutionEvidence, ExecutionHistory, ExecutionRecord } from "./execution-evidence";
import type { CouncilExecutionPage, CouncilExecutionRecord } from "@/lib/council/execution-evidence";
import ui from "./council.module.css";

// Live view over councils. Read-only by construction: watching a debate must
// never advance it, so nothing here writes presence or claims the floor. Online
// councils run on the server; older local-host councils stay readable here.

const POLL_MS = 2500;
// Matches PARTICIPANT_STALE_SECONDS: past this an agent is out of the
// round-advance quorum, which is the thing worth seeing at a glance.
const STALE_SECONDS = 180;

interface OpenCouncil {
    code: string; topic: string; councilType: string; status: string; round: number; maxRounds: number;
    messages: number; lastMessageAt: string; closerName: string; expiresAt: string;
    /** Seats are catalogue models the server runs. */
    online?: boolean;
    waitingOn: string[]; participants: string[];
}
interface RecentCouncil {
    code: string; topic: string; councilType: string; status: string; round: number; maxRounds: number;
    messages: number; closerName: string; verdict: string | null;
    vaultPath: string | null; archiveStatus: string; closedAt: string | null;
}
interface Participant {
    name: string; kind: string; expertise: string; status: string;
    postsTotal: number; postsThisRound: number; lastSeenAt: string;
}
interface Message {
    seq: number; round: number; speaker: string; role: string; addressedTo: string;
    intent: string; replyToSeq: number | null; body: string; answered: boolean; createdAt: string;
    executionId: string | null;
}
interface Detail {
    session: {
        code: string; topic: string; councilType: string; brief: string; status: string; round: number;
        maxRounds: number; messages: number; closerName: string; lastMessageAt: string;
        expiresAt: string; verdict: string | null; openQuestions: string[];
        vaultPath: string | null; archiveStatus: string; floorHolder: string | null;
        paused: boolean; pausedAt: string | null;
        standbyExpiresAt: string | null; continueCount: number;
        protocolVersion: number; baseSha: string | null;
    };
    participants: Participant[];
    messages: Message[];
    executions: CouncilExecutionPage;
    online: {
        seats: { name: string; modelKey: string; label: string; available: boolean }[];
        runner: { state: "waiting_owner" | "ended" | "paused" | "running" | "restarting"; leaseExpiresAt: string | null };
    } | null;
    openObligations: { seq: number; from: string; to: string; intent: string }[];
}

function ago(iso: string): string {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
}

function until(iso: string): string {
    const m = Math.round((Date.parse(iso) - Date.now()) / 60000);
    return m <= 0 ? "expired" : `${m}m left`;
}

const INTENT_TONE: Record<string, "success" | "warning"> = {
    challenge: "warning",
    concede: "success",
    verdict: "success",
};

// One per --fam-* token in council.module.css.
const SEAT_COLOURS = 4;

type RunnerState = NonNullable<Detail["online"]>["runner"]["state"];
const RUNNER_LABEL: Record<RunnerState, string> = {
    running: "Running on the server",
    restarting: "Resuming after a restart",
    paused: "Paused",
    waiting_owner: "Waiting for your decision",
    ended: "Ended",
};
const RUNNER_TONE: Record<RunnerState, "success" | "warning" | undefined> = {
    running: "success", restarting: "warning", paused: "warning", waiting_owner: "warning", ended: undefined,
};

export default function CouncilPage() {
    const [open, setOpen] = useState<OpenCouncil[]>([]);
    const [recent, setRecent] = useState<RecentCouncil[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [detail, setDetail] = useState<Detail | null>(null);
    const [loading, setLoading] = useState(true);
    const [live, setLive] = useState(true);
    const [error, setError] = useState("");
    const [detailError, setDetailError] = useState("");
    const selectedRef = useRef({ code: selected });
    if (selectedRef.current.code !== selected) selectedRef.current = { code: selected };
    const detailInFlight = useRef<{ code: string | null } | null>(null);
    const [monitor, setMonitor] = useState(false);
    const monitorRef = useRef<HTMLDialogElement>(null);
    const transcriptEnd = useRef<HTMLDivElement | null>(null);
    const lastSeqRef = useRef(0);

    useEffect(() => {
        if (!monitor) return;
        const dialog = monitorRef.current;
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        dialog?.showModal();
        transcriptEnd.current?.scrollIntoView({ block: "end" });
        return () => {
            dialog?.close();
            document.body.style.overflow = previousOverflow;
            previousFocus?.focus({ preventScroll: true });
        };
    }, [monitor]);

    const fetchList = useCallback(async () => {
        try {
            const res = await fetch("/api/council");
            if (!res.ok) throw new Error("list failed");
            const data = await res.json();
            setOpen(data.open ?? []);
            setRecent(data.recent ?? []);
            setSelected((cur) => cur ?? data.open?.[0]?.code ?? data.recent?.[0]?.code ?? null);
            setError("");
        } catch {
            setError("Could not load councils.");
        } finally {
            setLoading(false);
        }
    }, []);

    const fetchDetail = useCallback(async (code: string) => {
        const selection = selectedRef.current;
        if (selection.code !== code || detailInFlight.current === selection) return;
        detailInFlight.current = selection;
        try {
            const res = await fetch(`/api/council/${encodeURIComponent(code)}`);
            const payload = await res.json();
            if (!res.ok) throw new Error(payload.error || "Could not load that council.");
            if (selectedRef.current !== selection) return;
            setDetail(payload);
            setDetailError("");
        } catch (reason) {
            if (selectedRef.current !== selection) return;
            setDetailError(reason instanceof Error ? reason.message : "Could not load that council.");
        } finally {
            if (detailInFlight.current === selection) detailInFlight.current = null;
        }
    }, []);

    useEffect(() => { fetchList(); }, [fetchList]);

    useEffect(() => {
        if (!selected) return;
        fetchDetail(selected);
        if (!live) return;
        const id = setInterval(() => {
            fetchDetail(selected);
            fetchList();
        }, POLL_MS);
        return () => clearInterval(id);
    }, [selected, live, fetchDetail, fetchList]);

    // Only follow the tail when something new actually arrived, so scrolling
    // back to read an argument is not yanked away on the next poll.
    useEffect(() => {
        const last = detail?.messages.at(-1)?.seq ?? 0;
        if (last > lastSeqRef.current) {
            lastSeqRef.current = last;
            transcriptEnd.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "end" });
        }
    }, [detail]);

    const s = detail?.session;
    const executionRecords = [...(detail?.executions?.records ?? []), ...(detail?.executions?.referencedRecords ?? [])];
    const isRunning = s?.status === "open" || s?.status === "concluding";
    const agentSeats = new Map((detail?.participants ?? []).filter((p) => p.kind === "agent").map((p, index) => [p.name, index % SEAT_COLOURS]));
    const presence = (p: Participant) => p.status === "left" ? undefined
        : (Date.now() - Date.parse(p.lastSeenAt)) / 1000 > STALE_SECONDS ? "warning" : "success";
    const selectCouncil = (code: string) => {
        if (selected === code) return;
        setDetailError(""); setDetail(null); lastSeqRef.current = 0; setSelected(code);
    };

    return (
        <WorkspaceShell
            current="council"
            title="Council"
            description="Watch chat models debate. Viewing never advances a turn."
            actions={<>
                <button type="button" onClick={() => setLive((v) => !v)} aria-pressed={live} className={ui.liveToggle}>
                    <RefreshCw size={15} className={live ? ui.spin : undefined} />
                    {live ? "Live" : "Paused"}
                </button>
                {s && detail && <a href="#council-transcript" aria-label={`View transcript for ${s.code}`}><ChevronDown size={15} /> View transcript</a>}
            </>}
        >
            <div className={ui.council}>
                <OnlineCouncilPanel onStarted={(code) => { void fetchList(); selectCouncil(code); }} />

                {error && <div className={ui.notice} role="alert">{error} <button type="button" className={ui.btn} onClick={() => void fetchList()}>Retry councils</button></div>}

                {loading && (
                    <div className={ui.loading} role="status"><Clock size={16} /> Loading councils…</div>
                )}

                {!loading && !error && open.length === 0 && recent.length === 0 && (
                    <section className={ui.panel}>
                        <PanelHeader title="No councils yet" description="Nothing has been convened" icon={<Users size={16} />} />
                        <div className={ui.emptyText}>
                            Start a council above, or ask Zuychin in chat:
                            <em>&ldquo;start a council on X&rdquo;</em>. Then watch it here.
                        </div>
                    </section>
                )}

                {!loading && (open.length > 0 || recent.length > 0) && (
                    <div className={ui.split}>
                        <div className={ui.rail}>
                            <section className={ui.railGroup}>
                                <div className={ui.railHead}>
                                    <h2>Open</h2>
                                    <p>{open.length} running</p>
                                </div>
                                {open.length === 0 && <div className={ui.railEmpty}>None running.</div>}
                                {open.map((c) => (
                                    <button
                                        key={c.code}
                                        type="button"
                                        aria-pressed={selected === c.code}
                                        onClick={() => selectCouncil(c.code)}
                                        className={ui.railItem}
                                    >
                                        <span className={ui.railTop}>
                                            <span className={ui.railTitle}>{c.topic}</span>
                                            <time className={ui.railTime} dateTime={c.lastMessageAt}>{ago(c.lastMessageAt)}</time>
                                        </span>
                                        <span className={ui.railMeta}>
                                            <code>{c.code}</code>{c.online ? "" : " · local"} · {c.messages} {c.messages === 1 ? "msg" : "msgs"}
                                            {` · r${c.round}/${c.maxRounds}`}
                                            {/* expires_at stops governing once a verdict is proposed;
                                                standby_expires_at does, and it is not in this payload. */}
                                            {c.status !== "awaiting_owner" && <> · {until(c.expiresAt)}</>}
                                        </span>
                                        {c.status === "awaiting_owner" && <span className={ui.railSignal}>decision needed</span>}
                                        {c.waitingOn.length > 0 && (
                                            <span className={ui.railWaiting}>waiting on {c.waitingOn.join(", ")}</span>
                                        )}
                                    </button>
                                ))}
                            </section>

                            <section className={ui.railGroup}>
                                <div className={ui.railHead}>
                                    <h2>Recent</h2>
                                    <p>Closed and expired</p>
                                </div>
                                {recent.length === 0 && <div className={ui.railEmpty}>Nothing closed yet.</div>}
                                {recent.map((c) => (
                                    <button
                                        key={c.code}
                                        type="button"
                                        aria-pressed={selected === c.code}
                                        onClick={() => selectCouncil(c.code)}
                                        className={ui.railItem}
                                    >
                                        <span className={ui.railTop}>
                                            <span className={ui.railTitle}>{c.topic}</span>
                                            {c.closedAt && <time className={ui.railTime} dateTime={c.closedAt}>{ago(c.closedAt)}</time>}
                                        </span>
                                        <span className={ui.railMeta}>
                                            <code>{c.code}</code> · {c.status} · {c.messages} {c.messages === 1 ? "msg" : "msgs"} · {c.round} {c.round === 1 ? "round" : "rounds"}
                                        </span>
                                    </button>
                                ))}
                            </section>
                        </div>

                        <div className={ui.main}>
                            {detailError && <div className={ui.notice} role="alert">{detailError} <button type="button" className={ui.btn} onClick={() => { if (selected) { setDetailError(""); void fetchDetail(selected); } }}>Retry transcript</button></div>}
                            {!detail && !detailError && <div className={ui.loading} role="status"><Clock size={16} /> Loading transcript…</div>}

                            {s && detail && (
                                <>
                                    <section className={ui.panel}>
                                        <div className={ui.detailHead}>
                                            <h2 className={ui.detailTitle}>{s.topic}</h2>
                                            <p className={ui.detailMeta}>
                                                <code>{s.code}</code> · {detail.online ? "" : "local "}{s.councilType} council · {s.paused ? "stalled" : s.status} · round {s.round} of {s.maxRounds} · {s.messages} {s.messages === 1 ? "message" : "messages"} · closer {s.closerName}
                                            </p>
                                        </div>
                                        {detail.online && (
                                            <div className={ui.pillRow}>
                                                <span className={ui.pill} data-tone={RUNNER_TONE[detail.online.runner.state]}>{RUNNER_LABEL[detail.online.runner.state]}</span>
                                            </div>
                                        )}
                                        <p className={ui.brief}>{s.brief}</p>
                                        {s.status === "awaiting_owner" && (
                                            <DecisionPanel
                                                code={s.code}
                                                verdict={s.verdict}
                                                openQuestions={s.openQuestions}
                                                standbyExpiresAt={s.standbyExpiresAt}
                                                continueCount={s.continueCount}
                                                onDecided={() => { void fetchDetail(s.code); }}
                                            />
                                        )}
                                        {isRunning && (
                                            <OwnerChannelPanel
                                                code={s.code}
                                                paused={s.paused}
                                                onStateChange={() => { void fetchDetail(s.code); }}
                                            />
                                        )}
                                        <div className={ui.list}>
                                            {detail.participants.filter((p) => p.kind === "agent").map((p) => {
                                                const latestRun = detail.executions?.records.find(record => record.agentName === p.name);
                                                const seatModel = detail.online?.seats.find((seat) => seat.name === p.name);
                                                return (
                                                    <div key={p.name} className={ui.row}>
                                                        <span className={ui.dot} data-tone={presence(p)} />
                                                        <span className={ui.name}>
                                                            {p.name}
                                                            {p.name === s.closerName && <span className={ui.pill}>closer</span>}
                                                            {s.floorHolder === p.name && <span className={ui.pill} data-tone="success">has floor</span>}
                                                            {seatModel && <span className={ui.pill} data-tone={seatModel.available ? undefined : "warning"} title={seatModel.modelKey}>{seatModel.label}{seatModel.available ? "" : " (no longer offered)"}</span>}
                                                        </span>
                                                        <span className={ui.rowMeta}>
                                                            {p.postsThisRound}/{detail.online ? 1 : 2} this round · {p.postsTotal} total · seen {ago(p.lastSeenAt)} ago
                                                        </span>
                                                        <div className={ui.wide}>
                                                            {latestRun ? <ExecutionRecord record={latestRun} label="Latest recorded run" />
                                                                : <span className={ui.evidenceState}>{detail.executions?.historyStatus === "available" ? "No run in loaded history" : "Run history unavailable"}</span>}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                        {detail.executions && <ExecutionHistory key={s.code} code={s.code} page={detail.executions} onRetry={() => void fetchDetail(s.code)} />}
                                        {detail.openObligations.length > 0 && (
                                            <div className={ui.subBlock}>
                                                <div className={ui.subHead}>Unanswered</div>
                                                {detail.openObligations.map((o) => (
                                                    <div key={o.seq} className={ui.obligationRow}>
                                                        seq {o.seq} · {o.from} → <strong>{o.to}</strong> ({o.intent})
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </section>

                                    {s.verdict && (
                                        <section className={ui.panel}>
                                            <PanelHeader
                                                title="Verdict"
                                                description={`by ${s.closerName}`}
                                                icon={<Gavel size={16} />}
                                            />
                                            <div className={ui.verdict}>{s.verdict}</div>
                                            {s.openQuestions.length > 0 && (
                                                <div className={ui.subBlock}>
                                                    <div className={ui.subHead}>Open questions</div>
                                                    <ul className={ui.questions}>
                                                        {s.openQuestions.map((q, i) => <li key={i}>{q}</li>)}
                                                    </ul>
                                                </div>
                                            )}
                                            <div className={ui.filedRow}>
                                                <span className={ui.pill} data-tone={s.archiveStatus === "filed" ? "success" : undefined}>
                                                    {s.archiveStatus === "filed" ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                                                    {s.archiveStatus}
                                                </span>
                                                <span className={ui.path}>
                                                    {s.vaultPath ? <code>{s.vaultPath}</code> : "not filed"}
                                                    {s.vaultPath && <span className={ui.untrusted}> · untrusted draft, promote with vault_ingest</span>}
                                                </span>
                                            </div>
                                        </section>
                                    )}

                                    <section className={ui.panel}>
                                        <div className={ui.panelHeadRow}>
                                            <PanelHeader
                                                headingId="council-transcript"
                                                title="Transcript"
                                                description={isRunning ? `live · quiet ${ago(s.lastMessageAt)}` : "final"}
                                                icon={<MessageSquare size={16} />}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setMonitor(true)}
                                                className={ui.btn}
                                                title="Fullscreen monitor (Esc to exit)"
                                            >
                                                <Maximize2 size={15} /> Monitor
                                            </button>
                                        </div>
                                        <div className={ui.transcript}>
                                            {detail.messages.map((m) => <MessageRow key={m.seq} m={m} executions={executionRecords} seat={agentSeats.get(m.speaker)} />)}
                                            {detail.messages.length === 0 && <div className={ui.emptyText}>Nothing said yet.</div>}
                                            <div ref={monitor ? undefined : transcriptEnd} />
                                        </div>
                                    </section>
                                </>
                            )}
                        </div>
                    </div>
                )}

                {monitor && (
                    <dialog ref={monitorRef} className={ui.monitor} aria-label="Council monitor" onCancel={(event) => { event.preventDefault(); setMonitor(false); }}>
                        <div className={ui.monitorBar}>
                            <div className={ui.monitorHeading}>
                                <div className={ui.monitorTitle}>{s ? `${s.code} · ${s.topic}` : "Council monitor"}</div>
                                {s && (
                                    <div className={ui.monitorMeta}>
                                        {s.status} · round {s.round} of {s.maxRounds} · {s.messages} {s.messages === 1 ? "message" : "messages"}
                                        {isRunning ? ` · quiet ${ago(s.lastMessageAt)}` : ""}
                                        {s.floorHolder ? ` · floor ${s.floorHolder}` : ""}
                                    </div>
                                )}
                            </div>
                            <div className={ui.monitorActions}>
                                {(detail?.participants ?? []).filter((p) => p.kind === "agent").map((p) => (
                                    <span key={p.name} className={ui.monitorAgent}>
                                        <span className={ui.dot} data-tone={presence(p)} />
                                        {p.name}
                                        {s?.floorHolder === p.name && <span className={ui.pill} data-tone="success">floor</span>}
                                    </span>
                                ))}
                                <button
                                    type="button"
                                    onClick={() => setLive((v) => !v)}
                                    aria-pressed={live}
                                    className={`${ui.btn} ${ui.liveToggle}`}
                                >
                                    <RefreshCw size={15} className={live ? ui.spin : undefined} />
                                    {live ? "Live" : "Paused"}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setMonitor(false)}
                                    className={ui.btn}
                                    title="Exit fullscreen (Esc)"
                                >
                                    <Minimize2 size={15} /> Exit
                                </button>
                            </div>
                        </div>

                        <div className={ui.monitorFeed}>
                            {detailError && <div className={ui.notice} role="alert">{detailError} <button type="button" className={ui.btn} onClick={() => { if (selected) { setDetailError(""); void fetchDetail(selected); } }}>Retry transcript</button></div>}
                            {!detail && !detailError && <div className={ui.loading} role="status"><Clock size={16} /> Loading transcript…</div>}
                            {detail && (
                                <div className={ui.monitorInner}>
                                    {detail.messages.map((m) => <MessageRow key={m.seq} m={m} executions={executionRecords} seat={agentSeats.get(m.speaker)} />)}
                                    {detail.messages.length === 0 && <div className={ui.emptyText}>Nothing said yet.</div>}
                                    <div ref={transcriptEnd} />
                                </div>
                            )}
                        </div>
                    </dialog>
                )}
            </div>
        </WorkspaceShell>
    );
}

// Shared by the inline transcript and the monitor overlay so the two views can
// never drift apart.
function MessageRow({ m, executions, seat }: { m: Message; executions: CouncilExecutionRecord[]; seat?: number }) {
    const isPack = m.role === "moderator" && m.round === 1 && m.body.startsWith(RESEARCH_MARKER);
    return (
        <div className={ui.msg}>
            <div className={ui.msgHead}>
                <span className={ui.dot} data-seat={m.role === "agent" ? seat : undefined} />
                <span className={ui.speaker}>{m.speaker}</span>
                {m.role !== "agent" && <span className={ui.msgMuted}>{m.role}</span>}
                {m.addressedTo !== "all" && <span className={ui.msgMuted}>→ {m.addressedTo}</span>}
                <span className={ui.pill} data-tone={INTENT_TONE[m.intent]}>{isPack ? "sources" : m.intent}</span>
                {m.replyToSeq && <span className={ui.msgMuted}>re {m.replyToSeq}</span>}
                {!m.answered && ["challenge", "ask"].includes(m.intent) && m.addressedTo !== "all" && (
                    <span className={ui.pill} data-tone="warning">unanswered</span>
                )}
                <span className={ui.msgTime}>#{m.seq} · r{m.round} · {ago(m.createdAt)} ago</span>
            </div>
            <div className={m.role === "agent" ? ui.msgBody : `${ui.msgBody} ${ui.msgNote}`}>
                {m.body}
            </div>
            {m.role === "agent" && <ExecutionEvidence executionId={m.executionId} records={executions} />}
        </div>
    );
}

function PanelHeader({ title, description, icon, headingId }: {
    title: string;
    description: string;
    icon: React.ReactNode;
    headingId?: string;
}) {
    return (
        <div className={ui.panelHeader}>
            <span className={ui.panelIcon}>{icon}</span>
            <div className={ui.panelHeading}>
                <h2 id={headingId} tabIndex={headingId ? -1 : undefined} className={ui.panelTitle}>{title}</h2>
                <p className={ui.panelDescription}>{description}</p>
            </div>
        </div>
    );
}
