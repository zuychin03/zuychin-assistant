"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { WorkspaceLink as Link } from "@/components/workspace-link";
import { Download, Inbox, RefreshCw } from "lucide-react";
import { WorkspaceShell } from "@/components/workspace-shell";
import { Dropdown } from "@/components/dropdown";
import { ConfirmModal } from "../home/controls";
import { useUnsavedChanges } from "@/components/use-unsaved-changes";
import type { CaptureItem, CapturePreview, CaptureReview, CaptureSource } from "@/lib/capture/types";
import type { OfflineDocument, OfflineState, OfflineToken } from "@/lib/offline/library";
import { clearConfirmedOfflinePrivateData, clearOfflinePrivateData, offlineLibrary, OFFLINE_PRIVACY_EVENT } from "@/lib/offline/storage";
import styles from "./capture.module.css";

async function httpRequest(path: string, body?: unknown) {
    const response = await fetch(path, { method: body ? "POST" : "GET", cache: "no-store", headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
    if (response.status === 401 || (response.redirected && new URL(response.url).pathname === "/login")) {
        await clearOfflinePrivateData(); throw new Error("Sign in again to use the capture inbox.");
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The request failed. Your draft is still here.");
    return data;
}
const message = (error: unknown) => error instanceof Error ? error.message : "The update failed. Your existing data is unchanged.";
const date = (value: string | null) => value ? new Date(value).toLocaleString("en-AU", { timeZone: "Australia/Sydney", day: "2-digit", month: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }) : "Not yet synchronised";
function fileData(file: File) {
    if (file.size > 2 * 1024 * 1024) throw new Error("Choose a PDF no larger than 2 MB.");
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("The PDF could not be read.")); reader.readAsDataURL(file);
    });
}
function captureReview(item: CaptureItem): CaptureReview {
    return { title: item.source.title, text: item.source.text, destination: `captures/${item.source.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "note"}-${item.id.slice(0, 8)}.md` };
}
export default function CapturePage() {
    const [items, setItems] = useState<CaptureItem[]>([]), [documents, setDocuments] = useState<{ id: string; title: string; path: string }[]>([]);
    const [inboxLoading, setInboxLoading] = useState(true), [inboxLoaded, setInboxLoaded] = useState(false), [inboxError, setInboxError] = useState("");
    const [offline, setOffline] = useState<OfflineState>(), [token, setToken] = useState<OfflineToken>(), [profileId, setProfileId] = useState<string>();
    const [source, setSource] = useState<CaptureSource>({ kind: "text", title: "", text: "" });
    const [selected, setSelected] = useState<CaptureItem>(), [review, setReview] = useState<CaptureReview>(), [preview, setPreview] = useState<CapturePreview>();
    const [reading, setReading] = useState<string>(), [note, setNote] = useState("");
    const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState("loading");
    const [withPdf, setWithPdf] = useState(false), [pdfUrl, setPdfUrl] = useState<string>();
    const [clearRequest, setClearRequest] = useState<{ epoch: string } | null>(null);
    const reviewHeading = useRef<HTMLHeadingElement>(null), readerHeading = useRef<HTMLHeadingElement>(null);
    const captureId = useRef<string | null>(null), active = useRef(true), locked = useRef(false), privacyRevision = useRef(0);
    const inboxRequest = useRef(0);
    useUnsavedChanges(() => Boolean(source.title.trim() || source.text.trim() || source.url?.trim() || source.pdf || note.trim()
        || (selected && !selected.receipt && review && JSON.stringify(review) !== JSON.stringify(captureReview(selected)))));
    const request = useCallback(async (path: string, body?: unknown) => {
        const revision = privacyRevision.current;
        const result = await httpRequest(path, body);
        if (!active.current || revision !== privacyRevision.current) throw new Error("The account changed. Reopen the inbox.");
        return result;
    }, []);
    const refreshOffline = useCallback(async () => { const revision = privacyRevision.current; const value = await offlineLibrary.read(); if (active.current && revision === privacyRevision.current) setOffline(value); return value; }, []);
    const load = useCallback(async () => {
        const revision = privacyRevision.current;
        const requestId = ++inboxRequest.current;
        const current = () => active.current && revision === privacyRevision.current && requestId === inboxRequest.current;
        let inboxRead = false;
        setInboxLoading(true); setInboxError("");
        try {
            const before = await offlineLibrary.read().catch(() => null);
            if (!current()) return;
            const inbox = await request("/api/capture");
            if (!current()) return;
            if (!Array.isArray(inbox.items) || typeof inbox.profileId !== "string") throw new Error("The inbox response could not be read. Reload to try again.");
            setProfileId(inbox.profileId); setItems(inbox.items); setDocuments(inbox.documents ?? []);
            setInboxLoaded(true); inboxRead = true;
            if (before) {
                const identity = await offlineLibrary.bindProfile(inbox.profileId, before.epoch);
                if (!current()) return;
                setToken(identity); await refreshOffline();
            } else { setToken(undefined); setError("Offline storage is unavailable in this browser. The online capture inbox remains available."); }
        } catch (reason) {
            if (!active.current || requestId !== inboxRequest.current) return;
            if (revision !== privacyRevision.current) throw reason;
            if (inboxRead) throw reason;
            setInboxError(message(reason));
            try { await refreshOffline(); } catch { /* Online retry remains available. */ }
        } finally { if (current()) setInboxLoading(false); }
    }, [refreshOffline, request]);
    useEffect(() => {
        active.current = true;
        void load().catch(async reason => { if (active.current) setError(message(reason)); try { await refreshOffline(); } catch {} }).finally(() => { if (active.current) setBusy(""); });
        const cleared = () => { privacyRevision.current++; setClearRequest(null); setOffline(undefined); setToken(undefined); setProfileId(undefined); setItems([]); setInboxLoaded(false); setInboxLoading(false); setInboxError(""); setDocuments([]); setSelected(undefined); setReview(undefined); setPreview(undefined); readCopy(undefined); setNote(""); setPdfUrl(undefined); setSource({ kind: "text", title: "", text: "" }); captureId.current = null; };
        window.addEventListener(OFFLINE_PRIVACY_EVENT, cleared);
        const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(OFFLINE_PRIVACY_EVENT) : null;
        if (channel) channel.onmessage = cleared;
        return () => { active.current = false; window.removeEventListener(OFFLINE_PRIVACY_EVENT, cleared); channel?.close(); };
    }, [load, refreshOffline]);
    useEffect(() => { if (selected) reviewHeading.current?.focus(); }, [selected]);
    useEffect(() => { if (reading) readerHeading.current?.focus(); }, [reading]);
    useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);
    async function action(name: string, run: () => Promise<void>) {
        if (locked.current) return; locked.current = true; setBusy(name); setError(""); setNotice("");
        try { await run(); } catch (reason) { if (active.current) setError(message(reason)); }
        finally { locked.current = false; if (active.current) setBusy(""); }
    }
    const identity = () => {
        const value = token ?? (offline?.profileId ? { profileId: offline.profileId, epoch: offline.epoch } : undefined);
        if (!value) throw new Error("Reconnect and sign in before enabling offline storage.");
        return value;
    };
    async function saveCapture() {
        captureId.current ??= crypto.randomUUID();
        await request("/api/capture", { action: "capture", profileId, id: captureId.current, source });
        captureId.current = null; setSource({ kind: "text", title: "", text: "" }); await load(); setNotice("Saved to the inbox. Review the destination before adding it to knowledge.");
    }
    function choose(item: CaptureItem) {
        if (selected?.id === item.id) { reviewHeading.current?.focus(); return; }
        if (selected && review && JSON.stringify(review) !== JSON.stringify(captureReview(selected)) && !window.confirm("Discard your unsaved destination review and open another capture?")) return;
        setSelected(item); setPreview(undefined); setReview(captureReview(item));
    }
    function readCopy(documentId?: string) { setReading(documentId); setPdfUrl(undefined); setNote(""); }
    function leaveOfflineNote() { return !note.trim() || window.confirm("Discard this unqueued note? The saved document will remain unchanged."); }
    function chooseCopy(documentId?: string) {
        if (documentId === reading) { readerHeading.current?.focus(); return; }
        if (leaveOfflineNote()) readCopy(documentId);
    }
    async function download(documentId: string) {
        const current = identity();
        const downloaded: OfflineDocument = await request(`/api/capture/download?documentId=${encodeURIComponent(documentId)}`);
        if (withPdf && downloaded.originalCaptureId) {
            const response = await fetch(`/api/capture/original?id=${encodeURIComponent(downloaded.originalCaptureId)}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
            if (!response.ok || response.headers.get("content-type") !== "application/pdf") throw new Error("The PDF original could not be downloaded. Your existing copy is unchanged.");
            const blob = await response.blob();
            if (blob.size > 2 * 1024 * 1024 || await blob.slice(0, 5).text() !== "%PDF-") throw new Error("The original PDF is too large or invalid.");
            downloaded.originalPdf = blob;
        }
        await offlineLibrary.download(current, downloaded);
        await navigator.serviceWorker?.register("/sw.js");
        await refreshOffline(); setNotice("Downloaded for this device. Refresh explicitly to get a newer revision.");
    }
    function requestOfflineClear() {
        if (busy || !offline?.enabled) return;
        setError("");
        setClearRequest({ epoch: offline.epoch });
    }
    async function confirmOfflineClear() {
        if (!clearRequest) return;
        await action("clear", async () => {
            await clearConfirmedOfflinePrivateData(clearRequest.epoch);
            setClearRequest(null);
            setNotice("Private offline data cleared. Reload the inbox to enable downloads again.");
        });
    }
    const opened = offline?.documents.find(document => document.documentId === reading);
    return <WorkspaceShell current="capture" title="Capture & offline" description="Collect material, review where it belongs, and take selected documents with you.">
        <div className={styles.page}>
        {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
        <div className={styles.columns}>
            <section className={styles.section} aria-labelledby="new-capture"><h2 id="new-capture"><Inbox size={18} /> Add to the inbox</h2>
                <form onSubmit={event => { event.preventDefault(); void action("capture", saveCapture); }}>
                    <div className={styles.captureFields}>
                    <label>Capture type<Dropdown ariaLabel="Capture type" className={styles.dropdown} style={{ flex: "none", width: "100%" }} value={source.kind} disabled={!!busy} onChange={value => { if (value === source.kind) return; setSource({ kind: value as CaptureSource["kind"], title: source.title, text: source.text }); captureId.current = null; }} options={[{ value: "text", label: "Passage or note" }, { value: "link", label: "Link" }, { value: "pdf", label: "PDF" }]} /></label>
                    <label>Title<input required maxLength={200} value={source.title} disabled={!!busy} onChange={event => setSource({ ...source, title: event.target.value })} /></label>
                    </div>
                    {source.kind === "link" && <><label>Source URL<input type="url" required value={source.url ?? ""} disabled={!!busy} onChange={event => setSource({ ...source, url: event.target.value })} /></label><p>The link is saved as a reference. Paste the passage you want to keep below.</p></>}
                    {source.kind === "pdf" && <><label>PDF original (up to 2 MB)<input type="file" accept="application/pdf,.pdf" disabled={!!busy} onChange={event => { const file = event.target.files?.[0]; if (file) void action("pdf", async () => { const revision = privacyRevision.current; const base64 = await fileData(file); if (revision === privacyRevision.current && active.current) setSource(value => ({ ...value, pdf: { name: file.name, base64 } })); }); }} /></label><p>The original PDF is kept with your note. Text is not extracted automatically; add the passage or notes you have reviewed.</p>{source.pdf && <p>{source.pdf.name} ready to capture.</p>}</>}
                    <label>Passage or notes<textarea rows={5} maxLength={120000} required={source.kind === "text"} value={source.text} disabled={!!busy} onChange={event => setSource({ ...source, text: event.target.value })} /></label>
                    <button className={styles.primary} disabled={!!busy || !profileId || (source.kind === "pdf" && !source.pdf)}>{busy === "capture" ? "Saving…" : "Save to inbox"}</button>
                    {captureId.current && <button type="button" disabled={!!busy} onClick={() => { captureId.current = null; setNotice("A new capture ID will be used. The existing inbox entry is retained."); }}>Keep this as a separate capture</button>}
                </form>
            </section>
            <section className={styles.section} aria-labelledby="inbox"><div className={styles.heading}><h2 id="inbox">Inbox</h2><button disabled={!!busy} onClick={() => void action("reload", load)}><RefreshCw size={15} /> Reload</button></div>
                {inboxError && <p role="alert" className={styles.error}>{inboxError} {inboxLoaded && "The captures shown may be out of date."}</p>}
                {inboxLoading && <p role="status">{inboxLoaded ? "Refreshing your inbox…" : "Loading your inbox…"}</p>}
                {!inboxLoading && !inboxError && !inboxLoaded && <p>Reload the inbox to view your captures.</p>}
                {!inboxLoading && !inboxError && inboxLoaded && !items.length && <p>No captures yet. Saving here does not add material to knowledge until you review it.</p>}
                {!!items.length && <ul className={styles.list}>{items.map(item => <li key={item.id}>
                    <button disabled={!!busy} aria-controls="capture-review" aria-pressed={selected?.id === item.id} onClick={() => choose(item)}><strong>{item.source.title}</strong><span>{item.source.kind.replace("_", " ")} · {item.receipt ? "Added to knowledge" : "Awaiting review"}</span></button>
                    {item.source.pdf && <a download href={`/api/capture/original?id=${item.id}`}>Download original PDF</a>}
                </li>)}</ul>}
            </section>
        </div>
        {selected && review && <section id="capture-review" className={styles.section} aria-labelledby="review-capture"><h2 id="review-capture" ref={reviewHeading} tabIndex={-1}>Review destination</h2><p>New captures are private and untrusted. Existing pages are never replaced.</p>
            {selected.receipt ? <p>Already saved at <Link href={`/knowledge?path=${encodeURIComponent(selected.receipt.path)}`}>{selected.receipt.path}</Link>.</p> : <>
                <div className={styles.columns}><label>Title<input value={review.title} disabled={!!busy} onChange={event => { setReview({ ...review, title: event.target.value }); setPreview(undefined); }} /></label><label>New Markdown path<input value={review.destination} disabled={!!busy} onChange={event => { setReview({ ...review, destination: event.target.value }); setPreview(undefined); }} /></label></div>
                <label>Reviewed notes<textarea rows={6} value={review.text} disabled={!!busy} onChange={event => { setReview({ ...review, text: event.target.value }); setPreview(undefined); }} /></label>
                <button disabled={!!busy} onClick={() => void action("preview", async () => setPreview(await request("/api/capture", { action: "preview", profileId, id: selected.id, review })))}>{busy === "preview" ? "Preparing preview…" : "Preview destination"}</button>
                {preview && <div className={styles.preview}><p>Will save to <strong>{preview.path}</strong>{preview.originalPath ? ` with the original PDF at ${preview.originalPath}.` : "."}</p><pre tabIndex={0} aria-label="Capture preview">{preview.markdown}</pre><button disabled={!!busy} onClick={() => void action("ingest", async () => {
                    const result = await request("/api/capture", { action: "ingest", profileId, ...preview });
                    setPreview(undefined); setSelected(undefined); await load(); setNotice(result.warning || "Added to knowledge as a new document.");
                })}>{busy === "ingest" ? "Adding…" : "Add reviewed capture to knowledge"}</button></div>}
            </>}
        </section>}
        <section className={styles.section} aria-labelledby="offline-library"><div className={styles.heading}><h2 id="offline-library"><Download size={18} /> Offline reading</h2><a data-native-navigation className={styles.linkButton} href="/offline.html">Open offline reader</a></div>
            {!offline?.enabled ? <><p>Enable this only on a trusted device. Selected private documents and queued notes will be kept in this browser until removed or you sign out.</p><button disabled={!!busy || !token} onClick={() => void action("enable", async () => { await offlineLibrary.enable(identity()); await navigator.serviceWorker?.register("/sw.js"); await refreshOffline(); })}>Enable on this device</button></>
                : <><p>Last note sync: {date(offline.lastSync)}. {offline.queue.length} queued {offline.queue.length === 1 ? "note" : "notes"}. Downloads update only when you choose Download or Refresh.</p>
                    <label className={styles.check}><input type="checkbox" checked={withPdf} onChange={event => setWithPdf(event.target.checked)} /> Include the original PDF when available (up to 2 MB per file)</label>
                    <div className={styles.actions}><button disabled={!!busy || !token || !offline.queue.length} onClick={() => void action("sync", async () => {
                        const current = identity(); const count = await offlineLibrary.sync(current, async entry => { const result = await request("/api/capture", { action: "capture", profileId: current.profileId, id: entry.id, source: entry.source }); return { id: result.item.id }; });
                        await load(); setNotice(`${count} notes sent to the inbox for review. Source documents were not changed.`);
                    })}>Sync notes to inbox</button><button disabled={!!busy} onClick={requestOfflineClear}>Clear private offline data</button></div>
                    <ul className={styles.list}>{documents.map(document => { const saved = offline.documents.find(value => value.documentId === document.id); return <li key={document.id}><div><strong>{document.title}</strong><span>{saved ? `Downloaded ${date(saved.downloadedAt)} · ${saved.commitSha.slice(0, 10)}${saved.originalPdf ? " · PDF included" : ""}` : "Not downloaded"}</span></div><button disabled={!!busy || !token} onClick={() => void action("download", () => download(document.id))}>{saved ? "Refresh download" : "Download"}</button>{saved && <button disabled={!!busy} aria-controls="capture-reader" onClick={() => chooseCopy(document.id)}>Read offline copy</button>}</li>; })}</ul>
                    {!documents.length && offline.documents.map(document => <button key={document.documentId} disabled={!!busy} aria-controls="capture-reader" onClick={() => chooseCopy(document.documentId)}>{document.path}</button>)}
                </>}
        </section>
        {opened && <section id="capture-reader" className={styles.section} aria-labelledby="offline-document"><div className={styles.heading}><h2 id="offline-document" ref={readerHeading} tabIndex={-1}>{opened.path}</h2><button disabled={!!busy} onClick={() => chooseCopy(undefined)}>Close reader</button></div>
            <p>Saved {date(opened.downloadedAt)} · revision {opened.commitSha.slice(0, 10)}. External images are not loaded.</p><pre className={styles.reading} tabIndex={0} aria-label="Saved document content">{opened.markdown}</pre>
            {opened.originalPdf && <><button onClick={() => setPdfUrl(URL.createObjectURL(opened.originalPdf!))}>Prepare saved PDF</button>{pdfUrl && <a href={pdfUrl} download="saved-source.pdf">Download saved PDF</a>}</>}
            <label>Note on this saved revision<textarea value={note} disabled={!!busy} maxLength={20000} rows={4} onChange={event => setNote(event.target.value)} /></label><button disabled={!!busy || !note.trim()} onClick={() => void action("note", async () => { await offlineLibrary.queueNote(identity(), opened.documentId, note); setNote(""); await refreshOffline(); setNotice("Note queued on this device. Sync it to the inbox when connected."); })}>{busy === "note" ? "Saving note…" : "Queue note"}</button>
            <button disabled={!!busy} onClick={() => { if (!leaveOfflineNote()) return; void action("remove", async () => { await offlineLibrary.remove(identity(), opened.documentId); readCopy(undefined); await refreshOffline(); }); }}>Remove offline copy</button>
        </section>}
        </div>
        {clearRequest && <ConfirmModal title="Clear private offline data?"
            body={"Remove downloaded documents and " + (offline?.queue.length ?? 0) + " queued " + (offline?.queue.length === 1 ? "note" : "notes") + " from this device? Unsaved Capture edits and pending Study reviews will also be discarded. Saved source documents will remain unchanged."}
            confirmLabel="Clear offline data" busyText={busy === "clear" ? "Clearing offline data…" : undefined} error={error}
            onConfirm={confirmOfflineClear} onCancel={() => setClearRequest(null)} />}
    </WorkspaceShell>;
}
