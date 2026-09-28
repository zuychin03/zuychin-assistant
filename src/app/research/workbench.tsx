"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { WorkspaceLink as Link } from "@/components/workspace-link";
import { WorkspaceShell } from "@/components/workspace-shell";
import { Dropdown } from "@/components/dropdown";
import { useUnsavedChanges } from "@/components/use-unsaved-changes";
import { researchComparison, researchKinds, type ResearchEntry, type ResearchKind, type ResearchQuestion, type ResearchWorkspace } from "@/lib/research/contracts";
import { createResearchSessionClient, ResearchApiFailure as ApiFailure } from "@/lib/research/session-client";
import { OFFLINE_PRIVACY_EVENT } from "@/lib/offline/storage";
import styles from "./research.module.css";

type QuestionDraft = { id: string; projectId: string; title: string; question: string; status: "active" | "archived"; version?: number };
type EntryDraft = { id: string; kind: ResearchKind; text: string; sourceId: string | null; quote?: string; startOffset?: number; version?: number };
type Conflict = { target: "question" | "source" | "entry"; current: Record<string, unknown> };
const labels: Record<ResearchKind, string> = { annotation: "Passage annotation", claim: "Source-backed claim", interpretation: "Your interpretation", method: "Method", finding: "Finding", limitation: "Limitation" };
const newEntry = (): EntryDraft => ({ id: crypto.randomUUID(), kind: "interpretation", text: "", sourceId: null });

