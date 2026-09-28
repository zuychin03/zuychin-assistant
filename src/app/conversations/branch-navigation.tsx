"use client";

import { type MouseEvent, useEffect, useState } from "react";
import Link from "next/link";
import { comparisonUrl, type BranchConversation } from "@/lib/conversations/branches";
import styles from "./branches.module.css";

export function BranchNavigation({ conversationId, onSelect }: { conversationId: string | null; onSelect?: (id: string) => void }) {
    const [state, setState] = useState<{ id: string; related: BranchConversation[]; error?: string } | null>(null);
    const [retry, setRetry] = useState(0);
    function selectBranch(event: MouseEvent<HTMLAnchorElement>, id: string) {
        if (!onSelect || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); onSelect(id);
    }
    useEffect(() => {
        if (!conversationId) return;
        const controller = new AbortController();
        void fetch(`/api/conversations/branches?${new URLSearchParams({ conversationId })}`, { signal: controller.signal, cache: "no-store" })
            .then(async (response) => {
                const data = await response.json();
                if (!response.ok) throw new Error(data.error ?? "Related branches are unavailable.");
                if (!controller.signal.aborted) setState({ id: conversationId, related: data.related });
            }).catch((error: unknown) => {
                if (!controller.signal.aborted) setState({ id: conversationId, related: [], error: error instanceof Error ? error.message : "Branches are unavailable." });
            });
        return () => controller.abort();
    }, [conversationId, retry]);
    if (!conversationId) return null;
    if (state?.id !== conversationId) return <p className={styles.notice} role="status">Loading related branches…</p>;
    if (state.error) return <div className={styles.notice}><p role="alert">{state.error}</p><button className={styles.button} onClick={() => { setState(null); setRetry((value) => value + 1); }}>Retry related branches</button></div>;
    if (!state.related.length) return null;
    return <nav className={styles.navigation} aria-label="Related conversation branches">
        <strong>Related branches</strong>
        <ul>{state.related.map((item) => <li key={item.id}>
            <Link href={`/?${new URLSearchParams({ c: item.id })}`} onClick={(event) => selectBranch(event, item.id)}>{item.title}</Link>
            <Link href={comparisonUrl(conversationId, item.id)} aria-label={`Compare with ${item.title}`}>Compare</Link>
        </li>)}</ul>
    </nav>;
}
