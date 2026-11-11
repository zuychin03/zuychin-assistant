"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    CheckCircle2, ChevronDown, ChevronRight, Clock, Copy, Cpu, GitBranch,
    Gavel, Maximize2, MessageSquare, Minimize2, Play, Plug, RefreshCw, Square,
    Laptop, Users, XCircle,
} from "lucide-react";
import { WorkspaceShell } from "@/components/workspace-shell";
import {
    appendActivity, fetchBranches, findHost, forgetHost, pair, HostClient,
    type HostActivity, type HostConnection, type HostSnapshot,
} from "./host-client";
import { ActivityFeed } from "./activity-feed";
import { remoteAgentSetup } from "./remote-setup";
import { OwnerChannelPanel } from "./owner-channel-panel";
import { DecisionPanel } from "./decision-panel";
import { SeatKeysPanel } from "./seat-keys-panel";
import { IntegrationPanel } from "./integration-panel";
import { ExecutionEvidence, ExecutionHistory, ExecutionRecord } from "./execution-evidence";
import { executionIdentityLabel, type CouncilExecutionPage, type CouncilExecutionRecord } from "@/lib/council/execution-evidence";
import { DesktopHostControls } from "./desktop-host-controls";
import { isDesktopHostAvailable } from "./desktop-host";
import { Dropdown } from "@/components/dropdown";
import { isLoopbackUrl, publicBaseUrl } from "@/lib/public-url";
import ui from "./council.module.css";

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
    /** Closed, but its work campaign is still running, so a host can adopt it. */
    campaignRunning?: boolean;
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
    openObligations: { seq: number; from: string; to: string; intent: string }[];
    campaign: {
        id: string; status: string; repoPath: string; baseBranch: string; completedAt: string | null;
        integratorAgent: string | null; integrationBranch: string | null; integrationStatus: string | null;
        integrationReport: string | null; integrationCheckedAt: string | null;
        baseSha: string | null; verificationProfile: string; integrationManifest: unknown;
        manifestFrozenAt: string | null; integrationTipSha: string | null;
        workItems: { id: string; sequence: number; agentName: string; title: string; status: string; heartbeatAt: string | null; progress: string | null; commitHash: string | null; acceptedCommitSha: string | null; submittedExecutionId: string | null; acceptedExecutionId: string | null; branchName: string | null; verificationProfile: string; verificationRunId: string | null; dependencies: string[]; verification: string | null; blockedReason: string | null; hostVerified: boolean | null; hostVerification: string | null }[];
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

// Seconds matter here in a way they do not in ago(): this measures a build the
// reader is waiting on, and 4m is indistinguishable from stuck.
function elapsed(iso: string): string {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

const INTENT_TONE: Record<string, "success" | "warning"> = {
    challenge: "warning",
    concede: "success",
    verdict: "success",
};

// One per --fam-* token in council.module.css.
const SEAT_COLOURS = 4;

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

    const [hostState, setHostState] = useState<HostConnection>("probing");
    const [desktop, setDesktop] = useState(false);
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
    const [form, setForm] = useState({ topic: "", brief: "", agents: "", closer: "", councilType: "code", workspace: "", baseBranch: "" });
    const [hostToken, setHostToken] = useState<string | null>(null);
    const [branches, setBranches] = useState<string[]>([]);
    const [agentSelections, setAgentSelections] = useState<Record<string, { modelId?: string; reasoningEffort?: string }>>({});
    const clientRef = useRef<HostClient | null>(null);

    const connect = useCallback((port: number, token: string) => {
        clientRef.current?.close();
        setHostToken(token);
        const client = new HostClient(port, token, {
            onState: (snapshot) => {
                setHost(snapshot);
                setHostState("connected");
                if (snapshot.code) { setAdopting(null); setConvening(false); }
            },
            onActivity: (item) => setActivity((list) => appendActivity(list, item)),
            onError: (detail) => { setHostError(detail); setAdopting(null); setConvening(false); },
            onClose: () => { setHostState("observing"); setHost(null); },
        });
        clientRef.current = client;
        client.open();
    }, []);

    // Reloaded when the chosen repo changes, since the branch list is per repo.
    // The host's own answer decides the default, so a stale selection cannot
    // survive a workspace switch.
    useEffect(() => {
        if (!hostPort || !hostToken) { setBranches([]); return; }
        let cancelled = false;
        void fetchBranches(hostPort, hostToken, form.workspace || undefined).then((result) => {
            if (cancelled || !result) return;
            setBranches(result.branches);
            setForm((current) => (result.branches.includes(current.baseBranch)
                ? current
                : { ...current, baseBranch: result.baseBranch }));
        });
        return () => { cancelled = true; };
    }, [hostPort, hostToken, form.workspace]);

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
        const selections = Object.fromEntries(agents.map((name) => [name, agentSelections[name] ?? {}]));
        clientRef.current?.convene({ topic: form.topic.trim(), brief: form.brief.trim(), agents, closer, councilType: form.councilType, workspace: form.workspace || undefined, baseBranch: form.baseBranch || undefined, selections });
        setTimeout(() => setConvening(false), 8000);
    }, [form, agentSelections]);

    useEffect(() => setOrigin(window.location.origin), []);
    useEffect(() => setDesktop(isDesktopHostAvailable()), []);

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

    // The host only pushes a frame when the step changes, and a step can run for
    // minutes; without this the elapsed time freezes and reads as a hung build.
    const [, setBusyTick] = useState(0);
    const busySince = host?.busyWith?.since ?? null;
    useEffect(() => {
        if (!busySince) return;
        const id = setInterval(() => setBusyTick((n) => n + 1), 1000);
        return () => clearInterval(id);
    }, [busySince]);

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
    // One host owns one council, so Adopt is offered only while it owns none.
    const canAdopt = hostState === "connected" && !!host && !host.code;
    // The brief goes to a machine that is not this one, so it carries the
    // configured public address when there is one, not whatever is in the
    // address bar.
    const briefBase = publicBaseUrl(origin);
    const isLoopback = isLoopbackUrl(briefBase);
    const remoteBrief = remoteAgentSetup(`${briefBase || "https://your-deployment"}/api/mcp/mcp`);
    // Rendered copy masks the host so a screenshot of this panel carries no
    // deployment address; the clipboard still gets the real one.
    const remoteBriefShown = remoteAgentSetup("https://<your-host>/api/mcp/mcp");

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
            description="Watch your coding agents deliberate. Viewing never advances a turn."
            actions={<>
                <button type="button" onClick={() => setLive((v) => !v)} aria-pressed={live} className={ui.liveToggle}>
                    <RefreshCw size={15} className={live ? ui.spin : undefined} />
                    {live ? "Live" : "Paused"}
                </button>
                {s && detail && <a href="#council-transcript" aria-label={`View transcript for ${s.code}`}><ChevronDown size={15} /> View transcript</a>}
            </>}
        >
            <div className={ui.council}>
                <section className={ui.panel}>
                    <div className={ui.panelHeadRow}>
                        <PanelHeader
                            title="Local host"
                            description={
                                hostState === "connected"
                                    ? `${host?.agents.length ?? 0} ${host?.agents.length === 1 ? "agent" : "agents"} · ${host?.code ?? "idle"} · ${host?.repo ?? ""}`
                                    : hostState === "unpaired"
                                        ? `a host is running on port ${hostPort} but this browser is not paired with it`
                                        : hostState === "probing"
                                            ? `probing 127.0.0.1:${8787}-8791`
                                            : "no host reachable on this machine"
                            }
                            icon={<Cpu size={16} />}
                        />
                        <div className={ui.headActions}>
                            <span className={ui.hostStatus} data-state={hostState}>
                                <Plug size={14} />
                                {hostState === "connected" ? `local host :${hostPort}` : hostState === "probing" ? "looking for a host" : "observing via Zuychin"}
                            </span>
                            {hostState !== "connected" && (
                                <button type="button" onClick={() => void probeHost()} className={ui.btn}>
                                    <RefreshCw size={15} /> Retry
                                </button>
                            )}
                            {hostState === "connected" && !desktop && (
                                <button
                                    type="button"
                                    onClick={() => { clientRef.current?.stop(); forgetHost(); }}
                                    className={`${ui.btn} ${ui.danger}`}
                                    title="Stop the host and every agent it owns"
                                >
                                    <Square size={14} /> Stop host
                                </button>
                            )}
                        </div>
                    </div>

                    {desktop && (
                        <DesktopHostControls
                            externalHost={hostState === "connected" || hostState === "unpaired"}
                            onHostAvailable={probeHost}
                        />
                    )}

                    {hostError && <div className={ui.notice} role="alert">{hostError}</div>}

                    {hostState === "absent" && !desktop && (
                        <div className={ui.emptyText}>
                            Observing through Zuychin. Agents can still join by hand, but nothing here can
                            start one, mediate its file access or push it a turn. To take control, run{" "}
                            <code className={ui.inlineCode}>npx tsx --env-file=.env.local scripts/council-host.mts --repo &lt;path&gt;</code>{" "}
                            on the machine holding the repo, then Retry.
                            <br />
                            On a phone, or from the deployed site with the local-network prompt denied,
                            this is the only mode available - there is no host to reach.
                        </div>
                    )}

                    {hostState === "unpaired" && (
                        <div className={ui.pairRow}>
                            <span className={ui.emptyText}>Enter the pairing code the host printed:</span>
                            <input
                                aria-label="Host pairing code"
                                value={pairCode}
                                onChange={(e) => setPairCode(e.target.value.toUpperCase())}
                                placeholder="ABCD2345"
                                maxLength={8}
                                className={`${ui.input} ${ui.pairInput}`}
                            />
                            <button type="button" onClick={() => void submitPairing()} className={`${ui.btn} ${ui.primary}`}>Pair</button>
                        </div>
                    )}

                    {hostState === "connected" && host && (
                        <>
                            <div className={ui.pillRow}>
                                {/* An idle host never held a lease, so an unhealthy
                                    one has lost nothing; only a host that owns a
                                    council can lose it. */}
                                <span className={ui.pill} data-tone={host.code && host.leaseHealthy === false ? "warning" : host.leaseEpoch ? "success" : undefined}>
                                    {host.code && host.leaseHealthy === false
                                        ? "host lease lost"
                                        : host.leaseEpoch ? `host lease #${host.leaseEpoch}` : "host idle"}
                                </span>
                                {host.capabilities?.protocolVersion === 3 && <span className={ui.pill}>Council V3</span>}
                            </div>
                            {host.permissions.length > 0 && (
                                <div className={ui.subBlock} data-emphasis>
                                    <div className={ui.subHead} data-signal><Gavel size={15} /> Waiting on you</div>
                                    {host.permissions.map((p) => (
                                        <div key={p.id} className={ui.permissionRow}>
                                            <span className={ui.pill} data-tone="warning">{p.kind}</span>
                                            <span className={ui.name}>{p.agent}</span>
                                            <span className={ui.permissionTitle}>{p.title}</span>
                                            <span className={ui.permissionButtons}>
                                                <button type="button" onClick={() => clientRef.current?.replyToPermission(p.id, true)} className={`${ui.btn} ${ui.small}`}>Allow</button>
                                                <button type="button" onClick={() => clientRef.current?.replyToPermission(p.id, false)} className={`${ui.btn} ${ui.small} ${ui.danger}`}>Deny</button>
                                            </span>
                                            <span className={ui.detail}>{p.path ?? ""}{p.path ? " · " : ""}{p.reason} · denied automatically after 120s</span>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {host.agents.length > 0 && (
                                <div className={ui.list}>
                                    {host.agents.map((a) => (
                                        <div key={a.name} className={ui.row}>
                                            <span className={ui.dot} data-tone={a.state === "failed" || a.state === "exited" ? "danger" : a.state === "busy" ? "warning" : "success"} />
                                            <span className={ui.name}>{a.name}</span>
                                            <span className={ui.pill}>{a.mode}</span>
                                            <span className={ui.pill}>{a.state}</span>
                                            {host.floorHolder === a.name && <span className={ui.pill} data-tone="success">has floor</span>}
                                            <span className={ui.rowMeta}>{a.detail}</span>
                                            <span className={ui.detail}>
                                                {executionIdentityLabel(a.identityAssurance)}{a.effectiveModel ? ` · ${a.effectiveModel}` : ""}
                                                {a.effectiveReasoningEffort ? ` · ${a.effectiveReasoningEffort}` : ""}
                                            </span>
                                            <div className={ui.detail}>
                                                <ExecutionEvidence executionId={a.executionId} label="Host model report" snapshot={a.executionId ? {
                                                    executionId: a.executionId, agentName: a.name, connectorKind: a.mode,
                                                    identityAssurance: a.identityAssurance, provider: a.provider,
                                                    adapterVersion: a.adapterVersion ?? null, requestedModel: a.requestedModel,
                                                    effectiveModel: a.effectiveModel, requestedReasoningEffort: a.requestedReasoningEffort,
                                                    effectiveReasoningEffort: a.effectiveReasoningEffort, modelSource: a.modelSource ?? null,
                                                    hostGeneration: a.hostGeneration ?? null, policyVersion: a.policyVersion ?? null,
                                                } : null} />
                                            </div>
                                            <span className={ui.detail}><code>{a.branch} · {a.worktree}</code></span>
                                            {a.warn && <span className={ui.detail} data-tone="warning">! {a.warn}</span>}
                                        </div>
                                    ))}
                                </div>
                            )}

                            {host.busyWith && (
                                <div className={ui.busy}>
                                    <span className={ui.busyDot} />
                                    <span className={ui.busyLabel}>{host.busyWith.label}</span>
                                    <span className={ui.busySince}>{elapsed(host.busyWith.since)}</span>
                                </div>
                            )}

                            <ActivityFeed activity={activity} agents={host.agents} />

                            {!host.code && (
                                <div className={ui.conveneForm}>
                                    <h3 className={ui.conveneTitle}>Convene</h3>
                                    <input
                                        aria-label="Council topic"
                                        value={form.topic}
                                        onChange={(e) => setForm({ ...form, topic: e.target.value })}
                                        placeholder="One decidable question"
                                        className={ui.input}
                                    />
                                    <textarea
                                        aria-label="Council brief"
                                        value={form.brief}
                                        onChange={(e) => setForm({ ...form, brief: e.target.value })}
                                        placeholder="Context every agent needs: constraints, what has been tried, what a good answer looks like"
                                        className={`${ui.input} ${ui.textarea}`}
                                    />
                                    <div className={ui.conveneRow}>
                                        <input
                                            aria-label="Council agent names"
                                            value={form.agents}
                                            onChange={(e) => setForm({ ...form, agents: e.target.value })}
                                            placeholder="claude-a, codex-1, cursor-1"
                                            className={ui.input}
                                        />
                                        <input
                                            aria-label="Council closer"
                                            value={form.closer}
                                            onChange={(e) => setForm({ ...form, closer: e.target.value })}
                                            placeholder="closer (defaults to the first)"
                                            className={ui.input}
                                        />
                                        <Dropdown
                                            ariaLabel="Council type"
                                            value={form.councilType}
                                            onChange={(councilType) => setForm({ ...form, councilType })}
                                            options={["debate", "code", "research", "audit", "debug"]}
                                        />
                                        {(host.workspaces?.length ?? 0) > 1 && (
                                            <Dropdown
                                                ariaLabel="Repository"
                                                value={form.workspace}
                                                onChange={(workspace) => setForm({ ...form, workspace })}
                                                options={[
                                                    { value: "", label: "host default" },
                                                    ...(host.workspaces ?? []).map((w) => ({ value: w.name })),
                                                ]}
                                            />
                                        )}
                                        {branches.length > 1 && (
                                            <Dropdown
                                                ariaLabel="Base branch"
                                                value={form.baseBranch}
                                                onChange={(baseBranch) => setForm({ ...form, baseBranch })}
                                                options={branches}
                                            />
                                        )}
                                        <button type="button" onClick={submitConvene} disabled={convening} className={`${ui.btn} ${ui.primary}`}>
                                            <Play size={15} /> {convening ? "Convening…" : "Convene"}
                                        </button>
                                    </div>
                                    <div className={ui.modelGrid}>
                                        {form.agents.split(",").map((name) => name.trim()).filter(Boolean).map((name) => {
                                            const instance = host.instances?.find((item) => item.name === name);
                                            if (!instance) return null;
                                            const selection = agentSelections[name] ?? {};
                                            return (
                                                <div key={name} className={ui.modelRow}>
                                                    <span className={ui.modelAgent}>{name}</span>
                                                    <Dropdown
                                                        ariaLabel={`Model for ${name}`}
                                                        value={selection.modelId ?? instance.defaultModel ?? ""}
                                                        onChange={(modelId) => setAgentSelections((current) => ({
                                                            ...current, [name]: { ...current[name], modelId: modelId || undefined },
                                                        }))}
                                                        options={[
                                                            ...(instance.defaultModel ? [] : [{ value: "", label: "Provider default" }]),
                                                            ...instance.allowedModels.map((model) => ({ value: model })),
                                                        ]}
                                                    />
                                                    {instance.allowedReasoningEfforts.length > 0 && (
                                                        <Dropdown
                                                            ariaLabel={`Reasoning effort for ${name}`}
                                                            value={selection.reasoningEffort ?? instance.defaultReasoningEffort ?? ""}
                                                            onChange={(reasoningEffort) => setAgentSelections((current) => ({
                                                                ...current, [name]: { ...current[name], reasoningEffort: reasoningEffort || undefined },
                                                            }))}
                                                            options={[
                                                                ...(instance.defaultReasoningEffort ? [] : [{ value: "", label: "Default reasoning" }]),
                                                                ...instance.allowedReasoningEfforts.map((effort) => ({ value: effort })),
                                                            ]}
                                                        />
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                    <p className={ui.formNote}>
                                        Names must exist in <code>scripts/council-agents.json</code>. Each gets its own worktree off{" "}
                                        <code>{host.workspaces?.find((w) => w.name === form.workspace)?.path ?? host.repo}</code>
                                        {form.baseBranch ? <> at <code>{form.baseBranch}</code></> : ""}. The host checks ACP client file and
                                        terminal requests against that worktree. Adapter-managed operations may bypass those checks.
                                    </p>
                                </div>
                            )}
                        </>
                    )}
                </section>

                <section className={ui.panel}>
                    <div className={ui.panelHeadRow}>
                        <PanelHeader
                            title="Agents on other machines"
                            description="A brief they can self-configure from, so they can join a council by code"
                            icon={<Laptop size={16} />}
                        />
                        <button type="button" onClick={() => setShowRemote((v) => !v)} className={ui.btn}>
                            {showRemote ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            {showRemote ? "Hide" : "Show brief"}
                        </button>
                    </div>

                    {showRemote && (
                        <>
                            <div className={ui.emptyText}>
                                Paste this into a coding agent on another device. It joins over MCP by hand and
                                never touches the local host, so it needs no ACP adapter - but its council name
                                must be on the roster when the council is convened, and must NOT be one this
                                machine has configured, or the host would claim that seat first.
                                {isLoopback && (
                                    <>
                                        <br />
                                        <strong>The copied brief points at this machine, which a remote agent
                                        cannot reach.</strong> Set <code className={ui.inlineCode}>NEXT_PUBLIC_BASE_URL</code> to
                                        your deployed address and every brief carries it whatever page you copy
                                        from; until then, copy from the deployed site or swap the host in by hand.
                                    </>
                                )}
                                <br />
                                Replace <code className={ui.inlineCode}>&lt;PASTE_YOUR_SEAT_KEY_HERE&gt;</code> with a
                                seat key minted for that agent on the council page below — <strong>not</strong> your
                                MCP key, which would hand over the whole knowledge base. The host is masked below
                                so this panel is safe to screenshot; <strong>Copy brief</strong> fills in the real one.
                            </div>
                            <div className={ui.buttonRow}>
                                <button
                                    type="button"
                                    onClick={() => {
                                        void navigator.clipboard.writeText(remoteBrief).then(() => {
                                            setCopied(true);
                                            setTimeout(() => setCopied(false), 2000);
                                        });
                                    }}
                                    className={ui.btn}
                                    data-done={copied || undefined}
                                >
                                    {copied ? <CheckCircle2 size={15} /> : <Copy size={15} />}
                                    {copied ? "Copied" : "Copy brief"}
                                </button>
                            </div>
                            <pre className={ui.remoteBrief}>{remoteBriefShown}</pre>
                        </>
                    )}
                </section>

                {error && <div className={ui.notice} role="alert">{error} <button type="button" className={ui.btn} onClick={() => void fetchList()}>Retry councils</button></div>}

                {loading && (
                    <div className={ui.loading} role="status"><Clock size={16} /> Loading councils…</div>
                )}

                {!loading && !error && open.length === 0 && recent.length === 0 && (
                    <section className={ui.panel}>
                        <PanelHeader title="No councils yet" description="Nothing has been convened" icon={<Users size={16} />} />
                        <div className={ui.emptyText}>
                            Ask Zuychin to convene one: <em>&ldquo;convene a council on X with codex and
                            claude-code; claude-code closes it&rdquo;</em>. Paste each generated block into
                            that agent, then watch here.
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
                                    <div key={c.code}>
                                        <button
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
                                                <code>{c.code}</code> · {c.messages} {c.messages === 1 ? "msg" : "msgs"}
                                                {c.campaignRunning ? " · campaign running" : ` · r${c.round}/${c.maxRounds}`}
                                                {/* expires_at stops governing once a verdict is proposed;
                                                    standby_expires_at does, and it is not in this payload.
                                                    For a campaign the debate clock is long irrelevant. */}
                                                {c.status !== "awaiting_owner" && !c.campaignRunning && <> · {until(c.expiresAt)}</>}
                                            </span>
                                            {c.status === "awaiting_owner" && <span className={ui.railSignal}>decision needed</span>}
                                            {c.waitingOn.length > 0 && (
                                                <span className={ui.railWaiting}>waiting on {c.waitingOn.join(", ")}</span>
                                            )}
                                        </button>
                                        {canAdopt && (
                                            <button
                                                type="button"
                                                onClick={() => { setHostError(""); setAdopting(c.code); clientRef.current?.attach(c.code); }}
                                                disabled={adopting !== null}
                                                className={`${ui.btn} ${ui.small} ${ui.railAdopt}`}
                                                title={c.campaignRunning
                                                    ? "Hand this council's running campaign back to the local host: it restarts the agents in their worktrees and resumes verification, review and integration."
                                                    : "Hand this council to the local host. It starts every participant it has configured, and leaves alone any that someone is already driving by hand."}
                                            >
                                                <Plug size={13} /> {adopting === c.code ? "Adopting…" : c.campaignRunning ? "Resume" : "Adopt"}
                                            </button>
                                        )}
                                    </div>
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
                                                <code>{s.code}</code> · {s.councilType} council · {s.paused ? "stalled" : s.status} · round {s.round} of {s.maxRounds} · {s.messages} {s.messages === 1 ? "message" : "messages"} · closer {s.closerName}
                                            </p>
                                        </div>
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
                                        {isRunning && (
                                            <SeatKeysPanel key={s.code}
                                                code={s.code}
                                                agentNames={detail.participants.filter((p) => p.kind === "agent").map((p) => p.name)}
                                            />
                                        )}
                                        <div className={ui.list}>
                                            {detail.participants.filter((p) => p.kind === "agent").map((p) => {
                                                const latestRun = detail.executions?.records.find(record => record.agentName === p.name);
                                                return (
                                                    <div key={p.name} className={ui.row}>
                                                        <span className={ui.dot} data-tone={presence(p)} />
                                                        <span className={ui.name}>
                                                            {p.name}
                                                            {p.name === s.closerName && <span className={ui.pill}>closer</span>}
                                                            {s.floorHolder === p.name && <span className={ui.pill} data-tone="success">has floor</span>}
                                                        </span>
                                                        <span className={ui.rowMeta}>
                                                            {p.postsThisRound}/2 this round · {p.postsTotal} total · seen {ago(p.lastSeenAt)} ago
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

                                    {detail.campaign && (
                                        <section className={ui.panel}>
                                            <PanelHeader
                                                title="Work campaign"
                                                description={detail.campaign.status + " - " + detail.campaign.workItems.filter((item) => item.status === "verified").length + "/" + detail.campaign.workItems.length + " verified"}
                                                icon={<GitBranch size={16} />}
                                            />
                                            <p className={ui.path}><code>{detail.campaign.repoPath}</code> · base <code>{detail.campaign.baseBranch}</code></p>
                                            <div className={ui.list}>
                                                {detail.campaign.workItems.map((item) => (
                                                    <div key={item.id} className={`${ui.row} ${ui.workRow}`}>
                                                        <span className={ui.seq}>{item.sequence}</span>
                                                        <span className={ui.name}>{item.agentName}</span>
                                                        <span className={ui.pill} data-tone={item.status === "verified" ? "success" : item.status === "blocked" ? "warning" : undefined}>{item.status}</span>
                                                        <span className={ui.rowTitle}>{item.title}</span>
                                                        {/* Host-observed, not the agent's own account of its work. */}
                                                        {item.status === "awaiting_review" && (
                                                            <span className={ui.pill} data-tone={item.hostVerified === true ? "success" : item.hostVerified === false ? "danger" : undefined}>
                                                                {item.hostVerified === true ? "host ✓" : item.hostVerified === false ? "host ✗" : "host pending"}
                                                            </span>
                                                        )}
                                                        {item.blockedReason && <span className={ui.detail}>{item.blockedReason}</span>}
                                                        {!item.blockedReason && item.hostVerification && <span className={ui.detail}>{item.hostVerification.split("\n").find((l) => l.startsWith("FAIL")) ?? item.progress}</span>}
                                                        {!item.blockedReason && !item.hostVerification && item.progress && <span className={ui.detail}>{item.progress}</span>}
                                                        {item.commitHash && <div className={ui.detail}>
                                                            <span className={ui.evidenceNote}>Submitted commit <code>{item.commitHash}</code></span>
                                                            <ExecutionEvidence executionId={item.submittedExecutionId} records={executionRecords} label="Submitted in run" />
                                                        </div>}
                                                        {item.acceptedCommitSha && <div className={ui.detail}>
                                                            <span className={ui.evidenceNote}>Accepted commit <code>{item.acceptedCommitSha}</code></span>
                                                            <ExecutionEvidence executionId={item.acceptedExecutionId} records={executionRecords} label="Accepted submission run" />
                                                        </div>}
                                                    </div>
                                                ))}
                                            </div>
                                            <IntegrationPanel key={s.code}
                                                code={s.code}
                                                campaign={detail.campaign}
                                                agentNames={detail.participants.filter((p) => p.kind === "agent").map((p) => p.name)}
                                                onChange={() => { void fetchDetail(s.code); }}
                                            />
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
    return (
        <div className={ui.msg}>
            <div className={ui.msgHead}>
                <span className={ui.dot} data-seat={m.role === "agent" ? seat : undefined} />
                <span className={ui.speaker}>{m.speaker}</span>
                {m.role !== "agent" && <span className={ui.msgMuted}>{m.role}</span>}
                {m.addressedTo !== "all" && <span className={ui.msgMuted}>→ {m.addressedTo}</span>}
                <span className={ui.pill} data-tone={INTENT_TONE[m.intent]}>{m.intent}</span>
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
