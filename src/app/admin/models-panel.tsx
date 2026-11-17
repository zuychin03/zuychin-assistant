"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FlaskConical, Layers, RefreshCw, Undo2 } from "lucide-react";
import { Dropdown } from "@/components/dropdown";
import type { CatalogueRow } from "@/lib/ai/catalogue/snapshot";
import type { DiscoveryRunRecord } from "@/lib/ai/catalogue/store";

type ModelRow = CatalogueRow & { probeDetail: unknown; inCode: boolean; retired: boolean };
interface ProviderEntry { id: string; label: string; available: boolean; discovery: { include: string; pricing: string } | null }
interface CataloguePayload {
    storage: string;
    settings: { enabled: boolean; maxProbes: number };
    providers: ProviderEntry[];
    rows: ModelRow[];
    runs: DiscoveryRunRecord[];
}
type Filter = "all" | "attention" | "picker" | "hidden";
interface Notice { tone?: "danger"; text: string }

const FILTERS: { value: Filter; label: string }[] = [
    { value: "all", label: "All models" }, { value: "attention", label: "Needs attention" },
    { value: "picker", label: "In the picker" }, { value: "hidden", label: "Not in the picker" },
];
const POLL_MS = 4000;
const STEP_LABELS: Record<string, string> = { chat: "Chat", tools: "Tool call", forced: "Forced tool call", vision: "Vision" };
const OUTCOME_LABELS: Record<string, string> = { pass: "Passed", fail: "Failed", transient: "No clear result", skipped: "Skipped" };

const keyOf = (row: Pick<CatalogueRow, "providerId" | "modelId">) => `${row.providerId}::${row.modelId}`;

