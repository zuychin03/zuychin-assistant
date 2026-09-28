"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { WorkspaceLink as Link } from "@/components/workspace-link";
import { Plus, RefreshCw } from "lucide-react";
import { WorkspaceShell } from "@/components/workspace-shell";
import { Dropdown } from "@/components/dropdown";
import { useUnsavedChanges } from "@/components/use-unsaved-changes";
import type { KnowledgeEvidence } from "@/lib/knowledge/revision-types";
import { type StudyCard, type StudyKind, type StudyReport } from "@/lib/study/contracts";
import { clearStudyPending, readStudyPending, writeStudyPending, type PendingReview } from "@/lib/study/pending-review";
import { OFFLINE_PRIVACY_EVENT } from "@/lib/offline/storage";
import { studyDraft } from "@/lib/study/scheduler";
import { studyReviewState } from "./review-attempt";
import { refreshStudySettings, studySettingsChanged } from "./settings-draft";
import styles from "./study.module.css";

interface Snapshot { documentId: string; path: string; commitSha: string; contentHash: string; markdown: string }
interface Draft { id: string; deck: string; kind: StudyKind; prompt: string; answer: string; quote: string; startOffset: number }
const ratings = [[1, "Again", "Could not recall"], [2, "Hard", "Recalled with difficulty"], [3, "Good", "Recalled correctly"], [4, "Easy", "Recalled easily"]] as const;
function localTime(value: string) { return new Date(value).toLocaleString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
function Source({ evidence }: { evidence: KnowledgeEvidence }) {
    return <details className={styles.source}><summary>Saved source passage · {evidence.path}</summary><blockquote>{evidence.quote}</blockquote><p>Revision {evidence.commitSha.slice(0, 12)} · exact passage saved with this card</p><Link href={`/knowledge?document=${encodeURIComponent(evidence.documentId)}`}>Open current document</Link></details>;
}
async function requestApi(path = "/api/study", body?: unknown, signal?: AbortSignal) {
    const response = await fetch(path, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || "Study request failed. Please retry."), { status: response.status });
    return data;
}

