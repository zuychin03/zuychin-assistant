"use client";

import { useEffect, useState } from "react";
import { ArrowRightLeft, AudioLines, Check, Database, FlaskConical, Mic, Trash2, Undo2 } from "lucide-react";
import { Dropdown } from "@/components/dropdown";
import type { CatalogueRow } from "@/lib/ai/catalogue/snapshot";
import type { ModelKind } from "@/lib/ai/catalogue/sources";
import type { SpeechBackupChoice, TranscriptionChoice, TranscriptionOrder } from "@/lib/ai/voice-choices";
import { duration, melbourneDate, melbourneTime, OUTCOME_LABELS, probeSteps, STEP_LABELS } from "./model-format";

// Embedding, speech and transcription rows on /admin#models, with the knowledge switch and the voice choices.

export type TypedKind = Exclude<ModelKind, "chat">;
export type TypedRow = CatalogueRow & { kind: TypedKind; probeDetail: unknown; inCode: boolean; retired: boolean; inUse: boolean; knowledge: boolean; deletable: boolean };
export interface KnowledgeInfo { partitionId: string; providerId: string; modelId: string; label: string; dimension: number }
export interface VoiceInfo { speech: SpeechBackupChoice | null; transcription: TranscriptionChoice; defaultSpeechModel: string }
export interface SwitchJob {
    target: string; providerId: string; modelId: string; dimension: number; status: "running" | "paused" | "done" | "failed";
    done: number; remaining: number | null; rowsLeft: number; startedAt: string; updatedAt: string; error: string | null;
}
interface SwitchPreview {
    target: { providerId: string; modelId: string; dimension: number; nativeDimension: number; partitionId: string; label: string; providerLabel: string; mayTrain: boolean };
    estimate: { rows: number; seconds: number | null; storageBytes: number; large: boolean };
}

export const KIND_LABELS: Record<ModelKind, string> = { chat: "Chat", embedding: "Embeddings", speech: "Speech", transcription: "Transcription" };
const ORDER_OPTIONS: { value: TranscriptionOrder; label: string }[] = [
    { value: "local", label: "On-box only" },
    { value: "local-first", label: "On-box first, then the API model" },
    { value: "api-first", label: "API model first, then on-box" },
    { value: "api", label: "API model only" },
];
const RECENT_SWITCH_MS = 3 * 24 * 60 * 60 * 1000;
const RETIRING_SOON_MS = 30 * 24 * 60 * 60 * 1000;

const isNewTyped = (row: TypedRow) => row.origin === "discovered" && row.approvedAt === null && row.probeStatus === "passed" && !row.missingSince;
const unhealthy = (row: TypedRow) => row.probeStatus === "failed" || !!row.missingSince || row.retired;

/** Lower sorts first: an in-use route that is failing or gone, one that is retiring, new passes, the rest in use, then approved, passed, untested. */
export function typedRank(row: TypedRow): number {
    if (row.inUse && unhealthy(row)) return 0;
    if (row.inUse && row.expiresAt) return 1;
    if (isNewTyped(row)) return 2;
    if (row.inUse) return 3;
    if (row.approvedAt !== null && row.probeStatus === "passed") return 4;
    if (row.probeStatus === "passed") return 5;
    return row.probeStatus === "untested" ? 6 : 7;
}
export const typedNeedsAttention = (row: TypedRow) => typedRank(row) <= 2;

const usable = (row: TypedRow) => row.approvedAt !== null && row.probeStatus === "passed" && !row.missingSince && !row.retired;
const voicesOf = (row: TypedRow) => row.traits?.voices ?? [];

