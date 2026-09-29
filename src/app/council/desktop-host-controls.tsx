"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, Play, RefreshCw, Square } from "lucide-react";
import {
    readDesktopHostStatus, restartDesktopHost, startDesktopHost, stopDesktopHost,
    type DesktopHostStatus,
} from "./desktop-host";

const POLL_MS = 1000;
const FRESH_MS = 3000;
type Action = "start" | "stop" | "restart";
const actions = { start: startDesktopHost, stop: stopDesktopHost, restart: restartDesktopHost };

function statusLabel(status: DesktopHostStatus | null, fresh: boolean): string {
    if (!status) return "Checking status…";
    if (!fresh) return "Status unavailable";
    if (status.phase === "starting") return "Starting…";
    if (status.phase === "stopping") return "Stopping…";
    if (status.phase === "failed") return "Needs attention";
    if (status.phase === "stopped") return "Stopped";
    if (status.health?.draining) return "Council work in progress";
    if (status.health?.lifecycle === "degraded") return "Connection needs attention";
    return "Ready";
}

function uptime(milliseconds: number): string {
    const minutes = Math.floor(milliseconds / 60000);
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function DesktopHostControls({ externalHost, onHostAvailable }: {
    externalHost: boolean;
    onHostAvailable: () => Promise<void>;
}) {
    const [status, setStatus] = useState<DesktopHostStatus | null>(null);
    const [pending, setPending] = useState<Action | null>(null);
    const [statusError, setStatusError] = useState("");
    const [actionError, setActionError] = useState("");
    const [checkedAt, setCheckedAt] = useState(0);
    const [now, setNow] = useState(0);
    const mounted = useRef(false);
    const actionRef = useRef<Action | null>(null);
    const revision = useRef(0);
    const refreshConnection = useRef(false);
    const noteId = useId();

    useEffect(() => {
        mounted.current = true;
        let cancelled = false;
        let reading = false;
        const poll = async () => {
            setNow(Date.now());
            if (reading || actionRef.current) return;
            reading = true;
            const version = revision.current;
            try {
                const next = await readDesktopHostStatus();
                if (cancelled || version !== revision.current) return;
                setStatus(next);
                setCheckedAt(Date.now());
                setStatusError("");
            } catch {
                if (!cancelled && version === revision.current) {
                    setStatusError("Desktop host status is unavailable. Reopen Zuychin if it does not reconnect.");
                }
            } finally {
                reading = false;
            }
        };
        void poll();
        const timer = setInterval(() => void poll(), POLL_MS);
        return () => {
            cancelled = true;
            mounted.current = false;
            clearInterval(timer);
        };
    }, []);

    useEffect(() => {
        if (refreshConnection.current && status?.owned && status.phase === "running" && status.health?.port) {
            refreshConnection.current = false;
            void onHostAvailable();
        }
    }, [status, onHostAvailable]);

    const fresh = checkedAt > 0 && now - checkedAt <= FRESH_MS && !statusError;
    const busy = pending !== null || status?.phase === "starting" || status?.phase === "stopping";
    const unownedHost = status !== null && !status.owned && externalHost;
    const canStart = fresh && !busy && !unownedHost && !status?.owned
        && (status?.phase === "stopped" || status?.phase === "failed");
    const canStop = fresh && !busy && status?.owned && status.phase === "running"
        && status.restartSafe && status.health !== null && !status.health.draining;

    async function perform(action: Action) {
        if (actionRef.current || (action === "start" ? !canStart : !canStop)) return;
        if (Date.now() - checkedAt > FRESH_MS) { setNow(Date.now()); return; }
        actionRef.current = action;
        revision.current += 1;
        setPending(action);
        setActionError("");
        if (action !== "stop") refreshConnection.current = true;
        try {
            const next = await actions[action]();
            if (!mounted.current) return;
            setStatus(next);
            setCheckedAt(Date.now());
            setNow(Date.now());
            setStatusError("");
        } catch {
            if (mounted.current) setActionError(`Could not ${action} the desktop host. Check its status and try again.`);
        } finally {
            actionRef.current = null;
            if (mounted.current) setPending(null);
        }
    }

    let note = "Host controls work without pairing. Convening and agent controls still require a paired host.";
    if (unownedHost || status?.lastExit?.reason === "singleton") note = "A host was started outside this app. Stop it from its terminal before starting a desktop host. This app cannot stop or restart it.";
    else if (status?.health?.draining) note = "Council work is in progress. Stop and restart will become available when the host is idle.";
    else if (status?.owned && status.phase === "running" && (!fresh || !status.restartSafe)) {
        note = "Waiting for current host health before enabling stop and restart.";
    }
    const error = actionError || statusError || status?.error;
    const logs = status?.logs.slice(-50) ?? [];
    const health = status?.health;
    const lastExit = status?.lastExit;

    return (
        <div className="desktop-host-controls">
            <div className="head">
                <div className="state" role="status" aria-live="polite">
                    <h3>Desktop host</h3>
                    <span>{statusError ? "Status unavailable" : statusLabel(status, Boolean(fresh))}</span>
                </div>
                <div className="actions" aria-describedby={noteId}>
                    <button type="button" onClick={() => void perform("start")} disabled={!canStart}>
                        <Play size={14} aria-hidden="true" /> {pending === "start" || status?.phase === "starting" ? "Starting…" : "Start host"}
                    </button>
                    <button type="button" onClick={() => void perform("stop")} disabled={!canStop}>
                        <Square size={14} aria-hidden="true" /> {pending === "stop" || status?.phase === "stopping" ? "Stopping…" : "Stop host"}
                    </button>
                    <button type="button" onClick={() => void perform("restart")} disabled={!canStop}>
                        <RefreshCw size={14} aria-hidden="true" /> {pending === "restart" ? "Restarting…" : "Restart"}
                    </button>
                </div>
            </div>
            {health && status?.owned && (
                <p className="metrics">
                    {health.agents} {health.agents === 1 ? "agent" : "agents"}
                    {health.port !== null && ` · Port ${health.port}`}
                    {` · Up ${uptime(health.uptimeMs)}`}
                    {health.councilCode && !health.leaseHealthy && " · Host lease lost"}
                </p>
            )}
            <p id={noteId} className="note">{note}</p>
            {error && <p className="error" role="alert"><AlertCircle size={15} aria-hidden="true" /><span>{error}</span></p>}
            {lastExit && status?.phase !== "running" && (
                <p className="note">
                    {lastExit.forced ? "The last host required a forced shutdown."
                        : lastExit.clean ? "The last host stopped cleanly." : "The last host did not exit cleanly."}
                    {lastExit.draining && " Council work was still in progress."}
                </p>
            )}
            {logs.length > 0 && (
                <details>
                    <summary>Host activity ({logs.length})</summary>
                    <ol aria-label="Desktop host activity">
                        {logs.map((log, index) => (
                            <li key={`${log.atMs}-${index}`}>
                                <time dateTime={new Date(log.atMs).toISOString()}>
                                    {new Date(log.atMs).toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney", hour12: false })}
                                </time>
                                <span>{log.level === "error" ? "Error: " : log.level === "warn" ? "Warning: " : ""}{log.message}</span>
                            </li>
                        ))}
                    </ol>
                </details>
            )}
            <style jsx>{`
                .desktop-host-controls { display: flex; flex-direction: column; gap: 9px; margin-bottom: 14px; padding-bottom: 14px; border-bottom: 1px solid var(--color-border); }
                .head, .state, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
                .head { justify-content: space-between; gap: 12px; }
                h3 { margin: 0; font-size: 13px; font-weight: 700; }
                .state > span, .metrics, .note { color: var(--color-text-muted); font-size: 12px; line-height: 1.5; }
                p { margin: 0; }
                .note { max-width: 75ch; }
                .metrics, time { font-variant-numeric: tabular-nums; }
                button { display: inline-flex; align-items: center; gap: 7px; min-height: 36px; padding: 8px 11px; border: 1px solid var(--color-border); border-radius: 14px; font: inherit; font-size: 12.5px; font-weight: 650; color: var(--color-text-primary); background: color-mix(in srgb, var(--color-background) 58%, transparent); cursor: pointer; transition: background-color 160ms ease-out; }
                button:hover:not(:disabled) { background: var(--color-background); }
                button:active:not(:disabled) { background: var(--color-surface); }
                button:disabled { color: var(--color-text-muted); opacity: 0.55; cursor: not-allowed; }
                button:focus-visible, summary:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
                .error { display: flex; align-items: flex-start; gap: 8px; padding: 10px; border-radius: 8px; color: var(--color-text-primary); background: var(--color-background); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
                .error :global(svg) { flex-shrink: 0; margin-top: 1px; }
                summary { width: fit-content; color: var(--color-text-muted); font-size: 12px; cursor: pointer; }
                summary:hover { color: var(--color-text-primary); }
                ol { list-style: none; margin: 8px 0 0; padding: 0; max-height: 190px; overflow-y: auto; scrollbar-color: var(--color-border) transparent; }
                li { display: flex; align-items: baseline; gap: 10px; padding: 3px 0; font-size: 12px; line-height: 1.5; }
                time { color: var(--color-text-muted); flex-shrink: 0; }
                li > span { min-width: 0; overflow-wrap: anywhere; }
                ::selection { color: var(--color-primary-foreground); background: var(--color-primary); }
                @media (prefers-reduced-motion: reduce) { button { transition: none; } }
            `}</style>
        </div>
    );
}