export default function StudyPage() {
    const [report, setReport] = useState<StudyReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const lock = useRef(false);
    const generation = useRef(0);
    const privacy = useRef({ epoch: 0, profileId: "", controller: new AbortController() });
    const [tab, setTab] = useState<"review" | "cards" | "mistakes">("review");
    const [deck, setDeck] = useState("");
    const [response, setResponse] = useState("");
    const [attempt, setAttempt] = useState<StudyCard | null>(null);
    const [reflection, setReflection] = useState("");
    const [revealed, setRevealed] = useState(false);
    const [pending, setPending] = useState<PendingReview | null>(null);
    const [conflict, setConflict] = useState(false);
    const [newCard, setNewCard] = useState(false);
    const [documentId, setDocumentId] = useState("");
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const draftBaseline = useRef<Draft | null>(null);
    const editBaseline = useRef<StudyCard | null>(null);
    const [editing, setEditing] = useState<StudyCard | null>(null);
    const [settings, setSettings] = useState({ dailyLimit: 20, timezone: "Australia/Sydney", version: 1 });
    const settingsBaseline = useRef(settings);
    useUnsavedChanges(() => Boolean((!pending && (response.trim() || reflection.trim()))
        || (draft && draftBaseline.current && JSON.stringify(draft) !== JSON.stringify(draftBaseline.current))
        || (editing && editBaseline.current && JSON.stringify(editing) !== JSON.stringify(editBaseline.current))
        || studySettingsChanged(settings, settingsBaseline.current)));

    const clearPrivate = useCallback(() => {
        privacy.current.controller.abort();
        privacy.current = { epoch: privacy.current.epoch + 1, profileId: "", controller: new AbortController() };
        generation.current++;
        const defaults = { dailyLimit: 20, timezone: "Australia/Sydney", version: 1 };
        settingsBaseline.current = defaults; setSettings(defaults);
        try { clearStudyPending(sessionStorage); } catch { /* Storage may be unavailable. */ }
        setReport(null); setPending(null); setAttempt(null); setResponse(""); setReflection(""); setRevealed(false); setConflict(false);
        editBaseline.current = null; draftBaseline.current = null; setEditing(null); setDraft(null); setSnapshot(null); setDocumentId(""); setNewCard(false); setNotice(""); setError(""); setLoading(false);
        setLoadError("Your session changed. Sign in and reload your study records.");
    }, []);
    const api = useCallback(async (path = "/api/study", body?: unknown) => {
        const boundary = privacy.current;
        if (body && !boundary.profileId) throw new Error("Reload your authenticated study records before saving.");
        try {
            const result = await requestApi(path, body, boundary.controller.signal);
            if (boundary !== privacy.current) throw new Error("Your session changed. Reload your study records.");
            return result;
        } catch (cause) {
            if (boundary === privacy.current && cause && typeof cause === "object" && "status" in cause && cause.status === 401) clearPrivate();
            throw cause;
        }
    }, [clearPrivate]);
    const load = useCallback(async () => {
        const current = ++generation.current; setLoading(true);
        try {
            const value: StudyReport = await api();
            if (current !== generation.current) return;
            if (!value.profileId) throw new Error("Your study profile could not be verified.");
            if (privacy.current.profileId && privacy.current.profileId !== value.profileId) clearPrivate();
            privacy.current.profileId = value.profileId;
            const saved = readStudyPending(sessionStorage, value.profileId);
            setPending(saved);
            if (saved) { setResponse(saved.response); setReflection(saved.reflection); setRevealed(true); }
            const previousSettings = settingsBaseline.current;
            settingsBaseline.current = value.settings;
            setSettings(previous => refreshStudySettings(previous, previousSettings, value.settings));
            setReport(value); setLoadError(""); setLoading(false);
        }
        catch (cause) { if (current === generation.current) setLoadError(cause instanceof Error ? cause.message : "Study records could not be loaded."); }
        finally { if (current === generation.current) setLoading(false); }
    }, [api, clearPrivate]);
    useEffect(() => {
        const counter = generation;
        const boundary = privacy;
        if (privacy.current.controller.signal.aborted) privacy.current.controller = new AbortController();
        void load();
        const invalidate = () => clearPrivate();
        const verify = () => { if (!lock.current) void load(); };
        window.addEventListener(OFFLINE_PRIVACY_EVENT, invalidate);
        window.addEventListener("focus", verify);
        const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(OFFLINE_PRIVACY_EVENT) : null;
        if (channel) channel.onmessage = invalidate;
        return () => { counter.current++; boundary.current.controller.abort(); window.removeEventListener(OFFLINE_PRIVACY_EVENT, invalidate); window.removeEventListener("focus", verify); channel?.close(); };
    }, [load, clearPrivate]);

    const { current, changed: attemptChanged } = studyReviewState(report?.cards ?? [], attempt, pending?.cardId, deck, Date.now());
    const blocked = busy || Boolean(loadError) || !report;
    const dailyDone = Boolean(report && report.reviewedToday >= report.settings.dailyLimit);
    const reviewBlocked = blocked || attemptChanged || (dailyDone && !pending);

    async function act(fn: () => Promise<void>) {
        if (lock.current || !privacy.current.profileId) return;
        const boundary = privacy.current;
        lock.current = true; setBusy(true); setError(""); setNotice("");
        try { await fn(); } catch (cause) { if (boundary === privacy.current) setError(cause instanceof Error ? cause.message : "The change was not confirmed. Please retry."); }
        finally { lock.current = false; setBusy(false); }
    }
    function clearAttempt() { setAttempt(null); setResponse(""); setReflection(""); setRevealed(false); setPending(null); setConflict(false); }
    function grade(rating: 1 | 2 | 3 | 4) {
        if (!current || !revealed || !response.trim() || reviewBlocked) return;
        void act(async () => {
            const request = pending || { id: crypto.randomUUID(), cardId: current.id, version: current.version, rating, response: response.trim(), reflection: reflection.trim() };
            writeStudyPending(sessionStorage, privacy.current.profileId, request); setPending(request);
            try {
                const result = await api("/api/study", { action: "review", ...request });
                clearStudyPending(sessionStorage); clearAttempt();
                setNotice(result.reused ? "Your previous review was already saved. It was counted once." : "Review saved. The next review time has been updated.");
                await load();
            } catch (cause) { if (cause && typeof cause === "object" && "status" in cause && cause.status === 409) setConflict(true); throw cause; }
        });
    }
    function replaceCardDraft(textOnly = false) {
        if (!draft || !draftBaseline.current) return true;
        const changed = textOnly ? draft.prompt !== draftBaseline.current.prompt || draft.answer !== draftBaseline.current.answer : JSON.stringify(draft) !== JSON.stringify(draftBaseline.current);
        return !changed || window.confirm(textOnly ? "Discard your edited question and reference answer to use this selection?" : "Discard your unsaved card changes to use this selection?");
    }
    function editCard(card: StudyCard) {
        if (editing?.id === card.id) return;
        if (editing && editBaseline.current && JSON.stringify(editing) !== JSON.stringify(editBaseline.current) && !window.confirm("Discard your unsaved card changes and edit another card?")) return;
        editBaseline.current = card; setEditing({ ...card });
    }
    function choosePassage(quote: string, startOffset: number) {
        if (draft?.startOffset === startOffset && draft.quote === quote) return;
        if (!replaceCardDraft()) return;
        const title = report?.documents.find(doc => doc.id === documentId)?.title || snapshot?.path || "this source";
        const kind = draft?.kind || "recall";
        const next = { id: crypto.randomUUID(), deck: draft?.deck || title, kind, ...studyDraft(kind, quote, title), quote, startOffset };
        draftBaseline.current = { ...next, deck: draftBaseline.current?.deck ?? next.deck }; setDraft(next);
    }
    function snapshotPassages(value: Snapshot) {
        let offset = 0;
        return value.markdown.split(/\n\s*\n/).map(quote => { const startOffset = value.markdown.indexOf(quote, offset); offset = startOffset + quote.length; return { quote, startOffset }; }).filter(part => part.quote.trim().length > 20 && !part.quote.startsWith("---") && part.quote.length <= 20000);
    }

    return <WorkspaceShell current="study" title="Study" description="Practise from your saved sources, then assess your own recall." actions={<button onClick={() => void load()} disabled={loading || busy}><RefreshCw size={15} /> {loading ? "Loading…" : "Refresh"}</button>}>
        <div className={styles.page}>
        {loadError && <div role="alert" className={styles.error}>{loadError} {report && "The records shown may be out of date."}<button onClick={() => void load()} disabled={loading}>Retry loading</button></div>}
        {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
        <nav aria-label="Study views" className={styles.tabs}>{(["review", "cards", "mistakes"] as const).map(value => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{value === "review" ? "Review" : value === "cards" ? "Cards" : "Mistakes"}</button>)}</nav>
        {loading && !report && <p role="status">Loading study records…</p>}
        {report && <>
            <div className={styles.summary}><span>{report.reviewedToday} of {report.settings.dailyLimit} reviews today · {report.settings.timezone}</span><details><summary>Daily limit</summary><form onSubmit={event => { event.preventDefault(); void act(async () => { await api("/api/study", { action: "settings", ...settings }); settingsBaseline.current = settings; setNotice("Study settings saved."); await load(); }); }} className={styles.settings}><label>Reviews per day<input disabled={busy || Boolean(pending)} type="number" min={1} max={200} value={settings.dailyLimit} onChange={event => setSettings({ ...settings, dailyLimit: Number(event.target.value) })} /></label><label>Timezone<input disabled={busy || Boolean(pending)} value={settings.timezone} onChange={event => setSettings({ ...settings, timezone: event.target.value })} /></label><button disabled={blocked || Boolean(pending) || settings.version !== report.settings.version}>Save settings</button>{settings.version !== report.settings.version && <div className={styles.settingsConflict}><p>Settings changed elsewhere. Your edits are kept.</p><div className={styles.actions}><button type="button" disabled={busy} onClick={() => setSettings({ ...settings, version: report.settings.version })}>Keep my edits</button><button type="button" disabled={busy} onClick={() => { settingsBaseline.current = report.settings; setSettings(report.settings); }}>Use saved settings</button></div></div>}</form></details></div>
            {tab === "review" && <section>
                <div className={styles.sectionHead}><h2>Due for review</h2><Dropdown ariaLabel="Review deck" className={styles.select} value={deck} disabled={Boolean(pending) || busy} onChange={value => { if (attempt && (response.trim() || reflection.trim()) && !window.confirm("Discard your current answer and reflection to switch review decks?")) return; setDeck(value); clearAttempt(); }} options={[{ value: "", label: "All decks" }, ...[...new Set(report.cards.map(card => card.deck))].map(name => ({ value: name }))]} /></div>
                <p className={styles.muted}>Write an answer before revealing the reference. Ratings are your self-assessment, not AI grading. FSRS sets your next review time.</p>
                {pending && <p className={styles.warning}>A review request is unconfirmed. Its answer and rating are retained for a safe retry.</p>}
                {pending && !current && <button disabled={blocked} onClick={() => void act(async () => { const result = await api("/api/study", { action: "review", ...pending }); clearStudyPending(sessionStorage); clearAttempt(); setNotice(result.reused ? "Previous review recovered." : "Review saved."); await load(); })}>Recover saved review request</button>}
                {dailyDone && !pending && !attempt ? <div className={styles.empty}><h3>Today’s review limit is reached</h3><p>Return tomorrow in {report.settings.timezone}, or change your daily limit above.</p></div> : current ? <article className={styles.practice} key={current.id}>
                    <p className={styles.muted}>{current.deck} · {current.kind}</p><h3>{current.prompt}</h3>
                    {attemptChanged && <div className={styles.warning} role="status"><p>This card changed or left your review queue. Your answer is kept below. Start the next review to discard this attempt.</p><button disabled={blocked} onClick={clearAttempt}>Start next review</button></div>}
                    {dailyDone && attempt && !pending && !attemptChanged && <div className={styles.warning} role="status"><p>Today’s review limit is reached. Your answer is kept below.</p><button disabled={blocked} onClick={clearAttempt}>Discard this attempt</button></div>}
                    <label>Your answer<textarea rows={5} maxLength={20000} value={response} disabled={reviewBlocked || Boolean(pending)} onChange={event => { if (!attempt) setAttempt(current); setResponse(event.target.value); }} placeholder="Recall the idea or show your reasoning…" /></label>
                    {!revealed ? <button className={styles.primary} disabled={reviewBlocked || !response.trim()} onClick={() => setRevealed(true)}>Reveal reference answer</button> : <>
                        <h4>Reference answer</h4><p className={styles.prose}>{current.answer}</p><Source evidence={current.evidence} />
                        <label>What would you correct or improve? (optional)<textarea rows={3} maxLength={20000} value={reflection} disabled={reviewBlocked || Boolean(pending)} onChange={event => setReflection(event.target.value)} /></label>

                        {pending ? <div className={styles.actions}><button disabled={blocked} onClick={() => grade(pending.rating)}>Retry same review</button>{conflict && <button disabled={blocked} onClick={() => void act(async () => { clearStudyPending(sessionStorage); clearAttempt(); await load(); })}>Load latest card</button>}</div> : <div className={styles.ratings}>{ratings.map(([rating, label, description]) => <button key={rating} disabled={reviewBlocked || !response.trim()} onClick={() => grade(rating)}><strong>{label}</strong><span>{description}</span></button>)}</div>}
                    </>}
                </article> : !pending && <div className={styles.empty}><h3>No cards due now</h3><p>{report.cards.length ? "Your next review will appear when it is due. Refresh to check again." : "Create a card from a saved source to begin."}</p><button onClick={() => { setTab("cards"); setNewCard(true); }}>Create study card</button></div>}
            </section>}
            {tab === "cards" && <section><div className={styles.sectionHead}><h2>Your cards ({report.cards.length})</h2><button disabled={blocked} aria-expanded={newCard} aria-controls="study-card-editor" onClick={() => setNewCard(value => !value)}><Plus size={16} /> {newCard ? "Close new card" : "New card"}</button></div>
                {newCard && <div id="study-card-editor" className={styles.editor}><h3>Create from a saved passage</h3><p className={styles.muted}>Draft prompts use fixed templates. Edit them to make the practice useful for your source.</p><label>Saved source<Dropdown autoFocus ariaLabel="Saved source" className={styles.select} value={documentId} disabled={busy} onChange={value => { if (!replaceCardDraft()) return; setDocumentId(value); setSnapshot(null); setDraft(null); draftBaseline.current = null; }} options={[{ value: "", label: "Choose a document" }, ...report.documents.map(doc => ({ value: doc.id, label: doc.title || doc.path }))]} /></label><button disabled={blocked || !documentId} onClick={() => { if (!replaceCardDraft()) return; void act(async () => { setSnapshot(await api(`/api/study?documentId=${encodeURIComponent(documentId)}`)); setDraft(null); draftBaseline.current = null; }); }}>Load source revision</button>
                    {snapshot && <><p className={styles.muted}>Choose a passage from revision {snapshot.commitSha.slice(0, 12)}.</p><div className={styles.passages}>{snapshotPassages(snapshot).map(part => <button key={part.startOffset} aria-pressed={draft?.startOffset === part.startOffset} onClick={() => choosePassage(part.quote, part.startOffset)} disabled={busy}>{part.quote}</button>)}</div>{!snapshotPassages(snapshot).length && <p>No passage of 21 to 20,000 characters was found in this source.</p>}</>}
                    {draft && snapshot && <form onSubmit={event => { event.preventDefault(); void act(async () => { await api("/api/study", { action: "create", ...draft, documentId: snapshot.documentId, commitSha: snapshot.commitSha, path: snapshot.path }); setDraft(null); setNewCard(false); setSnapshot(null); setNotice("Study card saved."); await load(); }); }}><fieldset disabled={busy}><label>Deck<input maxLength={120} required value={draft.deck} onChange={event => setDraft({ ...draft, deck: event.target.value })} /></label><label>Practice type<Dropdown ariaLabel="Practice type" className={styles.select} value={draft.kind} disabled={busy} onChange={value => { if (!replaceCardDraft(true)) return; const kind = value as StudyKind; const next = { ...draft, kind, ...studyDraft(kind, draft.quote, draft.deck) }; draftBaseline.current = { ...next, deck: draftBaseline.current?.deck ?? next.deck }; setDraft(next); }} options={[{ value: "recall", label: "Recall question" }, { value: "exercise", label: "Worked exercise" }, { value: "explain", label: "Explain in your words" }]} /></label><label>Question or exercise<textarea required rows={3} maxLength={20000} value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} /></label><label>Reference answer<textarea required rows={5} maxLength={20000} value={draft.answer} onChange={event => setDraft({ ...draft, answer: event.target.value })} /></label><p className={styles.muted}>Your answer is editable. The selected source quotation is retained separately.</p><button type="submit" className={styles.primary} disabled={blocked}>Save card</button></fieldset></form>}
                </div>}
                {!report.cards.length && !newCard && <p className={styles.empty}>No study cards yet.</p>}
                {report.cards.map(card => <article className={styles.card} key={card.id}><div className={styles.sectionHead}><div><h3>{card.prompt}</h3><p className={styles.muted}>{card.deck} · {card.kind} · {card.active ? `Due ${localTime(card.schedule.due)}` : "Paused"}</p></div><button disabled={blocked || Boolean(pending)} onClick={() => editCard(card)}>Edit</button></div><Source evidence={card.evidence} />{editing?.id === card.id && <form onSubmit={event => { event.preventDefault(); void act(async () => { await api("/api/study", { action: "edit", id: editing.id, version: editing.version, deck: editing.deck, prompt: editing.prompt, answer: editing.answer, active: editing.active }); setEditing(null); setNotice("Card updated."); await load(); }); }}><fieldset disabled={busy}>{editing.version !== card.version && <div className={styles.warning}><p>This card changed. Your draft is retained below. Compare it with the latest saved version before saving.</p><details><summary>Latest saved version</summary><p>Deck: {card.deck}</p><h4>{card.prompt}</h4><p className={styles.prose}>{card.answer}</p></details><button type="button" onClick={() => setEditing({ ...editing, version: card.version })}>Keep my draft against this version</button><button type="button" onClick={() => setEditing({ ...card })}>Replace draft with latest saved card</button></div>}<label>Deck<input autoFocus required maxLength={120} value={editing.deck} onChange={event => setEditing({ ...editing, deck: event.target.value })} /></label><label>Question<textarea required maxLength={20000} rows={3} value={editing.prompt} onChange={event => setEditing({ ...editing, prompt: event.target.value })} /></label><label>Reference answer<textarea required maxLength={20000} rows={4} value={editing.answer} onChange={event => setEditing({ ...editing, answer: event.target.value })} /></label><label className={styles.check}><input type="checkbox" checked={editing.active} onChange={event => setEditing({ ...editing, active: event.target.checked })} /> Active in review queue</label><div className={styles.actions}><button disabled={blocked || editing.version !== card.version} type="submit">Save changes</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></div></fieldset></form>}</article>)}
            </section>}
            {tab === "mistakes" && <section><h2>Recent learning notes</h2><p className={styles.muted}>Again and Hard ratings from your latest 200 reviews, with the answer and source that were current at the time.</p>{!report.reviews.some(item => item.rating <= 2) && <p className={styles.empty}>No Again or Hard reviews recorded yet.</p>}{report.reviews.filter(item => item.rating <= 2).map(item => <article key={item.id} className={styles.card}><h3>{item.prompt}</h3><p className={styles.muted}>{item.rating === 1 ? "Again" : "Hard"} · {localTime(item.reviewedAt)}</p><h4>Your answer</h4><p className={styles.prose}>{item.response}</p><h4>Reference at review time</h4><p className={styles.prose}>{item.answer}</p>{item.reflection && <><h4>Your correction or reflection</h4><p className={styles.prose}>{item.reflection}</p></>}<Source evidence={item.evidence} /></article>)}</section>}
        </>}
        </div>
    </WorkspaceShell>;
}
