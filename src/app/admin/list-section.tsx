"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";

/** One folding group of rows in a long admin list. Rows render only while it is open. */
export function ListSection({ title, count, open, onToggle, children }: {
    title: string;
    count: number;
    open: boolean;
    onToggle: (open: boolean) => void;
    children: React.ReactNode;
}) {
    return (
        <details className="list-section" open={open} onToggle={(event) => { const next = event.currentTarget.open; if (next !== open) onToggle(next); }}>
            <summary className="list-section-head">
                <ChevronRight size={15} aria-hidden="true" />
                <span>{title}</span>
                <span className="meta">{count}</span>
            </summary>
            {open && children}
        </details>
    );
}

/** Which sections are open, per scope (a model kind, say); sections not touched yet use their default. */
export function useOpenSections<T extends string>(openByDefault: readonly T[]) {
    const [saved, setSaved] = useState<Record<string, boolean>>({});
    return {
        isOpen: (scope: string, id: T) => saved[`${scope}:${id}`] ?? openByDefault.includes(id),
        toggle: (scope: string, id: T, open: boolean) => setSaved((current) => ({ ...current, [`${scope}:${id}`]: open })),
    };
}

/** Which rows are unfolded. Kept above the rows so a reload or a move to another section keeps them open. */
export function useExpandedRows() {
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    return {
        isExpanded: (key: string) => expanded.has(key),
        setExpanded: (key: string, open: boolean) => setExpanded((current) => {
            if (current.has(key) === open) return current;
            const next = new Set(current);
            if (open) next.add(key); else next.delete(key);
            return next;
        }),
    };
}
