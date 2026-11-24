"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, EyeOff, FlaskConical, Layers, Pencil, RefreshCw, RotateCcw, Search, Trash2, Undo2 } from "lucide-react";
import { Dropdown } from "@/components/dropdown";
import type { CatalogueRow } from "@/lib/ai/catalogue/snapshot";
import type { DiscoveryRunRecord } from "@/lib/ai/catalogue/store";
import type { AdminModelInfo } from "@/lib/ai/models/admin-view";
import type { ModelSpeed } from "@/lib/ai/models/stats";
import type { PurposeTag } from "@/lib/ai/models/tags";
import type { ModelKind } from "@/lib/ai/catalogue/sources";
import type { TranscriptionOrder } from "@/lib/ai/voice-choices";
import { duration, keyOf, melbourneDate, melbourneTime, OUTCOME_LABELS, probeSteps, STEP_LABELS } from "./model-format";
import { KIND_LABELS, KnowledgeStrip, SpeechStrip, TranscriptionStrip, TypedEntry, typedNeedsAttention, typedRank, type KnowledgeInfo, type SwitchJob, type TypedRow, type VoiceInfo } from "./typed-models";

type ModelRow = CatalogueRow & AdminModelInfo & { kind: "chat"; probeDetail: unknown; inCode: boolean; retired: boolean };
type AnyRow = ModelRow | TypedRow;
interface ProviderEntry { id: string; label: string; available: boolean; discovery: { include: string; pricing: string } | null }
interface TagEntry { tag: PurposeTag; label: string; meaning: string }
interface CataloguePayload {
    storage: string;
    profileStorage: string;
    statsStorage: string;
    settings: { enabled: boolean; maxProbes: number; lookups: number; types?: { enabled: boolean; stored: boolean } };
    knowledge?: KnowledgeInfo | null;
    voice?: VoiceInfo;
    tags: TagEntry[];
    providers: ProviderEntry[];
    rows: AnyRow[];
    runs: DiscoveryRunRecord[];
}
type Filter = "all" | "attention" | "review" | "picker" | "hidden" | "removed" | "inuse";
interface Notice { tone?: "danger"; text: string }
interface ProfileText { description: string; strengths: string; weaknesses: string }
interface ProfileSave { tags?: PurposeTag[]; profile?: { description: string; strengths: string[]; weaknesses: string[]; developer: string | null; params: string | null; sources: { title: string; url: string }[] }; approveModel?: boolean }

const FILTERS: { value: Filter; label: string }[] = [
    { value: "all", label: "All models" }, { value: "attention", label: "Needs attention" }, { value: "review", label: "Profile to review" },
    { value: "picker", label: "In the picker" }, { value: "hidden", label: "Not in the picker" }, { value: "removed", label: "Removed" },
];
const TYPED_FILTERS: { value: Filter; label: string }[] = [{ value: "all", label: "All models" }, { value: "attention", label: "Needs attention" }, { value: "inuse", label: "In use" }];
const KINDS: readonly ModelKind[] = ["chat", "embedding", "speech", "transcription"];
const TYPES_MIGRATION = "scripts/migrations/v7-model-types.sql";
const POLL_MS = 4000;
const PROFILE_MIGRATION = "scripts/migrations/v7-model-awareness.sql";

function tokens(value: number | null): string {
    if (value === null) return "Unknown";
    return value >= 1000 ? `${Math.round(value / 1000).toLocaleString()}K` : value.toLocaleString();
}
const yesNo = (value: boolean | null) => value === null ? "Unknown" : value ? "Yes" : "No";
const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
const sameTags = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((tag) => b.includes(tag));

const inPicker = (row: ModelRow) => !row.removedAt && (row.inCode || row.approvedAt !== null || row.probeStatus === "passed");
const isNew = (row: ModelRow) => row.origin === "discovered" && row.approvedAt === null && row.probeStatus === "passed" && !row.missingSince;
const draftReady = (row: ModelRow) => !row.removedAt && row.profile?.draftStatus === "ready" && row.profile.draft !== null;

/** Lower sorts first: New or a draft to review, Missing, Failing, Untested paid, then the rest, removed last. */
function rank(row: ModelRow): number {
    if (row.removedAt) return 7;
    if (isNew(row) || draftReady(row)) return 0;
    if (row.missingSince && inPicker(row)) return 1;
    if (row.probeStatus === "failed" && (row.inCode || row.approvedAt !== null)) return 2;
    if (!row.inCode && !row.free && row.probeStatus === "untested") return 3;
    if (inPicker(row)) return 4;
    return row.probeStatus === "untested" ? 5 : 6;
}

function speedText(speed: ModelSpeed): string {
    if (speed.firstAnswerMs === null) return "Speed not measured yet.";
    const tier = speed.tier.charAt(0).toUpperCase() + speed.tier.slice(1);
    if (speed.source === "test") return `${tier}: first answer in ${duration(speed.firstAnswerMs)} in its last test.`;
    const parts = [`first answer ${duration(speed.firstAnswerMs)} (median of ${speed.samples} calls)`];
    if (speed.tokensPerSecond !== null) parts.push(`${Math.round(speed.tokensPerSecond)} tokens/s`);
    if (speed.successRate !== null) parts.push(`${Math.round(speed.successRate * 100)}% of ${speed.calls} calls succeeded`);
    return `${tier}: ${parts.join(", ")}, last 14 days.`;
}

function runSummary(run: DiscoveryRunRecord): string {
    const summary = run.summary;
    const count = (key: string) => Array.isArray(summary[key]) ? (summary[key] as unknown[]).length : 0;
    if (run.status === "running") return "Still running. New tests are saved when it finishes.";
    if (run.status === "failed") return `Failed: ${typeof summary.error === "string" ? summary.error : "no reason was recorded."}`;
    const took = typeof summary.durationMs === "number" ? ` in ${duration(summary.durationMs)}` : "";
    const drafted = count("drafted") ? `, ${count("drafted")} profiles drafted` : "";
    return `Finished${took}: ${count("added")} added, ${count("passed")} passed, ${count("newlyMissing")} newly missing, ${count("failedRetests")} failed a re-test${drafted}.`;
}

