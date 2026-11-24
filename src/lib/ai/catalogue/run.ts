import { PROVIDERS, getProviderApiKey, retiredChatModelIds, type ProviderConfig } from "@/lib/ai/providers";
import { familyFromId, listProviderModels, selectAllDiscoverable, selectDiscoverable, shortNameFor, typesDiscoveryEnabled, uniqueShortName, type ListedModel, type ListingResult, type ModelKind, type NonChatKind, type ProviderDiscovery } from "@/lib/ai/catalogue/sources";
import { probeModel, type ProbeResult, type ProbeTarget } from "@/lib/ai/catalogue/probe";
import { probeTypedModel, type TypedProbeResult, type TypedProbeTarget } from "@/lib/ai/catalogue/probe-typed";
import type { SpaceReference } from "@/lib/ai/catalogue/probe-embedding";
import type { InUse } from "@/lib/ai/catalogue/in-use";
import { catalogueSnapshot, refreshCatalogueSnapshot, rowKind, type CatalogueRow } from "@/lib/ai/catalogue/snapshot";
import { collectModelObservations } from "@/lib/ai/model-observations";
import type { DiscoveryTrigger, SavedRow, StartRunResult, StorageFailure } from "@/lib/ai/catalogue/store";
import { findSibling, lookupQueue, siblingDraft, type LookupOutcome } from "@/lib/ai/models/lookup";
import { removedModelKeys, type ProfileRecord } from "@/lib/ai/models/profiles";

const RETEST_AFTER_MS = 7 * 24 * 60 * 60_000;
const MAX_INCONCLUSIVE = 3;
const MISSING_AFTER = 2;
// New probes stop here so a run ends inside the store's 30-minute stale-lock window, even when one probe takes its full 6 minutes.
const RUN_BUDGET_MS = 20 * 60_000;
const DEFAULT_MAX_PROBES = 10;
// Keeps one notification under Discord's 2000-character message limit.
const NOTIFY_LIST_MAX = 12;
const DEFAULT_MAX_LOOKUPS = 4;
const LOOKUP_BUDGET_MS = 5 * 60_000;
// No lookup starts after this, so a slow one still ends inside the 30-minute stale-lock window.
const LOOKUP_STOP_MS = 24 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
// One notice when an in-use model is this many days or fewer from its retirement date, then one more.
const EXPIRY_NOTICE_DAYS = [30, 7] as const;
const EXPIRY_CHECK_AFTER_MS = 7 * DAY_MS;
const MAX_EXPIRY_LOOKUPS = 6;

export interface DraftSave {
    providerId: string;
    modelId: string;
    /** Failed attempts so far, this one included; 0 after a draft succeeds. */
    attempts: number;
    outcome: LookupOutcome;
}

export interface RunLookups {
    maxPerRun: number;
    budgetMs: number;
    /** Null when the profile table is missing; the run then skips lookups. */
    readProfiles(): Promise<ProfileRecord[] | null>;
    lookup(provider: ProviderConfig, row: CatalogueRow): Promise<LookupOutcome>;
    saveDrafts(results: readonly DraftSave[]): Promise<void>;
}

export interface DiscoveryDeps {
    providers: readonly ProviderConfig[];
    apiKey(provider: ProviderConfig): string | undefined;
    list(provider: ProviderConfig, discovery: ProviderDiscovery, apiKey: string): Promise<ListingResult>;
    probe(target: ProbeTarget): Promise<ProbeResult>;
    readRows(): Promise<{ ok: true; rows: CatalogueRow[] } | { ok: false; reason: StorageFailure }>;
    saveRows(rows: readonly SavedRow[], now: string): Promise<void>;
    startRun(trigger: DiscoveryTrigger): Promise<StartRunResult>;
    finishRun(runId: string, status: "done" | "failed", summary: object): Promise<void>;
    recentSummaries(runId: string): Promise<Record<string, unknown>[]>;
    /** Resolves true when the message was delivered. */
    notify(text: string): Promise<boolean>;
    persistObservations(observations: readonly unknown[]): Promise<void>;
    refreshSnapshot(): Promise<void>;
    now(): number;
    maxProbes: number;
    runBudgetMs: number;
    reviewLink: string;
    /** Absent: no profile lookups. */
    lookups?: RunLookups;
    /** Keys the owner removed: still tracked for Missing, never tested or announced. */
    removedKeys?(): ReadonlySet<string>;
    /** Embedding, speech and transcription probes. Absent: those rows are listed but never tested. */
    probeTyped?(target: TypedProbeTarget): Promise<TypedProbeResult>;
    /** Read after readRows. False keeps the run to chat rows (MODEL_TYPES_DISCOVERY=off, or v7-model-types.sql not applied). */
    typesEnabled?(): boolean;
    /** Routes the app uses now; their free rows are tested on every run, outside the cap. */
    inUse?(rows: readonly CatalogueRow[]): Promise<InUse>;
    /** Weekly retirement lookup for in-use non-chat models. Absent: none. */
    expiryLookups?: ExpiryLookups;
}

export type ExpiryLookupOutcome = { ok: true; date: string | null; url: string | null } | { ok: false; error: string };

export interface ExpiryLookups {
    maxPerRun: number;
    lookup(provider: ProviderConfig, row: CatalogueRow): Promise<ExpiryLookupOutcome>;
}

export type ListingState = "ok" | "failed" | "no_key" | "unavailable";

export interface ProviderRunSummary {
    listing: ListingState;
    /** Consecutive failed listings, carried across runs. */
    listingFailures: number;
    httpStatus?: number | null;
    error?: string;
    listed?: number;
    tracked?: number;
    added?: number;
    missing?: number;
    probed?: number;
    passed?: number;
    failed?: number;
    inconclusive?: number;
    /** Due for a probe but left for a later run by the cap or the time budget. */
    deferred?: number;
}

export interface RunSummary {
    kind: "run";
    trigger: DiscoveryTrigger;
    providers: Record<string, ProviderRunSummary>;
    added: string[];
    passed: string[];
    newlyMissing: string[];
    failedRetests: string[];
    notified: boolean;
    budgetReached: boolean;
    durationMs: number;
    drafted: string[];
    draftFailed: string[];
    lookupsDeferred: number;
    /** In-use models that got a retirement notice this run. */
    retiring?: string[];
    /** In-use models whose daily test failed this run. */
    inUseFailing?: string[];
    expiryChecked?: string[];
}

export interface TestSummary {
    kind: "test";
    providerId: string;
    modelId: string;
    modelKind?: ModelKind;
    status: CatalogueRow["probeStatus"];
    retired: boolean;
    chatMs: number | null;
}

const keyOf = (row: Pick<CatalogueRow, "providerId" | "modelId">) => `${row.providerId}::${row.modelId}`;

