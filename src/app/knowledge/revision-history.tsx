"use client";

import { useEffect, useRef, useState } from "react";
import { MarkdownReader } from "./markdown-reader";
import type { KnowledgeRevision, KnowledgeRevisionPreview } from "@/lib/knowledge/revision-types";
import styles from "./revision-history.module.css";

interface HistoryPage { revisions: KnowledgeRevision[]; headSha: string; page: number; hasMore: boolean }
export function RevisionHistory({ documentId, draftDirty, onRestored }: {
    documentId: string; draftDirty: boolean; onRestored: () => Promise<void>;
}) {
    const [history, setHistory] = useState<HistoryPage>();
    const [preview, setPreview] = useState<KnowledgeRevisionPreview>();
    const [busy, setBusy] = useState("history");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [view, setView] = useState<"changes" | "preview" | "source">("changes");
    const request = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController(); request.current = controller;
        fetch(`/api/knowledge/revisions?documentId=${encodeURIComponent(documentId)}`, { signal: controller.signal })
            .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error); return body; })
            .then((body) => { if (!controller.signal.aborted) setHistory(body); })
            .catch((reason) => { if (!controller.signal.aborted) setError(reason.message || "History could not be loaded."); })
            .finally(() => { if (!controller.signal.aborted) setBusy(""); });
        return () => { controller.abort(); request.current?.abort(); };
    }, [documentId]);
    async function loadMore(restart = false) {
        if (!history && !restart) return;
        request.current?.abort();
        const controller = new AbortController(); request.current = controller;
        setBusy("history"); setError("");
        try {
            const query = new URLSearchParams(restart ? { documentId } : { documentId, headSha: history!.headSha, page: String(history!.page + 1) });
            const response = await fetch(`/api/knowledge/revisions?${query}`, { signal: controller.signal });
            const body = await response.json(); if (!response.ok) throw new Error(body.error);
            if (!controller.signal.aborted) setHistory(restart ? body : { ...body, revisions: [...history!.revisions, ...body.revisions] });
        } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "History could not be loaded."); }
        finally { if (!controller.signal.aborted) setBusy(""); }
    }
    async function inspect(revision: KnowledgeRevision) {
        request.current?.abort();
        const controller = new AbortController(); request.current = controller;
        setBusy("preview"); setError(""); setNotice(""); setPreview(undefined);
        try {
            const query = new URLSearchParams({ documentId, sourceSha: revision.commitSha, sourcePath: revision.path });
            const response = await fetch(`/api/knowledge/revisions?${query}`, { signal: controller.signal });
            const body = await response.json(); if (!response.ok) throw new Error(body.error);
            if (!controller.signal.aborted) { setPreview(body); setView("changes"); }
        } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "This revision could not be opened."); }
        finally { if (!controller.signal.aborted) setBusy(""); }
    }
    async function restore() {
        if (!preview || draftDirty || busy) return;
        request.current?.abort();
        const controller = new AbortController(); request.current = controller;
        setBusy("restore"); setError(""); setNotice("");
        try {
            const response = await fetch("/api/knowledge/revisions", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({
                documentId, sourceSha: preview.sourceSha, sourcePath: preview.sourcePath, headSha: preview.headSha,
                currentHash: preview.currentHash, previewHash: preview.previewHash,
            }) });
            const body = await response.json(); if (!response.ok) throw new Error(body.error);
            if (controller.signal.aborted) return;
            setPreview(undefined);
            setNotice(body.warning || "The earlier content is saved as a new revision.");
            await onRestored();
            if (controller.signal.aborted) return;
            const fresh = await fetch(`/api/knowledge/revisions?documentId=${encodeURIComponent(documentId)}`, { signal: controller.signal });
            const updated = await fresh.json(); if (!fresh.ok) throw new Error(updated.error);
            if (!controller.signal.aborted) setHistory(updated);
        } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "The restore could not be completed. Reload history before trying again."); }
        finally { if (!controller.signal.aborted) setBusy(""); }
    }
    return <section className={styles.history} aria-label="Document revision history">
        <div className={styles.heading}><h3>Document history</h3>{history && <span>{history.revisions.length} loaded</span>}</div>
        <p>Choose a revision to compare its content with the current page. History is listed for this document’s current path.</p>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {error && !history && <button disabled={!!busy} onClick={() => loadMore(true)}>Retry history</button>}
        {notice && <p role="status">{notice}</p>}
        {!history && busy === "history" && <p role="status">Loading document history…</p>}
        {history && !history.revisions.length && <p>No revisions were found at this path.</p>}
        <ol className={styles.revisions}>{history?.revisions.map((revision) => <li key={revision.commitSha}>
            <button onClick={() => inspect(revision)} disabled={busy === "restore"} aria-pressed={preview?.sourceSha === revision.commitSha}>
                <strong>{revision.message || "Document update"}</strong>
                <span>{revision.committedAt ? new Date(revision.committedAt).toLocaleString("en-AU", { timeZone: "Australia/Sydney", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Date unavailable"} · {revision.author}</span>
                <code>{revision.commitSha.slice(0, 10)}</code>
            </button>
        </li>)}</ol>
        {history?.hasMore && <button onClick={() => loadMore()} disabled={!!busy}>{busy === "history" ? "Loading…" : "Load earlier revisions"}</button>}
        {busy === "preview" && <p role="status">Preparing comparison…</p>}
        {preview && <div className={styles.comparison}>
            <h4>Restore preview</h4>
            <p>This creates a new revision with the earlier body text. Current access, trust and lifecycle metadata are retained.</p>
            <div className={styles.tabs} aria-label="Comparison views">
                <button aria-pressed={view === "changes"} onClick={() => setView("changes")}>Changes</button>
                <button aria-pressed={view === "preview"} onClick={() => setView("preview")}>Restored page</button>
                <button aria-pressed={view === "source"} onClick={() => setView("source")}>Historical source</button>
            </div>
            {view === "changes" ? <div className={styles.diff}>{preview.diff.map((part, index) => <div key={index} className={styles[part.kind]}>
                <span>{part.kind === "added" ? "Added" : part.kind === "removed" ? "Removed" : "Unchanged"}</span><pre>{part.text}</pre>
            </div>)}</div> : view === "preview" ? <MarkdownReader markdown={preview.restoredMarkdown} /> : <pre className={styles.source}>{preview.historicalMarkdown}</pre>}
            <div className={styles.restoreActions}>
                {draftDirty && <p role="status">Save or discard your unsaved draft before restoring a revision.</p>}
                <button className={styles.restore} onClick={restore} disabled={draftDirty || !!busy}>{busy === "restore" ? "Restoring…" : "Restore this content"}</button>
            </div>
        </div>}
    </section>;
}
