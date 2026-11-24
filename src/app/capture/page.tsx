"use client";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { WorkspaceLink as Link } from "@/components/workspace-link";
import { Download, Inbox, RefreshCw, Trash2 } from "lucide-react";
import { WorkspaceShell } from "@/components/workspace-shell";
import { Dropdown } from "@/components/dropdown";
import { ConfirmModal } from "../home/controls";
import { useUnsavedChanges } from "@/components/use-unsaved-changes";
import type { CaptureExtract, CaptureItem, CapturePreview, CaptureReview, CaptureSource, OcrTier } from "@/lib/capture/types";
import { EXTRACT_LABEL, fillsSourceText, KIND_LABEL, offersGemini, offersPageReading, PAGE_READ_LIMIT, pageSection, readableCapture, sourceStatus, type SourceActivity } from "@/lib/capture/review-source";
import { sharedCapture } from "@/lib/capture/share";
import { blobBase64, photoTitle, preparePhoto } from "@/lib/capture/image-prep";
import type { PdfPages } from "@/lib/capture/pdf-pages";
import { audioFileSeconds, decodeRecording, RECORDING_ACCEPT, recordingBody, transcribeRecording } from "@/lib/capture/audio-pieces";
import { CAPTURE_TEXT_MAX, durationLabel, RECORDING_MAX_FILE_BYTES, RECORDING_MAX_SECONDS } from "@/lib/voice/recording-limits";
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
function fileData(file: Blob) {
    if (file.size > 2 * 1024 * 1024) throw new Error("Choose a PDF no larger than 2 MB.");
    return blobBase64(file).catch(() => { throw new Error("The PDF could not be read."); });
}
const SHARE_ERRORS: Record<string, string> = {
    "too-large": "The shared file is over 9 MB, so it was not added. Share a smaller file.",
    unreadable: "The share could not be read. Try sharing again.", empty: "Nothing was shared.",
};
type PageResult = { markdown: string; model: string } | { failed: string };
// One page, retried once when the reader is busy; a page that still fails is marked in the text instead.
async function readPage(page: Blob): Promise<PageResult> {
    let failed = "The page could not be read.";
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 2_000));
        const response = await fetch("/api/capture/parse-page", { method: "POST", body: page, headers: { "Content-Type": page.type }, cache: "no-store", signal: AbortSignal.timeout(90_000) })
            .catch(() => null);
        if (!response) continue;
        if (response.status === 401) { await clearOfflinePrivateData(); throw new Error("Sign in again to use the capture inbox."); }
        const data = await response.json().catch(() => ({}));
        if (response.ok && typeof data.markdown === "string") return { markdown: data.markdown, model: String(data.model) };
        failed = typeof data.error === "string" ? data.error : failed;
        if (![429, 502, 503, 504].includes(response.status) || /No page reading/.test(failed)) throw new Error(failed);
    }
    return { failed };
}
function captureReview(item: CaptureItem): CaptureReview {
    return { title: item.source.title, text: item.source.text, destination: `captures/${item.source.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "note"}-${item.id.slice(0, 8)}.md`,
        ...(readableCapture(item) ? { sourceText: "" } : {}) };
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
    const [baseline, setBaseline] = useState<CaptureReview>(), [extract, setExtract] = useState<CaptureExtract>();
    const [sourceBusy, setSourceBusy] = useState<SourceActivity>(""), [sourceError, setSourceError] = useState("");
    const [ocrTiers, setOcrTiers] = useState<Record<OcrTier, boolean>>({ free: false, paid: false });
    const [pageReader, setPageReader] = useState<string | null>(null), [pageProgress, setPageProgress] = useState("");
    const [audioMode, setAudioMode] = useState(false), [audioProgress, setAudioProgress] = useState(""), [recording, setRecording] = useState<string | null>(null);
    const reviewHeading = useRef<HTMLHeadingElement>(null), readerHeading = useRef<HTMLHeadingElement>(null), sourceLine = useRef<HTMLParagraphElement>(null);
    const captureId = useRef<string | null>(null), active = useRef(true), locked = useRef(false), privacyRevision = useRef(0);
    const inboxRequest = useRef(0), selectedId = useRef<string | undefined>(undefined), reviewTarget = useRef<string | null>(null), sharedDraft = useRef<CaptureSource | null>(null);
    const stagedShare = useRef<string | null>(null), shareError = useRef<string | null>(null), audioStop = useRef<AbortController | null>(null);
    useUnsavedChanges(() => Boolean(source.title.trim() || source.text.trim() || source.url?.trim() || source.pdf || source.image || note.trim()
        || (selected && !selected.receipt && review && JSON.stringify(review) !== JSON.stringify(baseline))));
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
            setOcrTiers({ free: inbox.ocr?.free === true, paid: inbox.ocr?.paid === true });
            setPageReader(typeof inbox.pageReader === "string" ? inbox.pageReader : null);
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
    const openStaged = useEffectEvent((id: string) => { void action("share", () => loadStaged(id)); });
    useEffect(() => {
        active.current = true;
        // Refs, not locals: Strict Mode runs this twice and the first run clears the query.
        const params = new URLSearchParams(window.location.search);
        sharedDraft.current ??= sharedCapture(params); reviewTarget.current ??= params.get("review");
        stagedShare.current ??= params.get("staged"); shareError.current ??= params.get("shareError");
        if (sharedDraft.current || reviewTarget.current || stagedShare.current || shareError.current) window.history.replaceState(window.history.state, "", window.location.pathname);
        void load().catch(async reason => { if (active.current) setError(message(reason)); try { await refreshOffline(); } catch {} }).finally(() => {
            if (!active.current) return;
            setBusy("");
            const shared = sharedDraft.current; sharedDraft.current = null;
            if (shared) { setSource(shared); setNotice("Shared into the form below. Check it, then save it to the inbox."); }
            const staged = stagedShare.current, failed = shareError.current; stagedShare.current = null; shareError.current = null;
            if (staged) openStaged(staged);
            else if (failed) setError(SHARE_ERRORS[failed] ?? "The share could not be added. Try sharing again.");
        });
        const cleared = () => { privacyRevision.current++; setClearRequest(null); setOffline(undefined); setToken(undefined); setProfileId(undefined); setItems([]); setInboxLoaded(false); setInboxLoading(false); setInboxError(""); setDocuments([]); setSelected(undefined); setReview(undefined); setPreview(undefined); readCopy(undefined); setNote(""); setPdfUrl(undefined); setSource({ kind: "text", title: "", text: "" }); captureId.current = null;
            selectedId.current = undefined; setBaseline(undefined); setExtract(undefined); setSourceBusy(""); setSourceError(""); setOcrTiers({ free: false, paid: false }); setPageReader(null); setPageProgress("");
            audioStop.current?.abort(); setAudioMode(false); setAudioProgress(""); setRecording(null); };
        window.addEventListener(OFFLINE_PRIVACY_EVENT, cleared);
        const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(OFFLINE_PRIVACY_EVENT) : null;
        if (channel) channel.onmessage = cleared;
        return () => { active.current = false; audioStop.current?.abort(); window.removeEventListener(OFFLINE_PRIVACY_EVENT, cleared); channel?.close(); };
    }, [load, refreshOffline]);
    const applyExtract = useCallback((id: string, value: CaptureExtract) => {
        setExtract(value);
        setItems(list => list.map(item => item.id === id ? { ...item, extractStatus: value.status } : item));
        if (fillsSourceText(value)) {
            setReview(current => current && { ...current, sourceText: value.text });
            setBaseline(current => current && { ...current, sourceText: value.text });
            setPreview(undefined);
        }
    }, []);
    const polling = extract?.status === "running" ? selected?.id : undefined;
    useEffect(() => {
        if (!polling) return;
        let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
        const tick = async () => {
            try {
                const result = await request("/api/capture", { action: "extract", profileId, id: polling });
                if (stopped || selectedId.current !== polling) return;
                setSourceError("");
                if (result.extract?.status !== "running") { applyExtract(polling, result.extract); return; }
            } catch (reason) { if (!stopped && selectedId.current === polling) setSourceError(message(reason)); }
            if (!stopped) timer = setTimeout(tick, 3_000);
        };
        timer = setTimeout(tick, 3_000);
        return () => { stopped = true; clearTimeout(timer); };
    }, [polling, profileId, request, applyExtract]);
    const openTarget = useEffectEvent((item: CaptureItem) => choose(item));
    useEffect(() => {
        const target = reviewTarget.current;
        if (!target || !inboxLoaded || !profileId) return;
        reviewTarget.current = null;
        const item = items.find(entry => entry.id === target);
        if (item) openTarget(item); else setError("That capture is not in the inbox. It may have been deleted.");
    }, [inboxLoaded, items, profileId]);
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
        captureId.current = null; setSource({ kind: "text", title: "", text: "" }); setAudioMode(false); setRecording(null); await load(); setNotice("Saved to the inbox. Review the destination before adding it to knowledge.");
    }
    async function transcribeFile(file: File) {
        const revision = privacyRevision.current;
        const current = () => active.current && revision === privacyRevision.current;
        if (file.size > RECORDING_MAX_FILE_BYTES) throw new Error("Choose a recording no larger than 300 MB.");
        setAudioProgress("Checking the recording…");
        const length = await audioFileSeconds(file);
        if (length && length > RECORDING_MAX_SECONDS + 1) throw new Error("This recording is over 2 hours. Trim it or split it first.");
        setAudioProgress("Decoding the recording…");
        const decoded = await decodeRecording(file);
        if (!current()) return;
        const controller = new AbortController();
        audioStop.current = controller;
        const heard = await transcribeRecording(decoded, { signal: controller.signal,
            onProgress: (done, total) => setAudioProgress(`Transcribing piece ${done + 1} of ${total} (${durationLabel(decoded.seconds)} in all)…`) }).finally(() => { audioStop.current = null; });
        if (!current()) return;
        if (!heard.text) throw new Error(heard.stopped ? "Stopped before any speech was transcribed." : heard.failed ?? "No speech was heard in this recording.");
        setAudioProgress("Writing a title and summary…");
        let summary: string | null = null, title = photoTitle(file.name), summaryError = "";
        try {
            const written = await request("/api/capture/recording", { name: file.name.slice(0, 200), seconds: decoded.seconds, transcript: heard.text.slice(0, CAPTURE_TEXT_MAX) });
            summary = written.summary; title = written.title;
        } catch (reason) { summaryError = message(reason); }
        if (!current()) return;
        // A second recording replaces the first one's text; anything typed before the first is kept.
        const notes = recording ? "" : source.text.trim();
        const body = recordingBody([notes, summary?.trim()].filter(Boolean).join("\n\n") || null, heard.text);
        setSource(value => ({ ...value, kind: "text", title: (recording ? "" : value.title.trim()) || title, text: body.text }));
        setRecording(file.name); captureId.current = null;
        const partial = heard.stopped ? ` Stopped after ${heard.done} of ${heard.total} pieces; the text so far is below.`
            : heard.failed ? ` Piece ${heard.done + 1} of ${heard.total} could not be transcribed (${heard.failed}); the text before it is below.` : "";
        setNotice(`Transcribed ${durationLabel(decoded.seconds)} with ${heard.models.join(" and ") || "the transcription model"}.${partial}`
            + (summaryError ? ` The summary could not be written (${summaryError}), so only the transcript is below.` : "")
            + (body.cut ? ` The transcript was cut at ${CAPTURE_TEXT_MAX.toLocaleString("en-AU")} characters, the most a capture holds.` : "")
            + " Check it, then save it to the inbox.");
    }
    function choose(item: CaptureItem) {
        if (selected?.id === item.id) { reviewHeading.current?.focus(); return; }
        if (selected && review && JSON.stringify(review) !== JSON.stringify(baseline) && !window.confirm("Discard your unsaved destination review and open another capture?")) return;
        const base = captureReview(item);
        selectedId.current = item.id;
        setSelected(item); setPreview(undefined); setReview(base); setBaseline(base); setExtract(undefined); setSourceError(""); setSourceBusy("");
        if (readableCapture(item) && !item.receipt) void readSource(item.id);
    }
    async function readSource(id: string, options: { refresh?: boolean; ocr?: OcrTier } = {}) {
        setSourceBusy(options.ocr ?? "read"); setSourceError("");
        try {
            const result = await request("/api/capture", { action: "extract", profileId, id, ...options });
            if (selectedId.current === id) applyExtract(id, result.extract);
        } catch (reason) {
            if (active.current && selectedId.current === id) setSourceError(message(reason));
        } finally { if (active.current && selectedId.current === id) setSourceBusy(""); }
    }
    function refreshSource() {
        if (!selected || !review) return;
        if ((review.sourceText ?? "") !== (baseline?.sourceText ?? "") && !window.confirm("Replace your edited source text with a fresh copy?")) return;
        sourceLine.current?.focus(); void readSource(selected.id, { refresh: true });
    }
    function readWithGemini(tier: OcrTier) {
        if (!selected) return;
        sourceLine.current?.focus(); void readSource(selected.id, { ocr: tier });
    }
    async function readPages() {
        if (!selected || !pageReader) return;
        const id = selected.id;
        sourceLine.current?.focus(); setSourceBusy("pages"); setSourceError(""); setPageProgress("Opening the PDF…");
        let pages: PdfPages | null = null;
        try {
            const response = await fetch(`/api/capture/original?id=${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
            if (!response.ok || response.headers.get("content-type") !== "application/pdf") throw new Error("The PDF original could not be opened. Try again.");
            const bytes = new Uint8Array(await response.arrayBuffer());
            pages = await (await import("@/lib/capture/pdf-pages")).openPdfPages(bytes).catch(() => { throw new Error("This PDF could not be opened in the browser. Use Read with Gemini instead."); });
            if (pages.count > PAGE_READ_LIMIT) throw new Error(`This PDF has ${pages.count} pages. Read pages takes up to ${PAGE_READ_LIMIT}, so use Read with Gemini instead.`);
            const parts: string[] = [];
            let unread = 0, model = pageReader, failed = "";
            for (let number = 1; number <= pages.count; number++) {
                if (!active.current || selectedId.current !== id) return;
                setPageProgress(`Reading page ${number} of ${pages.count}…`);
                const read = await readPage(await pages.render(number));
                if ("failed" in read) { unread++; failed = read.failed; parts.push(pageSection(number, null)); }
                else { model = read.model; parts.push(pageSection(number, read.markdown)); }
            }
            if (unread === pages.count) throw new Error(failed);
            const result = await request("/api/capture", { action: "pages", profileId, id, text: parts.join("\n\n"), pages: pages.count, unread, model });
            if (selectedId.current === id) applyExtract(id, result.extract);
        } catch (reason) {
            if (active.current && selectedId.current === id) setSourceError(message(reason));
        } finally {
            await pages?.close().catch(() => {});
            if (active.current && selectedId.current === id) { setSourceBusy(""); setPageProgress(""); }
        }
    }
    async function loadStaged(id: string) {
        const revision = privacyRevision.current;
        const staged = await request(`/api/capture/staged?id=${encodeURIComponent(id)}`);
        const shared = sharedCapture(new URLSearchParams({ title: staged.title ?? "", text: staged.text ?? "", url: staged.url ?? "" }));
        const left = staged.skipped ? " A shared file was left out: Capture takes photos and PDFs only." : "";
        let next: CaptureSource | null = shared;
        if (staged.file) {
            const response = await fetch(`/api/capture/staged?id=${encodeURIComponent(id)}&file=1`, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
            if (!response.ok) throw new Error("The shared file has expired. Share it again.");
            const file = await response.blob(), name = String(staged.file.name);
            const title = shared?.title || photoTitle(name);
            const text = shared?.kind === "link" ? [shared.text, shared.url].filter(Boolean).join("\n") : shared?.text ?? "";
            if (staged.file.type === "application/pdf") next = { kind: "pdf", title, text, pdf: { name, base64: await fileData(file) } };
            else { const photo = await preparePhoto(file, name); next = { kind: "image", title, text, image: { name: photo.name, base64: photo.base64 } }; }
        }
        if (!next) throw new Error(`Nothing usable was shared.${left}`);
        if (revision !== privacyRevision.current || !active.current) return;
        captureId.current = null; setSource(next); setNotice(`Shared into the form below. Check it, then save it to the inbox.${left}`);
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
            const pdf = response.headers.get("content-type") === "application/pdf";
            // Notes, links and photos have no PDF original; offline copies keep PDFs only.
            if (response.status === 404 || (response.ok && !pdf)) void response.body?.cancel();
            else if (!response.ok) throw new Error("The PDF original could not be downloaded. Your existing copy is unchanged.");
            else {
                const blob = await response.blob();
                if (blob.size > 2 * 1024 * 1024 || await blob.slice(0, 5).text() !== "%PDF-") throw new Error("The original PDF is too large or invalid.");
                downloaded.originalPdf = blob;
            }
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
    return <WorkspaceShell current="capture" title="Capture" description="Collect material, file it, read offline">
        <div className={styles.page}>
        {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
        <div className={styles.columns}>
            <section className={styles.section} aria-labelledby="new-capture"><h2 id="new-capture"><Inbox size={18} /> Add to the inbox</h2>
                <form onSubmit={event => { event.preventDefault(); void action("capture", saveCapture); }}>
                    <div className={styles.captureFields}>
                    <label>Capture type<Dropdown ariaLabel="Capture type" className={styles.dropdown} style={{ flex: "none", width: "100%" }} value={audioMode ? "audio" : source.kind} disabled={!!busy} onChange={value => { if (value === (audioMode ? "audio" : source.kind)) return; setAudioMode(value === "audio"); setRecording(null); setSource({ kind: value === "audio" ? "text" : value as CaptureSource["kind"], title: source.title, text: source.text }); captureId.current = null; }} options={[{ value: "text", label: "Passage or note" }, { value: "link", label: "Link" }, { value: "pdf", label: "PDF" }, { value: "image", label: "Photo" }, { value: "audio", label: "Audio recording" }]} /></label>
                    <label>Title<input required maxLength={200} value={source.title} disabled={!!busy} onChange={event => setSource({ ...source, title: event.target.value })} /></label>
                    </div>
                    {source.kind === "link" && <><label>Source URL<input type="url" required value={source.url ?? ""} disabled={!!busy} onChange={event => setSource({ ...source, url: event.target.value })} /></label><p>The page text is fetched when you review it. Add your own notes below (optional).</p></>}
                    {source.kind === "pdf" && <><label>PDF original (up to 2 MB)<input type="file" accept="application/pdf,.pdf" disabled={!!busy} onChange={event => { const file = event.target.files?.[0]; if (file) void action("pdf", async () => { const revision = privacyRevision.current; const base64 = await fileData(file); if (revision === privacyRevision.current && active.current) setSource(value => ({ ...value, pdf: { name: file.name, base64 } })); }); }} /></label><p>The text is read from the PDF when you review it.</p>{source.pdf && <p>{source.pdf.name} ready to capture.</p>}</>}
                    {source.kind === "image" && <><label>Photo (JPEG, PNG or WebP)<input type="file" accept="image/*" disabled={!!busy} onChange={event => { const file = event.target.files?.[0]; if (file) void action("photo", async () => { const revision = privacyRevision.current; const photo = await preparePhoto(file, file.name); if (revision === privacyRevision.current && active.current) setSource(value => ({ ...value, title: value.title || photoTitle(file.name), image: { name: photo.name, base64: photo.base64 } })); }); }} /></label><p>The photo is resized to 1600 px before it is saved. Its text is read when you review it.</p>
                        {busy === "photo" && <p role="status">Resizing the photo…</p>}
                        {/* eslint-disable-next-line @next/next/no-img-element -- a data URL of the downscaled photo; next/image adds nothing here */}
                        {source.image && <div className={styles.photo}><img src={`data:image/jpeg;base64,${source.image.base64}`} alt="The photo to capture" /><p>{source.image.name} ready to capture ({Math.round(source.image.base64.length * 0.75 / 1024).toLocaleString("en-AU")} KB).</p></div>}</>}
                    {audioMode && <><label>Audio recording (up to 2 hours)<input type="file" accept={RECORDING_ACCEPT} disabled={!!busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void action("audio", () => transcribeFile(file)); }} /></label>
                        <p>The browser cuts it into 3-minute pieces and sends each one to your transcription model, then a title and summary are written. Nothing is saved until you save it to the inbox.</p>
                        {busy === "audio" && <div className={styles.audioStatus}><p role="status">{audioProgress}</p><button type="button" onClick={() => audioStop.current?.abort()}>Stop</button></div>}
                        {recording && busy !== "audio" && <p>{recording} transcribed. Edit the text below if needed.</p>}</>}
                    <label>{audioMode ? "Your notes, then the summary and transcript" : "Passage or notes"}<textarea rows={audioMode && recording ? 12 : 5} maxLength={120000} required={source.kind === "text"} value={source.text} disabled={!!busy} onChange={event => setSource({ ...source, text: event.target.value })} /></label>
                    <button className={styles.primary} disabled={!!busy || !profileId || (source.kind === "pdf" && !source.pdf) || (source.kind === "image" && !source.image) || (audioMode && !recording)}>{busy === "capture" ? "Saving…" : "Save to inbox"}</button>
                    {captureId.current && <button type="button" disabled={!!busy} onClick={() => { captureId.current = null; setNotice("A new capture ID will be used. The existing inbox entry is retained."); }}>Keep this as a separate capture</button>}
                </form>
            </section>
            <section className={styles.section} aria-labelledby="inbox"><div className={styles.heading}><h2 id="inbox">Inbox</h2><button disabled={!!busy} onClick={() => void action("reload", load)}><RefreshCw size={15} /> Reload</button></div>
                {inboxError && <p role="alert" className={styles.error}>{inboxError} {inboxLoaded && "The captures shown may be out of date."}</p>}
                {inboxLoading && <p role="status">{inboxLoaded ? "Refreshing your inbox…" : "Loading your inbox…"}</p>}
                {!inboxLoading && !inboxError && !inboxLoaded && <p>Reload the inbox to view your captures.</p>}
                {!inboxLoading && !inboxError && inboxLoaded && !items.length && <p>No captures yet. Saving here does not add material to knowledge until you review it.</p>}
                {!!items.length && <ul className={styles.list}>{items.map(item => <li key={item.id}>
                    <button disabled={!!busy || sourceBusy === "read" || sourceBusy === "pages"} aria-controls="capture-review" aria-pressed={selected?.id === item.id} onClick={() => choose(item)}><strong>{item.source.title}</strong><span>{KIND_LABEL[item.source.kind] ?? item.source.kind} ·{item.receipt ? item.receipt.indexed ? "Added to knowledge" : "Added to knowledge · Not indexed yet" : "Awaiting review"}{!item.receipt && item.extractStatus ? ` · ${EXTRACT_LABEL[item.extractStatus]}` : ""}</span></button>
                    {item.source.pdf && <a download href={`/api/capture/original?id=${item.id}`}>Download original PDF</a>}
                    {item.source.image && <a download href={`/api/capture/original?id=${item.id}`}>Download original photo</a>}
                </li>)}</ul>}
            </section>
        </div>
        {selected && review && <section id="capture-review" className={styles.section} aria-labelledby="review-capture"><h2 id="review-capture" ref={reviewHeading} tabIndex={-1}>Review destination</h2><p>New captures are private and untrusted. Existing pages are never replaced.</p>
            {selected.receipt ? <><p>Already saved at <Link href={`/knowledge?path=${encodeURIComponent(selected.receipt.path)}`}>{selected.receipt.path}</Link>.</p>
                {!selected.receipt.indexed && <p>Search indexing had not finished when the inbox loaded. Reload to check. If it stays this way, use Reconcile in Knowledge.</p>}</> : <>
                <div className={styles.columns}><label>Title<input value={review.title} disabled={!!busy} onChange={event => { setReview({ ...review, title: event.target.value }); setPreview(undefined); }} /></label><label>New Markdown path<input value={review.destination} disabled={!!busy} onChange={event => { setReview({ ...review, destination: event.target.value }); setPreview(undefined); }} /></label></div>
                <label>Reviewed notes<textarea rows={6} value={review.text} disabled={!!busy} onChange={event => { setReview({ ...review, text: event.target.value }); setPreview(undefined); }} /></label>
                {readableCapture(selected) && <div className={styles.source}>
                    <h3 id="source-text">Source text</h3>
                    <p id="source-status" role="status" ref={sourceLine} tabIndex={-1} className={styles.status}>{sourceBusy === "pages" && pageProgress ? pageProgress : sourceStatus(selected, extract, sourceBusy)}</p>
                    {sourceError && <p role="alert" className={styles.error}>{sourceError}</p>}
                    {!sourceBusy && offersGemini(selected, extract) && <div className={styles.gemini}>
                        {pageReader && offersPageReading(selected, extract) && <div><button type="button" disabled={!!busy} aria-describedby="pages-note" onClick={() => void readPages()}>Read pages (free)</button><p id="pages-note">Each page goes to {pageReader}, a free model, one at a time. Up to {PAGE_READ_LIMIT} pages.</p></div>}
                        {ocrTiers.free && <div><button type="button" disabled={!!busy} aria-describedby="gemini-free-note" onClick={() => readWithGemini("free")}>Read with Gemini (free)</button><p id="gemini-free-note">Google may use free-tier content to improve its products.</p></div>}
                        {ocrTiers.paid && <div><button type="button" disabled={!!busy} aria-describedby="gemini-paid-note" onClick={() => readWithGemini("paid")}>Read with Gemini (paid)</button><p id="gemini-paid-note">Billed to your paid key, about 560 tokens a page.</p></div>}
                        {!ocrTiers.free && !ocrTiers.paid && !(pageReader && offersPageReading(selected, extract)) && <p>Gemini isn&apos;t set up on the server, so scanned pages can&apos;t be read here. Paste the passage instead.</p>}
                    </div>}
                    <textarea rows={10} maxLength={120000} aria-labelledby="source-text" aria-describedby="source-status" value={review.sourceText ?? ""}
                        disabled={!!busy || !!sourceBusy || extract?.status === "running"} onChange={event => { setReview({ ...review, sourceText: event.target.value }); setPreview(undefined); }} />
                    <div className={styles.actions}>
                        <button type="button" disabled={!!busy || !!sourceBusy || extract?.status === "running"} onClick={refreshSource}><RefreshCw size={15} aria-hidden="true" /> {selected.source.kind === "link" ? "Fetch again" : "Read again"}</button>
                        <button type="button" disabled={!!busy || !!sourceBusy || !review.sourceText} onClick={() => { setReview({ ...review, sourceText: "" }); setPreview(undefined); }}>Clear source text</button>
                    </div>
                </div>}
                <button disabled={!!busy} onClick={() => void action("preview", async () => setPreview(await request("/api/capture", { action: "preview", profileId, id: selected.id, review })))}>{busy === "preview" ? "Preparing preview…" : "Preview destination"}</button>
                {preview && <div className={styles.preview}><p>Will save to <strong>{preview.path}</strong>{preview.originalPath ? ` with the original ${preview.originalPath.endsWith(".pdf") ? "PDF" : "photo"} at ${preview.originalPath}.` : "."}</p><pre tabIndex={0} aria-label="Capture preview">{preview.markdown}</pre><button disabled={!!busy} onClick={() => void action("ingest", async () => {
                    const result = await request("/api/capture", { action: "ingest", profileId, ...preview });
                    setPreview(undefined); setSelected(undefined); selectedId.current = undefined; setExtract(undefined); await load(); setNotice(result.warning || "Added to knowledge as a new document. Search indexing finishes in the background.");
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
                    })}>Sync notes to inbox</button><button className={styles.danger} disabled={!!busy} onClick={requestOfflineClear}><Trash2 size={15} aria-hidden="true" /> Clear private offline data</button></div>
                    <ul className={styles.list}>{documents.map(document => { const saved = offline.documents.find(value => value.documentId === document.id); return <li key={document.id}><div><strong>{document.title}</strong><span>{saved ? `Downloaded ${date(saved.downloadedAt)} · ${saved.commitSha.slice(0, 10)}${saved.originalPdf ? " · PDF included" : ""}` : "Not downloaded"}</span></div><button disabled={!!busy || !token} onClick={() => void action("download", () => download(document.id))}>{saved ? "Refresh download" : "Download"}</button>{saved && <button disabled={!!busy} aria-controls="capture-reader" onClick={() => chooseCopy(document.id)}>Read offline copy</button>}</li>; })}</ul>
                    {!documents.length && offline.documents.map(document => <button key={document.documentId} disabled={!!busy} aria-controls="capture-reader" onClick={() => chooseCopy(document.documentId)}>{document.path}</button>)}
                </>}
        </section>
        {opened && <section id="capture-reader" className={styles.section} aria-labelledby="offline-document"><div className={styles.heading}><h2 id="offline-document" ref={readerHeading} tabIndex={-1}>{opened.path}</h2><button disabled={!!busy} onClick={() => chooseCopy(undefined)}>Close reader</button></div>
            <p>Saved {date(opened.downloadedAt)} · revision {opened.commitSha.slice(0, 10)}. External images are not loaded.</p><pre className={styles.reading} tabIndex={0} aria-label="Saved document content">{opened.markdown}</pre>
            {opened.originalPdf && <><button onClick={() => setPdfUrl(URL.createObjectURL(opened.originalPdf!))}>Prepare saved PDF</button>{pdfUrl && <a href={pdfUrl} download="saved-source.pdf">Download saved PDF</a>}</>}
            <label>Note on this saved revision<textarea value={note} disabled={!!busy} maxLength={20000} rows={4} onChange={event => setNote(event.target.value)} /></label><button disabled={!!busy || !note.trim()} onClick={() => void action("note", async () => { await offlineLibrary.queueNote(identity(), opened.documentId, note); setNote(""); await refreshOffline(); setNotice("Note queued on this device. Sync it to the inbox when connected."); })}>{busy === "note" ? "Saving note…" : "Queue note"}</button>
            <button className={styles.danger} disabled={!!busy} onClick={() => { if (!leaveOfflineNote()) return; void action("remove", async () => { await offlineLibrary.remove(identity(), opened.documentId); readCopy(undefined); await refreshOffline(); }); }}><Trash2 size={15} aria-hidden="true" /> Remove offline copy</button>
        </section>}
        </div>
        {clearRequest && <ConfirmModal title="Clear private offline data?"
            body={"Remove downloaded documents and " + (offline?.queue.length ?? 0) + " queued " + (offline?.queue.length === 1 ? "note" : "notes") + " from this device? Unsaved Capture edits and pending Study reviews will also be discarded. Saved source documents will remain unchanged."}
            confirmLabel="Clear offline data" busyText={busy === "clear" ? "Clearing offline data…" : undefined} error={error}
            onConfirm={confirmOfflineClear} onCancel={() => setClearRequest(null)} />}
    </WorkspaceShell>;
}
