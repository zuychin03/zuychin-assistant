"use client";

import { useMemo, useState } from "react";
import { GitBranch } from "lucide-react";
import { createBranchRequest } from "@/lib/conversations/branch-request";
import styles from "./branches.module.css";

export function BranchMessageAction({ conversationId, messageId, disabled, onCreated }: {
    conversationId: string; messageId: string; disabled: boolean;
    onCreated: (id: string, parentId: string) => void;
}) {
    const request = useMemo(() => createBranchRequest(conversationId, messageId), [conversationId, messageId]);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const branch = async () => {
        if (pending || disabled) return;
        setPending(true); setError(null);
        try { onCreated(await request(), conversationId); }
        catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create a branch. Retry to recover it."); }
        finally { setPending(false); }
    };
    return <div className={styles.action}>
        <button type="button" disabled={disabled || pending} onClick={() => { void branch(); }}
            title="Start another conversation including this message. The original chat stays available.">
            <GitBranch size={13} aria-hidden="true" />{pending ? "Creating branch…" : error ? "Retry branch" : "Branch from here"}
        </button>
        {error && <p role="alert">{error}</p>}
    </div>;
}
