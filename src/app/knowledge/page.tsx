"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    Archive, ArrowLeft, BookOpen, CheckCircle2, Clock3, Download,
    ExternalLink, FileText, GitBranch, History, Import, Loader2, Merge,
    RefreshCw, RotateCcw, Search, ShieldCheck, Sparkles, Trash2, Upload, XCircle,
} from "lucide-react";
import styles from "./knowledge.module.css";

type Tab = "library" | "recall" | "timeline" | "maintenance";
interface DocumentSummary {
    id: string; path: string; title: string; summary: string; category: string;
    kind: string; scope: string; status: string; trust: string; sensitivity: string; updated_at: string;
}
interface DocumentDetail {
    document: DocumentSummary; markdown: string;
    chunks: { id: string; heading: string; content: string; token_count: number }[];
    links: { id: string; target_ref: string; relation: string }[];
}
interface RecallHit {
    documentId: string; chunkId: string; path: string; title: string; heading: string;
    excerpt: string; category: string;
    score: Record<"semantic" | "lexical" | "graph" | "authority" | "freshness" | "importance" | "final", number>;
}
interface RecallResponse {
    hits: RecallHit[];
    grounded: { supported: boolean; support: number; answer: string };
}
interface KnowledgeEvent {
    id: string; document_id: string | null; action: string; actor: string;
    detail: Record<string, unknown>; occurred_at: string;
}
interface ImportPlan {
    files: number; changed: number; created: number; updated: number; unchanged: number;
    missingStableIds: string[]; dryRun: boolean; commit?: string;
}
interface Suggestion {
    id: string; kind: string; status: string; severity: string; document_ids: string[];
    title: string; detail: string; confidence: number; created_at: string;
    evidence: { source?: string; advisory?: boolean; excerpt?: string; paths?: string[] };
}


const TABS: { id: Tab; label: string; icon: typeof BookOpen }[] = [
    { id: "library", label: "Library", icon: BookOpen },
    { id: "recall", label: "Recall", icon: Search },
    { id: "timeline", label: "Timeline", icon: History },
    { id: "maintenance", label: "Maintenance", icon: ShieldCheck },
];
const percent = (value: number) => `${Math.round(value * 100)}%`;