export function ResearchComparison({ workspace }: { workspace: ResearchWorkspace }) {
    return <section className={styles.comparison} aria-label="Compare research sources">
        <p className={styles.hint}>Methods, findings and limitations are your source-linked notes. Expand a passage to inspect the quoted evidence.</p>
        {researchComparison(workspace).map(({ source, methods, findings, limitations }) => <article className={styles.compareRow} key={source.id}>
            <header><h3>{source.title}</h3><small>{source.path} · {source.commitSha.slice(0, 8)}{source.removedAt ? " · Removed from selection" : ""}</small></header>
            <div className={styles.compareColumns}>{[["Methods", methods], ["Findings", findings], ["Limitations", limitations]].map(([label, entries]) => <section key={label as string}>
                <h4>{label as string}</h4>{(entries as ResearchEntry[]).length ? (entries as ResearchEntry[]).map((entry) => <EvidenceNote key={entry.id} entry={entry} />) : <p className={styles.hint}>No notes yet.</p>}
            </section>)}</div>
        </article>)}
        {!workspace.sources.length && <p>Select sources to compare their methods, findings and limitations.</p>}
    </section>;
}
function EvidenceNote({ entry }: { entry: ResearchEntry }) {
    return <div className={styles.noteText}><p>{entry.text}</p>{entry.evidence && <details className={styles.evidence}>
        <summary>Quoted evidence · {entry.evidence.path} · {entry.evidence.commitSha.slice(0, 8)}</summary>
        <blockquote tabIndex={0} aria-label="Quoted source passage">{entry.evidence.quote}</blockquote>
        <small>Saved passage {entry.evidence.startOffset}–{entry.evidence.endOffset}. The quote is tied to this immutable revision.</small>
    </details>}</div>;
}
export function ResearchWorkbench() {
    const [index, setIndex] = useState<{ projects: { id: string; name: string }[]; questions: ResearchQuestion[] } | null>(null);
    const [activeId, setActiveId] = useState("");
    const activeRef = useRef("");
    const [workspace, setWorkspace] = useState<ResearchWorkspace | null>(null);
    const [questionDraft, setQuestionDraft] = useState<QuestionDraft | null>(null);
    const [entryDraft, setEntryDraft] = useState<EntryDraft | null>(null);
    const [sourceId, setSourceId] = useState("");
    const [documentId, setDocumentId] = useState("");
    const [sourceTitle, setSourceTitle] = useState("");
    const [sourceVersion, setSourceVersion] = useState(1);
    const [snapshot, setSnapshot] = useState<{ sourceId: string; markdown: string } | null>(null);
    const [snapshotError, setSnapshotError] = useState("");
    const [view, setView] = useState<"notes" | "compare">("notes");
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [conflict, setConflict] = useState<Conflict | null>(null);
    const reader = useRef<HTMLTextAreaElement>(null);
    const sourceRequests = useRef(new Map<string, string>());
    const sessionClient = useRef<ReturnType<typeof createResearchSessionClient> | null>(null);
    if (!sessionClient.current) sessionClient.current = createResearchSessionClient(() => {
        activeRef.current = ""; setActiveId(""); setIndex(null); setWorkspace(null); setQuestionDraft(null); setEntryDraft(null);
        setSourceId(""); setDocumentId(""); setSourceTitle(""); setSnapshot(null); setSnapshotError(""); setConflict(null);
        setNotice(""); setBusy(""); setError("Your session changed. Reload and sign in before opening research again."); sourceRequests.current.clear();
    });
    const request = sessionClient.current.request;
    const current = workspace?.question.id === activeId ? workspace : null;
    const selected = current?.sources.find((source) => source.id === sourceId);
    const archived = current?.question.status === "archived";
    const sourceLabelChanged = Boolean(selected && sourceTitle !== selected.title);

    const savedEntry = current?.entries.find(entry => entry.id === entryDraft?.id);
    const entryDraftChanged = Boolean(entryDraft && (savedEntry
        ? entryDraft.text !== savedEntry.text || entryDraft.kind !== savedEntry.kind || entryDraft.quote !== savedEntry.evidence?.quote || entryDraft.startOffset !== savedEntry.evidence?.startOffset || entryDraft.sourceId !== savedEntry.sourceId
        : entryDraft.text.trim() || entryDraft.quote));
    const questionDraftChanged = Boolean(questionDraft && (questionDraft.version
        ? questionDraft.title !== current?.question.title || questionDraft.question !== current?.question.question || questionDraft.status !== current?.question.status
        : questionDraft.title.trim() || questionDraft.question.trim()));
    const researchDraftChanged = entryDraftChanged || questionDraftChanged || sourceLabelChanged;
    useUnsavedChanges(() => researchDraftChanged);

    async function loadIndex() { const data = await request<NonNullable<typeof index>>("/api/research"); setIndex(data); return data; }
    async function reload(id = activeId) {
        const data = await request<ResearchWorkspace>(`/api/research?questionId=${id}`);
        if (activeRef.current === id) setWorkspace(data);
    }
    useEffect(() => {
        const invalidate = () => sessionClient.current?.invalidate();
        window.addEventListener(OFFLINE_PRIVACY_EVENT, invalidate);
        const privacy = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(OFFLINE_PRIVACY_EVENT) : null;
        if (privacy) privacy.onmessage = invalidate;
        const controller = new AbortController();
        void request<NonNullable<typeof index>>("/api/research", undefined, "GET", controller.signal).then((data) => {
            setIndex(data);
            const project = new URL(window.location.href).searchParams.get("project");
            const first = data.questions.find((item) => !project || item.projectId === project);
            if (first) { activeRef.current = first.id; setActiveId(first.id); }
        }).catch((err) => { if (!controller.signal.aborted && err.name !== "AbortError") setError(err.message); });
        return () => { controller.abort(); window.removeEventListener(OFFLINE_PRIVACY_EVENT, invalidate); privacy?.close(); sessionClient.current?.cancel(); };
    }, [request]);
    useEffect(() => {
        if (!activeId) return;
        const controller = new AbortController();
        void request<ResearchWorkspace>(`/api/research?questionId=${activeId}`, undefined, "GET", controller.signal)
            .then((data) => { if (!controller.signal.aborted) setWorkspace(data); })
            .catch((err) => { if (!controller.signal.aborted && err.name !== "AbortError") setError(err.message); });
        return () => controller.abort();
    }, [activeId, request]);
    useEffect(() => {
        if (!sourceId || !activeId) return;
        const controller = new AbortController();
        setSnapshot(null); setSnapshotError("");
        void request<{ markdown: string }>(`/api/research/sources?questionId=${activeId}&sourceId=${sourceId}`, undefined, "GET", controller.signal)
            .then((data) => { if (!controller.signal.aborted) setSnapshot({ sourceId, markdown: data.markdown }); })
            .catch((err) => { if (!controller.signal.aborted && err.name !== "AbortError") { setError(err.message); setSnapshotError("The saved source could not be loaded. Choose another source and return to retry."); } });
        return () => controller.abort();
    }, [activeId, sourceId, request]);
    async function retryLoad() {
        setBusy("reload"); setError("");
        try { if (activeId) await reload(); else await loadIndex(); }
        catch (err) { report(err, "question"); }
        finally { setBusy(""); }
    }
    function report(err: unknown, target: Conflict["target"]) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Could not save research.");
        if (err instanceof ApiFailure && err.current) setConflict({ target, current: err.current });
    }
    function chooseQuestion(id: string) {
        if (id === activeId) return;
        if (researchDraftChanged && !window.confirm("Discard your unsaved research edits and switch questions?")) return;
        activeRef.current = id; setActiveId(id); setSourceId(""); setEntryDraft(null); setQuestionDraft(null); setError(""); setNotice(""); setConflict(null);
    }
    function editQuestion() {
        if (!current || questionDraft?.id === current.question.id) return;
        if (questionDraftChanged && !window.confirm("Discard your unsaved question draft and edit the saved question?")) return;
        setQuestionDraft({ ...current.question });
    }
    function chooseSource(id: string) {
        if (id === sourceId) return true;
        if (sourceLabelChanged && !window.confirm("Discard the unsaved source label and switch sources?")) return false;
        const chosen = current?.sources.find((source) => source.id === id);
        setSourceId(id); setSourceTitle(chosen?.title ?? ""); setSourceVersion(chosen?.version ?? 1);
        return true;
    }
    async function saveQuestion(event: FormEvent) {
        event.preventDefault(); if (!questionDraft) return;
        setBusy("question"); setError("");
        try {
            const { question } = await request<{ question: ResearchQuestion }>("/api/research", questionDraft, "POST");
            if (activeRef.current !== question.id) { setSourceId(""); setSnapshot(null); setSnapshotError(""); setEntryDraft(null); setDocumentId(""); }
            activeRef.current = question.id; setActiveId(question.id); setQuestionDraft(null); setConflict(null); setNotice("Research question saved."); await loadIndex(); await reload(question.id);
        } catch (err) { report(err, "question"); } finally { setBusy(""); }
    }
    async function addSource() {
        if (!documentId || !current) return;
        if (sourceLabelChanged && !window.confirm("Discard the unsaved source label and select another source?")) return;
        const key = `${activeId}:${documentId}`;
        const id = sourceRequests.current.get(key) ?? crypto.randomUUID(); sourceRequests.current.set(key, id);
        setBusy("source"); setError("");
        try {
            const { source } = await request<{ source: ResearchWorkspace["sources"][number] }>("/api/research/sources", { id, questionId: activeId, documentId }, "POST");
            sourceRequests.current.delete(key);
            await reload(); setSourceId(source.id); setSourceTitle(source.title); setSourceVersion(source.version); setNotice("Immutable source snapshot selected.");
        } catch (err) { report(err, "source"); } finally { setBusy(""); }
    }
    async function editSource(remove = false) {
        if (!selected || (remove && !window.confirm("Remove this source from selection? Existing notes and their saved evidence will remain available."))) return;
        setBusy("source"); setError("");
        try {
            const { source } = await request<{ source: ResearchWorkspace["sources"][number] }>("/api/research/sources", { id: sourceId, questionId: activeId, version: sourceVersion, ...(remove ? { remove: true } : { title: sourceTitle }) }, "PATCH");
            setSourceVersion(source.version); setConflict(null); if (remove) setSourceId(""); await reload(); setNotice(remove ? "Source removed; saved evidence retained." : "Source label updated.");
        } catch (err) { report(err, "source"); } finally { setBusy(""); }
    }
    function selectPassage() {
        if (!reader.current || !selected || snapshot?.sourceId !== sourceId) return;
        const startOffset = reader.current.selectionStart, end = reader.current.selectionEnd;
        if (end <= startOffset) { setError("Select a passage in the source reader first. Keyboard selection works too."); return; }
        setEntryDraft((draft) => ({ ...(draft ?? newEntry()), sourceId, kind: draft?.kind === "interpretation" || !draft ? "annotation" : draft.kind,
            quote: snapshot.markdown.slice(startOffset, end), startOffset })); setError(""); setNotice("Passage selected. Add your annotation or claim below.");
    }
    async function saveEntry(event: FormEvent) {
        event.preventDefault(); if (!entryDraft || !current) return;
        setBusy("entry"); setError("");
        try {
            await request("/api/research/entries", { ...entryDraft, questionId: activeId }, "POST");
            setEntryDraft(null); setConflict(null); setNotice(entryDraft.kind === "interpretation" ? "Your interpretation was saved." : "Research note saved with its source evidence."); await reload();
        } catch (err) { report(err, "entry"); } finally { setBusy(""); }
    }
    function editEntry(entry: ResearchEntry) {
        if (entryDraftChanged && !window.confirm("Replace the current unsaved note draft?")) return;
        if (entry.sourceId && !chooseSource(entry.sourceId)) return;
        setEntryDraft({ id: entry.id, kind: entry.kind, text: entry.text, sourceId: entry.sourceId, version: entry.version,
            ...(entry.evidence ? { quote: entry.evidence.quote, startOffset: entry.evidence.startOffset } : {}) });
        setView("notes"); setConflict(null);
    }
    async function deleteEntry(entry: ResearchEntry) {
        if (!window.confirm("Delete this research note? The Library source and other notes will remain unchanged.")) return;
        setBusy("entry"); setError("");
        try { await request("/api/research/entries", { id: entry.id, questionId: activeId, version: entry.version }, "DELETE"); await reload(); setNotice("Research note deleted."); }
        catch (err) { report(err, "entry"); } finally { setBusy(""); }
    }
    function resolveConflict(useSaved: boolean) {
        if (!conflict) return;
        const saved = conflict.current, version = Number(saved.version);
        if (conflict.target === "entry") setEntryDraft((draft) => draft ? { ...draft, version, ...(useSaved ? { text: String(saved.text), kind: saved.kind as ResearchKind, sourceId: (saved.source_id as string | null) ?? null,
            quote: (saved.evidence as ResearchEntry["evidence"])?.quote, startOffset: (saved.evidence as ResearchEntry["evidence"])?.startOffset } : {}) } : draft);
        if (conflict.target === "question") setQuestionDraft((draft) => draft ? { ...draft, version, ...(useSaved ? { title: String(saved.title), question: String(saved.question), status: saved.status as QuestionDraft["status"] } : {}) } : draft);
        if (conflict.target === "source") { setSourceVersion(version); if (useSaved) setSourceTitle(String(saved.title)); }
        setConflict(null); setError(""); setNotice(useSaved ? "Latest saved text loaded." : "Latest version loaded. Review your draft before saving again."); void reload();
    }

    return <WorkspaceShell current="research" title="Research" description="Investigate a question, keep exact source passages and compare what the evidence supports."><div className={styles.page}>
        {error && <div role="alert" className={styles.error}><p>{error}</p>{(!index || (activeId && !current)) && <button disabled={!!busy} onClick={() => void retryLoad()}>Retry loading</button>}</div>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
        {conflict && <section className={styles.conflict}><h2>A newer saved version is available</h2><p className={styles.pre}>{String(conflict.current.text ?? conflict.current.question ?? conflict.current.title ?? "")}</p>
            <div className={styles.actions}><button onClick={() => resolveConflict(false)}>Keep my draft, use latest version</button><button onClick={() => resolveConflict(true)}>Load saved text</button></div></section>}
        <div className={styles.layout}>
            <aside className={styles.sidebar}><h2>Research questions</h2><button disabled={!index?.projects.length || !!busy} onClick={() => {
                if (researchDraftChanged && !window.confirm("Discard your unsaved research edits and start a new question?")) return;
                setEntryDraft(null); setQuestionDraft({ id: crypto.randomUUID(), projectId: index!.projects[0].id, title: "", question: "", status: "active" });
            }}>New question</button>
                {!index ? (!error && <p role="status">Loading research…</p>) : !index.projects.length ? <p>Create an owned project before starting research.</p> : null}
                <ul>{index?.questions.map((question) => <li key={question.id}><button aria-current={activeId === question.id ? "page" : undefined} disabled={!!busy} onClick={() => chooseQuestion(question.id)}><strong>{question.title}</strong><small>{index.projects.find((project) => project.id === question.projectId)?.name}{question.status === "archived" ? " · Archived" : ""}</small></button></li>)}</ul>
            </aside>
            <div className={styles.main}>
                {questionDraft && <form className={`${styles.panel} ${styles.questionForm}`} onSubmit={saveQuestion}><h2>{questionDraft.version ? "Edit question" : "New research question"}</h2><fieldset disabled={!!busy}>
                    <label>Project<Dropdown ariaLabel="Project" className={styles.select} value={questionDraft.projectId} disabled={!!busy || !!questionDraft.version} onChange={(projectId) => setQuestionDraft({ ...questionDraft, projectId })} options={index?.projects.map((project) => ({ value: project.id, label: project.name })) ?? []} /></label>
                    <label>Short title<input autoFocus required maxLength={160} value={questionDraft.title} onChange={(event) => setQuestionDraft({ ...questionDraft, title: event.target.value })} /></label>
                    <label>Research question<textarea required maxLength={8000} rows={3} value={questionDraft.question} onChange={(event) => setQuestionDraft({ ...questionDraft, question: event.target.value })} /></label>
                    {questionDraft.version && <label>Status<Dropdown ariaLabel="Status" className={styles.select} value={questionDraft.status} disabled={!!busy} onChange={(status) => setQuestionDraft({ ...questionDraft, status: status as QuestionDraft["status"] })} options={[{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }]} /></label>}
                    <div className={styles.actions}><button type="submit">{busy === "question" ? "Saving…" : "Save question"}</button><button type="button" onClick={() => setQuestionDraft(null)}>Cancel</button></div>
                </fieldset></form>}
                {activeId && !current ? (!error && <p role="status">Loading question…</p>) : current ? <>
                    <header className={styles.questionHeader}><div><h2>{current.question.title}</h2><p className={styles.pre}>{current.question.question}</p></div><button disabled={!!busy} onClick={editQuestion}>Edit question</button></header>
                    <div className={styles.viewTabs}><button disabled={!!busy} aria-pressed={view === "notes"} onClick={() => setView("notes")}>Sources and notes</button><button disabled={!!busy} aria-pressed={view === "compare"} onClick={() => setView("compare")}>Compare evidence</button></div>
                    {archived && <p className={styles.notice}>This question is archived. Change its status to Active before editing sources or notes.</p>}
                    {view === "compare" ? <ResearchComparison workspace={current} /> : <>
                        <section className={styles.sources}><h3>Selected sources</h3><div className={styles.sourceControls}>
                            <label>Library source<Dropdown ariaLabel="Library source" className={styles.select} value={documentId} disabled={!!busy || archived} onChange={setDocumentId} options={[{ value: "", label: "Choose a source…" }, ...current.documents.map((document) => ({ value: document.id, label: document.title }))]} /></label>
                            <button disabled={!documentId || !!busy || archived} onClick={() => void addSource()}>Select current revision</button>
                        </div><ul className={styles.sourceList}>{current.sources.filter((source) => !source.removedAt).map((source) => <li key={source.id}><button disabled={!!busy} aria-pressed={sourceId === source.id} onClick={() => chooseSource(source.id)}><span>{source.title}</span><small>{source.commitSha.slice(0, 8)}</small></button></li>)}</ul>
                            {!current.sources.some((source) => !source.removedAt) && <p className={styles.hint}>Select a source to begin. Each selection saves the exact revision used for your evidence.</p>}
                        </section>
                        <div className={styles.editorColumns}>
                            <section className={styles.editorPanel}><h3>Source passage reader</h3>{selected ? <>
                                <label>Source label<input maxLength={160} value={sourceTitle} disabled={!!busy || archived || !!selected.removedAt} onChange={(event) => setSourceTitle(event.target.value)} /></label>
                                <div className={styles.actions}><button disabled={!!busy || archived || !!selected.removedAt || !sourceTitle.trim()} onClick={() => void editSource()}>Save label</button><button disabled={!!busy || archived || !!selected.removedAt} onClick={() => void editSource(true)}>Remove source</button><Link href={`/knowledge?${new URLSearchParams({ document: selected.documentId, path: selected.path })}`}>Open Library page</Link></div>
                                <p className={styles.hint}>Reading saved revision {selected.commitSha.slice(0, 8)}. Select text, then choose Use selected passage.</p>
                                {snapshot?.sourceId === sourceId ? <textarea className={styles.reader} ref={reader} aria-label="Immutable source Markdown" value={snapshot.markdown} readOnly spellCheck={false} /> : <p role="status">{snapshotError || "Loading saved source…"}</p>}
                                <button disabled={!!busy || archived || !!selected.removedAt || snapshot?.sourceId !== sourceId} onClick={selectPassage}>Use selected passage</button>
                            </> : <p className={styles.hint}>Choose one of your selected sources to read and annotate it.</p>}</section>
                            <section className={styles.editorPanel}><h3>{entryDraft?.version ? "Edit research note" : "New research note"}</h3>{!entryDraft ? <><p className={styles.hint}>Select a source passage for an annotation or claim, or write your own interpretation.</p><button disabled={!!busy || archived} onClick={() => setEntryDraft(newEntry())}>Write interpretation</button></> : <form onSubmit={saveEntry}><fieldset disabled={!!busy || archived}>
                                <label>Note type<Dropdown ariaLabel="Note type" className={styles.select} value={entryDraft.kind} disabled={!!busy || archived} onChange={(value) => { const kind = value as ResearchKind; setEntryDraft({ ...entryDraft, kind, ...(kind === "interpretation" ? { quote: undefined, startOffset: undefined } : {}) }); }} options={researchKinds.map((kind) => ({ value: kind, label: labels[kind] }))} /></label>
                                {entryDraft.kind === "interpretation" ? <p className={styles.hint}>Your interpretation, kept separate from source evidence.</p> : entryDraft.quote ? <blockquote className={styles.selectedQuote} tabIndex={0} aria-label="Selected source passage">{entryDraft.quote}</blockquote> : <p className={styles.error}>Select a source passage before saving this note type.</p>}
                                <label>Your note<textarea autoFocus required maxLength={20000} rows={7} value={entryDraft.text} onChange={(event) => setEntryDraft({ ...entryDraft, text: event.target.value })} /></label>
                                <div className={styles.actions}><button type="submit" disabled={entryDraft.kind !== "interpretation" && !entryDraft.quote}>{busy === "entry" ? "Saving…" : "Save note"}</button><button type="button" onClick={() => setEntryDraft(null)}>Cancel</button></div>
                            </fieldset></form>}</section>
                        </div>
                        <section className={styles.notes}><h3>Research notes</h3>{!current.entries.length && <p className={styles.hint}>Your annotations, claims and interpretations will appear here.</p>}{current.entries.map((entry) => <article className={styles.note} key={entry.id}>
                            <header><strong>{labels[entry.kind]}</strong><span>{entry.sourceId ? current.sources.find((source) => source.id === entry.sourceId)?.title : "No source claim"}</span></header><EvidenceNote entry={entry} />
                            <div className={styles.actions}><button disabled={!!busy || archived} onClick={() => editEntry(entry)}>Edit note</button><button disabled={!!busy || archived} onClick={() => void deleteEntry(entry)}>Delete note</button></div>
                        </article>)}</section>
                    </>}
                </> : index && !activeId && !questionDraft && <section className={styles.empty}><h2>Start with a question</h2><p>Choose a project and record what you want to investigate. Source-backed claims and personal interpretations stay clearly separated.</p></section>}
            </div>
        </div>
    </div></WorkspaceShell>;
}