export function maxProbesFromEnv(raw = process.env.MODEL_DISCOVERY_MAX_PROBES): number {
    const value = Number(raw);
    return raw !== undefined && raw.trim() !== "" && Number.isInteger(value) && value >= 0 && value <= 50 ? value : DEFAULT_MAX_PROBES;
}

export function discoveryEnabled(raw = process.env.MODEL_DISCOVERY): boolean {
    return raw?.trim().toLowerCase() !== "off";
}

export function lookupEnabled(raw = process.env.MODEL_LOOKUP): boolean {
    return raw?.trim().toLowerCase() !== "off";
}

export function maxLookupsFromEnv(raw = process.env.MODEL_LOOKUP_MAX_PER_RUN): number {
    const value = Number(raw);
    return raw !== undefined && raw.trim() !== "" && Number.isInteger(value) && value >= 0 && value <= 20 ? value : DEFAULT_MAX_LOOKUPS;
}

function capsFor(provider: ProviderConfig, row: CatalogueRow) {
    const code = provider.chatModels.find((model) => model.id === row.modelId);
    return { supportsTools: code?.supportsTools ?? row.supportsTools === true, supportsVision: code?.supportsVision ?? row.supportsVision === true };
}

export function startFailure(reason: "busy" | StorageFailure): { status: number; error: string } {
    if (reason === "busy") return { status: 409, error: "A model check is already running. Try again when it finishes." };
    if (reason === "migration_required") return { status: 503, error: "The model catalogue tables are missing. Apply scripts/migrations/v7-model-catalogue.sql." };
    return { status: 503, error: "The model catalogue is unavailable. Please retry." };
}

const sameInstant = (a: string | null | undefined, b: string | null | undefined) => (a ?? null) === (b ?? null) || (!!a && !!b && Date.parse(a) === Date.parse(b));

/** Voices, family and the listing's expiry date for non-chat rows. A 410 date is kept; a lookup date gives way to the listing's. */
function typedListing(row: CatalogueRow, listed: ListedModel): Partial<CatalogueRow> {
    if (rowKind(row) === "chat") return {};
    const voices = listed.voices.length ? listed.voices : row.traits?.voices;
    const sameTraits = row.traits?.familyId === listed.familyId && JSON.stringify(row.traits?.voices ?? null) === JSON.stringify(voices ?? null);
    const traits = sameTraits ? row.traits : { ...row.traits, ...(voices ? { voices } : {}), familyId: listed.familyId };
    if (row.expiresSource === "gone") return { traits };
    if (listed.expiresAt) return { traits, expiresAt: sameInstant(row.expiresAt, listed.expiresAt) ? row.expiresAt : listed.expiresAt, expiresSource: "listing" };
    return row.expiresSource === "listing" ? { traits, expiresAt: null, expiresSource: null, notifiedExpiryDays: null } : { traits };
}

function metadataFrom(row: CatalogueRow, listed: ListedModel, provider: ProviderConfig): CatalogueRow {
    return { ...listingMetadata(row, listed, provider), ...typedListing(row, listed) };
}

function listingMetadata(row: CatalogueRow, listed: ListedModel, provider: ProviderConfig): CatalogueRow {
    if (row.origin === "seed") {
        // Seed rows carry the code's names and audited limits; the listing only fills gaps.
        return {
            ...row,
            description: row.description ?? listed.description, developer: row.developer ?? listed.developer,
            mayTrain: row.mayTrain ?? listed.mayTrain, contextTokens: row.contextTokens ?? listed.contextTokens,
            maxOutputTokens: row.maxOutputTokens ?? listed.maxOutputTokens, inputs: row.inputs.length ? row.inputs : listed.inputs,
            listedTools: listed.listedTools ?? row.listedTools, listedStructured: listed.listedStructured ?? row.listedStructured,
            listedThinking: listed.listedThinking ?? row.listedThinking,
        };
    }
    return {
        ...row,
        label: listed.label, description: listed.description, developer: listed.developer,
        free: listed.free, metered: !listed.free || provider.metered === true, mayTrain: listed.mayTrain,
        contextTokens: listed.contextTokens, maxOutputTokens: listed.maxOutputTokens, inputs: listed.inputs,
        listedTools: listed.listedTools, listedStructured: listed.listedStructured, listedThinking: listed.listedThinking,
    };
}

function newRow(provider: ProviderConfig, listed: ListedModel, shortName: string, now: string): CatalogueRow {
    return metadataFrom({
        providerId: provider.id, modelId: listed.modelId, origin: "discovered", label: listed.label, shortName,
        description: null, developer: null, free: listed.free, metered: true, mayTrain: null,
        contextTokens: null, maxOutputTokens: null, inputs: [], listedTools: null, listedStructured: null, listedThinking: null,
        probeStatus: "untested", probeAttempts: 0, probedAt: null, probeChatMs: null,
        supportsTools: null, supportsSearch: null, supportsVision: null, supportsThinking: null, supportsStructured: null,
        firstSeenAt: now, lastSeenAt: now, missedChecks: 0, missingSince: null, notifiedMissingAt: null, approvedAt: null,
        ...(listed.kind && listed.kind !== "chat" ? {
            kind: listed.kind, dimension: null, expiresAt: null, expiresSource: null, notifiedExpiryDays: null, expiryCheckedAt: null, spaceOf: null, traits: {},
        } : {}),
    }, listed, provider);
}

/** Folds an embedding, speech or transcription probe into a row. A 410 marks it gone with the date from the reply. */
export function applyTypedProbe(row: CatalogueRow, result: TypedProbeResult, at: string): CatalogueRow {
    const base: CatalogueRow = { ...row, probedAt: at, probeChatMs: result.ms ?? row.probeChatMs };
    if (result.status === "passed") {
        const listedAgain = row.missedChecks === 0;
        const space = result.steps.space?.outcome;
        return {
            ...base, probeStatus: "passed", probeAttempts: 0,
            dimension: result.dimension ?? row.dimension ?? null,
            traits: { ...row.traits, ...result.traits },
            // A skipped same-space step keeps the earlier proof.
            spaceOf: space === "pass" ? result.spaceOf : space === "fail" ? null : row.spaceOf ?? null,
            ...(row.expiresSource === "gone" ? { expiresAt: null, expiresSource: null, notifiedExpiryDays: null } : {}),
            missingSince: listedAgain ? null : row.missingSince, notifiedMissingAt: listedAgain ? null : row.notifiedMissingAt,
        };
    }
    if (result.status === "failed") {
        return {
            ...base, probeStatus: "failed", probeAttempts: 0,
            missingSince: result.retired ? row.missingSince ?? at : row.missingSince,
            ...(result.retired ? { expiresAt: result.retiredAt ?? at, expiresSource: "gone" as const } : {}),
        };
    }
    const attempts = row.probeAttempts + 1;
    const probeStatus = attempts >= MAX_INCONCLUSIVE ? "failed" : row.probeStatus === "passed" ? "passed" : "inconclusive";
    return { ...base, probeAttempts: attempts, probeStatus };
}

