"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Check, PanelRight, PanelRightClose, Repeat, X } from "lucide-react";
import { trapTab } from "./app-sidebar";
import styles from "./today-panel.module.css";
import { clock, dueState, fetchToday, isAllDay, parseDue, sameDay, type EventItem, type TodayResponse, type TodoItem } from "@/lib/today";

interface ScheduledTaskItem { id: string; title: string; scheduleType: "once" | "recurring"; enabled: boolean; nextRunAt: string | null }

const HOUR_PX = 44;
const MINUTE = 60_000;

const dayLabel = (date: Date) => date.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });

function relative(ms: number) {
    const minutes = Math.round(ms / MINUTE);
    if (minutes < 60) return `in ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `in ${hours} h ${rest} min` : `in ${hours} h`;
}

interface Placed { event: EventItem; start: Date; end: Date; lane: number; lanes: number }

function placeEvents(events: { event: EventItem; start: Date; end: Date }[]): Placed[] {
    const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime());
    const placed: Placed[] = [];
    let cluster: Placed[] = [];
    let clusterEnd = 0;
    const flush = () => { const lanes = Math.max(1, ...cluster.map((item) => item.lane + 1)); cluster.forEach((item) => { item.lanes = lanes; }); cluster = []; };
    for (const item of sorted) {
        if (cluster.length && item.start.getTime() >= clusterEnd) flush();
        const used = new Set(cluster.filter((other) => other.end.getTime() > item.start.getTime()).map((other) => other.lane));
        let lane = 0;
        while (used.has(lane)) lane += 1;
        const entry = { ...item, lane, lanes: 1 };
        cluster.push(entry);
        placed.push(entry);
        clusterEnd = Math.max(clusterEnd, item.end.getTime());
    }
    flush();
    return placed;
}

export const TODAY_DOCKED_QUERY = "(min-width: 1280px)";

export function useDueCount(refreshToken = 0) {
    const [count, setCount] = useState<number | null>(null);
    useEffect(() => {
        let current = true;
        fetchToday(refreshToken > 0)
            .then((data) => { if (current) setCount(data.dueTodos.length); })
            .catch(() => {});
        return () => { current = false; };
    }, [refreshToken]);
    return [count, setCount] as const;
}

export function TodayToggle({ open, onToggle, due, controls = "today-panel", compact = false }: {
    open: boolean;
    onToggle: () => void;
    due: number | null;
    controls?: string;
    compact?: boolean;
}) {
    const label = `${open ? "Hide" : "Show"} Today${due ? `, ${due} due` : ""}`;
    return <button type="button" className={styles.toggle} data-compact={compact || undefined} onClick={onToggle}
        aria-expanded={open} aria-controls={open ? controls : undefined} aria-label={label} title={label}>
        <PanelRight size={16} aria-hidden="true" />
        {!compact && <span>Today</span>}
        {!!due && <span className={styles.badge}>{compact ? due : `${due} due`}</span>}
    </button>;
}

export function TodayPanel({ variant, onClose, refreshToken = 0, onDueCount, id = "today-panel" }: {
    variant: "docked" | "sheet";
    onClose: () => void;
    refreshToken?: number;
    onDueCount?: (count: number) => void;
    id?: string;
}) {
    const [today, setToday] = useState<TodayResponse | null>(null);
    const [tasks, setTasks] = useState<ScheduledTaskItem[] | null>(null);
    const [state, setState] = useState<"loading" | "ready" | "error">("loading");
    const [completing, setCompleting] = useState<string[]>([]);
    const [actionError, setActionError] = useState("");
    const [now, setNow] = useState(() => new Date());
    const panel = useRef<HTMLElement>(null);

    const load = useCallback(async (signal?: AbortSignal) => {
        try {
            const [todayResponse, tasksResponse] = await Promise.all([
                fetch("/api/today", { signal, cache: "no-store" }),
                fetch("/api/tasks", { signal, cache: "no-store" }).catch(() => null),
            ]);
            if (!todayResponse.ok) throw new Error(`Today failed (${todayResponse.status})`);
            const data = await todayResponse.json() as TodayResponse;
            setToday({ dueTodos: data.dueTodos ?? [], todos: data.todos ?? [], events: data.events ?? [] });
            if (tasksResponse?.ok) {
                const report = await tasksResponse.json() as { tasks?: ScheduledTaskItem[] };
                setTasks(Array.isArray(report.tasks) ? report.tasks : []);
            }
            setState("ready");
        } catch (error) {
            if ((error as Error).name === "AbortError") return;
            setState((previous) => previous === "ready" ? "ready" : "error");
        }
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load, refreshToken]);

    useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), MINUTE);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => { onDueCount?.(today?.dueTodos.length ?? 0); }, [today, onDueCount]);

    useEffect(() => {
        if (variant !== "sheet") return;
        const previous = document.activeElement as HTMLElement | null;
        panel.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !document.querySelector("dialog[open]")) onClose();
            else if (event.key === "Tab" && panel.current) trapTab(event, panel.current);
        };
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("keydown", onKey); previous?.focus?.({ preventScroll: true }); };
    }, [variant, onClose]);

    async function complete(todo: TodoItem) {
        if (completing.includes(todo.id)) return;
        setCompleting((list) => [...list, todo.id]);
        setActionError("");
        try {
            const response = await fetch("/api/todos", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: todo.id, status: "done" }) });
            if (!response.ok) throw new Error(`Request failed (${response.status})`);
            setToday((current) => current && { ...current, dueTodos: current.dueTodos.filter((item) => item.id !== todo.id), todos: current.todos.filter((item) => item.id !== todo.id) });
        } catch {
            setActionError(`“${todo.title}” could not be marked as done. Try again.`);
        } finally {
            setCompleting((list) => list.filter((id) => id !== todo.id));
        }
    }

    const day = useMemo(() => {
        const events = today?.events ?? [];
        const timed: { event: EventItem; start: Date; end: Date }[] = [];
        const allDay: EventItem[] = [];
        const later: { event: EventItem; start: Date }[] = [];
        for (const event of events) {
            if (isAllDay(event.start)) {
                if (sameDay(new Date(`${event.start}T00:00:00`), now)) allDay.push(event);
                else later.push({ event, start: new Date(`${event.start}T00:00:00`) });
                continue;
            }
            const start = new Date(event.start);
            if (Number.isNaN(start.getTime())) continue;
            const end = event.end && !isAllDay(event.end) ? new Date(event.end) : new Date(start.getTime() + 30 * MINUTE);
            if (sameDay(start, now)) timed.push({ event, start, end: end > start ? end : new Date(start.getTime() + 30 * MINUTE) });
            else if (start > now) later.push({ event, start });
        }
        const startHours = timed.map((item) => item.start.getHours());
        const endHours = timed.map((item) => item.end.getHours() + (item.end.getMinutes() ? 1 : 0) + (sameDay(item.end, now) ? 0 : 24));
        const from = Math.max(0, Math.min(8, ...startHours, now.getHours()));
        const to = Math.min(24, Math.max(20, ...endHours, now.getHours() + 1));
        const next = timed.filter((item) => item.start > now).sort((a, b) => a.start.getTime() - b.start.getTime())[0];
        return { placed: placeEvents(timed), allDay, later: later.sort((a, b) => a.start.getTime() - b.start.getTime()), from, to, next };
    }, [today, now]);

    const scheduled = useMemo(() => (tasks ?? [])
        .filter((task) => task.enabled && task.nextRunAt)
        .sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""))
        .slice(0, 3), [tasks]);

    const offset = (date: Date) => ((date.getHours() + date.getMinutes() / 60) - day.from) * HOUR_PX;
    const nowVisible = now.getHours() >= day.from && now.getHours() < day.to;
    const span = day.to - day.from;
    let emptySlot = Math.floor(span / 2);
    if (nowVisible && Math.abs(offset(now) - (emptySlot + 0.5) * HOUR_PX) < 18) emptySlot += emptySlot + 1 < span ? 1 : -1;
    const heading = `${id}-title`;

    return <>
        {variant === "sheet" && <div className={styles.scrim} onClick={onClose} aria-hidden="true" />}
        <aside ref={panel} id={id} className={styles.panel} data-variant={variant} aria-labelledby={heading}
            role={variant === "sheet" ? "dialog" : "complementary"} aria-modal={variant === "sheet" || undefined}>
            <header className={styles.header}>
                <div>
                    <h2 id={heading}>Today</h2>
                    <p>{now.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}</p>
                </div>
                <button type="button" className={styles.iconButton} onClick={onClose} aria-label={variant === "docked" ? "Hide Today" : "Close Today"} title={variant === "docked" ? "Hide Today" : "Close"}>
                    {variant === "docked" ? <PanelRightClose size={17} aria-hidden="true" /> : <X size={18} aria-hidden="true" />}
                </button>
            </header>

            <div className={styles.body}>
                {state === "loading" && !today && <p className={styles.quiet} role="status">Loading today…</p>}
                {state === "error" && !today && <div className={styles.quiet} role="alert">
                    <p>Today could not be loaded.</p>
                    <button type="button" className={styles.textButton} onClick={() => { setState("loading"); void load(); }}>Try again</button>
                </div>}
                {actionError && <p className={styles.error} role="alert">{actionError}</p>}

                {today && <>
                    {day.allDay.length > 0 && <ul className={styles.allDay} aria-label="All-day events">
                        {day.allDay.map((event, index) => <li key={event.id ?? `all-${index}`}><span>All day</span>{event.summary}</li>)}
                    </ul>}

                    <section aria-label="Schedule" className={styles.day} style={{ height: (day.to - day.from) * HOUR_PX }}>
                        {nowVisible && <div className={styles.elapsed} style={{ height: offset(now) }} aria-hidden="true" />}
                        <div className={styles.axis} aria-hidden="true" />
                        {Array.from({ length: day.to - day.from + 1 }, (_, index) => day.from + index).map((hour) => {
                            const top = (hour - day.from) * HOUR_PX;
                            const covered = nowVisible && Math.abs(offset(now) - top) < 14;
                            return <div key={hour} className={styles.hour} style={{ top }} aria-hidden="true">
                                <span data-covered={covered || undefined}>{String(hour % 24).padStart(2, "0")}:00</span>
                            </div>;
                        })}
                        <div className={styles.track}>
                            {day.placed.map(({ event, start, end, lane, lanes }, index) => {
                                const isNext = day.next?.event === event;
                                const past = end <= now;
                                return <div key={event.id ?? `ev-${index}`} className={styles.event} data-past={past || undefined}
                                    style={{ top: offset(start) + 1, height: Math.max(22, offset(end) - offset(start) - 2), left: `calc(${(lane / lanes) * 100}% + ${lane ? 2 : 0}px)`, width: `calc(${100 / lanes}% - ${lanes > 1 ? 2 : 0}px)` }}
                                    title={`${event.summary}, ${clock(start)}–${clock(end)}${event.location ? `, ${event.location}` : ""}`}>
                                    <strong>{event.summary}</strong>
                                    <span><time>{clock(start)}–{clock(end)}</time>{isNext && <em>{relative(start.getTime() - now.getTime())}</em>}</span>
                                </div>;
                            })}
                        </div>
                        {nowVisible && <div className={styles.now} style={{ top: offset(now) }} aria-label={`Now, ${clock(now)}`}><time>{clock(now)}</time></div>}
                        {day.placed.length === 0 && <p className={styles.dayEmpty} style={{ top: (emptySlot + 0.5) * HOUR_PX }}>Nothing scheduled today</p>}
                    </section>

                    {day.later.length > 0 && <section className={styles.section} aria-labelledby={`${id}-later`}>
                        <h3 id={`${id}-later`}>Coming up</h3>
                        <ul className={styles.list}>{day.later.slice(0, 4).map(({ event, start }, index) => <li key={event.id ?? `later-${index}`} className={styles.row}>
                            <span className={styles.rowMain}><span className={styles.rowTitle}>{event.summary}</span></span>
                            <time className={styles.rowDate}>{dayLabel(start)}{isAllDay(event.start) ? "" : ` ${clock(start)}`}</time>
                        </li>)}</ul>
                    </section>}

                    <section className={styles.section} aria-labelledby={`${id}-due`}>
                        <h3 id={`${id}-due`}>Due</h3>
                        {today.dueTodos.length === 0 ? <p className={styles.quiet}>Nothing due soon</p> : <ul className={styles.list}>
                            {[...today.dueTodos].sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "")).map((todo) => {
                                const due = todo.dueDate ? parseDue(todo.dueDate) : null;
                                const status = due ? dueState(due, now) : null;
                                return <li key={todo.id} className={styles.row}>
                                    <button type="button" className={styles.check} onClick={() => void complete(todo)} disabled={completing.includes(todo.id)} aria-label={`Mark “${todo.title}” as done`} title="Mark as done"><Check size={12} aria-hidden="true" /></button>
                                    <span className={styles.rowMain}>
                                        <span className={styles.rowTitle}>{todo.title}</span>
                                        {status && <span className={styles.rowMeta} data-tone={status.tone}>{status.label}</span>}
                                    </span>
                                    {due && <time className={styles.rowDate}>{dayLabel(due)}</time>}
                                </li>;
                            })}
                        </ul>}
                    </section>

                    {today.todos.length > 0 && <section className={styles.section} aria-labelledby={`${id}-todo`}>
                        <h3 id={`${id}-todo`}>To-do</h3>
                        <ul className={styles.list}>{today.todos.map((todo) => <li key={todo.id} className={styles.row}>
                            <button type="button" className={styles.check} onClick={() => void complete(todo)} disabled={completing.includes(todo.id)} aria-label={`Mark “${todo.title}” as done`} title="Mark as done"><Check size={12} aria-hidden="true" /></button>
                            <span className={styles.rowMain}><span className={styles.rowTitle}>{todo.title}</span></span>
                            {todo.dueDate && <time className={styles.rowDate}>{dayLabel(parseDue(todo.dueDate))}</time>}
                        </li>)}</ul>
                    </section>}

                    {scheduled.length > 0 && <section className={styles.section} aria-labelledby={`${id}-scheduled`}>
                        <h3 id={`${id}-scheduled`}>Scheduled</h3>
                        <ul className={styles.list}>{scheduled.map((task) => {
                            const next = new Date(task.nextRunAt!);
                            return <li key={task.id} className={styles.row}>
                                <span className={styles.rowIcon} aria-hidden="true">{task.scheduleType === "recurring" ? <Repeat size={13} /> : <CalendarClock size={13} />}</span>
                                <span className={styles.rowMain}><span className={styles.rowTitle}>{task.title}</span><span className={styles.rowMeta}>{task.scheduleType === "recurring" ? "Recurring" : "Once"}</span></span>
                                <time className={styles.rowDate}>next {sameDay(next, now) ? "" : `${next.toLocaleDateString("en-AU", { weekday: "short" })} `}{clock(next)}</time>
                            </li>;
                        })}</ul>
                    </section>}
                </>}
            </div>
        </aside>
    </>;
}
