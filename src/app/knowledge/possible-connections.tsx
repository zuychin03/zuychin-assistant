"use client";

import { useEffect, useId, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import styles from "./possible-connections.module.css";

interface Suggestion { target: string; similarity: number }

// The pages /api/vault/link accepts.
export const LINKABLE_PAGE = /^wiki\/(sources|concepts|entities|synthesis)\/[a-z0-9-]+\.md$/;

const family = (path: string) => ({ sources: "source", concepts: "concept", entities: "entity", synthesis: "synthesis" })[path.split("/")[1]] ?? "concept";

export function PossibleConnections({ path, titleFor, blockedReason, onOpen, onLinked }: {
    path: string;
    titleFor: (path: string) => string;
    /** Set while accepting would collide with other work on this page; shown as the reason. */
    blockedReason?: string;
    onOpen: (path: string) => void;
    onLinked: (target: string) => void;
}) {
    const heading = useId();
    const [loaded, setLoaded] = useState<{ path: string; items: Suggestion[] | null; error?: string } | null>(null);
    const [pending, setPending] = useState<string | null>(null);
    const [failure, setFailure] = useState<{ target: string; message: string } | null>(null);
    const [linked, setLinked] = useState<{ path: string; title: string } | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch(`/api/vault/suggestions?path=${encodeURIComponent(path)}`)
            .then(async (response) => {
                const json = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(json.error || "Suggestions could not be loaded.");
                return (Array.isArray(json.suggestions) ? json.suggestions : []) as Suggestion[];
            })
            .then((items) => { if (!cancelled) setLoaded({ path, items }); })
            .catch((reason: unknown) => { if (!cancelled) setLoaded({ path, items: null, error: reason instanceof Error ? reason.message : "Suggestions could not be loaded." }); });
        return () => { cancelled = true; };
    }, [path]);

    const current = loaded?.path === path ? loaded : null;
    const items = current?.items ?? [];

    async function accept(target: string) {
        setPending(target); setFailure(null); setLinked(null);
        try {
            const response = await fetch("/api/vault/link", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ source: path, target, label: "related" }),
            });
            const json = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(json.error || "These pages could not be linked.");
            setLoaded((previous) => previous?.path === path ? { ...previous, items: (previous.items ?? []).filter((item) => item.target !== target) } : previous);
            setLinked({ path, title: titleFor(target) });
            onLinked(target);
        } catch (reason) {
            setFailure({ target, message: reason instanceof Error ? reason.message : "These pages could not be linked." });
        } finally {
            setPending(null);
        }
    }

    return <section className={styles.connections} aria-labelledby={heading}>
        <header className={styles.head}>
            <h3 id={heading}>Possible connections{current?.items && <span>{items.length}</span>}</h3>
            {items.length > 0 && <span className={styles.column}>Similarity</span>}
        </header>
        {!current && <p className={styles.note}><Loader2 size={14} className={styles.spin} aria-hidden="true" />Looking for related pages…</p>}
        {current?.error && <p className={styles.note}>Suggestions are unavailable right now. {current.error}</p>}
        {current?.items && items.length === 0 && <p className={styles.note}>No unlinked pages look closely related.</p>}
        {linked?.path === path && <p className={styles.done} role="status">Linked to {linked.title}. Both pages were updated in the vault.</p>}
        {items.length > 0 && <ul className={styles.list}>
            {items.map((item) => {
                const title = titleFor(item.target);
                return <li key={item.target}>
                    <i className={styles.dot} data-family={family(item.target)} aria-hidden="true" />
                    <button type="button" className={styles.title} onClick={() => onOpen(item.target)} title={item.target}>{title}</button>
                    <span className={styles.score}>{Math.round(item.similarity * 100)}%</span>
                    <button type="button" className={styles.accept} disabled={!!pending || !!blockedReason} title={blockedReason}
                        aria-label={`Link ${title} to this page`} onClick={() => void accept(item.target)}>
                        {pending === item.target ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                        {pending === item.target ? "Linking" : "Accept"}
                    </button>
                    {failure?.target === item.target && <p className={styles.failure} role="alert">{failure.message}</p>}
                </li>;
            })}
        </ul>}
        {blockedReason && items.length > 0 && <p className={styles.note}>{blockedReason}</p>}
    </section>;
}
