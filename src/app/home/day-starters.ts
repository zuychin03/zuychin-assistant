import { clock, dueState, isAllDay, parseDue, sameDay, type TodayResponse, type TodoItem } from "@/lib/today";

export type StarterKind = "event" | "due" | "study" | "plan" | "inbox" | "research" | "code" | "explain";
export interface Starter { kind: StarterKind; label: string; meta?: string; tone?: "danger" | "accent"; fill?: string; href?: string }

export const STARTER_COUNT = 5;

// Each fill is a command; the trailing space keeps the slash menu closed so Enter sends right away.
export const FIXED_STARTERS: Starter[] = [
    { kind: "plan", label: "Plan my day", fill: "/plan_day " },
    { kind: "inbox", label: "Triage my inbox", fill: "/triage_emails " },
    { kind: "research", label: "Research a topic", fill: "/research " },
    { kind: "code", label: "Write some code", fill: "/code " },
    { kind: "explain", label: "Explain a concept", fill: "/explain " },
];

const PRIORITY: Record<string, number> = { high: 0, medium: 1, low: 2 };
// Older overdue items are backlog, not today's work; the Today panel still lists them.
const STALE_MS = 7 * 86_400_000;

function endOfTomorrow(now: Date) {
    const end = new Date(now);
    end.setDate(now.getDate() + 1);
    end.setHours(23, 59, 59, 999);
    return end;
}

function when(start: Date, now: Date) {
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    if (sameDay(start, now)) return { short: clock(start), long: `at ${clock(start)}` };
    if (sameDay(start, tomorrow)) return { short: `Tomorrow ${clock(start)}`, long: `tomorrow at ${clock(start)}` };
    const day = start.toLocaleDateString("en-AU", { weekday: "short" });
    return { short: `${day} ${clock(start)}`, long: `on ${day} at ${clock(start)}` };
}

/** The live starters (next event, most urgent to-do, study cards due), topped up with fixed ones. */
export function dayStarters(today: TodayResponse | null, studyDue: number, now: Date): Starter[] {
    const live: Starter[] = [];

    const next = (today?.events ?? [])
        .filter((event) => event.summary && !isAllDay(event.start))
        .map((event) => ({ event, start: new Date(event.start) }))
        .filter(({ start }) => start.getTime() > now.getTime())
        .sort((a, b) => a.start.getTime() - b.start.getTime())[0];
    if (next) {
        const time = when(next.start, now);
        live.push({ kind: "event", label: `Prepare for ${next.event.summary}`, meta: time.short,
            fill: `Help me prepare for “${next.event.summary}” ${time.long}${next.event.location ? `, at ${next.event.location}` : ""}.` });
    }

    // dueTodos stops 24 hours out and the starter looks to the end of tomorrow, so the pending list is searched too.
    const dated = new Map<string, { todo: TodoItem; due: Date }>();
    for (const todo of [...(today?.dueTodos ?? []), ...(today?.todos ?? [])]) if (todo.dueDate) dated.set(todo.id, { todo, due: parseDue(todo.dueDate) });
    const urgent = [...dated.values()]
        .filter(({ due }) => !Number.isNaN(due.getTime()) && due <= endOfTomorrow(now) && now.getTime() - due.getTime() <= STALE_MS)
        .sort((a, b) => a.due.getTime() - b.due.getTime() || (PRIORITY[a.todo.priority] ?? 1) - (PRIORITY[b.todo.priority] ?? 1))[0];
    if (urgent) {
        const state = dueState(urgent.due, now);
        const phrase = state.label === "Overdue" ? "overdue" : `due ${state.label.toLowerCase()}`;
        live.push({ kind: "due", label: urgent.todo.title, meta: state.label === "Overdue" ? "Overdue" : `Due ${state.label.toLowerCase()}`,
            tone: state.tone === "muted" ? undefined : state.tone, fill: `Help me get “${urgent.todo.title}” done. It is ${phrase}.` });
    }

    if (studyDue > 0) live.push({ kind: "study", label: `Review ${studyDue} study card${studyDue === 1 ? "" : "s"}`, meta: "Study", href: "/study" });

    return [...live, ...FIXED_STARTERS.slice(0, STARTER_COUNT - live.length)];
}
