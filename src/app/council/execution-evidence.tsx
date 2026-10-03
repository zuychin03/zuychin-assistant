"use client";

import { useState } from "react";
import { executionIdentityLabel, executionSourceLabel, resolveExecutionEvidence, type CouncilExecutionEvidence, type CouncilExecutionPage, type CouncilExecutionRecord } from "@/lib/council/execution-evidence";
import ui from "./council.module.css";

export function ExecutionEvidence({ executionId, records = [], snapshot, label = "Model details" }: {
    executionId?: string | null;
    records?: CouncilExecutionEvidence[];
    snapshot?: CouncilExecutionEvidence | null;
    label?: string;
}) {
    const result = resolveExecutionEvidence(executionId, snapshot ? [snapshot] : records);
    const evidence = result.evidence;
    if (!evidence) return <span className={ui.evidenceState}>{label}: {result.status === "not_recorded" ? "not recorded" : "evidence unavailable"}</span>;
    return (
        <details className={ui.evidence}>
            <summary>{label}<span className={ui.evidenceSummary}>{evidence.effectiveModel ?? "Effective model not reported"}</span></summary>
            <dl className={ui.evidenceGrid}>
                <div><dt>Requested model</dt><dd>{evidence.requestedModel ?? "Not specified"}</dd></div>
                <div><dt>Effective model</dt><dd>{evidence.effectiveModel ?? "Not reported"}</dd></div>
                <div><dt>Requested effort</dt><dd>{evidence.requestedReasoningEffort ?? "Not specified"}</dd></div>
                <div><dt>Effective effort</dt><dd>{evidence.effectiveReasoningEffort ?? "Not reported"}</dd></div>
                <div><dt>Model evidence</dt><dd>{executionSourceLabel(evidence.modelSource)}</dd></div>
                <div><dt>Adapter version</dt><dd>{evidence.adapterVersion ?? "Not reported"}</dd></div>
                <div><dt>Provider / connector</dt><dd>{evidence.provider ?? "Not reported"} / {evidence.connectorKind}</dd></div>
                <div><dt>Seat identity</dt><dd>{executionIdentityLabel(evidence.identityAssurance)}</dd></div>
                <div><dt>Host generation</dt><dd>{evidence.hostGeneration ?? "Not recorded"}</dd></div>
                <div><dt>Policy version</dt><dd>{evidence.policyVersion ?? "Not recorded"}</dd></div>
                <div className={ui.evidenceWide}><dt>Execution</dt><dd><code>{evidence.executionId}</code></dd></div>
            </dl>
            {evidence.modelSource === "adapter_legacy_set_model" && <p className={ui.evidenceNote}>The adapter acknowledged this selection without independent model readback.</p>}
            {evidence.modelSource === "configured_cli" && <p className={ui.evidenceNote}>Configuration was recorded without adapter confirmation.</p>}
        </details>
    );
}

export function ExecutionRecord({ record, label }: { record: CouncilExecutionRecord; label: string }) {
    return <div className={ui.executionRecord}>
        <ExecutionEvidence executionId={record.executionId} snapshot={record} label={label} />
        <div className={ui.evidenceNote}>Started <time dateTime={record.startedAt}>{new Date(record.startedAt).toLocaleString()}</time>
            {record.endedAt ? <> · ended <time dateTime={record.endedAt}>{new Date(record.endedAt).toLocaleString()}</time></> : " · End not recorded"}
        </div>
    </div>;
}

export function ExecutionHistory({ code, page, onRetry }: { code: string; page: CouncilExecutionPage; onRetry: () => void }) {
    const [history, setHistory] = useState({ page, records: page.records });
    if (history.page !== page) {
        setHistory({ page, records: [...new Map([...history.records, ...page.records].map(record => [record.executionId, record])).values()] });
    }
    const [older, setOlder] = useState<CouncilExecutionRecord[]>([]);
    const [cursor, setCursor] = useState<string | null | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const records = [...new Map([...older, ...history.records, ...page.records].map(record => [record.executionId, record])).values()]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.executionId.localeCompare(a.executionId));
    const nextCursor = cursor === undefined ? page.nextCursor : cursor;
    async function loadOlder() {
        if (!nextCursor || busy) return;
        setBusy(true); setError("");
        try {
            const response = await fetch(`/api/council/${encodeURIComponent(code)}/executions?cursor=${encodeURIComponent(nextCursor)}`, { cache: "no-store" });
            const next = await response.json() as CouncilExecutionPage;
            if (!response.ok || next.historyStatus !== "available") throw new Error();
            setOlder(current => [...current, ...page.records, ...next.records]);
            setCursor(next.nextCursor);
        } catch { setError("Older run history is unavailable. Try again."); }
        finally { setBusy(false); }
    }
    return <details className={ui.executionHistory}>
        <summary>Recorded run history <span className={ui.evidenceSummary}>{records.length} loaded</span></summary>
        {page.historyStatus === "unavailable" && <div className={ui.evidenceNote} role="status">Run history is unavailable. <button type="button" onClick={onRetry}>Retry history</button></div>}
        {records.length === 0 && page.historyStatus === "available" && <p className={ui.evidenceNote}>No execution records.</p>}
        {records.map(record => <ExecutionRecord key={record.executionId} record={record} label={record.agentName} />)}
        {error && <p className={ui.evidenceNote} role="status">{error}</p>}
        {nextCursor && <button className={ui.evidenceButton} type="button" onClick={() => void loadOlder()} disabled={busy}>{busy ? "Loading older runs…" : "Load older runs"}</button>}
    </details>;
}
