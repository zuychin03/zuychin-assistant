export interface TodoItem { id: string; title: string; priority: string; dueDate: string | null }
export interface EventItem { id?: string; summary: string; start: string; end?: string; location?: string }
export interface TodayResponse { dueTodos: TodoItem[]; todos: TodoItem[]; events: EventItem[] }

export const isAllDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const clock = (date: Date) => date.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });

export function parseDue(value: string) {
    // A bare date is a whole-day deadline in local time, not UTC midnight.
    return isAllDay(value) ? new Date(`${value}T23:59:59`) : new Date(value);
}

export function dueState(due: Date, now: Date) {
    if (due.getTime() < now.getTime()) return { label: "Overdue", tone: "danger" as const };
    if (sameDay(due, now)) return { label: "Today", tone: "accent" as const };
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    if (sameDay(due, tomorrow)) return { label: "Tomorrow", tone: "muted" as const };
    const days = Math.ceil((due.getTime() - now.getTime()) / 86_400_000);
    return { label: `in ${days} days`, tone: "muted" as const };
}

const normalise = (data: Partial<TodayResponse>): TodayResponse => ({
    dueTodos: Array.isArray(data.dueTodos) ? data.dueTodos : [],
    todos: Array.isArray(data.todos) ? data.todos : [],
    events: Array.isArray(data.events) ? data.events : [],
});

let shared: { at: number; promise: Promise<TodayResponse> } | null = null;

/** Callers within 30 seconds share one /api/today read, which costs a calendar call. */
export function fetchToday(fresh = false): Promise<TodayResponse> {
    if (!fresh && shared && Date.now() - shared.at < 30_000) return shared.promise;
    const promise = fetch("/api/today", { cache: "no-store" })
        .then(async (response) => {
            if (!response.ok) throw new Error(`Today failed (${response.status})`);
            return normalise(await response.json() as Partial<TodayResponse>);
        });
    const entry = { at: Date.now(), promise };
    shared = entry;
    promise.catch(() => { if (shared === entry) shared = null; });
    return promise;
}
