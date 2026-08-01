"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
    Activity, Brain, CheckCircle2, ChevronDown, ChevronRight, Clock, Copy, Cpu, GitBranch,
    Gavel, Maximize2, MessageSquare, Minimize2, Play, Plug, RefreshCw, ShieldCheck, Square,
    Laptop, Users, XCircle,
} from "lucide-react";
import {
    findHost, forgetHost, pair, trimActivity, HostClient,
    type HostActivity, type HostConnection, type HostSnapshot,
} from "./host-client";
import { remoteAgentSetup } from "./remote-setup";

// Live view over a council, plus control of the local ACP host when one is
// reachable. The Zuychin half stays read-only by construction: watching a
// debate must never advance it, so nothing here writes presence or claims the
// floor. Everything that drives agents goes through the loopback host instead.

const POLL_MS = 2500;
// Matches PARTICIPANT_STALE_SECONDS: past this an agent is out of the
// round-advance quorum, which is the thing worth seeing at a glance.
const STALE_SECONDS = 180;

interface OpenCouncil {
    code: string; topic: string; councilType: string; status: string; round: number; maxRounds: number;
    messages: number; lastMessageAt: string; closerName: string; expiresAt: string;
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
}
interface Detail {
    session: {
        code: string; topic: string; councilType: string; brief: string; status: string; round: number;
        maxRounds: number; messages: number; closerName: string; lastMessageAt: string;
        expiresAt: string; verdict: string | null; openQuestions: string[];
        vaultPath: string | null; archiveStatus: string; floorHolder: string | null;
    };
    participants: Participant[];
    messages: Message[];
    openObligations: { seq: number; from: string; to: string; intent: string }[];
    campaign: {
        id: string; status: string; repoPath: string; baseBranch: string; completedAt: string | null;
        workItems: { id: string; sequence: number; agentName: string; title: string; status: string; heartbeatAt: string | null; progress: string | null; commitHash: string | null; verification: string | null; blockedReason: string | null }[];
    } | null;
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

const INTENT_TONE: Record<string, string> = {
    challenge: "#ff8f6b",
    ask: "#ffd166",
    answer: "#31d07f",
    concede: "#31d07f",
    propose: "#7aa2ff",
    refine: "#7aa2ff",
    pass: "#5f6368",
    moderate: "#c792ea",
    verdict: "#31d07f",
};

export default function CouncilPage() {
    const [open, setOpen] = useState<OpenCouncil[]>([]);
    const [recent, setRecent] = useState<RecentCouncil[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [detail, setDetail] = useState<Detail | null>(null);
    const [loading, setLoading] = useState(true);
    const [live, setLive] = useState(true);
    const [error, setError] = useState("");
    // The rail needs ~240px beside a readable transcript; below this the split
    // is stacked instead of squeezed.
    const [isNarrow, setIsNarrow] = useState(false);
    const [monitor, setMonitor] = useState(false);
    const transcriptEnd = useRef<HTMLDivElement | null>(null);
    const lastSeqRef = useRef(0);

    const [hostState, setHostState] = useState<HostConnection>("probing");
    const [hostPort, setHostPort] = useState<number | null>(null);
    const [host, setHost] = useState<HostSnapshot | null>(null);
    const [activity, setActivity] = useState<HostActivity[]>([]);
    const [hostError, setHostError] = useState("");
    const [pairCode, setPairCode] = useState("");
    const [convening, setConvening] = useState(false);
    const [adopting, setAdopting] = useState<string | null>(null);
    const [showRemote, setShowRemote] = useState(false);
    const [copied, setCopied] = useState(false);
    const [origin, setOrigin] = useState("");
    const [form, setForm] = useState({ topic: "", brief: "", agents: "", closer: "", councilType: "code" });
    const clientRef = useRef<HostClient | null>(null);

    const connect = useCallback((port: number, token: string) => {
        clientRef.current?.close();
        const client = new HostClient(port, token, {
            onState: (snapshot) => {
                setHost(snapshot);
                setHostState("connected");
                if (snapshot.code) { setAdopting(null); setConvening(false); }
            },
            onActivity: (item) => setActivity((list) => trimActivity([...list, item])),
            onError: (detail) => { setHostError(detail); setAdopting(null); setConvening(false); },
            onClose: () => { setHostState("observing"); setHost(null); },
        });
        clientRef.current = client;
        client.open();
    }, []);

    // Once on mount, never on a timer: a denied Local Network Access permission
    // cannot be re-requested programmatically, so retrying achieves nothing.
    const probeHost = useCallback(async () => {
        setHostState("probing");
        setHostError("");
        const found = await findHost();
        if (!found) { setHostState("absent"); setHostPort(null); return; }
        setHostPort(found.port);
        if (!found.token) { setHostState("unpaired"); return; }
        connect(found.port, found.token);
    }, [connect]);

    useEffect(() => {
        void probeHost();
        return () => clientRef.current?.close();
    }, [probeHost]);

    const submitPairing = useCallback(async () => {
        if (!hostPort) return;
        const token = await pair(hostPort, pairCode);
        if (!token) { setHostError("That pairing code was not accepted."); return; }
        setPairCode("");
        setHostError("");
        connect(hostPort, token);
    }, [hostPort, pairCode, connect]);

    const submitConvene = useCallback(() => {
        const agents = form.agents.split(",").map((a) => a.trim()).filter(Boolean);
        if (form.topic.trim().length === 0 || form.brief.trim().length === 0 || agents.length < 2) {
            setHostError("A council needs a topic, a brief and at least two agents.");
            return;
        }
        const closer = form.closer.trim() || agents[0];
        if (!agents.includes(closer)) { setHostError(`Closer "${closer}" is not one of ${agents.join(", ")}.`); return; }
        setHostError("");
        setConvening(true);
        clientRef.current?.convene({ topic: form.topic.trim(), brief: form.brief.trim(), agents, closer, councilType: form.councilType });
        setTimeout(() => setConvening(false), 8000);
    }, [form]);

    useEffect(() => setOrigin(window.location.origin), []);

    useEffect(() => {
        const check = () => setIsNarrow(window.innerWidth < 900);
        check();
        window.addEventListener("resize", check);
        return () => window.removeEventListener("resize", check);
    }, []);

    // The overlay covers the page, so the page behind it must not scroll under
    // the feed, and Esc has to be an exit or there is no way back on a TV.
    useEffect(() => {
        if (!monitor) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMonitor(false); };
        const previous = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        window.addEventListener("keydown", onKey);
        transcriptEnd.current?.scrollIntoView({ block: "end" });
        return () => {
            document.body.style.overflow = previous;
            window.removeEventListener("keydown", onKey);
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
        try {
            const res = await fetch(`/api/council/${encodeURIComponent(code)}`);
            if (!res.ok) return;
            setDetail(await res.json());
            setError("");
        } catch {
            setError("Could not load that council.");
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
            transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
        }
    }, [detail]);

    const s = detail?.session;
    const isRunning = s?.status === "open" || s?.status === "concluding";
    // One host owns one council, so Adopt is offered only while it owns none.
    const canAdopt = hostState === "connected" && !!host && !host.code;
    const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(origin);
    const remoteBrief = remoteAgentSetup(`${origin || "https://your-deployment"}/api/mcp/mcp`);

    return (
        <div style={{ ...styles.shell, ...(isNarrow ? styles.shellNarrow : {}) }}>
            <div style={styles.ambientOne} />
            <div style={styles.ambientTwo} />

            <header style={{ ...styles.header, ...(isNarrow ? styles.headerNarrow : {}) }}>
                <div>
                    <div style={styles.kicker}>zuychin-council</div>
                    <h1 style={{ ...styles.title, ...(isNarrow ? styles.titleNarrow : {}) }}>Council</h1>
                    <p style={styles.subtitle}>
                        Live debates between your coding agents. This view is read-only - it never
                        marks anyone present and never changes whose turn it is.
                    </p>
                </div>
                <div style={styles.headerActions}>
                    <span style={{ ...styles.quickLink, ...(hostState === "connected" ? styles.liveOn : styles.hostChipOff) }}>
                        <Plug size={15} />
                        {hostState === "connected" ? `local host :${hostPort}` : hostState === "probing" ? "looking for a host" : "observing via Zuychin"}
                    </span>
                    <button
                        type="button"
                        onClick={() => setLive((v) => !v)}
                        style={{ ...styles.quickLink, ...(live ? styles.liveOn : {}) }}
                    >
                        <RefreshCw size={15} style={live ? styles.spin : undefined} />
                        {live ? "Live" : "Paused"}
                    </button>
                </div>
            </header>

            <div style={styles.quickActions}>
                <Link href="/" style={styles.quickLink}><MessageSquare size={15} /> Chat</Link>
                <Link href="/knowledge" style={styles.quickLink}><Brain size={15} /> Knowledge</Link>
                <Link href="/graph" style={styles.quickLink}><GitBranch size={15} /> Graph</Link>
                <Link href="/admin" style={styles.quickLink}><ShieldCheck size={15} /> Dashboard</Link>
            </div>

            <section style={styles.panel}>
                <div style={styles.panelHeadRow}>
                    <PanelHeader
                        title="Local host"
                        description={
                            hostState === "connected"
                                ? `${host?.agents.length ?? 0} agents · ${host?.code ?? "idle"} · ${host?.repo ?? ""}`
                                : hostState === "unpaired"
                                    ? `a host is running on port ${hostPort} but this browser is not paired with it`
                                    : hostState === "probing"
                                        ? `probing 127.0.0.1:${8787}-8791`
                                        : "no host reachable on this machine"
                        }
                        icon={<Cpu size={16} />}
                    />
                    {hostState !== "connected" && (
                        <button type="button" onClick={() => void probeHost()} style={styles.quickLink}>
                            <RefreshCw size={15} /> Retry
                        </button>
                    )}
                    {hostState === "connected" && (
                        <button
                            type="button"
                            onClick={() => { clientRef.current?.stop(); forgetHost(); }}
                            style={{ ...styles.quickLink, ...styles.dangerLink }}
                            title="Stop the host and every agent it owns"
                        >
                            <Square size={14} /> Stop host
                        </button>
                    )}
                </div>

                {hostError && <div style={styles.errorBox}>{hostError}</div>}

                {hostState === "absent" && (
                    <div style={styles.emptyText}>
                        Observing through Zuychin. Agents can still join by hand, but nothing here can
                        start one, mediate its file access or push it a turn. To take control, run{" "}
                        <code style={styles.code}>npx tsx --env-file=.env.local scripts/council-host.mts --repo &lt;path&gt;</code>{" "}
                        on the machine holding the repo, then Retry.
                        <br />
                        On a phone, or from the deployed site with the local-network prompt denied,
                        this is the only mode available - there is no host to reach.
                    </div>
                )}

                {hostState === "unpaired" && (
                    <div style={styles.pairRow}>
                        <span style={styles.emptyText}>Enter the pairing code the host printed:</span>
                        <input
                            value={pairCode}
                            onChange={(e) => setPairCode(e.target.value.toUpperCase())}
                            placeholder="ABCD2345"
                            maxLength={8}
                            style={{ ...styles.input, maxWidth: 160, letterSpacing: 2 }}
                        />
                        <button type="button" onClick={() => void submitPairing()} style={styles.quickLink}>Pair</button>
                    </div>
                )}

                {hostState === "connected" && host && (
                    <>
                        {host.permissions.length > 0 && (
                            <div style={styles.permissionQueue}>
                                <div style={styles.obligationsTitle}>Waiting on you</div>
                                {host.permissions.map((p) => (
                                    <div key={p.id} style={styles.permissionRow}>
                                        <span style={{ ...styles.smallPill, ...styles.pillWarn }}>{p.kind}</span>
                                        <span style={styles.rosterName}>{p.agent}</span>
                                        <span style={styles.permissionTitle}>{p.title}</span>
                                        <span style={styles.permissionButtons}>
                                            <button type="button" onClick={() => clientRef.current?.replyToPermission(p.id, true)} style={styles.quickLink}>Allow</button>
                                            <button type="button" onClick={() => clientRef.current?.replyToPermission(p.id, false)} style={{ ...styles.quickLink, ...styles.dangerLink }}>Deny</button>
                                        </span>
                                        <span style={styles.workDetail}>{p.path ?? ""}{p.path ? " · " : ""}{p.reason} · denied automatically after 120s</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {host.agents.length > 0 && (
                            <div style={styles.roster}>
                                {host.agents.map((a) => (
                                    <div key={a.name} style={styles.workRow}>
                                        <span style={{
                                            ...styles.dot,
                                            background: a.state === "failed" || a.state === "exited"
                                                ? "#ff8f6b"
                                                : a.state === "busy" ? "#ffd166" : "#31d07f",
                                        }} />
                                        <span style={styles.rosterName}>{a.name}</span>
                                        <span style={{ ...styles.smallPill, ...(a.mode === "acp" ? styles.pillGood : styles.pillMuted) }}>{a.mode}</span>
                                        <span style={{ ...styles.smallPill, ...styles.pillMuted }}>{a.state}</span>
                                        {host.floorHolder === a.name && <span style={{ ...styles.tag, ...styles.tagFloor }}>has floor</span>}
                                        <span style={styles.rosterMeta}>{a.detail}</span>
                                        <span style={styles.workDetail}>{a.branch} · {a.worktree}</span>
                                        {a.warn && <span style={{ ...styles.workDetail, color: "#ffd166" }}>! {a.warn}</span>}
                                    </div>
                                ))}
                            </div>
                        )}

                        {activity.length > 0 && (
                            <div style={styles.activityFeed}>
                                {activity.slice().reverse().map((item, i) => (
                                    <div key={`${item.at}-${i}`} style={styles.activityRow}>
                                        <span style={styles.activityAgent}>{item.agent}</span>
                                        <span style={styles.activityKind}>{item.kind}</span>
                                        <span style={styles.activityDetail}>{item.detail.slice(0, 240)}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {!host.code && (
                            <div style={styles.conveneForm}>
                                <div style={styles.obligationsTitle}>Convene</div>
                                <input
                                    value={form.topic}
                                    onChange={(e) => setForm({ ...form, topic: e.target.value })}
                                    placeholder="One decidable question"
                                    style={styles.input}
                                />
                                <textarea
                                    value={form.brief}
                                    onChange={(e) => setForm({ ...form, brief: e.target.value })}
                                    placeholder="Context every agent needs: constraints, what has been tried, what a good answer looks like"
                                    style={{ ...styles.input, minHeight: 80, resize: "vertical" }}
                                />
                                <div style={styles.conveneRow}>
                                    <input
                                        value={form.agents}
                                        onChange={(e) => setForm({ ...form, agents: e.target.value })}
                                        placeholder="claude-a, codex-1"
                                        style={styles.input}
                                    />
                                    <input
                                        value={form.closer}
                                        onChange={(e) => setForm({ ...form, closer: e.target.value })}
                                        placeholder="closer (defaults to the first)"
                                        style={styles.input}
                                    />
                                    <select
                                        value={form.councilType}
                                        onChange={(e) => setForm({ ...form, councilType: e.target.value })}
                                        style={styles.input}
                                    >
                                        {["debate", "code", "research", "audit", "debug"].map((t) => <option key={t} value={t}>{t}</option>)}
                                    </select>
                                    <button type="button" onClick={submitConvene} disabled={convening} style={{ ...styles.quickLink, ...(convening ? styles.hostChipOff : {}) }}>
                                        <Play size={15} /> {convening ? "Convening…" : "Convene"}
                                    </button>
                                </div>
                                <div style={styles.workDetail}>
                                    Names must exist in scripts/council-agents.json. Each gets its own worktree off{" "}
                                    {host.repo}, and every file and terminal call it makes is checked against that worktree.
                                </div>
                            </div>
                        )}
                    </>
                )}
            </section>

            <section style={styles.panel}>
                <div style={styles.panelHeadRow}>
                    <PanelHeader
                        title="Agents on other machines"
                        description="A brief they can self-configure from, so they can join a council by code"
                        icon={<Laptop size={16} />}
                    />
                    <button type="button" onClick={() => setShowRemote((v) => !v)} style={styles.quickLink}>
                        {showRemote ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        {showRemote ? "Hide" : "Show brief"}
                    </button>
                </div>

                {showRemote && (
                    <>
                        <div style={styles.emptyText}>
                            Paste this into a coding agent on another device. It joins over MCP by hand and
                            never touches the local host, so it needs no ACP adapter - but its council name
                            must be on the roster when the council is convened, and must NOT be one this
                            machine has configured, or the host would claim that seat first.
                            {isLoopback && (
                                <>
                                    <br />
                                    <strong>You are viewing this on localhost, so the URL below points at this
                                    machine.</strong> Open this page on your deployed site before copying, or
                                    swap the host in by hand.
                                </>
                            )}
                            <br />
                            Replace <code style={styles.code}>&lt;PASTE_DUY&apos;S_MCP_API_KEY_HERE&gt;</code> with
                            your read-write MCP key. It is never shown here.
                        </div>
                        <div style={styles.remoteActions}>
                            <button
                                type="button"
                                onClick={() => {
                                    void navigator.clipboard.writeText(remoteBrief).then(() => {
                                        setCopied(true);
                                        setTimeout(() => setCopied(false), 2000);
                                    });
                                }}
                                style={{ ...styles.quickLink, ...(copied ? styles.liveOn : {}) }}
                            >
                                {copied ? <CheckCircle2 size={15} /> : <Copy size={15} />}
                                {copied ? "Copied" : "Copy brief"}
                            </button>
                        </div>
                        <pre style={styles.remoteBrief}>{remoteBrief}</pre>
                    </>
                )}
            </section>

            {loading && (
                <div style={styles.loadingCard}><Clock size={16} /> Loading councils…</div>
            )}

            {!loading && open.length === 0 && recent.length === 0 && (
                <section style={styles.panel}>
                    <PanelHeader title="No councils yet" description="Nothing has been convened" icon={<Users size={16} />} />
                    <div style={styles.emptyText}>
                        Ask Zuychin to convene one: <em>&ldquo;convene a council on X with codex and
                        claude-code; claude-code closes it&rdquo;</em>. Paste each generated block into
                        that agent, then watch here.
                    </div>
                </section>
            )}

            {!loading && (open.length > 0 || recent.length > 0) && (
                <div style={{ ...styles.split, ...(isNarrow ? styles.splitNarrow : {}) }}>
                    <div style={styles.rail}>
                        <section style={styles.panel}>
                            <PanelHeader
                                title="Open"
                                description={`${open.length} running`}
                                icon={<Activity size={16} />}
                            />
                            {open.length === 0 && <div style={styles.emptyText}>None running.</div>}
                            {open.map((c) => (
                                <div key={c.code}>
                                    <button
                                        type="button"
                                        onClick={() => { setDetail(null); lastSeqRef.current = 0; setSelected(c.code); }}
                                        style={{
                                            ...styles.railItem,
                                            ...(selected === c.code ? styles.railItemActive : {}),
                                            ...(canAdopt ? styles.railItemAdoptable : {}),
                                        }}
                                    >
                                        <div style={styles.railTop}>
                                            <span style={styles.railCode}>{c.code}</span>
                                            <span style={{ ...styles.smallPill, ...styles.pillGood }}>
                                                r{c.round}/{c.maxRounds}
                                            </span>
                                        </div>
                                        <div style={styles.railTopic}>{c.topic}</div>
                                        <div style={styles.railMeta}>
                                            {c.messages} msgs · quiet {ago(c.lastMessageAt)} · {until(c.expiresAt)}
                                        </div>
                                        {c.waitingOn.length > 0 && (
                                            <div style={styles.railWaiting}>waiting on {c.waitingOn.join(", ")}</div>
                                        )}
                                    </button>
                                    {canAdopt && (
                                        <button
                                            type="button"
                                            onClick={() => { setHostError(""); setAdopting(c.code); clientRef.current?.attach(c.code); }}
                                            disabled={adopting !== null}
                                            style={{ ...styles.railAdopt, ...(adopting ? styles.hostChipOff : {}) }}
                                            title="Hand this council to the local host. It starts every participant it has configured, and leaves alone any that someone is already driving by hand."
                                        >
                                            <Plug size={13} /> {adopting === c.code ? "Adopting…" : "Adopt"}
                                        </button>
                                    )}
                                </div>
                            ))}
                        </section>

                        <section style={styles.panel}>
                            <PanelHeader title="Recent" description="Closed and expired" icon={<Gavel size={16} />} />
                            {recent.length === 0 && <div style={styles.emptyText}>Nothing closed yet.</div>}
                            {recent.map((c) => (
                                <button
                                    key={c.code}
                                    type="button"
                                    onClick={() => { setDetail(null); lastSeqRef.current = 0; setSelected(c.code); }}
                                    style={{ ...styles.railItem, ...(selected === c.code ? styles.railItemActive : {}) }}
                                >
                                    <div style={styles.railTop}>
                                        <span style={styles.railCode}>{c.code}</span>
                                        <span style={{ ...styles.smallPill, ...styles.pillMuted }}>{c.status}</span>
                                    </div>
                                    <div style={styles.railTopic}>{c.topic}</div>
                                    <div style={styles.railMeta}>{c.messages} msgs · {c.round} rounds</div>
                                </button>
                            ))}
                        </section>
                    </div>

                    <div style={styles.main}>
                        {error && <div style={styles.errorBox}>{error}</div>}
                        {!detail && <div style={styles.loadingCard}><Clock size={16} /> Loading transcript…</div>}

                        {s && detail && (
                            <>
                                <section style={styles.panel}>
                                    <PanelHeader
                                        title={`${s.code} - ${s.topic}`}
                                        description={`${s.status} · round ${s.round} of ${s.maxRounds} · ${s.messages} messages · closer ${s.closerName}`}
                                        icon={<Users size={16} />}
                                    />
                                    <div style={styles.brief}><strong>{s.councilType} council</strong><br />{s.brief}</div>
                                    <div style={styles.roster}>
                                        {detail.participants.filter((p) => p.kind === "agent").map((p) => {
                                            const stale = (Date.now() - Date.parse(p.lastSeenAt)) / 1000 > STALE_SECONDS;
                                            const isFloor = s.floorHolder === p.name;
                                            return (
                                                <div key={p.name} style={styles.rosterRow}>
                                                    <span style={{ ...styles.dot, background: p.status === "left" ? "#5f6368" : stale ? "#ff8f6b" : "#31d07f" }} />
                                                    <span style={styles.rosterName}>
                                                        {p.name}
                                                        {p.name === s.closerName && <span style={styles.tag}>closer</span>}
                                                        {isFloor && <span style={{ ...styles.tag, ...styles.tagFloor }}>has floor</span>}
                                                    </span>
                                                    <span style={styles.rosterMeta}>
                                                        {p.postsThisRound}/2 this round · {p.postsTotal} total · seen {ago(p.lastSeenAt)} ago
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                    {detail.openObligations.length > 0 && (
                                        <div style={styles.obligations}>
                                            <div style={styles.obligationsTitle}>Unanswered</div>
                                            {detail.openObligations.map((o) => (
                                                <div key={o.seq} style={styles.obligationRow}>
                                                    seq {o.seq} · {o.from} → <strong>{o.to}</strong> ({o.intent})
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </section>

                                {s.verdict && (
                                    <section style={styles.panel}>
                                        <PanelHeader
                                            title="Verdict"
                                            description={`by ${s.closerName}`}
                                            icon={<Gavel size={16} />}
                                        />
                                        <div style={styles.verdict}>{s.verdict}</div>
                                        {s.openQuestions.length > 0 && (
                                            <div style={styles.openQ}>
                                                <div style={styles.obligationsTitle}>Open questions</div>
                                                {s.openQuestions.map((q, i) => <div key={i} style={styles.obligationRow}>· {q}</div>)}
                                            </div>
                                        )}
                                        <div style={styles.filedRow}>
                                            <span style={{ ...styles.smallPill, ...(s.archiveStatus === "filed" ? styles.pillGood : styles.pillMuted) }}>
                                                {s.archiveStatus === "filed" ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                                                {s.archiveStatus}
                                            </span>
                                            <span style={styles.filedPath}>
                                                {s.vaultPath ?? "not filed"}
                                                {s.vaultPath && <span style={styles.untrusted}> · untrusted draft, promote with vault_ingest</span>}
                                            </span>
                                        </div>
                                    </section>
                                )}

                                {detail.campaign && (
                                    <section style={styles.panel}>
                                        <PanelHeader
                                            title="Work campaign"
                                            description={detail.campaign.status + " - " + detail.campaign.workItems.filter((item) => item.status === "verified").length + "/" + detail.campaign.workItems.length + " verified"}
                                            icon={<GitBranch size={16} />}
                                        />
                                        <div style={styles.filedPath}>{detail.campaign.repoPath} - base {detail.campaign.baseBranch}</div>
                                        <div style={styles.roster}>
                                            {detail.campaign.workItems.map((item) => (
                                                <div key={item.id} style={styles.workRow}>
                                                    <span style={styles.seq}>{item.sequence}</span>
                                                    <span style={styles.rosterName}>{item.agentName}</span>
                                                    <span style={{ ...styles.smallPill, ...(item.status === "verified" ? styles.pillGood : item.status === "blocked" ? styles.pillWarn : styles.pillMuted) }}>{item.status}</span>
                                                    <span style={styles.workTitle}>{item.title}</span>
                                                    {item.blockedReason && <span style={styles.workDetail}>{item.blockedReason}</span>}
                                                    {!item.blockedReason && item.progress && <span style={styles.workDetail}>{item.progress}</span>}
                                                </div>
                                            ))}
                                        </div>
                                    </section>
                                )}

                                <section style={styles.panel}>
                                    <div style={styles.panelHeadRow}>
                                        <PanelHeader
                                            title="Transcript"
                                            description={isRunning ? `live · quiet ${ago(s.lastMessageAt)}` : "final"}
                                            icon={<MessageSquare size={16} />}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setMonitor(true)}
                                            style={styles.quickLink}
                                            title="Fullscreen monitor (Esc to exit)"
                                        >
                                            <Maximize2 size={15} /> Monitor
                                        </button>
                                    </div>
                                    <div style={styles.transcript}>
                                        {detail.messages.map((m) => <MessageRow key={m.seq} m={m} />)}
                                        {detail.messages.length === 0 && <div style={styles.emptyText}>Nothing said yet.</div>}
                                        <div ref={monitor ? undefined : transcriptEnd} />
                                    </div>
                                </section>
                            </>
                        )}
                    </div>
                </div>
            )}

            {monitor && (
                <div style={styles.monitorOverlay} role="dialog" aria-label="Council monitor">
                    <div style={styles.monitorBar}>
                        <div style={{ minWidth: 0 }}>
                            <div style={styles.monitorTitle}>{s ? `${s.code} · ${s.topic}` : "Council monitor"}</div>
                            {s && (
                                <div style={styles.monitorMeta}>
                                    {s.status} · round {s.round} of {s.maxRounds} · {s.messages} messages
                                    {isRunning ? ` · quiet ${ago(s.lastMessageAt)}` : ""}
                                    {s.floorHolder ? ` · floor ${s.floorHolder}` : ""}
                                </div>
                            )}
                        </div>
                        <div style={styles.monitorActions}>
                            {(detail?.participants ?? []).filter((p) => p.kind === "agent").map((p) => (
                                <span key={p.name} style={styles.monitorAgent}>
                                    <span style={{
                                        ...styles.dot,
                                        background: p.status === "left"
                                            ? "#5f6368"
                                            : (Date.now() - Date.parse(p.lastSeenAt)) / 1000 > STALE_SECONDS ? "#ff8f6b" : "#31d07f",
                                    }} />
                                    {p.name}
                                    {s?.floorHolder === p.name && <span style={{ ...styles.tag, ...styles.tagFloor }}>floor</span>}
                                </span>
                            ))}
                            <button
                                type="button"
                                onClick={() => setLive((v) => !v)}
                                style={{ ...styles.quickLink, ...(live ? styles.liveOn : {}) }}
                            >
                                <RefreshCw size={15} style={live ? styles.spin : undefined} />
                                {live ? "Live" : "Paused"}
                            </button>
                            <button
                                type="button"
                                onClick={() => setMonitor(false)}
                                style={styles.quickLink}
                                title="Exit fullscreen (Esc)"
                            >
                                <Minimize2 size={15} /> Exit
                            </button>
                        </div>
                    </div>

                    <div style={styles.monitorFeed}>
                        {!detail && <div style={styles.loadingCard}><Clock size={16} /> Loading transcript…</div>}
                        {detail && (
                            <div style={styles.monitorInner}>
                                {detail.messages.map((m) => <MessageRow key={m.seq} m={m} />)}
                                {detail.messages.length === 0 && <div style={styles.emptyText}>Nothing said yet.</div>}
                                <div ref={transcriptEnd} />
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

// Shared by the inline transcript and the monitor overlay so the two views can
// never drift apart.
function MessageRow({ m }: { m: Message }) {
    return (
        <div style={styles.msg}>
            <div style={styles.msgHead}>
                <span style={styles.seq}>{m.seq}</span>
                <span style={styles.speaker}>{m.speaker}</span>
                {m.addressedTo !== "all" && <span style={styles.arrow}>→ {m.addressedTo}</span>}
                <span style={{ ...styles.intent, color: INTENT_TONE[m.intent] ?? "var(--color-text-muted)" }}>
                    {m.intent}
                </span>
                {m.replyToSeq && <span style={styles.re}>re {m.replyToSeq}</span>}
                {!m.answered && ["challenge", "ask"].includes(m.intent) && m.addressedTo !== "all" && (
                    <span style={{ ...styles.smallPill, ...styles.pillWarn }}>unanswered</span>
                )}
                <span style={styles.msgTime}>r{m.round} · {ago(m.createdAt)} ago</span>
            </div>
            <div style={{ ...styles.msgBody, ...(m.role !== "agent" ? styles.msgModerator : {}) }}>
                {m.body}
            </div>
        </div>
    );
}

function PanelHeader({ title, description, icon }: {
    title: string;
    description: string;
    icon: React.ReactNode;
}) {
    return (
        <div style={styles.panelHeader}>
            <div style={styles.panelIcon}>{icon}</div>
            <div>
                <h2 style={styles.sectionTitle}>{title}</h2>
                <p style={styles.sectionDescription}>{description}</p>
            </div>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    shell: {
        position: "relative",
        minHeight: "100vh",
        overflow: "hidden",
        maxWidth: 1240,
        margin: "0 auto",
        padding: "36px 24px 56px",
        fontFamily: "var(--font-family)",
        color: "var(--color-text-primary)",
        background: "radial-gradient(circle at 12% 0%, color-mix(in srgb, var(--color-secondary) 18%, transparent), transparent 30%), radial-gradient(circle at 95% 20%, color-mix(in srgb, #7aa2ff 13%, transparent), transparent 28%), var(--color-background)",
    },
    ambientOne: {
        position: "fixed", width: 520, height: 520, top: -180, left: -160, borderRadius: "50%",
        background: "color-mix(in srgb, var(--color-secondary) 18%, transparent)",
        filter: "blur(90px)", pointerEvents: "none",
    },
    ambientTwo: {
        position: "fixed", width: 460, height: 460, right: -160, top: 80, borderRadius: "50%",
        background: "color-mix(in srgb, #7aa2ff 14%, transparent)",
        filter: "blur(95px)", pointerEvents: "none",
    },
    header: {
        position: "relative", zIndex: 1, display: "flex", alignItems: "flex-start",
        justifyContent: "space-between", gap: 20, marginBottom: 18,
    },
    headerNarrow: { flexDirection: "column", alignItems: "stretch", gap: 12 },
    shellNarrow: { padding: "22px 14px 40px" },
    titleNarrow: { fontSize: 26 },
    kicker: {
        fontSize: 11, fontWeight: 800, letterSpacing: 1.2, textTransform: "uppercase",
        color: "var(--color-text-muted)", marginBottom: 6,
    },
    title: { fontSize: 34, lineHeight: 1.05, fontWeight: 850, letterSpacing: "-0.05em", margin: 0 },
    subtitle: { maxWidth: 640, margin: "10px 0 0", color: "var(--color-text-muted)", fontSize: 14, lineHeight: 1.55 },
    quickActions: {
        position: "relative", zIndex: 1, display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18,
    },
    // Longhand border, because liveOn and dangerLink override borderColor alone:
    // React warns when a shorthand and its longhand are mixed across a rerender.
    quickLink: {
        display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 11px", borderRadius: 14,
        textDecoration: "none", color: "var(--color-text-primary)",
        background: "color-mix(in srgb, var(--color-background) 58%, transparent)",
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-border) 62%, transparent)",
        fontSize: 12.5, fontWeight: 650, cursor: "pointer", fontFamily: "inherit",
    },
    liveOn: { color: "#31d07f", borderColor: "color-mix(in srgb, #31d07f 45%, transparent)" },
    spin: { animation: "spin 2s linear infinite" },
    headerActions: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
    hostChipOff: { color: "var(--color-text-muted)", opacity: 0.75 },
    dangerLink: { color: "#ff8f6b", borderColor: "color-mix(in srgb, #ff8f6b 40%, transparent)" },
    code: {
        fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 11.5,
        padding: "2px 6px", borderRadius: 5,
        background: "color-mix(in srgb, var(--color-background) 60%, transparent)",
    },
    input: {
        flex: "1 1 180px", minWidth: 0, padding: "8px 10px", fontSize: 13,
        borderRadius: 8, border: "1px solid var(--color-border)",
        background: "color-mix(in srgb, var(--color-background) 60%, transparent)",
        color: "var(--color-text-primary)", fontFamily: "inherit",
    },
    pairRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
    remoteActions: { display: "flex", gap: 8, flexWrap: "wrap", padding: "0 12px 10px" },
    remoteBrief: {
        margin: 0, padding: 14, borderRadius: 14, maxHeight: 380, overflow: "auto",
        fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 11.5, lineHeight: 1.6,
        whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--color-text-muted)",
        background: "color-mix(in srgb, var(--color-background) 60%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 50%, transparent)",
    },
    conveneForm: { display: "flex", flexDirection: "column", gap: 8, marginTop: 14 },
    conveneRow: { display: "flex", gap: 8, flexWrap: "wrap" },
    permissionQueue: {
        display: "flex", flexDirection: "column", gap: 10, marginBottom: 14, padding: 12,
        borderRadius: 10, border: "1px solid color-mix(in srgb, #ff8f6b 40%, transparent)",
        background: "color-mix(in srgb, #ff8f6b 8%, transparent)",
    },
    permissionRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
    permissionTitle: { fontSize: 12.5, fontWeight: 650, minWidth: 0, overflowWrap: "anywhere" },
    permissionButtons: { display: "flex", gap: 6, marginLeft: "auto" },
    activityFeed: {
        marginTop: 14, maxHeight: 190, overflowY: "auto", display: "flex",
        flexDirection: "column", gap: 4,
    },
    activityRow: { display: "flex", gap: 8, alignItems: "baseline", fontSize: 11.5 },
    activityAgent: { fontWeight: 750, flexShrink: 0 },
    activityKind: { color: "var(--color-text-muted)", flexShrink: 0 },
    activityDetail: { color: "var(--color-text-muted)", minWidth: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" },
    loadingCard: {
        minHeight: "30vh", display: "flex", alignItems: "center", justifyContent: "center",
        gap: 10, color: "var(--color-text-muted)",
    },
    split: {
        position: "relative", zIndex: 1, display: "grid",
        gridTemplateColumns: "minmax(240px, 320px) minmax(0, 1fr)", gap: 16, alignItems: "start",
    },
    splitNarrow: { gridTemplateColumns: "minmax(0, 1fr)" },
    rail: { display: "flex", flexDirection: "column" },
    main: { minWidth: 0 },
    panel: {
        marginBottom: 16, padding: 18, borderRadius: 24,
        background: "color-mix(in srgb, var(--color-surface) 88%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 66%, transparent)",
        backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
        boxShadow: "0 18px 60px rgba(0, 0, 0, 0.18)",
    },
    panelHeader: { display: "flex", gap: 11, alignItems: "flex-start", marginBottom: 14 },
    panelHeadRow: {
        display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        gap: 12, flexWrap: "wrap",
    },
    // Fixed rather than the Fullscreen API: it needs no user-gesture permission,
    // survives a re-render, and Esc still exits.
    monitorOverlay: {
        position: "fixed", inset: 0, zIndex: 60, display: "flex", flexDirection: "column",
        background: "var(--color-background)", fontFamily: "var(--font-family)",
        color: "var(--color-text-primary)",
    },
    monitorBar: {
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
        flexWrap: "wrap", padding: "12px 18px", flexShrink: 0,
        borderBottom: "1px solid color-mix(in srgb, var(--color-border) 66%, transparent)",
        background: "color-mix(in srgb, var(--color-surface) 88%, transparent)",
    },
    monitorTitle: {
        fontSize: 15, fontWeight: 800, letterSpacing: "-0.02em",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    },
    monitorMeta: { fontSize: 12, color: "var(--color-text-muted)", marginTop: 3 },
    monitorActions: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
    monitorAgent: {
        display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 650,
        padding: "7px 10px", borderRadius: 12,
        background: "color-mix(in srgb, var(--color-background) 58%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 50%, transparent)",
    },
    // The scroll container is this element, so transcriptEnd.scrollIntoView
    // follows the tail here exactly as it does inline.
    monitorFeed: { flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 18px 28px" },
    monitorInner: { maxWidth: 1600, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 },
    panelIcon: {
        width: 32, height: 32, borderRadius: 12, display: "flex", alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in srgb, var(--color-background) 58%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)",
        flexShrink: 0,
    },
    sectionTitle: { fontSize: 15, fontWeight: 800, letterSpacing: "-0.02em", margin: 0 },
    sectionDescription: { margin: "3px 0 0", fontSize: 12, color: "var(--color-text-muted)" },
    emptyText: { color: "var(--color-text-muted)", fontSize: 13, padding: 12, lineHeight: 1.5 },
    errorBox: {
        padding: 12, borderRadius: 14, marginBottom: 12, fontSize: 13, color: "#ff8f6b",
        background: "color-mix(in srgb, #ff8f6b 10%, transparent)",
    },
    railItem: {
        display: "block", width: "100%", textAlign: "left", marginBottom: 8, padding: "10px 12px",
        borderRadius: 16, cursor: "pointer", fontFamily: "inherit",
        color: "var(--color-text-primary)",
        background: "color-mix(in srgb, var(--color-background) 45%, transparent)",
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-border) 45%, transparent)",
    },
    railItemActive: {
        background: "color-mix(in srgb, var(--color-secondary) 14%, transparent)",
        borderColor: "color-mix(in srgb, var(--color-secondary) 45%, transparent)",
    },
    railItemAdoptable: { marginBottom: 4 },
    railAdopt: {
        display: "inline-flex", alignItems: "center", gap: 5, marginBottom: 10, padding: "5px 11px",
        borderRadius: 999, fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
        color: "var(--color-text-primary)",
        background: "color-mix(in srgb, var(--color-background) 45%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 62%, transparent)",
    },
    railTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
    railCode: { fontSize: 12.5, fontWeight: 800, letterSpacing: "-0.01em" },
    railTopic: { marginTop: 4, fontSize: 12.5, lineHeight: 1.4, color: "var(--color-text-primary)" },
    railMeta: { marginTop: 4, fontSize: 11, color: "var(--color-text-muted)" },
    railWaiting: { marginTop: 3, fontSize: 11, fontWeight: 700, color: "#ffd166" },
    smallPill: {
        display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 7px", borderRadius: 999,
        fontSize: 11, fontWeight: 750, whiteSpace: "nowrap",
    },
    pillGood: { color: "#31d07f", background: "color-mix(in srgb, #31d07f 12%, transparent)" },
    pillMuted: { color: "var(--color-text-muted)", background: "color-mix(in srgb, var(--color-background) 55%, transparent)" },
    pillWarn: { color: "#ff8f6b", background: "color-mix(in srgb, #ff8f6b 14%, transparent)" },
    brief: {
        padding: 12, borderRadius: 14, fontSize: 12.5, lineHeight: 1.55,
        color: "var(--color-text-muted)",
        background: "color-mix(in srgb, var(--color-background) 45%, transparent)",
        marginBottom: 12, whiteSpace: "pre-wrap",
    },
    roster: { display: "flex", flexDirection: "column", gap: 8 },
    rosterRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
    workRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 0", borderBottom: "1px solid color-mix(in srgb, var(--color-border) 30%, transparent)" },
    workTitle: { fontSize: 12.5, fontWeight: 650 },
    workDetail: { width: "100%", fontSize: 11.5, lineHeight: 1.45, color: "var(--color-text-muted)", paddingLeft: 36 },
    dot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
    rosterName: { fontSize: 13, fontWeight: 750, display: "inline-flex", alignItems: "center", gap: 6 },
    rosterMeta: { fontSize: 11.5, color: "var(--color-text-muted)", marginLeft: "auto" },
    tag: {
        fontSize: 10, fontWeight: 800, padding: "2px 6px", borderRadius: 999,
        textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-muted)",
        background: "color-mix(in srgb, var(--color-background) 60%, transparent)",
    },
    tagFloor: { color: "#31d07f", background: "color-mix(in srgb, #31d07f 14%, transparent)" },
    obligations: {
        marginTop: 12, padding: 10, borderRadius: 14,
        background: "color-mix(in srgb, #ff8f6b 8%, transparent)",
    },
    obligationsTitle: {
        fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.8,
        color: "var(--color-text-muted)", marginBottom: 6,
    },
    obligationRow: { fontSize: 12, lineHeight: 1.5 },
    verdict: { fontSize: 13.5, lineHeight: 1.6, whiteSpace: "pre-wrap" },
    openQ: { marginTop: 12 },
    filedRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 14, flexWrap: "wrap" },
    filedPath: { fontSize: 11.5, color: "var(--color-text-muted)" },
    untrusted: { color: "#ffd166" },
    transcript: { display: "flex", flexDirection: "column", gap: 14, maxHeight: "62vh", overflowY: "auto" },
    msg: { paddingBottom: 12, borderBottom: "1px solid color-mix(in srgb, var(--color-border) 35%, transparent)" },
    msgHead: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 },
    seq: {
        fontSize: 11, fontWeight: 800, minWidth: 22, padding: "2px 6px", borderRadius: 8,
        textAlign: "center", color: "var(--color-text-muted)",
        background: "color-mix(in srgb, var(--color-background) 60%, transparent)",
    },
    speaker: { fontSize: 13, fontWeight: 800 },
    arrow: { fontSize: 12, color: "var(--color-text-muted)" },
    intent: { fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5 },
    re: { fontSize: 11, color: "var(--color-text-muted)" },
    msgTime: { fontSize: 11, color: "var(--color-text-muted)", marginLeft: "auto" },
    msgBody: { fontSize: 13.5, lineHeight: 1.6, whiteSpace: "pre-wrap" },
    msgModerator: {
        padding: 10, borderRadius: 12, fontStyle: "italic",
        color: "var(--color-text-muted)",
        background: "color-mix(in srgb, #c792ea 8%, transparent)",
    },
};
