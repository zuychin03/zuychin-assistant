"use client";

import { useCallback, useSyncExternalStore } from "react";
import { acknowledgeDocumentSave, discardDocumentDraft, documentDraftPersisted, readDocumentDraft, subscribeDocumentDrafts, writeDocumentDraft } from "@/lib/document-drafts";

function storage(): Storage | undefined {
    try { return window.localStorage; } catch { return undefined; }
}

export function useDocumentDraft(path: string | null, source: string | null) {
    const snapshot = useCallback(() => path ? readDocumentDraft(path, storage()) : null, [path]);
    const draft = useSyncExternalStore(subscribeDocumentDrafts, snapshot, () => null);
    const base = draft?.base ?? source ?? "";
    const text = draft?.text ?? source ?? "";

    const change = useCallback((value: string) => {
        if (path && source !== null) writeDocumentDraft(path, base, value, storage());
    }, [path, source, base]);

    const discard = useCallback(() => path ? discardDocumentDraft(path, storage()) : false, [path]);
    const saved = useCallback((savedPath: string, submitted: string, serverText: string) => {
        acknowledgeDocumentSave(savedPath, submitted, serverText, storage());
    }, []);
    const dirty = text !== base;

    return { text, base, dirty, persisted: !path || documentDraftPersisted(path),
        conflict: dirty && source !== null && source !== base, change, discard, saved };
}
