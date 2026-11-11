"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { CalendarClock, CalendarDays, Code2, Globe, GraduationCap, Lightbulb, ListChecks, Mail } from "lucide-react";
import { fetchToday } from "@/lib/today";
import { dayStarters, FIXED_STARTERS, type Starter, type StarterKind } from "./day-starters";
import styles from "./day-starters.module.css";

const ICON: Record<StarterKind, ReactNode> = {
    event: <CalendarClock size={15} aria-hidden="true" />,
    due: <ListChecks size={15} aria-hidden="true" />,
    study: <GraduationCap size={15} aria-hidden="true" />,
    plan: <CalendarDays size={15} aria-hidden="true" />,
    inbox: <Mail size={15} aria-hidden="true" />,
    research: <Globe size={15} aria-hidden="true" />,
    code: <Code2 size={15} aria-hidden="true" />,
    explain: <Lightbulb size={15} aria-hidden="true" />,
};

// A slow calendar or study read gives way to the fixed set instead of holding the empty state.
const WAIT_MS = 2500;

export function DayStarters({ onFill }: { onFill: (fill: string) => void }) {
    const [starters, setStarters] = useState<Starter[] | null>(null);

    useEffect(() => {
        let current = true;
        let timer = 0;
        const study = fetch("/api/study?view=due", { cache: "no-store" })
            .then((response) => response.ok ? response.json() as Promise<{ due?: unknown }> : null)
            .then((json) => typeof json?.due === "number" ? json.due : 0)
            .catch(() => 0);
        const live = Promise.all([fetchToday().catch(() => null), study]);
        const timeout = new Promise<null>((resolve) => { timer = window.setTimeout(() => resolve(null), WAIT_MS); });
        void Promise.race([live, timeout]).then((result) => {
            if (current) setStarters(dayStarters(result?.[0] ?? null, result?.[1] ?? 0, new Date()));
        });
        return () => { current = false; window.clearTimeout(timer); };
    }, []);

    // The fixed set holds the space, hidden, until the live set is known, so nothing swaps under the pointer.
    return <div className={styles.starters} data-pending={!starters || undefined} aria-busy={!starters || undefined}>
        {(starters ?? FIXED_STARTERS).map((starter) => {
            const body = <>
                {ICON[starter.kind]}
                <span className={styles.label}>{starter.label}</span>
                {starter.meta && <span className={styles.meta} data-tone={starter.tone}>{starter.meta}</span>}
            </>;
            return starter.href
                ? <Link key={starter.kind} href={starter.href} className={styles.starter}>{body}</Link>
                : <button key={starter.kind} type="button" className={styles.starter} onClick={() => onFill(starter.fill ?? "")}>{body}</button>;
        })}
    </div>;
}