function typedCrash(error: unknown, key: string): TypedProbeResult {
    console.error(`[ModelDiscovery] Probe crashed for ${key}:`, error instanceof Error ? error.message : error);
    return { status: "inconclusive", retired: false, retiredAt: null, ms: null, dimension: null, spaceOf: null, traits: {}, steps: { probe: { outcome: "transient", httpStatus: null, ms: null, detail: "The probe crashed." } } };
}

const familyOf = (row: CatalogueRow) => row.traits?.familyId ?? familyFromId(row.modelId);

/** Days until an in-use model's retirement date, rounded up; null without a date. */
export function daysUntil(expiresAt: string | null | undefined, nowMs: number): number | null {
    const ms = expiresAt ? Date.parse(expiresAt) : NaN;
    return Number.isFinite(ms) ? Math.ceil((ms - nowMs) / DAY_MS) : null;
}

/** The notice threshold due now (30, then 7), or null when this row was already told. */
export function expiryNoticeDue(row: Pick<CatalogueRow, "expiresAt" | "notifiedExpiryDays">, nowMs: number): number | null {
    const days = daysUntil(row.expiresAt, nowMs);
    if (days === null) return null;
    const threshold = [...EXPIRY_NOTICE_DAYS].reverse().find((limit) => days <= limit);
    if (threshold === undefined) return null;
    return row.notifiedExpiryDays === null || row.notifiedExpiryDays === undefined || row.notifiedExpiryDays > threshold ? threshold : null;
}

function auDay(iso: string): string {
    return new Date(iso).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
}

/** Folds one probe into a row. Three inconclusive probes in a row count as a failure; one does not demote a passed model. */
export function applyProbe(row: CatalogueRow, result: ProbeResult, at: string): CatalogueRow {
    const base: CatalogueRow = { ...row, probedAt: at, probeChatMs: result.chatMs ?? row.probeChatMs };
    if (result.status === "passed") {
        const listedAgain = row.missedChecks === 0;
        return {
            ...base, probeStatus: "passed", probeAttempts: 0,
            supportsTools: result.supportsTools ?? row.supportsTools, supportsSearch: result.supportsSearch ?? row.supportsSearch,
            supportsVision: result.supportsVision ?? row.supportsVision,
            missingSince: listedAgain ? null : row.missingSince, notifiedMissingAt: listedAgain ? null : row.notifiedMissingAt,
        };
    }
    if (result.status === "failed") {
        return { ...base, probeStatus: "failed", probeAttempts: 0, missingSince: result.retired ? row.missingSince ?? at : row.missingSince };
    }
    const attempts = row.probeAttempts + 1;
    const probeStatus = attempts >= MAX_INCONCLUSIVE ? "failed" : row.probeStatus === "passed" ? "passed" : "inconclusive";
    return { ...base, probeAttempts: attempts, probeStatus };
}

/** Probe order: new free models (discovered, or seeded with no code entry), then inconclusive retries, then free picker models whose last probe is over 7 days old. Paid models never. */
export function probePriority(row: CatalogueRow, inCode: boolean, listedNow: boolean, nowMs: number): number | null {
    if (!row.free || !listedNow || row.missingSince !== null) return null;
    if (row.probeStatus === "untested" && (row.origin === "discovered" || !inCode)) return 0;
    if (row.probeAttempts > 0 && row.probeAttempts < MAX_INCONCLUSIVE) return 1;
    const inPicker = inCode || row.approvedAt !== null || row.probeStatus === "passed";
    const due = row.probedAt === null || nowMs - Date.parse(row.probedAt) > RETEST_AFTER_MS;
    return inPicker && due ? 2 : null;
}

function inPicker(row: CatalogueRow, inCode: boolean): boolean {
    return inCode || row.approvedAt !== null || row.probeStatus === "passed";
}

function previousFailures(summaries: readonly Record<string, unknown>[], providerId: string): number {
    const last = summaries.find((summary) => summary.kind === "run" && summary.providers && typeof summary.providers === "object");
    const entry = last ? (last.providers as Record<string, unknown>)[providerId] : undefined;
    const count = entry && typeof entry === "object" ? (entry as { listingFailures?: unknown }).listingFailures : undefined;
    return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0;
}

function section(title: string, lines: readonly string[]): string[] {
    if (!lines.length) return [];
    const shown = lines.slice(0, NOTIFY_LIST_MAX).map((line) => `- ${line}`);
    if (lines.length > shown.length) shown.push(`- and ${lines.length - shown.length} more`);
    return [`${title} (${lines.length}):`, ...shown];
}

const KIND_NAMES: Record<NonChatKind, string> = { embedding: "embedding", speech: "speech", transcription: "transcription" };

export function discoveryMessage(parts: {
    passed: string[]; missing: string[]; failedRetests: string[]; listingFailed: string[]; drafted?: string[];
    retiring?: string[]; inUseFailing?: string[]; passedByKind?: Partial<Record<NonChatKind, string[]>>;
}, reviewLink: string): string | null {
    const body = [
        ...section("In use and retiring", parts.retiring ?? []),
        ...section("In use and failing its daily test", parts.inUseFailing ?? []),
        ...section("New models passed their tests, not yet approved for automatic routes", parts.passed),
        ...(Object.keys(KIND_NAMES) as NonChatKind[]).flatMap((kind) => section(`New ${KIND_NAMES[kind]} models passed their tests, not yet approved`, parts.passedByKind?.[kind] ?? [])),
        ...section("Missing from the provider's list, still selectable", parts.missing),
        ...section("Approved models that failed a re-test", parts.failedRetests),
        ...section("Provider list failed twice in a row", parts.listingFailed),
        ...section("Model profiles drafted, waiting for your review", parts.drafted ?? []),
    ];
    if (!body.length) return null;
    return ["**Model catalogue check**", ...body, reviewLink ? `Review: ${reviewLink}` : ""].filter(Boolean).join("\n");
}

function describe(provider: ProviderConfig, row: CatalogueRow): string {
    return `${provider.label}: ${row.label} (\`${row.shortName}\`)`;
}

/** Runs one discovery pass under a lock taken with `deps.startRun`, and always finishes the run row. */
export async function executeDiscovery(runId: string, trigger: DiscoveryTrigger, deps: DiscoveryDeps): Promise<RunSummary | null> {
    const startedMs = deps.now();
    try {
        const summary = await discover(runId, trigger, deps, startedMs);
        await deps.finishRun(runId, "done", summary);
        return summary;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[ModelDiscovery] Run failed:", message);
        await deps.finishRun(runId, "failed", { kind: "run", trigger, error: message.slice(0, 500), durationMs: deps.now() - startedMs })
            .catch((finishError) => console.error("[ModelDiscovery] Could not finish the run row:", finishError instanceof Error ? finishError.message : finishError));
        return null;
    }
}