function listingFailed(run: DiscoveryRunRecord | undefined, providerId: string): boolean {
    const providers = run?.summary.providers;
    const entry = providers && typeof providers === "object" ? (providers as Record<string, { listing?: unknown }>)[providerId] : undefined;
    return entry?.listing === "failed";
}

function ProfileBlock({ row, tagList, open, onToggle, selected, setSelected, text, setText, editing, setEditing, busy, onSaveTags, onApproveProfile }: {
    row: ModelRow;
    tagList: TagEntry[];
    open: boolean;
    onToggle: (open: boolean) => void;
    selected: PurposeTag[];
    setSelected: (tags: PurposeTag[]) => void;
    text: ProfileText;
    setText: (text: ProfileText) => void;
    editing: boolean;
    setEditing: (editing: boolean) => void;
    busy: boolean;
    onSaveTags: () => void;
    onApproveProfile: () => void;
}) {
    const info = row.profile;
    const draft = draftReady(row) ? info!.draft! : null;
    const approved = info?.approvedAt && info.profile ? info.profile : null;
    const shown = draft ?? approved;
    const sources = shown?.sources ?? [];
    const canApproveProfile = (row.inCode || row.approvedAt !== null) && (draft !== null || editing);
    const tagsChanged = !sameTags(selected, row.tags);
    const approvesAll = !row.inCode && row.approvedAt === null;
    const status = info?.draftStatus === "pending" ? "Looking up sources and drafting a profile."
        : draft ? `Draft from ${draft.basis === "sibling" ? `the approved profile of ${draft.siblingOf ?? "the same model on another provider"}` : "a lookup"}${info?.draftedAt ? ` on ${melbourneDate(info.draftedAt)}` : ""}. Review it, then approve.`
            : info?.draftStatus === "failed" ? `Lookup failed${info.lookupAttempts ? ` (${info.lookupAttempts} of 3 tries)` : ""}: ${info.draftError ?? "no reason was recorded."}`
                : approved ? `Profile approved ${melbourneDate(info!.approvedAt!)}.`
                    : "No profile yet. Look up drafts one from free sources.";
    const tagSource = !row.tags.length ? "none saved yet" : row.tagsSource === "seed" ? "current tags seeded" : row.tagsSource === "owner" ? "current tags chosen by you" : row.tagsSource === "derived" ? "current tags read off the built-in notes" : "current tags from a lookup";
    const id = `profile-${keyOf(row).replace(/[^a-zA-Z0-9]/g, "-")}`;

    return (
        <details style={styles.details} open={open} onToggle={(event) => onToggle((event.currentTarget as HTMLDetailsElement).open)}>
            <summary className="link-btn" style={styles.detailsToggle}>Profile and tags</summary>
            <div style={styles.profile} id={id}>
                <p className="meta" style={styles.line} role="status">{status}</p>
                <fieldset style={styles.fieldset}>
                    <legend className="meta" style={styles.legend}>Good for <span style={styles.legendNote}>({tagSource})</span></legend>
                    <div style={styles.chips}>
                        {tagList.map(({ tag, label, meaning }) => {
                            const blocked = row.blockedTags[tag];
                            const pressed = selected.includes(tag);
                            return <button key={tag} type="button" className="chip" aria-pressed={pressed} disabled={!!blocked || busy}
                                title={blocked ?? meaning} aria-label={blocked ? `${label}: ${blocked}` : `${label}: ${meaning}`}
                                onClick={() => setSelected(pressed ? selected.filter((entry) => entry !== tag) : [...selected, tag])}>
                                {pressed && <Check size={12} aria-hidden="true" />}{label}
                            </button>;
                        })}
                    </div>
                </fieldset>
                {draft && draft.suggestedTags.length > 0 && <p className="meta" style={styles.line}>
                    Suggested: {draft.suggestedTags.map((tag) => `${tagList.find((entry) => entry.tag === tag)?.label ?? tag}${draft.tagReasons[tag] ? ` (${draft.tagReasons[tag]})` : ""}`).join("; ")}.
                    {!sameTags(selected, draft.suggestedTags) && <> <button type="button" className="link-btn" style={styles.inlineLink} disabled={busy} onClick={() => setSelected([...draft.suggestedTags])}>Use the suggested tags</button></>}
                </p>}
                {editing ? <div style={styles.editor}>
                    <label style={styles.field}><span>Description</span><textarea className="field" rows={3} maxLength={300} value={text.description} onChange={(event) => setText({ ...text, description: event.target.value })} /></label>
                    <label style={styles.field}><span>Strengths, one per line</span><textarea className="field" rows={4} value={text.strengths} onChange={(event) => setText({ ...text, strengths: event.target.value })} /></label>
                    <label style={styles.field}><span>Weaknesses, one per line</span><textarea className="field" rows={4} value={text.weaknesses} onChange={(event) => setText({ ...text, weaknesses: event.target.value })} /></label>
                </div> : shown && <div style={styles.profileText}>
                    <p style={styles.description}>{shown.description}</p>
                    {(shown.developer || shown.params) && <p className="meta" style={styles.line}>{[shown.developer, shown.params].filter(Boolean).join(" · ")}</p>}
                    {shown.strengths.length > 0 && <p className="meta" style={styles.line}><strong style={styles.term}>Strong at:</strong> {shown.strengths.join("; ")}</p>}
                    {shown.weaknesses.length > 0 && <p className="meta" style={styles.line}><strong style={styles.term}>Weak at:</strong> {shown.weaknesses.join("; ")}</p>}
                </div>}
                {row.measured.length > 0 && <p className="meta" style={styles.line}><strong style={styles.term}>Measured:</strong> {row.measured.join("; ")}.</p>}
                {sources.length > 0 && <p className="meta" style={styles.line}><strong style={styles.term}>Sources:</strong>{" "}
                    {sources.map((source, index) => <span key={source.url}>{index ? ", " : ""}<a href={source.url} target="_blank" rel="noopener noreferrer" style={styles.source}>{source.title}</a></span>)}
                </p>}
                {draft && draft.sourcesTried.some((entry) => !entry.ok) && <p className="meta" style={styles.line}>No answer from: {draft.sourcesTried.filter((entry) => !entry.ok).map((entry) => entry.name).join(", ")}.</p>}
                {approvesAll && <p className="meta" style={styles.line}>The Approve button above saves the model, {draft ? "this profile " : ""}and the ticked tags in one step.</p>}
                {info?.vaultError && <p className="meta" style={styles.line}>The vault page could not be saved: {info.vaultError}</p>}
                {info?.vaultPath && !info.vaultError && <p className="meta" style={styles.line}>Saved to the vault as {info.vaultPath}.</p>}
                <div style={styles.actions}>
                    {shown && <button type="button" className="btn" disabled={busy} onClick={() => setEditing(!editing)} aria-pressed={editing}><Pencil size={14} aria-hidden="true" />{editing ? "Stop editing" : "Edit"}</button>}
                    {canApproveProfile && <button type="button" className="btn" data-tone="primary" disabled={busy || !selected.length || !text.description.trim()} onClick={onApproveProfile}><Check size={14} aria-hidden="true" />Approve profile</button>}
                    {tagsChanged && !canApproveProfile && !approvesAll && <button type="button" className="btn" disabled={busy} onClick={onSaveTags}>Save tags</button>}
                </div>
            </div>
        </details>
    );
}

