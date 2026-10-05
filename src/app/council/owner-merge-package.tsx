"use client";

import { useEffect, useRef, useState } from "react";
import { Dropdown } from "@/components/dropdown";
import { ownerCompareCommand, type OwnerAttempt, type OwnerAttemptPage, type OwnerAttemptSummary, type OwnerVerification } from "@/lib/council/owner-evidence";
import { ExecutionEvidence } from "./execution-evidence";
import ui from "./council.module.css";

const attemptUrl = (code: string, id?: string) => `/api/council/${encodeURIComponent(code)}/integration-attempts${id ? `/${encodeURIComponent(id)}` : ""}`;

export function OwnerMergePackage({ code, revision }: { code: string; revision: string | null }) {
    const [open, setOpen] = useState(false);
    const [attempts, setAttempts] = useState<OwnerAttemptSummary[]>([]);
    const [selected, setSelected] = useState("");
    const [nextCursor, setNextCursor] = useState<number | null>(null);
    const historyCursor = useRef<number | null | undefined>(undefined);
    const [attempt, setAttempt] = useState<OwnerAttempt | null>(null);
    const [loading, setLoading] = useState(false);
    const [historyLoaded, setHistoryLoaded] = useState(false);
    const [detailLoading, setDetailLoading] = useState(false);
    const [historyError, setHistoryError] = useState("");
    const [detailError, setDetailError] = useState("");
    const [refresh, setRefresh] = useState(0);

    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        setLoading(true); setHistoryError("");
        void fetch(attemptUrl(code), { cache: "no-store", signal: controller.signal }).then(async response => {
            const page = await response.json() as OwnerAttemptPage;
            if (!response.ok || page.status !== "available") throw new Error();
            if (controller.signal.aborted) return;
            setAttempts(current => [...new Map([...current, ...page.attempts].map(item => [item.attemptId, item])).values()].sort((a, b) => b.attemptNumber - a.attemptNumber));
            setSelected(current => current || page.attempts[0]?.attemptId || "");
            if (historyCursor.current === undefined) {
                historyCursor.current = page.nextCursor;
                setNextCursor(page.nextCursor);
            }
            setHistoryLoaded(true);
        }).catch(() => { if (!controller.signal.aborted) setHistoryError("Attempt history is unavailable. Retry to load it."); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [code, open, refresh, revision]);

    useEffect(() => {
        if (!open || !selected) return;
        const controller = new AbortController();
        setDetailLoading(true); setDetailError("");
        void fetch(attemptUrl(code, selected), { cache: "no-store", signal: controller.signal }).then(async response => {
            const result = await response.json() as { status: string; attempt: OwnerAttempt };
            if (!response.ok || result.status !== "available" || result.attempt.attemptId !== selected) throw new Error();
            if (!controller.signal.aborted) setAttempt(result.attempt);
        }).catch(() => { if (!controller.signal.aborted) setDetailError("This attempt's evidence is unavailable. Retry to load it."); })
            .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
        return () => controller.abort();
    }, [code, open, selected, refresh, revision]);

    async function older() {
        if (nextCursor === null || loading) return;
        setLoading(true); setHistoryError("");
        try {
            const response = await fetch(`${attemptUrl(code)}?cursor=${nextCursor}`, { cache: "no-store" });
            const page = await response.json() as OwnerAttemptPage;
            if (!response.ok || page.status !== "available") throw new Error();
            setAttempts(current => [...new Map([...current, ...page.attempts].map(item => [item.attemptId, item])).values()].sort((a, b) => b.attemptNumber - a.attemptNumber));
            historyCursor.current = page.nextCursor;
            setNextCursor(page.nextCursor);
        } catch { setHistoryError("Older attempts are unavailable. Try again."); }
        finally { setLoading(false); }
    }

    return <details className={ui.executionHistory} onToggle={event => setOpen(event.currentTarget.open)}>
        <summary>Owner review package</summary>
        <div className={ui.ownerControls}>
            {attempts.length > 0 && <Dropdown ariaLabel="Integration attempt" value={selected} onChange={setSelected}
                options={attempts.map(item => ({ value: item.attemptId, label: `Attempt ${item.attemptNumber} · ${item.status} · ${item.mode === "host" ? "host assembly" : item.integratorAgent ?? "agent assembly"}` }))}
                className={ui.ownerAttemptPicker} />}
            <button className={ui.evidenceButton} type="button" disabled={loading || detailLoading} onClick={() => setRefresh(value => value + 1)}>Refresh evidence</button>
        </div>
        {loading && <p className={ui.evidenceNote} role="status">Loading attempt history…</p>}
        {historyError && <p className={ui.ownerError} role="status">{historyError}</p>}
        {historyLoaded && !loading && !historyError && attempts.length === 0 && <p className={ui.evidenceNote}>No recorded integration attempts. Older integration results do not contain this evidence package.</p>}
        {nextCursor !== null && <button className={ui.evidenceButton} type="button" disabled={loading} onClick={() => void older()}>Load older attempts</button>}
        {detailError && <p className={ui.ownerError} role="status">{detailError}</p>}
        {detailLoading && attempt?.attemptId !== selected && <p className={ui.evidenceNote} role="status">Loading selected attempt…</p>}
        {attempt?.attemptId === selected && <AttemptReview key={attempt.attemptId} code={code} attempt={attempt} />}
    </details>;
}

export function AttemptReview({ code, attempt }: { code: string; attempt: OwnerAttempt }) {
    const [copyStatus, setCopyStatus] = useState("");
    const commandRef = useRef<HTMLTextAreaElement>(null);
    const command = attempt.status === "verified" && attempt.manifest ? ownerCompareCommand(attempt.baseSha, attempt.tipSha) : null;
    async function copy() {
        if (!command) return;
        try { await navigator.clipboard.writeText(command); setCopyStatus("Comparison command copied."); }
        catch { setCopyStatus("Clipboard unavailable. Select and copy the command below."); commandRef.current?.focus(); commandRef.current?.select(); }
    }
    const evidence = attempt.evidence;
    return <div className={ui.ownerReview}>
        <h3 className={ui.ownerTitle}>Attempt {attempt.attemptNumber} · {attempt.status}</h3>
        <p className={ui.evidenceNote}>{attempt.mode === "host" ? "Host assembly" : `Agent assembly by ${attempt.integratorAgent ?? "an unrecorded seat"}`} · started <time dateTime={attempt.startedAt}>{new Date(attempt.startedAt).toLocaleString()}</time>
            {attempt.finishedAt && <> · finished <time dateTime={attempt.finishedAt}>{new Date(attempt.finishedAt).toLocaleString()}</time></>}</p>
        <dl className={ui.evidenceGrid}>
            <div><dt>Base branch</dt><dd>{attempt.baseBranch}</dd></div>
            <div><dt>Integration branch</dt><dd>{attempt.branch ?? "Not recorded"}</dd></div>
            <div><dt>Frozen base SHA</dt><dd><code>{attempt.baseSha}</code></dd></div>
            <div><dt>Recorded integration tip</dt><dd><code>{attempt.tipSha ?? "Not recorded"}</code></dd></div>
            <div className={ui.evidenceWide}><dt>Frozen manifest SHA-256</dt><dd><code>{attempt.manifestHash}</code></dd></div>
        </dl>
        {attempt.mode === "agent" && <ExecutionEvidence executionId={attempt.executionId} snapshot={attempt.executionEvidence} label="Integrator execution" />}
        {command && <div className={ui.ownerCompare}>
            <label className={ui.evidenceNote} htmlFor={`compare-${attempt.attemptId}`}>Compare the frozen base with this recorded result in your repository.</label>
            <textarea id={`compare-${attempt.attemptId}`} ref={commandRef} className={ui.ownerCommand} rows={3} readOnly value={command} spellCheck={false} />
            <button className={ui.evidenceButton} type="button" onClick={() => void copy()}>Copy comparison command</button>
            <p className={ui.evidenceNote} role="status">{copyStatus}</p>
        </div>}
        {attempt.manifest ? <details className={ui.executionHistory}>
            <summary>Accepted commits <span className={ui.evidenceSummary}>{attempt.manifest.items.length} {attempt.manifest.items.length === 1 ? "task" : "tasks"}</span></summary>
            {attempt.manifest.items.map(item => <div key={item.itemId} className={ui.executionRecord}>
                <div className={ui.evidenceNote}>Task {item.sequence} · {item.agentName} · <code>{item.commitSha}</code></div>
                <ExecutionEvidence executionId={item.acceptedExecutionId} snapshot={item.executionEvidence} label="Accepted submission run" />
                <VerificationReview code={code} attemptId={attempt.attemptId} runId={item.verificationRunId} />
            </div>)}
        </details> : <p className={ui.evidenceNote}>Frozen manifest unavailable.</p>}
        {evidence ? <>
            <details className={ui.executionHistory}>
                <summary>Integration checks <span className={ui.evidenceSummary}>{evidence.receipts.length} commands</span></summary>
                {evidence.receipts.length === 0 && <p className={ui.evidenceNote}>No command receipts recorded.</p>}
                {evidence.receipts.map((receipt, index) => <div key={index} className={ui.executionRecord}>
                    <code>{receipt.command.join(" ")}</code>
                    <p className={ui.evidenceNote}>Exit {receipt.exitCode ?? "not recorded"} · {receipt.durationMs} ms{receipt.timedOut ? " · timed out" : ""}</p>
                    <p className={ui.evidenceNote}>Output digest <code>{receipt.outputDigest}</code></p>
                    <pre className={ui.ownerOutput}>{receipt.outputTail || "No output."}</pre>
                </div>)}
            </details>
            <details className={ui.executionHistory}>
                <summary>Changes and protected refs</summary>
                <pre className={ui.ownerOutput}>{evidence.diffSummary ?? "Diff summary not recorded."}</pre>
                {evidence.changedPaths === null ? <p className={ui.evidenceNote}>Changed paths not recorded.</p> : evidence.changedPaths.length === 0 ? <p className={ui.evidenceNote}>No changed paths.</p> : <ul className={ui.ownerList}>{evidence.changedPaths.map(path => <li key={path}><code>{path}</code></li>)}</ul>}
                {evidence.protectedRefs.before === null || evidence.protectedRefs.after === null ? <p className={ui.evidenceNote}>Protected-ref observations not recorded.</p>
                    : <dl className={ui.evidenceGrid}>{[...new Set([...Object.keys(evidence.protectedRefs.before), ...Object.keys(evidence.protectedRefs.after)])].map(ref => <div key={ref} className={ui.evidenceWide}>
                        <dt>{ref}</dt><dd>Before <code>{ref in evidence.protectedRefs.before! ? evidence.protectedRefs.before![ref] ?? "absent" : "not observed"}</code><br />After <code>{ref in evidence.protectedRefs.after! ? evidence.protectedRefs.after![ref] ?? "absent" : "not observed"}</code></dd>
                    </div>)}</dl>}
            </details>
        </> : <p className={ui.evidenceNote}>{attempt.evidenceStatus === "not_recorded" ? "Integration receipts and observations were not recorded for this attempt." : "Integration evidence is unavailable."}</p>}
        <details className={ui.executionHistory}>
                <summary>Decision and remaining review</summary>
                <p className={ui.evidenceNote}>Decision captured when this attempt began</p><p className={ui.ownerProse}>{attempt.decision ?? "No decision recorded."}</p>
                <p className={ui.evidenceNote}>Open questions captured at start</p>
                {attempt.openQuestions.length ? <ul className={ui.ownerList}>{attempt.openQuestions.map((question, index) => <li key={index}>{question}</li>)}</ul> : <p className={ui.evidenceNote}>No open questions recorded.</p>}
                <p className={ui.evidenceNote}>Reported conflict notes, not independent verification</p><p className={ui.ownerProse}>{evidence?.conflictNotes ?? "Not recorded."}</p>
                <p className={ui.evidenceNote}>Manual checks</p>{evidence?.manualChecks == null ? <p className={ui.evidenceNote}>Not recorded.</p> : evidence.manualChecks.length === 0 ? <p className={ui.evidenceNote}>None recorded.</p> : <ul className={ui.ownerList}>{evidence.manualChecks.map((note, index) => <li key={index}>{note}</li>)}</ul>}
            </details>
    </div>;
}

function VerificationReview({ code, attemptId, runId }: { code: string; attemptId: string; runId: string }) {
    const [open, setOpen] = useState(false);
    const [verification, setVerification] = useState<OwnerVerification | null>(null);
    const [error, setError] = useState("");
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        void fetch(`${attemptUrl(code, attemptId)}/verification/${encodeURIComponent(runId)}`, { cache: "no-store", signal: controller.signal }).then(async response => {
            const result = await response.json() as { status: string; verification: OwnerVerification };
            if (!response.ok || result.status !== "available" || result.verification.verificationRunId !== runId) throw new Error();
            if (!controller.signal.aborted) { setVerification(result.verification); setError(""); }
        }).catch(() => { if (!controller.signal.aborted) setError("Exact verification evidence is unavailable."); });
        return () => controller.abort();
    }, [open, code, attemptId, runId, retry]);
    return <details className={ui.executionHistory} id={`verification-${runId}`} onToggle={event => setOpen(event.currentTarget.open)}>
        <summary>Verification run <code className={ui.evidenceSummary}>{runId}</code></summary>
        {error && <p className={ui.ownerError} role="status">{error} <button className={ui.evidenceButton} type="button" onClick={() => { setError(""); setRetry(value => value + 1); }}>Retry verification</button></p>}
        {!verification && !error && <p className={ui.evidenceNote} role="status">Loading verification…</p>}
        {verification && <>
            <p className={ui.evidenceNote}>{verification.passed ? "Passed" : "Failed"} · {verification.profileId} · <time dateTime={verification.checkedAt}>{new Date(verification.checkedAt).toLocaleString()}</time></p>
            {verification.receipts.map((receipt, index) => <div key={index} className={ui.executionRecord}>
                <code>{receipt.command?.join(" ") ?? `Command ${index + 1}: legacy arguments withheld`}</code>
                <p className={ui.evidenceNote}>Exit {receipt.exitCode ?? "not recorded"} · {receipt.durationMs} ms{receipt.timedOut ? " · timed out" : ""}</p>
                <p className={ui.evidenceNote}>Output digest <code>{receipt.outputDigest}</code></p>
                {receipt.textStatus === "redacted" ? <pre className={ui.ownerOutput}>{receipt.outputTail || "No output."}</pre>
                    : <p className={ui.evidenceNote}>Legacy output withheld because no redaction version was recorded.</p>}
            </div>)}
        </>}
    </details>;
}