type ProviderListing =
    | { provider: ProviderConfig; discovery: ProviderDiscovery; state: "unavailable" | "no_key" }
    | { provider: ProviderConfig; discovery: ProviderDiscovery; state: "listed"; apiKey: string; result: ListingResult };

async function discover(runId: string, trigger: DiscoveryTrigger, deps: DiscoveryDeps, startedMs: number): Promise<RunSummary> {
    const now = new Date(startedMs).toISOString();
    const read = await deps.readRows();
    if (!read.ok) throw new Error(`The model catalogue is ${read.reason === "migration_required" ? "not set up; apply v7-model-catalogue.sql" : "unavailable"}.`);
    const earlier = await deps.recentSummaries(runId).catch((): Record<string, unknown>[] => []);

    const before = new Map(read.rows.map((row) => [keyOf(row), row]));
    const after = new Map(before);
    const removed = deps.removedKeys?.() ?? new Set<string>();
    const typesOn = deps.typesEnabled?.() === true;
    const typedProbes = typesOn && !!deps.probeTyped;
    const inUse = typesOn && deps.inUse ? await deps.inUse(read.rows).catch((error) => {
        console.error("[ModelDiscovery] Could not read the models in use:", error instanceof Error ? error.message : error);
        return null;
    }) : null;
    const inUseKeys = inUse?.keys ?? new Set<string>();
    const summary: RunSummary = {
        kind: "run", trigger, providers: {}, added: [], passed: [], newlyMissing: [], failedRetests: [],
        notified: false, budgetReached: false, durationMs: 0, drafted: [], draftFailed: [], lookupsDeferred: 0,
    };
    const listingFailed: string[] = [];
    const probeQueues: { provider: ProviderConfig; apiKey: string; rows: CatalogueRow[]; entry: ProviderRunSummary }[] = [];
    // Providers with a key; in-use models are tested even when their list failed.
    const keyed = new Map<string, { provider: ProviderConfig; apiKey: string }>();

    const listed = await Promise.all(deps.providers.map(async (provider): Promise<ProviderListing | null> => {
        const discovery = provider.discovery;
        if (!discovery) return null;
        if (provider.unavailableReason) return { provider, discovery, state: "unavailable" };
        const apiKey = deps.apiKey(provider);
        if (!apiKey) return { provider, discovery, state: "no_key" };
        const result = await deps.list(provider, discovery, apiKey).catch((error): ListingResult => ({ ok: false, status: null, error: error instanceof Error ? error.message : String(error) }));
        return { provider, discovery, state: "listed", apiKey, result };
    }));

    for (const item of listed) {
        if (!item) continue;
        if (item.state !== "listed") {
            summary.providers[item.provider.id] = { listing: item.state, listingFailures: 0 };
            continue;
        }
        const { provider, discovery, apiKey, result } = item;
        keyed.set(provider.id, { provider, apiKey });
        // An empty list is treated as a failed one, so a provider hiccup never marks every model missing.
        if (!result.ok || !result.models.length) {
            const failures = previousFailures(earlier, provider.id) + 1;
            const httpStatus = result.ok ? null : result.status;
            summary.providers[provider.id] = { listing: "failed", listingFailures: failures, httpStatus, error: result.ok ? "The list was empty." : result.error.slice(0, 300) };
            if (failures === 2) listingFailed.push(`${provider.label}${httpStatus ? ` (HTTP ${httpStatus})` : ""}`);
            continue;
        }

        const retired = retiredChatModelIds(provider.id);
        const codeIds = codeModelIds(provider);
        const listing = new Map(result.models.map((model) => [model.modelId, model]));
        const tracked = typesOn ? selectAllDiscoverable(result.models, discovery, retired) : selectDiscoverable(result.models, discovery, retired);
        const entry: ProviderRunSummary = { listing: "ok", listingFailures: 0, listed: result.models.length, tracked: tracked.length, added: 0, missing: 0 };
        summary.providers[provider.id] = entry;

        const own = [...after.values()].filter((row) => row.providerId === provider.id && !retired.has(row.modelId));
        for (const row of own) {
            const seen = listing.get(row.modelId);
            let next: CatalogueRow;
            if (seen) {
                // A model marked missing by a 410 probe stays missing while it is still listed.
                const backAfterMiss = row.missedChecks > 0;
                next = {
                    ...metadataFrom(row, seen, provider), lastSeenAt: now, missedChecks: 0,
                    missingSince: backAfterMiss ? null : row.missingSince, notifiedMissingAt: backAfterMiss ? null : row.notifiedMissingAt,
                };
            } else {
                const missedChecks = row.missedChecks + 1;
                next = { ...row, missedChecks, missingSince: row.missingSince ?? (missedChecks >= MISSING_AFTER ? now : null) };
            }
            if (next.missingSince) entry.missing = (entry.missing ?? 0) + 1;
            after.set(keyOf(next), next);
        }

        const taken = new Set([...provider.chatModels.map((model) => model.name), ...own.map((row) => row.shortName)]);
        for (const model of tracked) {
            if (after.has(keyOf({ providerId: provider.id, modelId: model.modelId }))) continue;
            const shortName = uniqueShortName(shortNameFor(model.modelId, discovery.nameSuffix), taken);
            taken.add(shortName);
            const row = newRow(provider, model, shortName, now);
            after.set(keyOf(row), row);
            summary.added.push(keyOf(row));
            entry.added = (entry.added ?? 0) + 1;
        }

        // In-use models are tested in their own pass below, outside the cap.
        const queue = [...after.values()]
            .filter((row) => row.providerId === provider.id && (rowKind(row) === "chat" || typedProbes) && !inUseKeys.has(keyOf(row)) && !retired.has(row.modelId) && !removed.has(keyOf(row)))
            .map((row) => ({ row, priority: probePriority(row, codeIds.has(row.modelId), listing.has(row.modelId), startedMs) }))
            .filter((item): item is { row: CatalogueRow; priority: number } => item.priority !== null)
            .sort((a, b) => a.priority - b.priority
                || (a.priority === 2 ? (a.row.probedAt ?? "").localeCompare(b.row.probedAt ?? "") : a.row.firstSeenAt.localeCompare(b.row.firstSeenAt))
                || a.row.modelId.localeCompare(b.row.modelId))
            .map((item) => item.row);
        entry.deferred = Math.max(0, queue.length - deps.maxProbes);
        probeQueues.push({ provider, apiKey, rows: queue.slice(0, deps.maxProbes), entry });
    }

    const probeDetails = new Map<string, unknown>();
    const atNow = () => new Date(deps.now()).toISOString();
    const primaryKey = inUse?.embedding ? `${inUse.embedding.providerId}::${inUse.embedding.modelId}` : null;
    let reference: SpaceReference | undefined;
    let referenceFamily: string | null = null;
    const referenceFor = (row: CatalogueRow) => reference && rowKind(row) === "embedding" && familyOf(row) === referenceFamily && keyOf(row) !== primaryKey ? reference : undefined;
    const tally = (entry: ProviderRunSummary | undefined, status: "passed" | "failed" | "inconclusive") => {
        if (!entry) return;
        entry.probed = (entry.probed ?? 0) + 1;
        entry[status] = (entry[status] ?? 0) + 1;
    };
    const typedProbe = async (provider: ProviderConfig, apiKey: string, row: CatalogueRow): Promise<TypedProbeResult> => {
        const result = await deps.probeTyped!({
            kind: rowKind(row) as NonChatKind, provider, modelId: row.modelId, apiKey, listedVoices: row.traits?.voices, reference: referenceFor(row),
        }).catch((error) => typedCrash(error, keyOf(row)));
        const next = applyTypedProbe(after.get(keyOf(row)) ?? row, result, atNow());
        after.set(keyOf(next), next);
        probeDetails.set(keyOf(next), { retired: result.retired, retiredAt: result.retiredAt, steps: result.steps });
        return result;
    };

    const { observations } = await collectModelObservations(async () => {
        // In-use pass: the knowledge model first, so its vectors are the same-space reference for the rest.
        if (typedProbes && inUse) {
            const targets = [...after.values()]
                .filter((row) => inUseKeys.has(keyOf(row)) && rowKind(row) !== "chat" && row.free && !removed.has(keyOf(row)) && keyed.has(row.providerId))
                .sort((a, b) => Number(keyOf(b) === primaryKey) - Number(keyOf(a) === primaryKey));
            for (const row of targets) {
                if (deps.now() - startedMs >= deps.runBudgetMs) {
                    summary.budgetReached = true;
                    break;
                }
                const { provider, apiKey } = keyed.get(row.providerId)!;
                const result = await typedProbe(provider, apiKey, row);
                tally(summary.providers[provider.id], result.status);
                if (keyOf(row) === primaryKey && result.vectors) {
                    reference = { partitionId: inUse.embedding!.modelId, ...result.vectors };
                    referenceFamily = familyOf(row);
                }
            }
        }
        await Promise.all(probeQueues.map(async ({ provider, apiKey, rows, entry }) => {
            entry.probed ??= 0;
            entry.passed ??= 0;
            entry.failed ??= 0;
            entry.inconclusive ??= 0;
            for (const [index, row] of rows.entries()) {
                if (deps.now() - startedMs >= deps.runBudgetMs) {
                    summary.budgetReached = true;
                    entry.deferred = (entry.deferred ?? 0) + rows.length - index;
                    break;
                }
                if (rowKind(row) !== "chat") {
                    tally(entry, (await typedProbe(provider, apiKey, row)).status);
                    continue;
                }
                const checkVision = !row.inputs.length || row.inputs.includes("image");
                const result = await deps.probe({ provider, modelId: row.modelId, apiKey, checkVision }).catch((error): ProbeResult => {
                    console.error(`[ModelDiscovery] Probe crashed for ${keyOf(row)}:`, error instanceof Error ? error.message : error);
                    const step = { outcome: "transient" as const, httpStatus: null, ms: null, detail: "The probe crashed." };
                    return { status: "inconclusive", retired: false, chatMs: null, supportsTools: null, supportsSearch: null, supportsVision: null, steps: { chat: step, tools: step, forced: step, vision: step } };
                });
                const next = applyProbe(after.get(keyOf(row)) ?? row, result, atNow());
                after.set(keyOf(next), next);
                probeDetails.set(keyOf(next), { retired: result.retired, steps: result.steps });
                tally(entry, result.status);
            }
        }));
    });
    await deps.persistObservations(observations).catch((error) => console.error("[ModelDiscovery] Could not store probe observations:", error instanceof Error ? error.message : error));

    const passedLines: string[] = [], missingLines: string[] = [], failedLines: string[] = [], missingKeys: string[] = [], inUseFailingLines: string[] = [];
    const passedByKind: Partial<Record<NonChatKind, string[]>> = {};
    for (const provider of deps.providers) {
        const codeIds = codeModelIds(provider);
        const retired = retiredChatModelIds(provider.id);
        for (const row of after.values()) {
            if (row.providerId !== provider.id || retired.has(row.modelId) || removed.has(keyOf(row))) continue;
            const old = before.get(keyOf(row));
            const inCode = codeIds.has(row.modelId);
            const kind = rowKind(row);
            if (old?.probeStatus !== "passed" && row.probeStatus === "passed" && row.origin === "discovered" && row.approvedAt === null) {
                summary.passed.push(keyOf(row));
                if (kind === "chat") passedLines.push(describe(provider, row));
                else (passedByKind[kind] ??= []).push(describe(provider, row));
            }
            if (old && old.probeStatus !== "failed" && row.probeStatus === "failed") {
                if (inUseKeys.has(keyOf(row))) {
                    (summary.inUseFailing ??= []).push(keyOf(row));
                    inUseFailingLines.push(`${describe(provider, row)}${keyOf(row) === primaryKey ? backupNote(after, inUse!.embedding!.modelId, primaryKey) : ""}`);
                } else if (inCode || row.approvedAt !== null) {
                    summary.failedRetests.push(keyOf(row));
                    failedLines.push(describe(provider, row));
                }
            }
            if (row.missingSince !== null && row.notifiedMissingAt === null && inPicker(row, inCode)) {
                missingKeys.push(keyOf(row));
                missingLines.push(describe(provider, row));
            }
        }
    }
    summary.newlyMissing = missingKeys;

    const drafts = deps.lookups ? await draftProfiles(deps, deps.lookups, after, summary, startedMs) : [];
    const draftedLines = drafts.filter((entry) => entry.outcome.ok).flatMap((entry) => {
        const provider = deps.providers.find((item) => item.id === entry.providerId);
        const row = after.get(keyOf(entry));
        return provider && row ? [describe(provider, row)] : [];
    });
    if (inUse && deps.expiryLookups) await checkExpiry(deps, deps.expiryLookups, after, inUseKeys, summary, startedMs);
    const retiring = inUse ? retiringNotices(deps, after, inUseKeys) : [];

    const message = discoveryMessage({
        passed: passedLines, missing: missingLines, failedRetests: failedLines, listingFailed, drafted: draftedLines,
        retiring: retiring.map((notice) => notice.line), inUseFailing: inUseFailingLines, passedByKind,
    }, deps.reviewLink);
    if (message) {
        summary.notified = await deps.notify(message).catch((error) => {
            console.error("[ModelDiscovery] Notification failed:", error instanceof Error ? error.message : error);
            return false;
        });
        // Undelivered missing and retirement notices are retried by the next run.
        if (summary.notified) {
            for (const key of missingKeys) after.set(key, { ...after.get(key)!, notifiedMissingAt: now });
            for (const notice of retiring) after.set(notice.key, { ...after.get(notice.key)!, notifiedExpiryDays: notice.threshold });
            if (retiring.length) summary.retiring = retiring.map((notice) => notice.key);
        }
    }

    const changed: SavedRow[] = [];
    for (const [key, row] of after) {
        const detail = probeDetails.get(key);
        if (detail !== undefined || JSON.stringify(before.get(key)) !== JSON.stringify(row)) changed.push({ row, probeDetail: detail });
    }
    if (changed.length) await deps.saveRows(changed, new Date(deps.now()).toISOString());
    // Profile rows reference catalogue rows, so drafts are saved after the rows they describe.
    if (drafts.length) await deps.lookups!.saveDrafts(drafts).catch((error) => console.error("[ModelDiscovery] Could not save profile drafts:", error instanceof Error ? error.message : error));
    await deps.refreshSnapshot().catch((error) => console.error("[ModelDiscovery] Snapshot refresh failed:", error instanceof Error ? error.message : error));
    summary.durationMs = deps.now() - startedMs;
    return summary;
}

