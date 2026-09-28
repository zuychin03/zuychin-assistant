"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { WorkspaceShell } from "@/components/workspace-shell";
import { Dropdown } from "@/components/dropdown";
import { useUnsavedChanges } from "@/components/use-unsaved-changes";
import type { ScheduledTask } from "@/lib/tasks/store";
import type { ActionApproval, TasksReport } from "@/lib/tasks/types";
import { approvalActionable, recurringScheduleLabel, runRequestKey, taskDraft, taskPayload, type TaskDraft } from "./task-form";
import { submitRunRequest } from "./run-request";
import styles from "./tasks.module.css";

function date(value: string | null, timezone?: string) {
    if (!value) return "Not recorded";
    try {
        return new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", ...(timezone ? { timeZone: timezone } : {}) }).format(new Date(value));
    } catch { return "Invalid recorded time or timezone"; }
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : "The request failed. Please retry."; }

async function request(path: string, method = "GET", body?: unknown) {
    const response = await fetch(path, { method, cache: "no-store", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
    const data = await response.json();
    if (response.status === 401) throw new Error("Sign in with your owner account to manage tasks and approvals.");
    return { response, data };
}

export default function TasksPage() {
    const [report, setReport] = useState<TasksReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [actionError, setActionError] = useState("");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState("");
    const busyRef = useRef(false);
    const loadVersion = useRef(0);
    const [tab, setTab] = useState<"schedules" | "approvals" | "runs">("schedules");
    const [editor, setEditor] = useState<{ id?: string; draft: TaskDraft } | null>(null);
    const [deleteId, setDeleteId] = useState<string | null>(null);
    const [uncertainRuns, setUncertainRuns] = useState<string[]>([]);
    const [now, setNow] = useState(0);
    const editorTitle = useRef<HTMLInputElement>(null);
    const editorBaseline = useRef<TaskDraft | null>(null);
    const editorId = editor ? editor.id ?? "new" : null;
    const [requestedApproval, setRequestedApproval] = useState<string | null>(null);

    useUnsavedChanges(() => Boolean(editor && editorBaseline.current && JSON.stringify(editor.draft) !== JSON.stringify(editorBaseline.current)));

    const load = useCallback(async () => {
        const version = ++loadVersion.current;
        setLoading(true);
        try {
            const { response, data } = await request("/api/tasks");
            if (!response.ok) throw new Error(data.error || "Task records could not be loaded.");
            if (!Array.isArray(data.tasks) || !Array.isArray(data.runs) || !Array.isArray(data.approvals)) throw new Error("Task records could not be read. Retry loading.");
            if (version !== loadVersion.current) return;
            setReport(data);
            setLoadError("");
            setUncertainRuns(data.tasks.filter((task: ScheduledTask) => {
                try { return Boolean(sessionStorage.getItem(runRequestKey(task.id))); } catch { return false; }
            }).map((task: ScheduledTask) => task.id));
        } catch (error) { if (version === loadVersion.current) setLoadError(errorMessage(error)); }
        finally { if (version === loadVersion.current) setLoading(false); }
    }, []);

    useEffect(() => { void load(); setNow(Date.now()); const clock = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(clock); }, [load]);
    useEffect(() => {
        const id = new URLSearchParams(window.location.search).get("approval");
        if (id) { setRequestedApproval(id); setTab("approvals"); }
    }, []);
    useEffect(() => {
        if (tab === "approvals" && requestedApproval && report) document.getElementById(`approval-${requestedApproval}`)?.scrollIntoView({ block: "center" });
    }, [requestedApproval, report, tab]);

    useEffect(() => { if (editorId) editorTitle.current?.focus(); }, [editorId]);

    async function mutate(key: string, path: string, method: string, body: unknown, success: string, onSuccess?: () => void) {
        if (busyRef.current) return;
        busyRef.current = true; setBusy(key); setActionError(""); setNotice("");
        try {
            const { response, data } = await request(path, method, body);
            if (!response.ok) throw new Error(data.error || "The change was not confirmed. Please retry.");
            onSuccess?.(); setNotice(`${success}${typeof data.warning === "string" ? ` ${data.warning}` : ""}`); await load();
        } catch (error) { setActionError(errorMessage(error)); }
        finally { busyRef.current = false; setBusy(""); }
    }

    async function run(task: ScheduledTask) {
        if (busyRef.current || report?.activationError) return;
        busyRef.current = true; setBusy(`run:${task.id}`); setActionError(""); setNotice("");
        let dispatched = false;
        try {
            const data = await submitRunRequest(task.id, sessionStorage, body => {
                dispatched = true;
                return request("/api/tasks/run", "POST", body);
            });
            setUncertainRuns(previous => previous.filter(id => id !== task.id));
            setNotice(data.status === "accepted" ? "Run accepted. Its result will appear in run history." : "This run already exists. Check run history for its result.");
            await load();
        } catch (error) {
            if (dispatched) setUncertainRuns(previous => [...new Set([...previous, task.id])]);
            setActionError(`${errorMessage(error)}${dispatched ? " The outcome is unconfirmed. Retry the same request to check it safely." : ""}`);
        } finally { busyRef.current = false; setBusy(""); }
    }

    function openEditor(next: { id?: string; draft: TaskDraft }) {
        if (editor && editorBaseline.current && JSON.stringify(editor.draft) !== JSON.stringify(editorBaseline.current) && !window.confirm("Discard your unsaved task changes and open another draft?")) return;
        editorBaseline.current = next.draft;
        setEditor(next); setActionError(""); editorTitle.current?.focus();
    }

    function save(event: React.FormEvent) {
        event.preventDefault();
        if (!editor) return;
        try {
            const payload = taskPayload(editor.draft);
            const { conversationId, ...editable } = payload;
            void mutate("save", "/api/tasks", editor.id ? "PATCH" : "POST", editor.id ? { ...editable, id: editor.id } : { ...editable, conversationId }, "Task saved.", () => setEditor(null));
        } catch (error) { setActionError(errorMessage(error)); }
    }

    function decide(approval: ActionApproval, decision: "approve" | "reject") {
        if (!approvalActionable(approval) || (decision === "approve" && report?.activationError)) { setActionError("This approval is no longer actionable. Refresh to see its current status."); return; }
        void mutate(`approval:${approval.id}`, "/api/tasks/approvals", "POST", { id: approval.id, decision }, decision === "approve" ? "Approval decision recorded. Review the resulting status below." : "Approval rejected.");
    }

    const blocked = Boolean(busy || loadError || !report);
    const pending = report?.approvals.filter(approval => approvalActionable(approval, now)).length || 0;
    const field = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => setEditor(previous => previous ? { ...previous, draft: { ...previous.draft, [key]: value } } : null);

    return <WorkspaceShell current="tasks" title="Tasks" description="Manage recurring work and review actions that need your approval." actions={<button onClick={() => void load()} disabled={loading || Boolean(busy)}><RefreshCw size={15} /> {loading ? "Loading…" : "Refresh"}</button>}>
        <div className={styles.page}>
        {loadError && <div role="alert" className={styles.error}>{loadError} {report && "The records below may be out of date."} <button onClick={() => void load()} disabled={loading}>Retry loading</button></div>}
        {report?.activationError && <div role="alert" className={styles.error}><strong>Task execution is unavailable.</strong><p>{report.activationError}</p><p>Apply the required migration, then refresh. Running tasks and approving actions are blocked.</p></div>}
        {actionError && <div role="alert" className={styles.error}>{actionError}</div>}
        {notice && <p role="status" className={styles.notice}>{notice}</p>}
        <nav aria-label="Task views" className={styles.tabs}>
            <button aria-pressed={tab === "schedules"} onClick={() => setTab("schedules")}>Schedules {report ? `(${report.tasks.length})` : ""}</button>
            <button aria-pressed={tab === "approvals"} onClick={() => setTab("approvals")}>Approvals {pending ? `(${pending} pending)` : ""}</button>
            <button aria-pressed={tab === "runs"} onClick={() => setTab("runs")}>Run history</button>
        </nav>
        {loading && !report && <p role="status" className={styles.empty}>Loading tasks and approvals…</p>}
        {tab === "schedules" && report && <>
            <div className={styles.sectionHead}><h2>Your schedules</h2><button title="Uses paid models" disabled={blocked} onClick={() => openEditor({ draft: taskDraft() })}><Plus size={16} /> New task</button></div>
            {editor && <form className={styles.card} onSubmit={save}>
                <h2>{editor.id ? "Edit task" : "New task"}</h2>
                <fieldset disabled={Boolean(busy)} className={styles.fields}>
                    <label className={styles.full}>Title<input ref={editorTitle} value={editor.draft.title} maxLength={160} required onChange={event => field("title", event.target.value)} /></label>
                    <label className={styles.full}>Instruction<textarea rows={4} value={editor.draft.instruction} maxLength={20000} required onChange={event => field("instruction", event.target.value)} /><small>Describe the work and the intended recipient. Actions that require approval will be held for review.</small></label>
                    <label>Schedule<Dropdown ariaLabel="Schedule" className={styles.dropdown} style={{ flex: "none", width: "100%" }} disabled={Boolean(busy)} value={editor.draft.scheduleType} onChange={value => field("scheduleType", value as TaskDraft["scheduleType"])} options={[{ value: "recurring", label: "Recurring" }, { value: "once", label: "Once" }]} /></label>
                    <label>Timezone<input value={editor.draft.timezone} required onChange={event => field("timezone", event.target.value)} placeholder="Australia/Sydney" /><small>All schedule inputs use this timezone.</small></label>
                    {editor.draft.scheduleType === "once" ? <label className={styles.full}>Date and time<input type="datetime-local" value={editor.draft.localRunAt} required onChange={event => field("localRunAt", event.target.value)} /></label> : <>
                        <label>Repeat<Dropdown ariaLabel="Repeat" className={styles.dropdown} style={{ flex: "none", width: "100%" }} disabled={Boolean(busy)} value={editor.draft.recurrence} onChange={value => field("recurrence", value as TaskDraft["recurrence"])} options={[{ value: "daily", label: "Every day" }, { value: "weekdays", label: "Weekdays" }, { value: "weekly", label: "Weekly" }, { value: "custom", label: "Custom cron" }]} /></label>
                        {editor.draft.recurrence === "custom" ? <label>Cron expression<input value={editor.draft.cron} required onChange={event => field("cron", event.target.value)} /><small>Five fields: minute hour day month weekday.</small></label> : <label>Time<input type="time" value={editor.draft.time} required onChange={event => field("time", event.target.value)} /></label>}
                        {editor.draft.recurrence === "weekly" && <label>Day<Dropdown ariaLabel="Day" className={styles.dropdown} style={{ flex: "none", width: "100%" }} disabled={Boolean(busy)} value={editor.draft.weekday} onChange={value => field("weekday", value)} options={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) => ({ value: String(index), label: day }))} /></label>}
                    </>}
                    <label>Delivery<Dropdown ariaLabel="Delivery" className={styles.dropdown} style={{ flex: "none", width: "100%" }} disabled={Boolean(busy)} value={editor.draft.channel} onChange={value => field("channel", value as TaskDraft["channel"])} options={[{ value: "web", label: "Web" }, { value: "telegram", label: "Telegram" }, { value: "discord", label: "Discord" }]} /></label>
                    <label>Conversation ID (optional)<input disabled={Boolean(editor.id)} value={editor.draft.conversationId} onChange={event => field("conversationId", event.target.value)} /><small>{editor.id ? "The conversation is fixed when this task is created." : "Leave blank to use the channel’s default conversation."}</small></label>
                    <label className={`${styles.check} ${styles.full}`}><input type="checkbox" checked={editor.draft.agentMode} onChange={event => field("agentMode", event.target.checked)} /> Enable agent mode for multi-step work</label>
                </fieldset>
                <div className={styles.actions}><button type="submit" title="Uses paid models" className={styles.primary} disabled={blocked}>{busy === "save" ? "Saving…" : "Save task"}</button><button type="button" disabled={Boolean(busy)} onClick={() => setEditor(null)}>Cancel</button></div>
            </form>}
            {!report.tasks.length && <p className={styles.empty}>No scheduled tasks yet. Create one to run work at a chosen time.</p>}
            {report.tasks.map(task => {
                const active = report.runs.some(run => run.taskId === task.id && run.status === "running");
                const uncertain = uncertainRuns.includes(task.id);
                return <article className={styles.card} key={task.id}>
                    <div className={styles.row}><h3>{task.title}</h3><span className={styles.badge}>{task.enabled ? "Enabled" : "Paused"}</span></div>
                    <p className={styles.instruction}>{task.instruction}</p>
                    <dl className={styles.facts}><div><dt>Schedule</dt><dd>{task.scheduleType === "once" ? date(task.runAt, task.timezone) : recurringScheduleLabel(task)}</dd></div><div><dt>Timezone</dt><dd>{task.timezone}</dd></div><div><dt>Next run</dt><dd>{task.enabled ? date(task.nextRunAt, task.timezone) : "Paused"}</dd></div><div><dt>Delivery</dt><dd>{task.channel}{task.agentMode ? " · Agent mode" : ""}</dd></div></dl>
                    {task.lastRunAt && <p className={styles.muted}>Last run: {date(task.lastRunAt, task.timezone)} · {task.lastStatus || "Unknown result"}</p>}
                    {uncertain && <p className={styles.warning}>A run request is unconfirmed. Retry the same request to recover its status.</p>}
                    {active && <p role="status" className={styles.muted}>A run is in progress. Refresh to check its result.</p>}
                    <div className={styles.actions}>
                        <button title="Uses paid models" disabled={blocked || Boolean(report.activationError) || (active && !uncertain)} onClick={() => void run(task)}>{busy === `run:${task.id}` ? "Checking run…" : uncertain ? "Retry same run request" : "Run now"}</button>
                        <button disabled={blocked} onClick={() => void mutate(`toggle:${task.id}`, "/api/tasks", "PATCH", { id: task.id, enabled: !task.enabled }, task.enabled ? "Task paused." : "Task resumed.")}>{task.enabled ? "Pause" : "Resume"}</button>
                        <button disabled={blocked} onClick={() => openEditor({ id: task.id, draft: taskDraft(task) })}>Edit</button>
                        <button disabled={blocked} onClick={() => setDeleteId(task.id)}>Delete</button>
                    </div>
                    {deleteId === task.id && <div className={styles.confirm} role="group" aria-label="Confirm task deletion"><p>Delete “{task.title}”? This removes its schedule.</p><div className={styles.actions}><button disabled={blocked} onClick={() => void mutate(`delete:${task.id}`, `/api/tasks?id=${encodeURIComponent(task.id)}`, "DELETE", undefined, "Task deleted.", () => setDeleteId(null))}>Confirm delete</button><button autoFocus disabled={Boolean(busy)} onClick={() => setDeleteId(null)}>Keep task</button></div></div>}
                </article>;
            })}
        </>}
        {tab === "approvals" && report && <section><h2>Action approvals</h2><p className={styles.muted}>Review the exact action before allowing it. Expired or completed requests cannot be approved again.</p>
            {requestedApproval && !report.approvals.some(approval => approval.id === requestedApproval) && <p role="status" className={styles.warning}>The linked approval is not in the loaded records. It may be older, deleted or unavailable to this account.</p>}
            {!report.approvals.length && <p className={styles.empty}>No actions awaiting review.</p>}
            {report.approvals.map(approval => {
                const actionable = approvalActionable(approval, now);
                return <article className={styles.card} key={approval.id} id={`approval-${approval.id}`}>
                    <div className={styles.row}><h3>{approval.taskTitle}</h3><span className={styles.badge}>{approval.status === "pending" && !actionable ? "Expired" : approval.status.replaceAll("_", " ")}</span></div>
                    <p><strong>Action:</strong> {approval.tool}</p>
                    <p className={styles.muted}>Expires {date(approval.expiresAt)} · Your local time</p>
                    <h4>Exact arguments</h4><pre className={styles.arguments} tabIndex={0} aria-label="Exact action arguments">{JSON.stringify(approval.args, null, 2)}</pre>
                    <details><summary>Source instruction and context</summary><h4>Instruction</h4><p className={styles.instruction}>{approval.instruction}</p><h4>Context</h4><p className={styles.instruction}>{approval.sourceContext}</p><p className={styles.muted}>Run: {approval.runId}</p></details>
                    {approval.status === "outcome_unknown" && <p className={styles.warning}>The action may have reached its recipient, but no reliable result was recorded. Check the destination before taking further action. It will not be retried here.</p>}
                    {approval.status === "executing" && <p className={styles.muted}>Execution is in progress. Refresh to check its result.</p>}
                    {approval.receipt && <p className={styles.instruction}><strong>Receipt:</strong> {approval.receipt}</p>}
                    {actionable && <div className={styles.actions}><button className={styles.primary} disabled={blocked || Boolean(report.activationError)} onClick={() => decide(approval, "approve")}>Approve action</button><button disabled={blocked} onClick={() => decide(approval, "reject")}>Reject</button></div>}
                </article>;
            })}
        </section>}
        {tab === "runs" && report && <section><h2>Recent runs</h2><p className={styles.muted}>Recorded outcomes, shown in your local time. A missing result is not a confirmed success.</p>
            {!report.runs.length && <p className={styles.empty}>No recorded runs yet.</p>}
            {report.runs.map(run => <article className={styles.card} key={run.id}><div className={styles.row}><h3>{run.taskTitle}</h3><span className={styles.badge}>{run.status === "ok" ? "Succeeded" : run.status}</span></div><p className={styles.muted}>{date(run.startedAt)} · {run.trigger === "manual" ? "Manual" : "Scheduled"} · Paid model route</p>{run.finishedAt && <p className={styles.muted}>Finished {date(run.finishedAt)}</p>}{run.detail && <p className={styles.instruction}>{run.detail}</p>}{run.status === "interrupted" && <p className={styles.warning}>The run was interrupted. Review any pending approvals and destination before starting another run.</p>}<details><summary>Run identifier</summary><p className={styles.muted}>{run.id}</p></details></article>)}
        </section>}
        </div>
    </WorkspaceShell>;
}