export default function KnowledgePage() {
    const [tab, setTab] = useState<Tab>("library");
    const [documents, setDocuments] = useState<DocumentSummary[]>([]);
    const [detail, setDetail] = useState<DocumentDetail>();
    const [events, setEvents] = useState<KnowledgeEvent[]>([]);
    const [recall, setRecall] = useState<RecallResponse>();
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState("");
    const [status, setStatus] = useState("active");
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [editing, setEditing] = useState(false);
    const [markdown, setMarkdown] = useState("");
    const [importFile, setImportFile] = useState<File>();
    const [importPlan, setImportPlan] = useState<ImportPlan>();
    const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
    const [mergeSuggestion, setMergeSuggestion] = useState<Suggestion>();
    const [mergeTarget, setMergeTarget] = useState("");
    const [mergeMarkdown, setMergeMarkdown] = useState("");
    const fileInput = useRef<HTMLInputElement>(null);
    const obsidianVault = process.env.NEXT_PUBLIC_OBSIDIAN_VAULT_NAME;

    const loadDocuments = useCallback(async () => {
        const response = await fetch(`/api/knowledge/documents?status=${encodeURIComponent(status)}`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Failed to load documents.");
        setDocuments(payload.documents ?? []);
    }, [status]);

    const loadEvents = useCallback(async () => {
        const response = await fetch("/api/knowledge/events");
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Failed to load timeline.");
        setEvents(payload.events ?? []);
    }, []);


    const loadSuggestions = useCallback(async () => {
        const response = await fetch("/api/knowledge/suggestions");
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Failed to load suggestions.");
        setSuggestions(payload.suggestions ?? []);
    }, []);
    useEffect(() => { loadDocuments().catch((reason) => setError(String(reason.message ?? reason))); }, [loadDocuments]);
    useEffect(() => { if (tab === "timeline") loadEvents().catch((reason) => setError(String(reason.message ?? reason))); }, [tab, loadEvents]);
    useEffect(() => { if (tab === "maintenance") loadSuggestions().catch((reason) => setError(String(reason.message ?? reason))); }, [tab, loadSuggestions]);

    async function selectDocument(id: string) {
        setBusy("document"); setError("");
        try {
            const response = await fetch(`/api/knowledge/documents?id=${encodeURIComponent(id)}`);
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || "Failed to load document.");
            setDetail(payload); setMarkdown(payload.markdown); setEditing(false);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Failed to load document."); }
        finally { setBusy(""); }
    }

    const visibleDocuments = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        return needle ? documents.filter((item) =>
            [item.title, item.path, item.summary, item.category, item.kind].some((value) => value?.toLowerCase().includes(needle)),
        ) : documents;
    }, [documents, filter]);

    async function lifecycle(action: "archive" | "restore" | "forget" | "promote" | "correct") {
        if (!detail) return;
        if (action === "forget" && !window.confirm("Retire this page from recall while preserving Markdown and history?")) return;
        setBusy(action); setError("");
        try {
            const response = await fetch("/api/knowledge/documents", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action, documentId: detail.document.id, ...(action === "correct" ? { markdown } : {}) }),
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || "Knowledge update failed.");
            await loadDocuments(); await selectDocument(detail.document.id);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Knowledge update failed."); }
        finally { setBusy(""); }
    }

    async function runRecall(event: FormEvent) {
        event.preventDefault(); if (!query.trim()) return;
        setBusy("recall"); setError("");
        try {
            const response = await fetch("/api/knowledge/recall", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query, limit: 10 }),
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || "Recall failed.");
            setRecall(payload);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Recall failed."); }
        finally { setBusy(""); }
    }

    async function syncVault(applyIdentities = false) {
        setBusy(applyIdentities ? "identities" : "sync"); setError("");
        try {
            const response = await fetch("/api/knowledge/sync", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fullScan: true, applyIdentities }),
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || "Sync failed.");
            await loadDocuments();
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Sync failed."); }
        finally { setBusy(""); }
    }

    async function uploadVault(file: File, dryRun: boolean) {
        setBusy(dryRun ? "inspect-import" : "apply-import"); setError("");
        try {
            const form = new FormData(); form.set("vault", file); form.set("dryRun", String(dryRun));
            const response = await fetch("/api/knowledge/import", { method: "POST", body: form });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || "Import failed.");
            setImportPlan(payload); if (!dryRun) await loadDocuments();
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Import failed."); }
        finally { setBusy(""); }
    }

    async function scanMaintenance() {
        setBusy("maintenance"); setError("");
        try {
            const response = await fetch("/api/knowledge/suggestions", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "scan", includeAssisted: true }),
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || "Maintenance scan failed.");
            setSuggestions(payload.suggestions ?? []);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Maintenance scan failed."); }
        finally { setBusy(""); }
    }

    async function dismissSuggestion(id: string) {
        setBusy(id); setError("");
        try {
            const response = await fetch("/api/knowledge/suggestions", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "dismiss", suggestionId: id }),
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || "Could not dismiss suggestion.");
            setSuggestions((items) => items.filter((item) => item.id !== id));
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not dismiss suggestion."); }
        finally { setBusy(""); }
    }

    async function prepareMerge(suggestion: Suggestion, targetId = suggestion.document_ids[0]) {
        setBusy("merge-preview"); setError("");
        try {
            const response = await fetch(`/api/knowledge/documents?id=${encodeURIComponent(targetId)}`);
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || "Could not load the merge target.");
            setMergeSuggestion(suggestion); setMergeTarget(targetId); setMergeMarkdown(payload.markdown);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load the merge target."); }
        finally { setBusy(""); }
    }


    async function applyMerge() {
        if (!mergeSuggestion || !mergeTarget || !mergeMarkdown.trim()) return;
        if (!window.confirm("Merge these pages and mark the source pages as superseded?")) return;
        setBusy("merge-apply"); setError("");
        try {
            const response = await fetch("/api/knowledge/suggestions", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "merge",
                    suggestionId: mergeSuggestion.id,
                    targetId: mergeTarget,
                    mergedMarkdown: mergeMarkdown,
                }),
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || "Merge failed.");
            setMergeSuggestion(undefined); setMergeTarget(""); setMergeMarkdown("");
            await Promise.all([loadSuggestions(), loadDocuments()]);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Merge failed."); }
        finally { setBusy(""); }
    }

    async function openSuggestionDocument(id: string) {
        setStatus("all"); setTab("library"); await selectDocument(id);
    }


    const obsidianHref = detail && obsidianVault
        ? `obsidian://open?vault=${encodeURIComponent(obsidianVault)}&file=${encodeURIComponent(detail.document.path.replace(/\.md$/i, ""))}`
        : undefined;

    return <main className={styles.shell}>
        <header className={styles.header}>
            <div className={styles.titleGroup}>
                <Link href="/" className={styles.iconButton} aria-label="Back to chat"><ArrowLeft size={18} /></Link>
                <div><span className={styles.eyebrow}>Second brain</span><h1>Knowledge workspace</h1><p>Markdown-first, explainable, and portable to Obsidian.</p></div>
            </div>
            <div className={styles.actions}>
                <button onClick={() => syncVault()} disabled={!!busy}><RefreshCw size={15} /> Reconcile</button>
                <a href="/api/knowledge/export"><Download size={15} /> Export</a>
                <button onClick={() => fileInput.current?.click()} disabled={!!busy}><Upload size={15} /> Import</button>
                <Link href="/graph"><GitBranch size={15} /> Graph</Link>
                <input ref={fileInput} type="file" accept=".zip,application/zip" hidden onChange={(event) => {
                    const file = event.target.files?.[0]; if (file) { setImportFile(file); uploadVault(file, true); }
                }} />
            </div>
        </header>
        <nav className={styles.tabs}>{TABS.map(({ id, label, icon: Icon }) =>
            <button key={id} className={tab === id ? styles.activeTab : ""} onClick={() => setTab(id)}><Icon size={16} /> {label}</button>,
        )}</nav>
        {error && <div className={styles.error}><XCircle size={16} /> {error}</div>}

        {tab === "library" && <section className={styles.library}>
            <aside className={styles.sidebar}>
                <div className={styles.filters}><label><Search size={15} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter pages" /></label>
                    <select value={status} onChange={(event) => setStatus(event.target.value)}>
                        {["active", "suggested", "archived", "superseded", "deleted", "all"].map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                </div>
                <small className={styles.count}>{visibleDocuments.length} documents</small>
                <div className={styles.documentList}>{visibleDocuments.map((item) =>
                    <button key={item.id} className={detail?.document.id === item.id ? styles.selected : ""} onClick={() => selectDocument(item.id)}>
                        <FileText size={15} /><span><strong>{item.title}</strong><small>{item.path}</small><em>{item.kind} / {item.scope}</em></span>
                    </button>,
                )}</div>
            </aside>
            <div className={styles.detail}>
                {busy === "document" && <div className={styles.blank}><Loader2 className={styles.spin} /> Loading page</div>}
                {!detail && busy !== "document" && <div className={styles.blank}><BookOpen size={34} /><h2>Select a page</h2><p>Inspect source, chunks, links, and lifecycle.</p></div>}
                {detail && <>
                    <div className={styles.detailHeader}><div><div className={styles.badges}>
                        {[detail.document.status, detail.document.kind, detail.document.trust, detail.document.sensitivity].map((value) => <span key={value}>{value}</span>)}
                    </div><h2>{detail.document.title}</h2><code>{detail.document.path}</code></div>
                    <div className={styles.actions}>
                        {obsidianHref && <a href={obsidianHref}><ExternalLink size={14} /> Obsidian</a>}
                        <button onClick={() => setEditing((value) => !value)}><FileText size={14} /> {editing ? "Preview" : "Edit"}</button>
                        {detail.document.status === "active"
                            ? <button onClick={() => lifecycle("archive")}><Archive size={14} /> Archive</button>
                            : <button onClick={() => lifecycle("restore")}><RotateCcw size={14} /> Restore</button>}
                    </div></div>
                    {editing ? <div className={styles.editor}><textarea value={markdown} onChange={(event) => setMarkdown(event.target.value)} /><div>
                        <button className={styles.primary} onClick={() => lifecycle("correct")} disabled={!!busy}><CheckCircle2 size={15} /> Save correction</button>
                        <button onClick={() => lifecycle("promote")} disabled={!!busy}><Sparkles size={15} /> Promote</button>
                        <button className={styles.danger} onClick={() => lifecycle("forget")} disabled={!!busy}>Retire</button>
                    </div></div> : <article className={`${styles.markdown} markdown-body`}><ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.markdown}</ReactMarkdown></article>}
                    <div className={styles.metrics}><div><strong>{detail.chunks.length}</strong><span>chunks</span></div><div><strong>{detail.links.length}</strong><span>links</span></div><div><strong>{detail.document.scope}</strong><span>scope</span></div><div><strong>{new Date(detail.document.updated_at).toLocaleDateString()}</strong><span>indexed</span></div></div>
                    <details className={styles.chunks}><summary>Indexed chunks</summary>{detail.chunks.map((chunk) =>
                        <div key={chunk.id}><strong>{chunk.heading || "Document"}</strong><small>{chunk.token_count} tokens</small><p>{chunk.content}</p></div>,
                    )}</details>
                </>}
            </div>
        </section>}

        {tab === "recall" && <section className={styles.panel}>
            <div className={styles.intro}><span>Retrieval lab</span><h2>Ask the vault directly</h2><p>Inspect evidence and every component of the ranking.</p></div>
            <form className={styles.recallForm} onSubmit={runRecall}><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="What does my knowledge base say about..." /><button className={styles.primary}>Recall</button></form>
            {recall && <><div className={recall.grounded.supported ? styles.grounded : styles.abstained}>
                {recall.grounded.supported ? <CheckCircle2 /> : <ShieldCheck />}<div><strong>{recall.grounded.supported ? "Grounded answer" : "Abstained"}</strong><p>{recall.grounded.answer}</p><small>Support {percent(recall.grounded.support)}</small></div>
            </div><div className={styles.hits}>{recall.hits.map((hit) => <article key={hit.chunkId}>
                <header><div><small>{hit.category}</small><h3>{hit.title}</h3><code>{hit.path}{hit.heading ? `#${hit.heading}` : ""}</code></div><strong>{percent(hit.score.final)}</strong></header>
                <p>{hit.excerpt}</p><div className={styles.scores}>{Object.entries(hit.score).filter(([key]) => key !== "final").map(([key, value]) =>
                    <div key={key}><span>{key}</span><i><b style={{ width: percent(value) }} /></i><em>{percent(value)}</em></div>,
                )}</div>
            </article>)}</div></>}
        </section>}

        {tab === "timeline" && <section className={styles.panel}>
            <div className={styles.intro}><span>Audit trail</span><h2>Knowledge timeline</h2><p>Corrections, promotions, merges, archives, imports, and indexing.</p></div>
            <div className={styles.timeline}>{events.map((event) => <article key={event.id}><Clock3 size={15} /><div><strong>{event.action}</strong><p>{String(event.detail.path ?? event.document_id ?? "Knowledge record")}</p><small>{event.actor} / {new Date(event.occurred_at).toLocaleString()}</small></div></article>)}</div>
        </section>}

        {tab === "maintenance" && <section className={styles.panel}>
            <div className={styles.intro}><span>Portability and health</span><h2>Vault maintenance</h2><p>Rebuild indexes safely and keep stable identity in Markdown.</p></div>
            <div className={styles.maintenance}>
                <article><Sparkles /><h3>Governed curator</h3><p>Find duplicates, contradictions, stale episodes, broken links, orphans, and consolidation opportunities. Every result requires review.</p><button className={styles.primary} onClick={scanMaintenance} disabled={!!busy}>{busy === "maintenance" && <Loader2 className={styles.spin} size={15} />} Scan knowledge</button></article>
                <article><RefreshCw /><h3>Complete reconciliation</h3><p>Hash every Markdown file and infer deletions only after a complete scan.</p><button onClick={() => syncVault()}>Run reconciliation</button></article>
                <article><ShieldCheck /><h3>Stable identities</h3><p>Add missing <code>zuychin_id</code> properties in one Git commit.</p><button onClick={() => syncVault(true)}>Add missing IDs</button></article>
                <article><Download /><h3>Obsidian export</h3><p>Download Markdown, attachments, settings, and checksums without conversion.</p><a href="/api/knowledge/export">Download ZIP</a></article>
                <article><Import /><h3>Obsidian import</h3><p>Inspect first, then accept the dry-run plan before overwriting files.</p><button onClick={() => fileInput.current?.click()}>Choose ZIP</button></article>
            </div>
            <div className={styles.suggestionHeader}>
                <div><span className={styles.eyebrow}>Review queue</span><h3>{suggestions.length} open suggestions</h3></div>
                <small>Assistant findings are advisory and never change the vault automatically.</small>
            </div>
            <div className={styles.suggestionList}>
                {!suggestions.length && <div className={styles.emptySuggestions}><CheckCircle2 /><strong>No open findings</strong><p>Run a scan to refresh the queue.</p></div>}
                {suggestions.map((suggestion) => <article key={suggestion.id} data-severity={suggestion.severity}>
                    <header><div><span>{suggestion.kind.replace("_", " ")}</span><h3>{suggestion.title}</h3></div><strong>{percent(suggestion.confidence)}</strong></header>
                    <p>{suggestion.detail}</p>
                    {!!suggestion.evidence.excerpt && <blockquote>{suggestion.evidence.excerpt}</blockquote>}
                    <div className={styles.suggestionMeta}>
                        <small>{suggestion.evidence.source === "assistant-review" ? "Advisory review" : "Deterministic check"}</small>
                        <small>{suggestion.document_ids.length} document{suggestion.document_ids.length === 1 ? "" : "s"}</small>
                    </div>
                    <footer>
                        <button onClick={() => openSuggestionDocument(suggestion.document_ids[0])}><FileText size={14} /> Open</button>
                        {["duplicate", "merge"].includes(suggestion.kind) && suggestion.document_ids.length > 1 &&
                            <button className={styles.primary} onClick={() => prepareMerge(suggestion)}><Merge size={14} /> Review merge</button>}
                        <button className={styles.danger} onClick={() => dismissSuggestion(suggestion.id)} disabled={busy === suggestion.id}><Trash2 size={14} /> Dismiss</button>
                    </footer>
                </article>)}
            </div>

            {mergeSuggestion && <div className={styles.mergeReview}>
                <header><div><span className={styles.eyebrow}>Human-approved consolidation</span><h3>Review merged Markdown</h3></div><button onClick={() => setMergeSuggestion(undefined)}><XCircle size={14} /> Close</button></header>
                <label>Canonical page<select value={mergeTarget} onChange={(event) => prepareMerge(mergeSuggestion, event.target.value)}>
                    {mergeSuggestion.document_ids.map((id) => <option key={id} value={id}>{documents.find((item) => item.id === id)?.path ?? id}</option>)}
                </select></label>
                <textarea value={mergeMarkdown} onChange={(event) => setMergeMarkdown(event.target.value)} />
                <p>Only the canonical page receives this content. Source pages remain in Git and are marked superseded.</p>
                <button className={styles.primary} onClick={applyMerge} disabled={!!busy}><Merge size={15} /> Apply reviewed merge</button>
            </div>}

            {importPlan && <div className={styles.importPlan}><strong>{importPlan.dryRun ? "Import preview" : "Import complete"}</strong>
                <p>{importPlan.changed} changes / {importPlan.created} new / {importPlan.updated} updated / {importPlan.unchanged} unchanged.</p>
                {!!importPlan.missingStableIds.length && <p>{importPlan.missingStableIds.length} files need stable IDs.</p>}
                {importPlan.dryRun && importFile && <button className={styles.primary} onClick={() => uploadVault(importFile, false)}><Upload size={15} /> Apply import</button>}
                {importPlan.commit && <code>{importPlan.commit}</code>}
            </div>}
        </section>}
    </main>;
}
