"use client";

import { Suspense, useEffect, useState } from "react";
import { WorkspaceShell } from "@/components/workspace-shell";
import { useSearchParams } from "next/navigation";
import { validConversationId, type BranchComparison } from "@/lib/conversations/branches";
import { BranchNavigation } from "../branch-navigation";
import { BranchComparisonContent } from "../branch-comparison";
import styles from "../branches.module.css";

function ComparisonView() {
    const params = useSearchParams();
    const left = params.get("left"), right = params.get("right");
    const key = `${left}:${right}`;
    const [state, setState] = useState<{ key: string; result?: BranchComparison; error?: string } | null>(null);
    const valid = validConversationId(left) && validConversationId(right) && left !== right;
    useEffect(() => {
        if (!valid) return;
        const controller = new AbortController();
        void fetch(`/api/conversations/compare?${new URLSearchParams({ left: left!, right: right! })}`, { signal: controller.signal, cache: "no-store" })
            .then(async (response) => {
                const data = await response.json();
                if (!response.ok) throw new Error(data.error ?? "Comparison unavailable.");
                if (!controller.signal.aborted) setState({ key, result: data });
            }).catch((error: unknown) => {
                if (!controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : "Comparison unavailable." });
            });
        return () => controller.abort();
    }, [key, left, right, valid]);
    const result = state?.key === key ? state.result : undefined;
    return <WorkspaceShell current="conversations" title="Compare approaches" description="Explore different prompts or models while keeping the original discussion." backHref={validConversationId(left) ? `/?c=${left}` : "/"}><div className={styles.page}>
        {!valid ? <p role="alert">Choose two different related conversations from a chat’s branch links.</p>
            : state?.key === key && state.error ? <div className={styles.error} role="alert"><p>{state.error}</p><button className={styles.button} onClick={() => window.location.reload()}>Retry comparison</button></div>
                : !result ? <p role="status">Loading conversations…</p>
                    : <><BranchComparisonContent result={result} />
                        <BranchNavigation conversationId={left} /></>}
    </div></WorkspaceShell>;
}
export default function ConversationComparisonPage() {
    return <Suspense fallback={<WorkspaceShell current="conversations" title="Compare approaches" description="Explore different prompts or models while keeping the original discussion."><div className={styles.page} role="status">Loading comparison…</div></WorkspaceShell>}><ComparisonView /></Suspense>;
}