function ModelEntry({ row, tagList, profilesReady, locked, busy, confirming, confirmingDelete, onTest, onLookup, onApprove, onUnapprove, onSave, onCancel, onRemove, onDelete, onCancelDelete }: {
    row: ModelRow;
    tagList: TagEntry[];
    profilesReady: boolean;
    locked: boolean;
    busy: boolean;
    confirming: boolean;
    confirmingDelete: boolean;
    onTest: () => void;
    onLookup: () => void;
    onApprove: (save: ProfileSave | null) => void;
    onUnapprove: () => void;
    onSave: (save: ProfileSave, done: string) => void;
    onCancel: () => void;
    onRemove: (removed: boolean) => void;
    onDelete: () => void;
    onCancelDelete: () => void;
}) {
    const draft = draftReady(row) ? row.profile!.draft! : null;
    const approvedProfile = row.profile?.approvedAt ? row.profile.profile : null;
    const base = draft ?? approvedProfile;
    const [selected, setSelected] = useState<PurposeTag[]>(() => draft && row.tagsSource === "derived" ? [...draft.suggestedTags] : [...row.tags]);
    const [text, setText] = useState<ProfileText>(() => ({ description: base?.description ?? "", strengths: base?.strengths.join("\n") ?? "", weaknesses: base?.weaknesses.join("\n") ?? "" }));
    const [editing, setEditing] = useState(false);
    const [open, setOpen] = useState(() => draftReady(row));
    const stepList = probeSteps(row.probeDetail);
    const statusPill = isNew(row) ? <span className="pill">New</span>
        : row.probeStatus === "passed" ? <span className="pill" data-tone="success">Passed</span>
            : row.probeStatus === "failed" ? <span className="pill" data-tone="danger">Failed</span>
                : row.probeStatus === "inconclusive" ? <span className="pill" data-tone="warning">Inconclusive</span>
                    : <span className="pill">Untested</span>;
    const profilePill = row.profile?.draftStatus === "pending" ? <span className="pill">Looking up</span>
        : draft ? <span className="pill">Draft ready</span>
            : row.profile?.draftStatus === "failed" ? <span className="pill" data-tone="danger">Lookup failed</span>
                : approvedProfile ? <span className="pill" data-tone="success">Profile approved</span> : null;
    const tagNames = row.tags.map((tag) => tagList.find((entry) => entry.tag === tag)?.label ?? tag);
    const lookedUp = !!(row.profile?.draft || row.profile?.profile || row.profile?.draftStatus === "failed");

    const profilePayload = (): ProfileSave["profile"] | undefined => {
        if (!base) return undefined;
        const description = text.description.trim();
        if (!description) return undefined;
        return { description, strengths: lines(text.strengths), weaknesses: lines(text.weaknesses), developer: base.developer, params: base.params, sources: base.sources };
    };
    const approve = () => {
        if (!profilesReady) { onApprove(null); return; }
        if (!selected.length) { setOpen(true); onApprove({ approveModel: true }); return; }
        onApprove({ tags: selected, approveModel: true, ...(draft || editing ? { profile: profilePayload() } : {}) });
    };

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
                    {profilesReady && !row.removedAt && <button type="button" className="btn" disabled={locked || busy || row.profile?.draftStatus === "pending"} onClick={onLookup} aria-label={`${lookedUp ? "Look up again" : "Look up"} ${row.label}`}>
                        <Search size={14} aria-hidden="true" />{lookedUp ? "Look up again" : "Look up"}
                    </button>}
                    {!row.inCode && !row.removedAt && (row.approvedAt
                        ? <button type="button" className="btn" disabled={busy} onClick={onUnapprove} aria-label={`Unapprove ${row.label}`}><Undo2 size={14} aria-hidden="true" />Unapprove</button>
                        : <button type="button" className="btn" disabled={busy} onClick={approve} aria-label={`Approve ${row.label}${draft ? " with its profile and tags" : ""}`}><Check size={14} aria-hidden="true" />Approve</button>)}
                    {profilesReady && (row.removedAt
                        ? <button type="button" className="btn" disabled={busy} onClick={() => onRemove(false)} aria-label={`Restore ${row.label} to the model list`}><RotateCcw size={14} aria-hidden="true" />Restore</button>
                        : <button type="button" className="btn" disabled={busy || row.removeBlocked !== null} onClick={() => onRemove(true)} title={row.removeBlocked ?? undefined}
                            aria-label={row.removeBlocked ? `Remove ${row.label}: ${row.removeBlocked}` : `Remove ${row.label} from the model list`}><EyeOff size={14} aria-hidden="true" />Remove</button>)}
                    {row.deletable && <button type="button" className="btn" data-tone="danger" disabled={busy} onClick={onDelete} aria-label={`Delete ${row.label} for good`}><Trash2 size={14} aria-hidden="true" />Delete</button>}
                </div>
            </div>
            <div style={styles.pills}>
                <span className="pill">{row.free ? "Free" : "Paid"}</span>
                {statusPill}
                {row.missingSince && <span className="pill" data-tone="danger">Missing</span>}
                {row.inCode ? <span className="pill">Built in</span> : row.approvedAt && <span className="pill" data-tone="success"><Check size={12} aria-hidden="true" />Approved</span>}
                {profilePill}
                {row.removedAt && <span className="pill" data-tone="warning">Removed</span>}
            </div>
            {confirming && <div className="notice" role="alert" style={styles.confirm}>
                <span>This test sends a few short requests to a paid model, which costs a little. Run it?</span>
                <button type="button" className="btn" data-tone="primary" disabled={locked || busy} onClick={onTest}>Run paid test</button>
                <button type="button" className="btn" onClick={onCancel}>Cancel</button>
            </div>}
            {confirmingDelete && <div className="notice" data-tone="danger" role="alert" style={styles.confirm}>
                <span>Delete {row.label} for good? Its profile and tags go with it, and this cannot be undone. Its provider no longer lists it, so the daily check adds it back only if it returns.</span>
                <button type="button" className="btn" data-tone="danger" disabled={busy} onClick={onDelete}>Delete for good</button>
                <button type="button" className="btn" onClick={onCancelDelete}>Cancel</button>
            </div>}
            {row.removedAt && <p className="meta" style={styles.line}>
                Removed from the model list on {melbourneDate(row.removedAt)}. It stays out of the picker, /model and worker picks until you restore it.
                {row.missingSince ? row.deletable ? " Its provider no longer lists it, so you can delete it." : " Its provider no longer lists it. Built-in models are deleted by a code change in providers.ts." : ""}
            </p>}
            <p className="meta" style={styles.line}>
                {row.probedAt
                    ? `Tested ${melbourneTime(row.probedAt)}${row.probeChatMs !== null ? `, first answer in ${duration(row.probeChatMs)}` : ""}.`
                    : row.missingSince ? "Not tested."
                        : row.free ? "Not tested yet. The daily check tests it when its turn comes." : "Not tested. Paid models are tested only when you press Test."}
                {row.missingSince ? ` Missing from the provider's list since ${melbourneTime(row.missingSince)}.` : ""}
            </p>
            <p className="meta" style={styles.line}>
                <strong style={styles.term}>Good for:</strong> {tagNames.length ? tagNames.join(", ") : "No tags yet"}. <strong style={styles.term}>Speed:</strong> {speedText(row.speed)}
                {row.feedback && row.feedback.useful + row.feedback.notUseful > 0 ? ` Sub-agent ratings: ${row.feedback.useful} useful, ${row.feedback.notUseful} not useful (30 days).` : ""}
            </p>
            {profilesReady && <ProfileBlock row={row} tagList={tagList} open={open} onToggle={setOpen} selected={selected} setSelected={setSelected}
                text={text} setText={setText} editing={editing} setEditing={setEditing} busy={busy}
                onSaveTags={() => onSave({ tags: selected }, "tags saved")}
                onApproveProfile={() => onSave({ tags: selected, profile: profilePayload() }, "profile approved")} />}
            <details style={styles.details}>
                <summary className="link-btn" style={styles.detailsToggle}>Details</summary>
                <dl className="facts" style={styles.facts}>
                    <div><dt>Tool calls</dt><dd>{yesNo(row.supportsTools)}</dd></div>
                    <div><dt>Forced tool call (Search)</dt><dd>{yesNo(row.supportsSearch)}</dd></div>
                    <div><dt>Vision</dt><dd>{yesNo(row.supportsVision)}</dd></div>
                    <div><dt>Context / max output</dt><dd>{tokens(row.contextTokens)} / {tokens(row.maxOutputTokens)}</dd></div>
                    <div><dt>Inputs listed</dt><dd>{row.inputs.length ? row.inputs.join(", ") : "Not listed"}</dd></div>
                    <div><dt>First seen / last listed</dt><dd>{melbourneTime(row.firstSeenAt)} / {melbourneTime(row.lastSeenAt)}</dd></div>
                </dl>
                {stepList.length > 0 && <ul style={styles.steps}>
                    {stepList.map((step) => (
                        <li key={step.name} className="meta">
                            <strong style={styles.stepName}>{STEP_LABELS[step.name] ?? step.name}:</strong> {OUTCOME_LABELS[step.outcome] ?? step.outcome}
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

export default function ModelsPanel() {
    const [data, setData] = useState<CataloguePayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [query, setQuery] = useState("");
    const [provider, setProvider] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [confirmKey, setConfirmKey] = useState<string | null>(null);
    const [deleteKey, setDeleteKey] = useState<string | null>(null);
    const [pending, setPending] = useState<{ key: string; label: string; runId: string; kind: "test" | "lookup" } | null>(null);
    const [kind, setKind] = useState<ModelKind>("chat");
    const [switchJob, setSwitchJob] = useState<SwitchJob | null>(null);
    const [voiceBusy, setVoiceBusy] = useState(false);
    const requestRef = useRef<AbortController | null>(null);
    const jobStatusRef = useRef<SwitchJob["status"] | null>(null);

    const load = useCallback(async () => {
        requestRef.current?.abort();
        const controller = new AbortController();
        requestRef.current = controller;
        setLoading(true);
        try {
            const response = await fetch("/api/admin/models", { cache: "no-store", signal: controller.signal });
            const body = await response.json().catch(() => null) as (CataloguePayload & { error?: string }) | null;
            if (controller.signal.aborted) return;
            if (!response.ok || !body || !Array.isArray(body.rows)) {
                throw new Error(response.status === 401 ? "Sign in again to view the model catalogue." : body?.error ?? "The model catalogue could not be loaded. Retry the request.");
            }
            setData(body);
            setLoadError(null);
        } catch (failure) {
            if (!controller.signal.aborted) setLoadError(failure instanceof Error ? failure.message : "The model catalogue could not be loaded. Retry the request.");
        } finally {
            if (!controller.signal.aborted) setLoading(false);
        }
    }, []);

    useEffect(() => { void load(); return () => requestRef.current?.abort(); }, [load]);

    const running = data?.runs.some((run) => run.status === "running") ?? false;
    useEffect(() => {
        if (!running) return;
        const timer = window.setTimeout(() => { void load(); }, POLL_MS);
        return () => window.clearTimeout(timer);
    }, [running, data, load]);

    useEffect(() => {
        if (!pending || !data) return;
        const run = data.runs.find((entry) => entry.id === pending.runId);
        if (!run || run.status === "running") return;
        const summary = run.summary;
        const error = typeof summary.error === "string" ? summary.error : "no reason was recorded.";
        if (run.status === "failed") setNotice({ tone: "danger", text: `The ${pending.kind === "lookup" ? "lookup" : "test"} of ${pending.label} could not run: ${error}` });
        else if (pending.kind === "lookup") setNotice(summary.status === "ready" ? { text: `A profile draft for ${pending.label} is ready to review.` } : { tone: "danger", text: `The lookup of ${pending.label} found nothing usable: ${error}` });
        else setNotice({ text: `${pending.label} test finished: ${summary.status === "passed" ? "passed" : summary.status === "failed" ? "failed" : "no clear result, so it will be retried"}.` });
        setPending(null);
    }, [data, pending]);

    const loadSwitch = useCallback(async () => {
        try {
            const response = await fetch("/api/admin/embedding/switch", { cache: "no-store" });
            const body = await response.json().catch(() => null) as { job?: SwitchJob | null } | null;
            if (!response.ok || !body) return;
            const job = body.job ?? null;
            // The catalogue shows the new knowledge model once a running job ends.
            if (jobStatusRef.current === "running" && job?.status !== "running") void load();
            jobStatusRef.current = job?.status ?? null;
            setSwitchJob(job);
        } catch { /* the strip keeps its last state */ }
    }, [load]);

    useEffect(() => { if (kind === "embedding") void loadSwitch(); }, [kind, loadSwitch]);
    useEffect(() => {
        if (switchJob?.status !== "running") return;
        const timer = window.setTimeout(() => { void loadSwitch(); }, POLL_MS);
        return () => window.clearTimeout(timer);
    }, [switchJob, loadSwitch]);

    const send = async (url: string, method: "POST" | "PATCH" | "PUT" | "DELETE", body?: object) => {
        const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
        const payload = await response.json().catch(() => ({})) as { error?: string; runId?: string };
        return { ok: response.ok, error: payload.error, runId: payload.runId };
    };

    const allRows = data?.rows ?? [];
    const rows = allRows.filter((row): row is ModelRow => row.kind === "chat" && !row.retired);
    const typedRows = allRows.filter((row): row is TypedRow => row.kind !== "chat");
    const providerLabels = new Map((data?.providers ?? []).map((entry) => [entry.id, entry.label]));
    const nameOf = (row: AnyRow) => `${providerLabels.get(row.providerId) ?? row.providerId} ${row.label}`;
    const findTyped = (rowKind: ModelKind, providerId: string | null | undefined, modelId: string | null | undefined) =>
        typedRows.find((row) => row.kind === rowKind && row.providerId === providerId && row.modelId === modelId);

    const checkNow = async () => {
        setNotice(null);
        const result = await send("/api/admin/models/refresh", "POST");
        setNotice(result.ok ? { text: "Checking every provider now. This usually takes under a minute." } : { tone: "danger", text: result.error ?? "The check could not start." });
        await load();
    };

    const startRun = async (row: AnyRow, kind: "test" | "lookup") => {
        const key = keyOf(row);
        setBusyKey(key);
        setNotice(null);
        const result = await send(`/api/admin/models/${kind}`, "POST", { providerId: row.providerId, modelId: row.modelId });
        if (result.ok && result.runId) {
            setPending({ key, label: nameOf(row), runId: result.runId, kind });
            if (kind === "lookup") setNotice({ text: `Looking up ${nameOf(row)}. This usually takes under a minute.` });
        } else setNotice({ tone: "danger", text: result.error ?? `The ${kind} could not start.` });
        await load();
        setBusyKey(null);
    };

    const test = async (row: AnyRow) => {
        if (!row.free && confirmKey !== keyOf(row)) { setConfirmKey(keyOf(row)); return; }
        setConfirmKey(null);
        await startRun(row, "test");
    };

    const setApproval = async (row: AnyRow, approved: boolean) => {
        setBusyKey(keyOf(row));
        setNotice(null);
        const result = await send("/api/admin/models", "PATCH", { providerId: row.providerId, modelId: row.modelId, approved });
        setNotice(result.ok
            ? { text: approved ? `${nameOf(row)} is approved for automatic routes.` : row.kind === "chat" ? `${nameOf(row)} is no longer used by automatic routes. It stays in the picker while its test passes, and its profile is kept.` : `${nameOf(row)} is no longer approved, so no automatic route uses it.` }
            : { tone: "danger", text: result.error ?? "The change could not be saved." });
        await load();
        setBusyKey(null);
    };

    const setRemoved = async (row: ModelRow, removed: boolean) => {
        setBusyKey(keyOf(row));
        setNotice(null);
        const result = await send("/api/admin/models", "PATCH", { providerId: row.providerId, modelId: row.modelId, removed });
        setNotice(result.ok
            ? { text: removed ? `${nameOf(row)} is removed from the model list. Chats and channels that had it selected use the default model now. Show Removed to restore it.` : `${nameOf(row)} is back in the model list.` }
            : { tone: "danger", text: result.error ?? "The change could not be saved." });
        await load();
        setBusyKey(null);
    };

    const remove = async (row: AnyRow) => {
        if (deleteKey !== keyOf(row)) { setDeleteKey(keyOf(row)); return; }
        setDeleteKey(null);
        setBusyKey(keyOf(row));
        setNotice(null);
        const result = await send("/api/admin/models", "DELETE", { providerId: row.providerId, modelId: row.modelId });
        setNotice(result.ok ? { text: `${nameOf(row)} is deleted.` } : { tone: "danger", text: result.error ?? "The model could not be deleted." });
        await load();
        setBusyKey(null);
    };

    const saveVoice = async (body: object, done: string) => {
        setVoiceBusy(true);
        setNotice(null);
        const result = await send("/api/admin/speech", "PUT", body);
        setNotice(result.ok ? { text: done } : { tone: "danger", text: result.error ?? "The choice could not be saved." });
        await load();
        setVoiceBusy(false);
    };

    const chooseBackup = (row: TypedRow, voiceName: string | null) => {
        void saveVoice({ backup: { providerId: row.providerId, modelId: row.modelId, voice: voiceName } },
            `${nameOf(row)}${voiceName ? ` (${voiceName})` : ""} is the backup voice now. It speaks when the on-box voice is off or fails.`);
    };

    const chooseTranscription = (row: TypedRow) => {
        const current = data?.voice?.transcription.order ?? "local";
        const order: TranscriptionOrder = current === "local" ? "local-first" : current;
        void saveVoice({ transcription: { order, providerId: row.providerId, modelId: row.modelId } },
            `${nameOf(row)} transcribes now${current === "local" ? ", after the on-box service. Change the order at the top of this list" : ""}.`);
    };

    const setOrder = (order: TranscriptionOrder) => {
        const choice = data?.voice?.transcription;
        void saveVoice({ transcription: { order, providerId: choice?.providerId ?? null, modelId: choice?.modelId ?? null } }, "The transcription order is saved.");
    };

    const startSwitch = async (row: TypedRow, dimension: number) => {
        setBusyKey(keyOf(row));
        setNotice(null);
        const result = await send("/api/admin/embedding/switch", "POST", { providerId: row.providerId, modelId: row.modelId, dimension });
        setNotice(result.ok ? { text: `Switching the knowledge store to ${nameOf(row)}. Progress shows at the top of this list.` } : { tone: "danger", text: result.error ?? "The switch could not start." });
        await loadSwitch();
        setBusyKey(null);
    };

    const chooseKind = (next: ModelKind) => {
        setKind(next);
        setProvider("");
        if (next !== "chat" && !TYPED_FILTERS.some((entry) => entry.value === filter)) setFilter("all");
        if (next === "chat" && filter === "inuse") setFilter("all");
    };

    const saveProfile = async (row: ModelRow, save: ProfileSave, done: string) => {
        if (!save.tags?.length && (save.profile || save.approveModel)) {
            setNotice({ tone: "danger", text: `Choose at least one purpose tag for ${nameOf(row)} under Profile and tags, then approve.` });
            return;
        }
        setBusyKey(keyOf(row));
        setNotice(null);
        const result = await send("/api/admin/models/profile", "POST", { providerId: row.providerId, modelId: row.modelId, ...save });
        setNotice(result.ok ? { text: `${nameOf(row)}: ${done}.` } : { tone: "danger", text: result.error ?? "The profile could not be saved." });
        await load();
        setBusyKey(null);
    };

    const profilesReady = data?.profileStorage === "ok";
    const needle = query.trim().toLocaleLowerCase();
    const visible = rows.filter((row) => (!provider || row.providerId === provider)
        && (filter === "removed" ? !!row.removedAt : !row.removedAt
            && (filter === "all" || (filter === "attention" ? rank(row) <= 3 : filter === "review" ? draftReady(row) : filter === "picker" ? inPicker(row) : !inPicker(row))))
        && (!needle || `${row.label} ${row.modelId} ${providerLabels.get(row.providerId) ?? row.providerId}`.toLocaleLowerCase().includes(needle)));
    const groups = (data?.providers ?? [])
        .map((entry) => ({ entry, rows: visible.filter((row) => row.providerId === entry.id).sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)) }))
        .filter((group) => group.rows.length > 0);
    const ofKind = typedRows.filter((row) => row.kind === kind);
    const typedVisible = ofKind.filter((row) => (!provider || row.providerId === provider)
        && (filter === "attention" ? typedNeedsAttention(row) : filter === "inuse" ? row.inUse : true)
        && (!needle || `${row.label} ${row.modelId} ${providerLabels.get(row.providerId) ?? row.providerId}`.toLocaleLowerCase().includes(needle)));
    const typedGroups = (data?.providers ?? [])
        .map((entry) => ({ entry, rows: typedVisible.filter((row) => row.providerId === entry.id).sort((a, b) => typedRank(a) - typedRank(b) || a.label.localeCompare(b.label)) }))
        .filter((group) => group.rows.length > 0);
    const counts: Record<ModelKind, number> = { chat: rows.length, embedding: 0, speech: 0, transcription: 0 };
    for (const row of typedRows) counts[row.kind]++;
    const typesStored = data?.settings.types?.stored !== false;
    const showKinds = typesStored || typedRows.length > 0;
    const kindRows: AnyRow[] = kind === "chat" ? rows : ofKind;
    const voice = data?.voice;
    const knowledge = data?.knowledge ?? null;
    const jobRow = switchJob ? findTyped("embedding", switchJob.providerId, switchJob.modelId) : undefined;
    const backupRow = findTyped("speech", voice?.speech?.providerId, voice?.speech?.modelId);
    const transcriberRow = findTyped("transcription", voice?.transcription.providerId, voice?.transcription.modelId);
    const lastCheck = data?.runs.find((run) => run.id !== pending?.runId && run.summary.kind !== "test" && run.summary.kind !== "lookup");
    const attentionCount = rows.filter((row) => rank(row) <= 3).length;
    const reviewCount = rows.filter(draftReady).length;
    const removedCount = rows.filter((row) => row.removedAt).length;

    return (
        <div>
            <div className="panel-head">
                <Layers size={16} aria-hidden="true" />
                <div className="panel-heading">
                    <h2>Model catalogue</h2>
                    <p>Chat, embedding, speech and transcription models the daily check found and tested. Tested free chat models join the picker; approve a model to let automatic routes use it.</p>
                </div>
                <button type="button" className="btn" onClick={() => { void checkNow(); }} disabled={running || !data} aria-label="Check providers now">
                    <RefreshCw size={15} className={running ? "animate-spin" : undefined} aria-hidden="true" />
                    {running && !pending ? "Checking" : "Check now"}
                </button>
            </div>
            {loadError && <div className="notice" data-tone="danger" role="alert" style={styles.feedback}>
                <span>{loadError}{data ? " The last loaded catalogue is shown below." : ""}</span>
                <button type="button" className="btn" disabled={loading} onClick={() => { void load(); }}>Retry</button>
            </div>}
            {notice && <div className="notice" data-tone={notice.tone} role={notice.tone ? "alert" : "status"} style={styles.feedback}><span>{notice.text}</span></div>}
            {loading && !data && !loadError && <p role="status" className="empty">Loading the model catalogue…</p>}
            {data && <>
                <div className="inset" style={styles.run}>
                    <p className="meta" style={styles.runLine}>
                        <strong style={styles.runLabel}>Last check:</strong> {lastCheck ? `${melbourneTime(lastCheck.startedAt)} Melbourne time, ${lastCheck.trigger === "cron" ? "daily" : "manual"}. ${runSummary(lastCheck)}` : "No check has run yet."}
                    </p>
                    {!data.settings.enabled && <p className="meta" style={styles.runLine}>The daily check is off (MODEL_DISCOVERY=off). Check now still works.</p>}
                    <p className="meta" style={styles.runLine}>
                        {rows.length} models, {attentionCount} need attention{profilesReady ? `, ${reviewCount} ${reviewCount === 1 ? "profile" : "profiles"} to review` : ""}{removedCount ? `, ${removedCount} removed` : ""}. Up to {data.settings.maxProbes} free models per provider are tested each run
                        {profilesReady ? data.settings.lookups ? `, and up to ${data.settings.lookups} profiles are drafted.` : ". Daily profile lookups are off (MODEL_LOOKUP=off); Look up still works." : "."}
                    </p>
                    {!profilesReady && <p className="meta" style={styles.runLine}>Profiles and purpose tags need {PROFILE_MIGRATION}. Until it is applied, tags are read off the built-in notes and Approve works as before.</p>}
                    {!typesStored && <p className="meta" style={styles.runLine}>Embedding, speech and transcription models need {TYPES_MIGRATION}. Until it is applied, only chat models are listed.</p>}
                    {typesStored && data.settings.types?.enabled === false && <p className="meta" style={styles.runLine}>Discovery of embedding, speech and transcription models is off (MODEL_TYPES_DISCOVERY=off). Models already listed are still tested.</p>}
                </div>
                {showKinds && <div role="group" aria-label="Model type" style={styles.kinds}>
                    {KINDS.map((entry) => (
                        <button key={entry} type="button" className="chip" aria-pressed={kind === entry} onClick={() => chooseKind(entry)}>
                            {KIND_LABELS[entry]}<span style={styles.kindCount}>{counts[entry]}</span>
                        </button>
                    ))}
                </div>}
                {kind === "embedding" && <KnowledgeStrip knowledge={knowledge} providerLabel={knowledge ? providerLabels.get(knowledge.providerId) ?? knowledge.providerId : ""} job={switchJob} jobLabel={jobRow ? nameOf(jobRow) : null} />}
                {kind === "speech" && voice && <SpeechStrip voice={voice} label={backupRow ? nameOf(backupRow) : null} busy={voiceBusy}
                    onUseDefault={() => { void saveVoice({ backup: null }, "The backup voice is the default Gemini voice again."); }} />}
                {kind === "transcription" && voice && <TranscriptionStrip voice={voice} label={transcriberRow ? nameOf(transcriberRow) : null} busy={voiceBusy} onOrder={setOrder} />}
                <div style={styles.filters}>
                    <label style={styles.filter}><span>Find a model</span><input className="field" style={styles.input} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Model or provider" /></label>
                    <label style={styles.filter}><span>Provider</span><Dropdown ariaLabel="Model catalogue provider" className="field" style={{ ...styles.input, flex: "none" }} value={provider} onChange={setProvider}
                        options={[{ value: "", label: "All providers" }, ...data.providers.filter((entry) => kindRows.some((row) => row.providerId === entry.id)).map((entry) => ({ value: entry.id, label: entry.label }))]} /></label>
                    <label style={styles.filter}><span>Show</span><Dropdown ariaLabel="Model catalogue filter" className="field" style={{ ...styles.input, flex: "none" }} value={filter} onChange={(value) => setFilter(value as Filter)}
                        options={kind !== "chat" ? TYPED_FILTERS : profilesReady ? FILTERS : FILTERS.filter((entry) => entry.value !== "review" && entry.value !== "removed")} /></label>
                </div>
                {kind === "chat" ? <div className="list scroll" style={styles.list}>
                    {groups.map(({ entry, rows: providerRows }) => (
                        <section key={entry.id} aria-labelledby={`catalogue-${entry.id}`} style={styles.group}>
                            <h3 id={`catalogue-${entry.id}`} style={styles.groupHead}>
                                {entry.label}
                                <span className="meta">{providerRows.length} shown</span>
                                {listingFailed(lastCheck, entry.id) && <span className="pill" data-tone="danger">List check failed</span>}
                                {!entry.available && <span className="pill">Not available</span>}
                            </h3>
                            {providerRows.map((row) => {
                                const key = keyOf(row);
                                // Remounts when the stored profile changes, so the chips and text start from the saved state.
                                const version = `${key}|${row.tags.join(",")}|${row.profile?.draftedAt ?? ""}|${row.profile?.approvedAt ?? ""}|${row.profile?.draftStatus ?? ""}`;
                                return <ModelEntry key={version} row={row} tagList={data.tags} profilesReady={profilesReady} locked={running} busy={busyKey === key || pending?.key === key}
                                    confirming={confirmKey === key} confirmingDelete={deleteKey === key}
                                    onTest={() => { void test(row); }} onLookup={() => { void startRun(row, "lookup"); }}
                                    onApprove={(save) => { void (save ? saveProfile(row, save, save.profile ? "approved with its profile and tags" : "approved with its tags") : setApproval(row, true)); }}
                                    onUnapprove={() => { void setApproval(row, false); }}
                                    onSave={(save, done) => { void saveProfile(row, save, done); }} onCancel={() => setConfirmKey(null)}
                                    onRemove={(removed) => { void setRemoved(row, removed); }} onDelete={() => { void remove(row); }} onCancelDelete={() => setDeleteKey(null)} />;
                            })}
                        </section>
                    ))}
                    {!groups.length && <p className="empty">{rows.length ? "No models match these filters. Clear the search or choose another filter." : "The catalogue is empty. Press Check now to list each provider's models."}</p>}
                </div> : <div className="list scroll" style={styles.list}>
                    {typedGroups.map(({ entry, rows: providerRows }) => (
                        <section key={entry.id} aria-labelledby={`catalogue-${kind}-${entry.id}`} style={styles.group}>
                            <h3 id={`catalogue-${kind}-${entry.id}`} style={styles.groupHead}>
                                {entry.label}
                                <span className="meta">{providerRows.length} shown</span>
                                {!entry.available && <span className="pill">Not available</span>}
                            </h3>
                            {providerRows.map((row) => {
                                const key = keyOf(row);
                                const chosenVoice = voice?.speech?.providerId === row.providerId && voice.speech.modelId === row.modelId ? voice.speech.voice ?? "" : "";
                                return <TypedEntry key={`${key}|${chosenVoice}`} row={row} providerLabel={entry.label} voice={voice ?? { speech: null, transcription: { order: "local", providerId: null, modelId: null }, defaultSpeechModel: "" }}
                                    locked={running} busy={busyKey === key || pending?.key === key || voiceBusy} switchRunning={switchJob?.status === "running"}
                                    confirming={confirmKey === key} confirmingDelete={deleteKey === key}
                                    onTest={() => { void test(row); }} onApproval={(approved) => { void setApproval(row, approved); }}
                                    onDelete={() => { void remove(row); }} onCancel={() => setConfirmKey(null)} onCancelDelete={() => setDeleteKey(null)}
                                    onStartSwitch={(dimension) => { void startSwitch(row, dimension); }}
                                    onUseBackup={(voiceName) => chooseBackup(row, voiceName)} onUseTranscription={() => chooseTranscription(row)} />;
                            })}
                        </section>
                    ))}
                    {!typedGroups.length && <p className="empty">{ofKind.length ? "No models match these filters. Clear the search or choose another filter."
                        : !typesStored ? `Apply ${TYPES_MIGRATION}, then press Check now.` : `No ${KIND_LABELS[kind].toLocaleLowerCase()} models yet. Press Check now to list them.`}</p>}
                </div>}
            </>}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    feedback: { marginBottom: 12 },
    run: { marginBottom: 12 },
    runLine: { margin: "2px 0" },
    runLabel: { color: "var(--ink)", fontWeight: 600 },
    filters: { display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 10 },
    kinds: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 },
    kindCount: { marginLeft: 6, color: "var(--faint)", fontVariantNumeric: "tabular-nums" },
    filter: { display: "flex", flexDirection: "column", gap: 6, flex: "1 1 200px", minWidth: 0, fontSize: 13, color: "var(--muted)" },
    input: { width: "100%", padding: "0 10px", background: "var(--surface)" },
    list: { marginTop: 4, maxHeight: 640, scrollbarGutter: "stable" },
    group: { marginTop: 14 },
    groupHead: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 13.5, fontWeight: 650, color: "var(--ink)" },
    row: { display: "flex", flexDirection: "column", gap: 6, padding: "12px 0" },
    rowTop: { display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "8px 12px" },
    rowText: { display: "flex", flexDirection: "column", gap: 2, flex: "1 1 240px", minWidth: 0 },
    id: { fontFamily: "var(--font-mono)", fontSize: 12, overflowWrap: "anywhere" },
    actions: { display: "flex", flexWrap: "wrap", gap: 8 },
    pills: { display: "flex", flexWrap: "wrap", gap: 6 },
    confirm: { marginTop: 2 },
    line: { margin: 0 },
    term: { color: "var(--ink)", fontWeight: 600 },
    details: { marginTop: 2 },
    detailsToggle: { width: "fit-content" },
    profile: { display: "flex", flexDirection: "column", gap: 8, margin: "8px 0 4px", paddingLeft: 12, borderLeft: "2px solid var(--line)" },
    fieldset: { margin: 0, padding: 0, border: 0, minWidth: 0 },
    legend: { padding: 0, marginBottom: 6 },
    legendNote: { color: "var(--faint)" },
    chips: { display: "flex", flexWrap: "wrap", gap: 6 },
    inlineLink: { display: "inline", textDecoration: "underline" },
    editor: { display: "flex", flexDirection: "column", gap: 10 },
    field: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0, fontSize: 13, color: "var(--muted)" },
    profileText: { display: "flex", flexDirection: "column", gap: 4 },
    description: { margin: 0, color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.5 },
    source: { color: "var(--ink-2)", textDecoration: "underline", textUnderlineOffset: 2, overflowWrap: "anywhere" },
    facts: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", gap: "12px 24px", margin: "10px 0", lineHeight: 1.45, fontVariantNumeric: "tabular-nums" },
    steps: { display: "flex", flexDirection: "column", gap: 4, margin: "4px 0 8px", padding: 0, listStyle: "none" },
    stepName: { color: "var(--ink)", fontWeight: 600 },
    stepDetail: { display: "block", overflowWrap: "anywhere" },
};