function codeModelIds(provider: ProviderConfig): Set<string> {
    return new Set([...provider.chatModels.map((model) => model.id), ...provider.embeddingModels.map((model) => model.id)]);
}

function backupNote(rows: ReadonlyMap<string, CatalogueRow>, partitionModelId: string, primaryKey: string): string {
    const backups = [...rows.values()].filter((row) => rowKind(row) === "embedding" && row.approvedAt !== null && row.spaceOf === partitionModelId
        && row.probeStatus === "passed" && !row.missingSince && keyOf(row) !== primaryKey);
    return backups.length ? `; backup ${backups.map((row) => `\`${row.shortName}\``).join(", ")} serves the knowledge store` : "; no same-space backup is approved";
}

/** Weekly: each in-use non-chat model's provider docs, for a stated retirement date. Within the lookup switch and time limit. */
async function checkExpiry(deps: DiscoveryDeps, lookups: ExpiryLookups, after: Map<string, CatalogueRow>, inUseKeys: ReadonlySet<string>, summary: RunSummary, startedMs: number): Promise<void> {
    const providers = new Map(deps.providers.map((provider) => [provider.id, provider]));
    const due = [...after.values()]
        .filter((row) => inUseKeys.has(keyOf(row)) && rowKind(row) !== "chat" && providers.has(row.providerId)
            && (!row.expiryCheckedAt || deps.now() - Date.parse(row.expiryCheckedAt) > EXPIRY_CHECK_AFTER_MS))
        .sort((a, b) => (a.expiryCheckedAt ?? "").localeCompare(b.expiryCheckedAt ?? ""))
        .slice(0, Math.min(lookups.maxPerRun, MAX_EXPIRY_LOOKUPS));
    if (!due.length) return;
    const checked: string[] = [];
    const { observations } = await collectModelObservations(async () => {
        for (const row of due) {
            if (deps.now() - startedMs >= LOOKUP_STOP_MS) break;
            const outcome = await lookups.lookup(providers.get(row.providerId)!, row).catch((error): ExpiryLookupOutcome => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
            if (!outcome.ok) {
                console.warn(`[ModelDiscovery] Retirement lookup failed for ${keyOf(row)}: ${outcome.error.slice(0, 200)}`);
                continue;
            }
            const current = after.get(keyOf(row))!;
            // The provider's own list and a 410 outrank a web page.
            const authoritative = current.expiresSource === "listing" || current.expiresSource === "gone";
            const dated = authoritative ? {}
                : outcome.date ? { expiresAt: sameInstant(current.expiresAt, outcome.date) ? current.expiresAt : outcome.date, expiresSource: "lookup" as const }
                    : current.expiresSource === "lookup" ? { expiresAt: null, expiresSource: null, notifiedExpiryDays: null } : {};
            after.set(keyOf(row), {
                ...current, expiryCheckedAt: new Date(deps.now()).toISOString(), ...dated,
                ...(outcome.url && current.traits?.lookupUrl !== outcome.url ? { traits: { ...current.traits, lookupUrl: outcome.url } } : {}),
            });
            checked.push(keyOf(row));
        }
    }, ["public_search"]);
    summary.expiryChecked = checked;
    await deps.persistObservations(observations).catch((error) => console.error("[ModelDiscovery] Could not store lookup observations:", error instanceof Error ? error.message : error));
}

/** In-use models due a retirement notice. A date moved past 30 days clears the earlier notice so a new one can follow. */
function retiringNotices(deps: DiscoveryDeps, after: Map<string, CatalogueRow>, inUseKeys: ReadonlySet<string>): { key: string; threshold: number; line: string }[] {
    const providers = new Map(deps.providers.map((provider) => [provider.id, provider]));
    const out: { key: string; threshold: number; line: string }[] = [];
    for (const row of after.values()) {
        const key = keyOf(row), provider = providers.get(row.providerId);
        if (!inUseKeys.has(key) || rowKind(row) === "chat" || !provider) continue;
        const days = daysUntil(row.expiresAt, deps.now());
        if ((days === null || days > EXPIRY_NOTICE_DAYS[0]) && row.notifiedExpiryDays !== null && row.notifiedExpiryDays !== undefined) {
            after.set(key, { ...row, notifiedExpiryDays: null });
            continue;
        }
        const threshold = expiryNoticeDue(row, deps.now());
        if (threshold === null || days === null) continue;
        const when = days <= 0 ? `retired on ${auDay(row.expiresAt!)}` : `retires ${auDay(row.expiresAt!)} (${days} day${days === 1 ? "" : "s"})`;
        const source = row.expiresSource === "lookup" ? `, from ${row.traits?.lookupUrl ?? "a web lookup"}`
            : row.expiresSource === "gone" ? ", from the provider's 410 reply" : row.expiresSource === "listing" ? ", from the provider's model list" : "";
        out.push({ key, threshold, line: `${describe(provider, row)} ${when}${source}` });
    }
    return out;
}

/** Drafts profiles in memory: routes with an approved sibling profile copy it, the rest are looked up within the cap and budget. */
async function draftProfiles(deps: DiscoveryDeps, lookups: RunLookups, after: ReadonlyMap<string, CatalogueRow>, summary: RunSummary, startedMs: number): Promise<DraftSave[]> {
    if (deps.now() - startedMs >= LOOKUP_STOP_MS) return [];
    const profiles = await lookups.readProfiles().catch(() => null);
    if (!profiles) return [];
    const providers = new Map(deps.providers.map((provider) => [provider.id, provider]));
    const usable = (row: CatalogueRow) => {
        const provider = providers.get(row.providerId);
        return !!provider && !provider.unavailableReason && !!deps.apiKey(provider) && !retiredChatModelIds(provider.id).has(row.modelId);
    };
    const inCode = (row: CatalogueRow) => providers.get(row.providerId)?.chatModels.some((model) => model.id === row.modelId) ?? false;
    const queue = lookupQueue([...after.values()], profiles, inCode, usable);
    const deadline = Math.min(deps.now() + lookups.budgetMs, startedMs + LOOKUP_STOP_MS);
    const results: DraftSave[] = [];
    let looked = 0;
    const { observations } = await collectModelObservations(async () => {
        for (const { row } of queue) {
            const provider = providers.get(row.providerId)!;
            const previous = profiles.find((entry) => entry.providerId === row.providerId && entry.modelId === row.modelId);
            const failedBefore = previous?.draftStatus === "failed" ? previous.lookupAttempts : 0;
            const sibling = findSibling(row, profiles);
            if (sibling?.profile) {
                results.push({ providerId: row.providerId, modelId: row.modelId, attempts: 0, outcome: { ok: true, draft: siblingDraft(sibling.profile, sibling.tags, keyOf(sibling), capsFor(provider, row)) } });
                continue;
            }
            if (looked >= lookups.maxPerRun || deps.now() >= deadline) {
                summary.lookupsDeferred += 1;
                continue;
            }
            looked += 1;
            const outcome = await lookups.lookup(provider, row).catch((error): LookupOutcome => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
            results.push({ providerId: row.providerId, modelId: row.modelId, attempts: outcome.ok ? 0 : failedBefore + 1, outcome });
        }
    }, ["public_search"]);
    await deps.persistObservations(observations).catch((error) => console.error("[ModelDiscovery] Could not store lookup observations:", error instanceof Error ? error.message : error));
    summary.drafted = results.filter((entry) => entry.outcome.ok).map(keyOf);
    summary.draftFailed = results.filter((entry) => !entry.outcome.ok).map(keyOf);
    return results;
}

export interface LookupSummary {
    kind: "lookup";
    providerId: string;
    modelId: string;
    status: "ready" | "failed";
    error: string | null;
}

/** One lookup on request, under a lock taken with `startDiscoveryRun("manual")`. Always a fresh lookup, never a sibling copy. */
export async function executeModelLookup(runId: string, providerId: string, modelId: string, deps: DiscoveryDeps): Promise<LookupSummary | null> {
    const startedMs = deps.now();
    let failedAttempts = 1;
    try {
        const lookups = deps.lookups;
        if (!lookups) throw new Error("Model lookups are not configured.");
        const provider = deps.providers.find((entry) => entry.id === providerId);
        if (!provider) throw new Error(`Unknown provider ${providerId}.`);
        const read = await deps.readRows();
        if (!read.ok) throw new Error(`The model catalogue is ${read.reason === "migration_required" ? "not set up" : "unavailable"}.`);
        const row = read.rows.find((entry) => entry.providerId === providerId && entry.modelId === modelId);
        if (!row) throw new Error("That model is not in the catalogue.");
        const profiles = await lookups.readProfiles();
        if (!profiles) throw new Error("The model profile table is missing. Apply scripts/migrations/v7-model-awareness.sql.");
        const previous = profiles.find((entry) => entry.providerId === providerId && entry.modelId === modelId);
        failedAttempts = (previous?.draftStatus === "failed" ? previous.lookupAttempts : 0) + 1;
        const { value: outcome, observations } = await collectModelObservations(
            () => lookups.lookup(provider, row).catch((error): LookupOutcome => ({ ok: false, error: error instanceof Error ? error.message : String(error) })),
            ["public_search"],
        );
        await deps.persistObservations(observations).catch((error) => console.error("[ModelLookup] Could not store lookup observations:", error instanceof Error ? error.message : error));
        await lookups.saveDrafts([{ providerId, modelId, attempts: outcome.ok ? 0 : failedAttempts, outcome }]);
        await deps.refreshSnapshot().catch((error) => console.error("[ModelLookup] Snapshot refresh failed:", error instanceof Error ? error.message : error));
        const summary: LookupSummary = { kind: "lookup", providerId, modelId, status: outcome.ok ? "ready" : "failed", error: outcome.ok ? null : outcome.error.slice(0, 300) };
        await deps.finishRun(runId, "done", { ...summary, durationMs: deps.now() - startedMs });
        return summary;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[ModelLookup] Lookup failed:", message);
        // The route marked the draft pending; leave it failed rather than stuck.
        await deps.lookups?.saveDrafts([{ providerId, modelId, attempts: failedAttempts, outcome: { ok: false, error: message } }]).catch(() => {});
        await deps.finishRun(runId, "failed", { kind: "lookup", providerId, modelId, error: message.slice(0, 500), durationMs: deps.now() - startedMs })
            .catch((finishError) => console.error("[ModelLookup] Could not finish the run row:", finishError instanceof Error ? finishError.message : finishError));
        return null;
    }
}

/** Probes one stored model, paid ones included, under a lock taken with `startDiscovery("manual")`. Sends no notification. */
export async function executeModelTest(runId: string, providerId: string, modelId: string, deps: DiscoveryDeps): Promise<TestSummary | null> {
    const startedMs = deps.now();
    try {
        const provider = deps.providers.find((entry) => entry.id === providerId);
        const apiKey = provider ? deps.apiKey(provider) : undefined;
        if (!provider || provider.unavailableReason || !apiKey) throw new Error(`${provider?.label ?? providerId} is unavailable or has no key.`);
        const read = await deps.readRows();
        if (!read.ok) throw new Error(`The model catalogue is ${read.reason === "migration_required" ? "not set up" : "unavailable"}.`);
        const row = read.rows.find((entry) => entry.providerId === providerId && entry.modelId === modelId);
        if (!row) throw new Error("That model is not in the catalogue.");
        if (rowKind(row) !== "chat") return await testTypedModel(runId, provider, apiKey, row, read.rows, deps, startedMs);

        const checkVision = !row.inputs.length || row.inputs.includes("image");
        const { value: result, observations } = await collectModelObservations(() => deps.probe({ provider, modelId, apiKey, checkVision }));
        await deps.persistObservations(observations).catch((error) => console.error("[ModelDiscovery] Could not store probe observations:", error instanceof Error ? error.message : error));
        const next = applyProbe(row, result, new Date(deps.now()).toISOString());
        await deps.saveRows([{ row: next, probeDetail: { retired: result.retired, steps: result.steps } }], new Date(deps.now()).toISOString());
        await deps.refreshSnapshot().catch((error) => console.error("[ModelDiscovery] Snapshot refresh failed:", error instanceof Error ? error.message : error));
        const summary: TestSummary = { kind: "test", providerId, modelId, status: next.probeStatus, retired: result.retired, chatMs: result.chatMs };
        await deps.finishRun(runId, "done", { ...summary, durationMs: deps.now() - startedMs });
        return summary;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[ModelDiscovery] Test failed:", message);
        await deps.finishRun(runId, "failed", { kind: "test", providerId, modelId, error: message.slice(0, 500), durationMs: deps.now() - startedMs })
            .catch((finishError) => console.error("[ModelDiscovery] Could not finish the run row:", finishError instanceof Error ? finishError.message : finishError));
        return null;
    }
}

/** The same-space reference: the knowledge model's vectors, when the target shares its family and is not it. */
async function referenceForTest(row: CatalogueRow, rows: readonly CatalogueRow[], deps: DiscoveryDeps): Promise<SpaceReference | undefined> {
    const active = deps.inUse ? (await deps.inUse(rows).catch(() => null))?.embedding : null;
    if (!active || (active.providerId === row.providerId && active.modelId === row.modelId)) return undefined;
    const primaryRow = rows.find((entry) => entry.providerId === active.providerId && entry.modelId === active.modelId);
    const provider = deps.providers.find((entry) => entry.id === active.providerId);
    const apiKey = provider ? deps.apiKey(provider) : undefined;
    if (!provider || !apiKey || familyOf(row) !== (primaryRow ? familyOf(primaryRow) : familyFromId(active.modelId))) return undefined;
    const result = await deps.probeTyped!({ kind: "embedding", provider, modelId: active.modelId, apiKey }).catch(() => null);
    return result?.vectors ? { partitionId: active.modelId, ...result.vectors } : undefined;
}

async function testTypedModel(runId: string, provider: ProviderConfig, apiKey: string, row: CatalogueRow, rows: readonly CatalogueRow[], deps: DiscoveryDeps, startedMs: number): Promise<TestSummary> {
    if (!deps.probeTyped) throw new Error("Embedding, speech and transcription tests are not configured.");
    const kind = rowKind(row) as NonChatKind;
    const { value: result, observations } = await collectModelObservations(async () => deps.probeTyped!({
        kind, provider, modelId: row.modelId, apiKey, listedVoices: row.traits?.voices,
        reference: kind === "embedding" ? await referenceForTest(row, rows, deps) : undefined,
    }));
    await deps.persistObservations(observations).catch((error) => console.error("[ModelDiscovery] Could not store probe observations:", error instanceof Error ? error.message : error));
    const next = applyTypedProbe(row, result, new Date(deps.now()).toISOString());
    await deps.saveRows([{ row: next, probeDetail: { retired: result.retired, retiredAt: result.retiredAt, steps: result.steps } }], new Date(deps.now()).toISOString());
    await deps.refreshSnapshot().catch((error) => console.error("[ModelDiscovery] Snapshot refresh failed:", error instanceof Error ? error.message : error));
    const summary: TestSummary = { kind: "test", providerId: row.providerId, modelId: row.modelId, modelKind: kind, status: next.probeStatus, retired: result.retired, chatMs: result.ms };
    await deps.finishRun(runId, "done", { ...summary, durationMs: deps.now() - startedMs });
    return summary;
}

/** Routes in use now: the knowledge model and its approved backups, the voice and the transcription model. */
async function liveInUse(rows: readonly CatalogueRow[]): Promise<InUse> {
    const [{ refreshEmbeddingOverride }, { getEmbeddingRef }, { readVoiceChoices }, { inUseRoutes }] = await Promise.all([
        import("@/lib/ai/embedding-override"), import("@/lib/ai/embeddings"), import("@/lib/ai/voice-choices"), import("@/lib/ai/catalogue/in-use"),
    ]);
    await refreshEmbeddingOverride();
    const ref = getEmbeddingRef();
    const choices = await readVoiceChoices();
    return inUseRoutes({
        embedding: { partitionId: ref.model.id, providerId: ref.provider.id, modelId: ref.model.apiId ?? ref.model.id },
        speech: choices.speech, transcription: choices.transcription,
    }, rows);
}

/** Real dependencies. Imported lazily so this module loads without Supabase or messaging configuration. */
export async function liveDiscoveryDeps(): Promise<DiscoveryDeps> {
    const [store, router, health, publicUrl, profileStore] = await Promise.all([
        import("@/lib/ai/catalogue/store"), import("@/lib/messaging/router"), import("@/lib/ai/model-health"), import("@/lib/public-url"),
        import("@/lib/ai/models/store"),
    ]);
    return {
        providers: PROVIDERS,
        apiKey: getProviderApiKey,
        list: (provider, discovery, apiKey) => listProviderModels(provider, discovery, apiKey),
        probe: (target) => probeModel(target),
        readRows: store.readCatalogueRows,
        saveRows: store.saveCatalogueRows,
        startRun: store.startDiscoveryRun,
        finishRun: store.finishDiscoveryRun,
        recentSummaries: (runId) => store.recentDiscoverySummaries(runId),
        notify: async (text) => (await router.notify("model_catalogue", text)).discord,
        persistObservations: async (observations) => { await health.persistModelObservations(observations); },
        refreshSnapshot: async () => { await refreshCatalogueSnapshot(); },
        now: Date.now,
        maxProbes: maxProbesFromEnv(),
        runBudgetMs: RUN_BUDGET_MS,
        reviewLink: publicUrl.ownerLink("/admin#models"),
        removedKeys: () => removedModelKeys(catalogueSnapshot().profiles),
        probeTyped: (target) => probeTypedModel(target),
        typesEnabled: () => typesDiscoveryEnabled() && store.catalogueTypesAvailable() === true,
        inUse: liveInUse,
        expiryLookups: lookupEnabled() ? {
            maxPerRun: MAX_EXPIRY_LOOKUPS,
            lookup: async (provider, row) => {
                const retirement = await import("@/lib/ai/models/retirement-lookup");
                return retirement.lookupRetirement({ providerId: provider.id, providerLabel: provider.label, modelId: row.modelId, label: row.label }, retirement.liveRetirementDeps());
            },
        } : undefined,
        lookups: {
            maxPerRun: lookupEnabled() ? maxLookupsFromEnv() : 0,
            budgetMs: LOOKUP_BUDGET_MS,
            readProfiles: async () => {
                const result = await profileStore.readProfiles();
                return result.ok ? result.profiles : null;
            },
            // Loaded on first use: the Gemini client module throws at import time when no key is set.
            lookup: async (provider, row) => {
                const [lookup, live] = await Promise.all([import("@/lib/ai/models/lookup"), import("@/lib/ai/models/lookup-live")]);
                return lookup.lookupModel(live.lookupTarget(provider, row), live.liveLookupDeps());
            },
            saveDrafts: profileStore.saveDrafts,
        },
    };
}