function roughTime(seconds: number): string {
    if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
    if (seconds < 90 * 60) return `${Math.round(seconds / 60)} minutes`;
    return `${(seconds / 3600).toFixed(1)} hours`;
}
function megabytes(bytes: number): string {
    return bytes < 1024 * 1024 ? "under 1 MB" : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function facts(row: TypedRow): string {
    const traits = row.traits ?? {};
    if (row.kind === "embedding") {
        return [
            row.dimension ? `${row.dimension.toLocaleString()} dimensions` : "Size unknown",
            traits.needsInputType ? "needs query and passage types" : traits.acceptsInputType ? "query and passage types" : "one input type",
            traits.truncatable ? "smaller sizes work" : "fixed size",
            traits.batch ? "batches" : "one text per call",
            `${duration(row.probeChatMs)} per call`,
        ].join(" · ");
    }
    if (row.kind === "speech") {
        const voices = voicesOf(row).length;
        const format = traits.audioFormat ? `${traits.audioFormat.toUpperCase()}${traits.sampleRate ? ` at ${traits.sampleRate.toLocaleString()} Hz` : ""}` : "Format unknown";
        return [voices ? `${voices} ${voices === 1 ? "voice" : "voices"}` : "No voice list", format, `first audio in ${duration(traits.firstAudioMs ?? row.probeChatMs)}`].join(" · ");
    }
    const accuracy = typeof traits.accuracy === "number" ? `${Math.round(traits.accuracy * 100)}% of words heard` : "Accuracy not measured";
    return [`${duration(row.probeChatMs)} for the 4-second test clip`, accuracy].join(" · ");
}

function expiryText(row: TypedRow): string | null {
    if (row.retired) return "Its provider stopped serving it.";
    if (!row.expiresAt) return null;
    const source = row.expiresSource === "listing" ? "the provider's list" : "a web check";
    return `Retires on ${melbourneDate(row.expiresAt)}, from ${source}.`;
}

function SwitchDialog({ row, busy, onStart, onCancel }: { row: TypedRow; busy: boolean; onStart: (dimension: number) => void; onCancel: () => void }) {
    const native = row.dimension ?? 0;
    const resizable = !!row.traits?.truncatable || row.providerId.startsWith("gemini");
    const [size, setSize] = useState(String(native));
    const [preview, setPreview] = useState<SwitchPreview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const wanted = Number(size);

    useEffect(() => {
        const controller = new AbortController();
        const timer = window.setTimeout(async () => {
            setLoading(true);
            const params = new URLSearchParams({ providerId: row.providerId, modelId: row.modelId, ...(resizable && size ? { dimension: size } : {}) });
            try {
                const response = await fetch(`/api/admin/embedding/switch?${params}`, { cache: "no-store", signal: controller.signal });
                const body = await response.json().catch(() => null) as { preview?: SwitchPreview | { error: string } | null; error?: string } | null;
                if (controller.signal.aborted) return;
                const result = body?.preview;
                if (!response.ok || !result) { setPreview(null); setError(body?.error ?? "The estimate could not be loaded. Please retry."); }
                else if ("error" in result) { setPreview(null); setError(result.error); }
                else { setPreview(result); setError(null); }
            } catch {
                if (!controller.signal.aborted) { setPreview(null); setError("The estimate could not be loaded. Please retry."); }
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        }, 400);
        return () => { window.clearTimeout(timer); controller.abort(); };
    }, [row.providerId, row.modelId, resizable, size]);

    const estimate = preview?.estimate;
    return (
        <div className="notice" role="alert" style={styles.dialog}>
            <span><strong style={styles.term}>Switch the knowledge store to {row.label}?</strong></span>
            {resizable && <label style={styles.size}>
                <span>Size (1 to {native.toLocaleString()} dimensions)</span>
                <input className="field" style={styles.sizeInput} type="number" inputMode="numeric" min={1} max={native} step={1} value={size} onChange={(event) => setSize(event.target.value)} />
            </label>}
            {loading && <span className="meta" role="status">Counting stored rows…</span>}
            {!loading && error && <span>{error}</span>}
            {!loading && estimate && preview && <>
                <span>
                    {estimate.rows.toLocaleString()} stored {estimate.rows === 1 ? "row is" : "rows are"} re-embedded on the server{estimate.seconds !== null ? `, which takes about ${roughTime(estimate.seconds)}` : ""}.
                    The new vectors take about {megabytes(estimate.storageBytes)}. Search keeps using the current model until every row is done, then switches on its own.
                    If the provider&apos;s daily limit runs out, the job pauses and carries on later.
                </span>
                {estimate.large && <span>Vectors above 4,096 dimensions need more space and make every search slower.</span>}
                {preview.target.mayTrain && <span>{preview.target.providerLabel} may use what it is sent to train its models. Every stored note, memory and message goes to it once, then each new one.</span>}
            </>}
            <div style={styles.actions}>
                <button type="button" className="btn" data-tone="primary" disabled={busy || loading || !preview || !Number.isInteger(wanted) || wanted < 1}
                    onClick={() => onStart(preview?.target.dimension ?? native)}>
                    <ArrowRightLeft size={14} aria-hidden="true" />Start switch
                </button>
                <button type="button" className="btn" onClick={onCancel}>Cancel</button>
            </div>
        </div>
    );
}

export function TypedEntry({ row, providerLabel, voice, locked, busy, switchRunning, confirming, confirmingDelete, onTest, onApproval, onDelete, onCancel, onCancelDelete, onStartSwitch, onUseBackup, onUseTranscription }: {
    row: TypedRow;
    providerLabel: string;
    voice: VoiceInfo;
    locked: boolean;
    busy: boolean;
    switchRunning: boolean;
    confirming: boolean;
    confirmingDelete: boolean;
    onTest: () => void;
    onApproval: (approved: boolean) => void;
    onDelete: () => void;
    onCancel: () => void;
    onCancelDelete: () => void;
    onStartSwitch: (dimension: number) => void;
    onUseBackup: (voiceName: string | null) => void;
    onUseTranscription: () => void;
}) {
    const [switching, setSwitching] = useState(false);
    const isBackupVoice = row.kind === "speech" && voice.speech?.providerId === row.providerId && voice.speech.modelId === row.modelId;
    const isTranscriber = row.kind === "transcription" && voice.transcription.order !== "local" && voice.transcription.providerId === row.providerId && voice.transcription.modelId === row.modelId;
    const voices = voicesOf(row);
    const savedVoice = isBackupVoice ? voice.speech?.voice ?? null : null;
    const [voiceName, setVoiceName] = useState<string>(() => savedVoice ?? row.traits?.defaultVoice ?? voices[0] ?? "");
    const stepList = probeSteps(row.probeDetail);
    const expiry = expiryText(row);
    const [now] = useState(() => Date.now());
    const soon = !!row.expiresAt && new Date(row.expiresAt).getTime() - now < RETIRING_SOON_MS;
    const statusPill = isNewTyped(row) ? <span className="pill">New</span>
        : row.probeStatus === "passed" ? <span className="pill" data-tone="success">Passed</span>
            : row.probeStatus === "failed" ? <span className="pill" data-tone="danger">Failed</span>
                : row.probeStatus === "inconclusive" ? <span className="pill" data-tone="warning">Inconclusive</span>
                    : <span className="pill">Untested</span>;
    const embeddingBackup = row.kind === "embedding" && row.inUse && !row.knowledge;
    const canSwitch = row.kind === "embedding" && usable(row) && !row.inUse && !!row.dimension;
    const voiceChanged = isBackupVoice && voices.length > 0 && voiceName !== savedVoice;

    return (
        <div className="row" style={styles.row}>
            <div style={styles.rowTop}>
                <div style={styles.rowText}>
                    <span className="row-title">{row.label}</span>
                    <span className="meta" style={styles.id}>{row.modelId}</span>
                </div>
                <div style={styles.actions}>
                    <button type="button" className="btn" disabled={locked || busy} onClick={onTest} aria-label={`Test ${row.label}${row.free ? "" : ", a paid model"}`}>
                        <FlaskConical size={14} aria-hidden="true" />{row.free ? "Test" : "Test (paid)"}
                    </button>
                    {!row.knowledge && (row.approvedAt
                        ? <button type="button" className="btn" disabled={busy} onClick={() => onApproval(false)} aria-label={`Unapprove ${row.label}`}><Undo2 size={14} aria-hidden="true" />Unapprove</button>
                        : <button type="button" className="btn" disabled={busy || row.retired} onClick={() => onApproval(true)} aria-label={`Approve ${row.label}`}><Check size={14} aria-hidden="true" />Approve</button>)}
                    {canSwitch && <button type="button" className="btn" disabled={busy || switchRunning} aria-expanded={switching} onClick={() => setSwitching(!switching)}
                        title={switchRunning ? "A switch is already running." : undefined}>
                        <Database size={14} aria-hidden="true" />Switch knowledge to this
                    </button>}
                    {row.kind === "speech" && usable(row) && !isBackupVoice && <button type="button" className="btn" disabled={busy} onClick={() => onUseBackup(voices.length ? voiceName : null)}>
                        <AudioLines size={14} aria-hidden="true" />Use as backup voice
                    </button>}
                    {row.kind === "transcription" && usable(row) && !isTranscriber && <button type="button" className="btn" disabled={busy} onClick={onUseTranscription}>
                        <Mic size={14} aria-hidden="true" />Use for transcription
                    </button>}
                    {row.deletable && <button type="button" className="btn" data-tone="danger" disabled={busy} onClick={onDelete} aria-label={`Delete ${row.label} for good`}><Trash2 size={14} aria-hidden="true" />Delete</button>}
                </div>
            </div>
            <div style={styles.pills}>
                <span className="pill">{row.free ? "Free" : "Paid"}</span>
                {statusPill}
                {row.knowledge && <span className="pill" data-tone="success"><Database size={12} aria-hidden="true" />Knowledge model</span>}
                {row.inUse && !row.knowledge && <span className="pill" data-tone="success">In use</span>}
                {(embeddingBackup || isBackupVoice) && <span className="pill">Backup</span>}
                {row.spaceOf && <span className="pill" title={`Gives the same vectors as ${row.spaceOf}`}>Same space</span>}
                {row.expiresAt && !row.retired && <span className="pill" data-tone={soon ? "warning" : undefined}>Retires {melbourneDate(row.expiresAt)}</span>}
                {row.retired ? <span className="pill" data-tone="danger">Gone</span> : row.missingSince && <span className="pill" data-tone="danger">Missing</span>}
                {row.mayTrain === true && <span className="pill" data-tone="warning">May train</span>}
                {row.inCode ? <span className="pill">Built in</span> : row.approvedAt && <span className="pill" data-tone="success"><Check size={12} aria-hidden="true" />Approved</span>}
            </div>
            {confirming && <div className="notice" role="alert" style={styles.dialog}>
                <span>This test sends a few short requests to a paid model, which costs a little. Run it?</span>
                <div style={styles.actions}>
                    <button type="button" className="btn" data-tone="primary" disabled={locked || busy} onClick={onTest}>Run paid test</button>
                    <button type="button" className="btn" onClick={onCancel}>Cancel</button>
                </div>
            </div>}
            {confirmingDelete && <div className="notice" data-tone="danger" role="alert" style={styles.dialog}>
                <span>Delete {row.label} for good? This cannot be undone. Its provider no longer lists it, so the daily check adds it back only if it returns.</span>
                <div style={styles.actions}>
                    <button type="button" className="btn" data-tone="danger" disabled={busy} onClick={onDelete}>Delete for good</button>
                    <button type="button" className="btn" onClick={onCancelDelete}>Cancel</button>
                </div>
            </div>}
            {switching && canSwitch && <SwitchDialog row={row} busy={busy || switchRunning} onCancel={() => setSwitching(false)} onStart={(dimension) => { setSwitching(false); onStartSwitch(dimension); }} />}
            <p className="meta" style={styles.line}>{facts(row)}.</p>
            {row.kind === "speech" && voices.length > 0 && (isBackupVoice || usable(row)) && <div style={styles.voice}>
                <label style={styles.voiceLabel}>
                    <span>{isBackupVoice ? "Backup voice" : "Voice to use"}</span>
                    <Dropdown ariaLabel={`Voice for ${row.label}`} className="field" style={styles.voiceSelect} value={voiceName} onChange={setVoiceName} disabled={busy}
                        options={voices.map((name) => ({ value: name, label: name }))} />
                </label>
                {voiceChanged && <button type="button" className="btn" disabled={busy} onClick={() => onUseBackup(voiceName)}>Save voice</button>}
            </div>}
            <p className="meta" style={styles.line}>
                {row.probedAt
                    ? `Tested ${melbourneTime(row.probedAt)}.`
                    : row.missingSince ? "Not tested."
                        : row.free ? "Not tested yet. The daily check tests it when its turn comes." : "Not tested. Paid models are tested only when you press Test."}
                {row.inUse && row.free ? " In use, so the daily check tests it every run." : ""}
                {row.missingSince ? ` Missing from the provider's list since ${melbourneTime(row.missingSince)}.` : ""}
                {expiry ? ` ${expiry}` : ""}
                {row.traits?.lookupUrl && <> <a href={row.traits.lookupUrl} target="_blank" rel="noopener noreferrer" style={styles.source}>Source</a></>}
            </p>
            <details style={styles.details}>
                <summary className="link-btn" style={styles.detailsToggle}>Details</summary>
                <dl className="facts" style={styles.facts}>
                    <div><dt>Provider</dt><dd>{providerLabel}</dd></div>
                    {row.spaceOf && <div><dt>Same space as</dt><dd style={styles.id}>{row.spaceOf}</dd></div>}
                    <div><dt>First seen / last listed</dt><dd>{melbourneTime(row.firstSeenAt)} / {melbourneTime(row.lastSeenAt)}</dd></div>
                    {row.expiryCheckedAt && <div><dt>Retirement checked</dt><dd>{melbourneTime(row.expiryCheckedAt)}</dd></div>}
                </dl>
                {stepList.length > 0 && <ul style={styles.steps}>
                    {stepList.map((step) => (
                        <li key={step.name} className="meta">
                            <strong style={styles.term}>{STEP_LABELS[step.name] ?? step.name}:</strong> {OUTCOME_LABELS[step.outcome] ?? step.outcome}
                            {step.httpStatus !== null ? `, HTTP ${step.httpStatus}` : ""}{step.ms !== null && step.outcome !== "skipped" ? `, ${duration(step.ms)}` : ""}
                            {step.detail ? <span style={styles.stepDetail}>{step.detail}</span> : null}
                        </li>
                    ))}
                </ul>}
                {row.description && <p className="meta" style={styles.line}>{row.description}</p>}
            </details>
        </div>
    );
}

export function KnowledgeStrip({ knowledge, providerLabel, job, jobLabel }: { knowledge: KnowledgeInfo | null; providerLabel: string; job: SwitchJob | null; jobLabel: string | null }) {
    const [now] = useState(() => Date.now());
    const recent = job?.status === "done" && now - new Date(job.updatedAt).getTime() < RECENT_SWITCH_MS;
    const total = job ? job.done + job.rowsLeft : 0;
    const name = jobLabel ?? job?.modelId ?? "";
    return (
        <div className="inset" style={styles.strip}>
            <p className="meta" style={styles.line}>
                <strong style={styles.term}>Knowledge model:</strong>{" "}
                {knowledge ? `${knowledge.label} on ${providerLabel}, ${knowledge.dimension.toLocaleString()} dimensions. Notes, memories and messages are searched with it.` : "Unknown. The saved knowledge model is not in the catalogue."}
            </p>
            {job?.status === "running" && <>
                <p className="meta" style={styles.line} role="status">Switching to {name} at {job.dimension.toLocaleString()} dimensions: {job.done.toLocaleString()} rows done, {job.rowsLeft.toLocaleString()} left. Search keeps using the current model until it finishes.</p>
                <div style={styles.track} role="progressbar" aria-label="Knowledge switch progress" aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={job.done}>
                    <div style={{ ...styles.fill, width: `${total ? Math.round((job.done / total) * 100) : 0}%` }} />
                </div>
            </>}
            {job?.status === "paused" && <p className="meta" style={styles.line} role="status">
                The switch to {name} is paused{job.error ? `: ${job.error}` : "."} It carries on by itself after 10 minutes, when the daily check runs or this panel is opened. {job.rowsLeft.toLocaleString()} rows left.
            </p>}
            {job?.status === "failed" && <p className="meta" style={styles.line} role="alert">
                The switch to {name} stopped{job.error ? `: ${job.error}` : "."} Search still uses the current model. Starting the switch again carries on from where it stopped.
            </p>}
            {recent && <p className="meta" style={styles.line}>Switched to {name} on {melbourneTime(job!.updatedAt)}.</p>}
        </div>
    );
}

export function SpeechStrip({ voice, label, busy, onUseDefault }: { voice: VoiceInfo; label: string | null; busy: boolean; onUseDefault: () => void }) {
    return (
        <div className="inset" style={styles.strip}>
            <p className="meta" style={styles.line}>
                <strong style={styles.term}>Backup voice:</strong>{" "}
                {voice.speech
                    ? `${label ?? voice.speech.modelId}${voice.speech.voice ? `, voice ${voice.speech.voice}` : ""}. It speaks when the on-box voice is off or fails. Free only uses it only when it is free, and falls back to the free Gemini key otherwise.`
                    : `the default Gemini voice (${voice.defaultSpeechModel}). Choose Use as backup voice on a tested, approved model to change it.`}
            </p>
            {voice.speech && <div style={styles.actions}><button type="button" className="btn" disabled={busy} onClick={onUseDefault}>Use the default</button></div>}
        </div>
    );
}

export function TranscriptionStrip({ voice, label, busy, onOrder }: { voice: VoiceInfo; label: string | null; busy: boolean; onOrder: (order: TranscriptionOrder) => void }) {
    const chosen = !!voice.transcription.modelId;
    return (
        <div className="inset" style={styles.strip}>
            <label style={styles.voiceLabel}>
                <span>Transcription order</span>
                <Dropdown ariaLabel="Transcription order" className="field" style={styles.orderSelect} value={voice.transcription.order} onChange={(value) => onOrder(value as TranscriptionOrder)}
                    disabled={busy || !chosen} options={ORDER_OPTIONS} />
            </label>
            <p className="meta" style={styles.line}>
                {chosen
                    ? `API model: ${label ?? voice.transcription.modelId}. Free only sends audio to it only when it is free. The chat model hears the audio itself when every step fails.`
                    : "Choose Use for transcription on a tested, approved model to turn on the API orders. Until then the on-box service transcribes."}
            </p>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    row: { display: "flex", flexDirection: "column", gap: 6, padding: "12px 0" },
    rowTop: { display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "8px 12px" },
    rowText: { display: "flex", flexDirection: "column", gap: 2, flex: "1 1 240px", minWidth: 0 },
    id: { fontFamily: "var(--font-mono)", fontSize: 12, overflowWrap: "anywhere" },
    actions: { display: "flex", flexWrap: "wrap", gap: 8 },
    pills: { display: "flex", flexWrap: "wrap", gap: 6 },
    line: { margin: 0 },
    term: { color: "var(--ink)", fontWeight: 600 },
    dialog: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, marginTop: 2 },
    size: { display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "var(--muted)" },
    sizeInput: { width: 140, padding: "0 10px", background: "var(--surface)" },
    voice: { display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 8 },
    voiceLabel: { display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "var(--muted)", minWidth: 0 },
    voiceSelect: { minWidth: 180, padding: "0 10px", background: "var(--surface)" },
    orderSelect: { width: "min(100%, 320px)", padding: "0 10px", background: "var(--surface)" },
    strip: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 },
    track: { height: 6, borderRadius: 999, background: "var(--line)", overflow: "hidden" },
    fill: { height: "100%", background: "var(--accent)", transition: "width 300ms ease" },
    details: { marginTop: 2 },
    detailsToggle: { width: "fit-content" },
    source: { color: "var(--ink-2)", textDecoration: "underline", textUnderlineOffset: 2 },
    facts: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", gap: "12px 24px", margin: "10px 0", lineHeight: 1.45, fontVariantNumeric: "tabular-nums" },
    steps: { display: "flex", flexDirection: "column", gap: 4, margin: "4px 0 8px", padding: 0, listStyle: "none" },
    stepDetail: { display: "block", overflowWrap: "anywhere" },
};