function melbourneTime(value: string | null): string {
    return value ? new Date(value).toLocaleString("en-AU", { timeZone: "Australia/Melbourne", day: "2-digit", month: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" }) : "Never";
}
function duration(ms: number | null): string {
    if (ms === null) return "Not measured";
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
function tokens(value: number | null): string {
    if (value === null) return "Unknown";
    return value >= 1000 ? `${Math.round(value / 1000).toLocaleString()}K` : value.toLocaleString();
}
const yesNo = (value: boolean | null) => value === null ? "Unknown" : value ? "Yes" : "No";

const inPicker = (row: ModelRow) => row.inCode || row.approvedAt !== null || row.probeStatus === "passed";
const isNew = (row: ModelRow) => row.origin === "discovered" && row.approvedAt === null && row.probeStatus === "passed" && !row.missingSince;

/** Lower sorts first: New, Missing, Failing, Untested paid, then the rest. */
function rank(row: ModelRow): number {
    if (isNew(row)) return 0;
    if (row.missingSince && inPicker(row)) return 1;
    if (row.probeStatus === "failed" && (row.inCode || row.approvedAt !== null)) return 2;
    if (!row.inCode && !row.free && row.probeStatus === "untested") return 3;
    if (inPicker(row)) return 4;
    return row.probeStatus === "untested" ? 5 : 6;
}

function steps(detail: unknown): { name: string; outcome: string; httpStatus: number | null; ms: number | null; detail: string | null }[] {
    const raw = detail !== null && typeof detail === "object" ? (detail as { steps?: unknown }).steps : null;
    if (!raw || typeof raw !== "object") return [];
    return Object.entries(raw as Record<string, unknown>).flatMap(([name, value]) => {
        if (!value || typeof value !== "object") return [];
        const step = value as Record<string, unknown>;
        return [{
            name, outcome: typeof step.outcome === "string" ? step.outcome : "unknown",
            httpStatus: typeof step.httpStatus === "number" ? step.httpStatus : null,
            ms: typeof step.ms === "number" ? step.ms : null,
            detail: typeof step.detail === "string" ? step.detail : null,
        }];
    });
}

function runSummary(run: DiscoveryRunRecord): string {
    const summary = run.summary;
    const count = (key: string) => Array.isArray(summary[key]) ? (summary[key] as unknown[]).length : 0;
    if (run.status === "running") return "Still running. New tests are saved when it finishes.";
    if (run.status === "failed") return `Failed: ${typeof summary.error === "string" ? summary.error : "no reason was recorded."}`;
    const took = typeof summary.durationMs === "number" ? ` in ${duration(summary.durationMs)}` : "";
    return `Finished${took}: ${count("added")} added, ${count("passed")} passed, ${count("newlyMissing")} newly missing, ${count("failedRetests")} failed a re-test.`;
}

function listingFailed(run: DiscoveryRunRecord | undefined, providerId: string): boolean {
    const providers = run?.summary.providers;
    const entry = providers && typeof providers === "object" ? (providers as Record<string, { listing?: unknown }>)[providerId] : undefined;
    return entry?.listing === "failed";
}

function ModelEntry({ row, locked, busy, confirming, onTest, onApprove, onCancel }: {
    row: ModelRow;
    locked: boolean;
    busy: boolean;
    confirming: boolean;
    onTest: () => void;
    onApprove: (approved: boolean) => void;
    onCancel: () => void;
}) {
    const probeSteps = steps(row.probeDetail);
    const statusPill = isNew(row) ? <span className="pill">New</span>
        : row.probeStatus === "passed" ? <span className="pill" data-tone="success">Passed</span>
            : row.probeStatus === "failed" ? <span className="pill" data-tone="danger">Failed</span>
                : row.probeStatus === "inconclusive" ? <span className="pill" data-tone="warning">Inconclusive</span>
                    : <span className="pill">Untested</span>;
    return (
        <div className="row" style={styles.row}>
            <div style={styles.rowTop}>
                <div style={styles.rowText}>
                    <span className="row-title">{row.label}</span>
                    <span className="meta" style={styles.id}>{row.modelId}</span>
                </div>
                <div style={styles.actions}>
                    <button type="button" className="btn" disabled={locked || busy} onClick={onTest} aria-label={`Test ${row.label}${row.free ? "" : ", a paid model"}`}>
                        <FlaskConical size={14} aria-hidden="true" />{row.free ? "Test" : "Test (paid)"}
                    </button>
                    {!row.inCode && (row.approvedAt
                        ? <button type="button" className="btn" disabled={busy} onClick={() => onApprove(false)} aria-label={`Unapprove ${row.label}`}><Undo2 size={14} aria-hidden="true" />Unapprove</button>
                        : <button type="button" className="btn" disabled={busy} onClick={() => onApprove(true)} aria-label={`Approve ${row.label}`}><Check size={14} aria-hidden="true" />Approve</button>)}
                </div>
            </div>
            <div style={styles.pills}>
                <span className="pill">{row.free ? "Free" : "Paid"}</span>
                {statusPill}
                {row.missingSince && <span className="pill" data-tone="danger">Missing</span>}
                {row.inCode ? <span className="pill">Built in</span> : row.approvedAt && <span className="pill" data-tone="success"><Check size={12} aria-hidden="true" />Approved</span>}
            </div>
            {confirming && <div className="notice" role="alert" style={styles.confirm}>
                <span>This test sends a few short requests to a paid model, which costs a little. Run it?</span>
                <button type="button" className="btn" data-tone="primary" disabled={locked || busy} onClick={onTest}>Run paid test</button>
                <button type="button" className="btn" onClick={onCancel}>Cancel</button>
            </div>}
            <p className="meta" style={styles.line}>
                {row.probedAt
                    ? `Tested ${melbourneTime(row.probedAt)}${row.probeChatMs !== null ? `, first answer in ${duration(row.probeChatMs)}` : ""}.`
                    : row.missingSince ? "Not tested."
                        : row.free ? "Not tested yet. The daily check tests it when its turn comes." : "Not tested. Paid models are tested only when you press Test."}
                {row.missingSince ? ` Missing from the provider's list since ${melbourneTime(row.missingSince)}.` : ""}
            </p>
            <details style={styles.details}>
                <summary className="link-btn" style={styles.detailsToggle}>Details</summary>
                <dl className="facts" style={styles.facts}>
                    <div><dt>Tool calls</dt><dd>{yesNo(row.supportsTools)}</dd></div>
                    <div><dt>Forced tool call (Search)</dt><dd>{yesNo(row.supportsSearch)}</dd></div>
                    <div><dt>Vision</dt><dd>{yesNo(row.supportsVision)}</dd></div>
                    <div><dt>Context / max output</dt><dd>{tokens(row.contextTokens)} / {tokens(row.maxOutputTokens)}</dd></div>
                    <div><dt>Inputs listed</dt><dd>{row.inputs.length ? row.inputs.join(", ") : "Not listed"}</dd></div>
                    <div><dt>First seen / last listed</dt><dd>{melbourneTime(row.firstSeenAt)} / {melbourneTime(row.lastSeenAt)}</dd></div>
                </dl>
                {probeSteps.length > 0 && <ul style={styles.steps}>
                    {probeSteps.map((step) => (
                        <li key={step.name} className="meta">
                            <strong style={styles.stepName}>{STEP_LABELS[step.name] ?? step.name}:</strong> {OUTCOME_LABELS[step.outcome] ?? step.outcome}
                            {step.httpStatus !== null ? `, HTTP ${step.httpStatus}` : ""}{step.ms !== null && step.outcome !== "skipped" ? `, ${duration(step.ms)}` : ""}
                            {step.detail ? <span style={styles.stepDetail}>{step.detail}</span> : null}
                        </li>
                    ))}
                </ul>}
                {row.description && <p className="meta" style={styles.line}>{row.description}</p>}
            </details>
        </div>
    );
}

export default function ModelsPanel() {
    const [data, setData] = useState<CataloguePayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [query, setQuery] = useState("");
    const [provider, setProvider] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [confirmKey, setConfirmKey] = useState<string | null>(null);
    const [testing, setTesting] = useState<{ key: string; label: string; runId: string } | null>(null);
    const requestRef = useRef<AbortController | null>(null);

    const load = useCallback(async () => {
        requestRef.current?.abort();
        const controller = new AbortController();
        requestRef.current = controller;
        setLoading(true);
        try {
            const response = await fetch("/api/admin/models", { cache: "no-store", signal: controller.signal });
            const body = await response.json().catch(() => null) as (CataloguePayload & { error?: string }) | null;
            if (controller.signal.aborted) return;
            if (!response.ok || !body || !Array.isArray(body.rows)) {
                throw new Error(response.status === 401 ? "Sign in again to view the model catalogue." : body?.error ?? "The model catalogue could not be loaded. Retry the request.");
            }
            setData(body);
            setLoadError(null);
        } catch (failure) {
            if (!controller.signal.aborted) setLoadError(failure instanceof Error ? failure.message : "The model catalogue could not be loaded. Retry the request.");
        } finally {
            if (!controller.signal.aborted) setLoading(false);
        }
    }, []);

    useEffect(() => { void load(); return () => requestRef.current?.abort(); }, [load]);

    const running = data?.runs.some((run) => run.status === "running") ?? false;
    useEffect(() => {
        if (!running) return;
        const timer = window.setTimeout(() => { void load(); }, POLL_MS);
        return () => window.clearTimeout(timer);
    }, [running, data, load]);

    useEffect(() => {
        if (!testing || !data) return;
        const run = data.runs.find((entry) => entry.id === testing.runId);
        if (!run || run.status === "running") return;
        const status = run.summary.status;
        setNotice(run.status === "failed"
            ? { tone: "danger", text: `The test of ${testing.label} could not run: ${typeof run.summary.error === "string" ? run.summary.error : "no reason was recorded."}` }
            : { text: `${testing.label} test finished: ${status === "passed" ? "passed" : status === "failed" ? "failed" : "no clear result, so it will be retried"}.` });
        setTesting(null);
    }, [data, testing]);

    const send = async (url: string, method: "POST" | "PATCH", body?: object) => {
        const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
        const payload = await response.json().catch(() => ({})) as { error?: string; runId?: string };
        return { ok: response.ok, error: payload.error, runId: payload.runId };
    };

    const checkNow = async () => {
        setNotice(null);
        const result = await send("/api/admin/models/refresh", "POST");
        setNotice(result.ok ? { text: "Checking every provider now. This usually takes under a minute." } : { tone: "danger", text: result.error ?? "The check could not start." });
        await load();
    };

    const test = async (row: ModelRow) => {
        const key = keyOf(row);
        if (!row.free && confirmKey !== key) { setConfirmKey(key); return; }
        setConfirmKey(null);
        setBusyKey(key);
        setNotice(null);
        const result = await send("/api/admin/models/test", "POST", { providerId: row.providerId, modelId: row.modelId });
        if (result.ok && result.runId) setTesting({ key, label: `${providerLabels.get(row.providerId) ?? row.providerId} ${row.label}`, runId: result.runId });
        else setNotice({ tone: "danger", text: result.error ?? "The test could not start." });
        await load();
        setBusyKey(null);
    };

    const approve = async (row: ModelRow, approved: boolean) => {
        setBusyKey(keyOf(row));
        setNotice(null);
        const result = await send("/api/admin/models", "PATCH", { providerId: row.providerId, modelId: row.modelId, approved });
        const name = `${providerLabels.get(row.providerId) ?? row.providerId} ${row.label}`;
        setNotice(result.ok
            ? { text: approved ? `${name} is approved for automatic routes.` : `${name} is no longer used by automatic routes. It stays in the picker while its test passes.` }
            : { tone: "danger", text: result.error ?? "The change could not be saved." });
        await load();
        setBusyKey(null);
    };

    const rows = (data?.rows ?? []).filter((row) => !row.retired);
    const providerLabels = new Map((data?.providers ?? []).map((entry) => [entry.id, entry.label]));
    const needle = query.trim().toLocaleLowerCase();
    const visible = rows.filter((row) => (!provider || row.providerId === provider)
        && (filter === "all" || (filter === "attention" ? rank(row) <= 3 : filter === "picker" ? inPicker(row) : !inPicker(row)))
        && (!needle || `${row.label} ${row.modelId} ${providerLabels.get(row.providerId) ?? row.providerId}`.toLocaleLowerCase().includes(needle)));
    const groups = (data?.providers ?? [])
        .map((entry) => ({ entry, rows: visible.filter((row) => row.providerId === entry.id).sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)) }))
        .filter((group) => group.rows.length > 0);
    const lastCheck = data?.runs.find((run) => run.id !== testing?.runId && run.summary.kind !== "test");
    const attentionCount = rows.filter((row) => rank(row) <= 3).length;

    return (
        <div>
            <div className="panel-head">
                <Layers size={16} aria-hidden="true" />
                <div className="panel-heading">
                    <h2>Model catalogue</h2>
                    <p>Models the daily check found and tested. Tested free models join the picker; approve one to let worker runs and fallbacks use it.</p>
                </div>
                <button type="button" className="btn" onClick={() => { void checkNow(); }} disabled={running || !data} aria-label="Check providers now">
                    <RefreshCw size={15} className={running ? "animate-spin" : undefined} aria-hidden="true" />
                    {running && !testing ? "Checking" : "Check now"}
                </button>
            </div>
            {loadError && <div className="notice" data-tone="danger" role="alert" style={styles.feedback}>
                <span>{loadError}{data ? " The last loaded catalogue is shown below." : ""}</span>
                <button type="button" className="btn" disabled={loading} onClick={() => { void load(); }}>Retry</button>
            </div>}
            {notice && <div className="notice" data-tone={notice.tone} role={notice.tone ? "alert" : "status"} style={styles.feedback}><span>{notice.text}</span></div>}
            {loading && !data && !loadError && <p role="status" className="empty">Loading the model catalogue…</p>}
            {data && <>
                <div className="inset" style={styles.run}>
                    <p className="meta" style={styles.runLine}>
                        <strong style={styles.runLabel}>Last check:</strong> {lastCheck ? `${melbourneTime(lastCheck.startedAt)} Melbourne time, ${lastCheck.trigger === "cron" ? "daily" : "manual"}. ${runSummary(lastCheck)}` : "No check has run yet."}
                    </p>
                    {!data.settings.enabled && <p className="meta" style={styles.runLine}>The daily check is off (MODEL_DISCOVERY=off). Check now still works.</p>}
                    <p className="meta" style={styles.runLine}>{rows.length} models, {attentionCount} need attention. Up to {data.settings.maxProbes} free models per provider are tested each run.</p>
                </div>
                <div style={styles.filters}>
                    <label style={styles.filter}><span>Find a model</span><input className="field" style={styles.input} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Model or provider" /></label>
                    <label style={styles.filter}><span>Provider</span><Dropdown ariaLabel="Model catalogue provider" className="field" style={{ ...styles.input, flex: "none" }} value={provider} onChange={setProvider}
                        options={[{ value: "", label: "All providers" }, ...data.providers.filter((entry) => rows.some((row) => row.providerId === entry.id)).map((entry) => ({ value: entry.id, label: entry.label }))]} /></label>
                    <label style={styles.filter}><span>Show</span><Dropdown ariaLabel="Model catalogue filter" className="field" style={{ ...styles.input, flex: "none" }} value={filter} onChange={(value) => setFilter(value as Filter)} options={FILTERS} /></label>
                </div>
                <div className="list scroll" style={styles.list}>
                    {groups.map(({ entry, rows: providerRows }) => (
                        <section key={entry.id} aria-labelledby={`catalogue-${entry.id}`} style={styles.group}>
                            <h3 id={`catalogue-${entry.id}`} style={styles.groupHead}>
                                {entry.label}
                                <span className="meta">{providerRows.length} shown</span>
                                {listingFailed(lastCheck, entry.id) && <span className="pill" data-tone="danger">List check failed</span>}
                                {!entry.available && <span className="pill">Not available</span>}
                            </h3>
                            {providerRows.map((row) => {
                                const key = keyOf(row);
                                return <ModelEntry key={key} row={row} locked={running} busy={busyKey === key || testing?.key === key} confirming={confirmKey === key}
                                    onTest={() => { void test(row); }} onApprove={(approved) => { void approve(row, approved); }} onCancel={() => setConfirmKey(null)} />;
                            })}
                        </section>
                    ))}
                    {!groups.length && <p className="empty">{rows.length ? "No models match these filters. Clear the search or choose another filter." : "The catalogue is empty. Press Check now to list each provider's models."}</p>}
                </div>
            </>}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    feedback: { marginBottom: 12 },
    run: { marginBottom: 12 },
    runLine: { margin: "2px 0" },
    runLabel: { color: "var(--ink)", fontWeight: 600 },
    filters: { display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 10 },
    filter: { display: "flex", flexDirection: "column", gap: 6, flex: "1 1 200px", minWidth: 0, fontSize: 13, color: "var(--muted)" },
    input: { width: "100%", padding: "0 10px", background: "var(--surface)" },
    list: { marginTop: 4, maxHeight: 640, scrollbarGutter: "stable" },
    group: { marginTop: 14 },
    groupHead: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 13.5, fontWeight: 650, color: "var(--ink)" },
    row: { display: "flex", flexDirection: "column", gap: 6, padding: "12px 0" },
    rowTop: { display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "8px 12px" },
    rowText: { display: "flex", flexDirection: "column", gap: 2, flex: "1 1 240px", minWidth: 0 },
    id: { fontFamily: "var(--font-mono)", fontSize: 12, overflowWrap: "anywhere" },
    actions: { display: "flex", flexWrap: "wrap", gap: 8 },
    pills: { display: "flex", flexWrap: "wrap", gap: 6 },
    confirm: { marginTop: 2 },
    line: { margin: 0 },
    details: { marginTop: 2 },
    detailsToggle: { width: "fit-content" },
    facts: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", gap: "12px 24px", margin: "10px 0", lineHeight: 1.45, fontVariantNumeric: "tabular-nums" },
    steps: { display: "flex", flexDirection: "column", gap: 4, margin: "4px 0 8px", padding: 0, listStyle: "none" },
    stepName: { color: "var(--ink)", fontWeight: 600 },
    stepDetail: { display: "block", overflowWrap: "anywhere" },
};
