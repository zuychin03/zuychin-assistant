import { PROVIDERS, getProviderApiKey, retiredChatModelIds, type ProviderConfig } from "@/lib/ai/providers";
import { listProviderModels, selectDiscoverable, shortNameFor, uniqueShortName, type ListedModel, type ListingResult, type ProviderDiscovery } from "@/lib/ai/catalogue/sources";
import { probeModel, type ProbeResult, type ProbeTarget } from "@/lib/ai/catalogue/probe";
import { refreshCatalogueSnapshot, type CatalogueRow } from "@/lib/ai/catalogue/snapshot";
import { collectModelObservations } from "@/lib/ai/model-observations";
import type { DiscoveryTrigger, SavedRow, StartRunResult, StorageFailure } from "@/lib/ai/catalogue/store";

const RETEST_AFTER_MS = 7 * 24 * 60 * 60_000;
const MAX_INCONCLUSIVE = 3;
const MISSING_AFTER = 2;
// New probes stop here so a run ends inside the store's 30-minute stale-lock window, even when one probe takes its full 6 minutes.
const RUN_BUDGET_MS = 20 * 60_000;
const DEFAULT_MAX_PROBES = 10;
// Keeps one notification under Discord's 2000-character message limit.
const NOTIFY_LIST_MAX = 12;

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
}

export interface TestSummary {
    kind: "test";
    providerId: string;
    modelId: string;
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

export function startFailure(reason: "busy" | StorageFailure): { status: number; error: string } {
    if (reason === "busy") return { status: 409, error: "A model check is already running. Try again when it finishes." };
    if (reason === "migration_required") return { status: 503, error: "The model catalogue tables are missing. Apply scripts/migrations/v7-model-catalogue.sql." };
    return { status: 503, error: "The model catalogue is unavailable. Please retry." };
}

function metadataFrom(row: CatalogueRow, listed: ListedModel, provider: ProviderConfig): CatalogueRow {
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
    }, listed, provider);
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

/** Probe order: new free models, then inconclusive retries, then free picker models whose last probe is over 7 days old. Paid models never. */
export function probePriority(row: CatalogueRow, inCode: boolean, listedNow: boolean, nowMs: number): number | null {
    if (!row.free || !listedNow || row.missingSince !== null) return null;
    if (row.origin === "discovered" && row.probeStatus === "untested") return 0;
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

export function discoveryMessage(parts: { passed: string[]; missing: string[]; failedRetests: string[]; listingFailed: string[] }, reviewLink: string): string | null {
    const body = [
        ...section("New models passed their tests, not yet approved for automatic routes", parts.passed),
        ...section("Missing from the provider's list, still selectable", parts.missing),
        ...section("Approved models that failed a re-test", parts.failedRetests),
        ...section("Provider list failed twice in a row", parts.listingFailed),
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
    const summary: RunSummary = {
        kind: "run", trigger, providers: {}, added: [], passed: [], newlyMissing: [], failedRetests: [],
        notified: false, budgetReached: false, durationMs: 0,
    };
    const listingFailed: string[] = [];
    const probeQueues: { provider: ProviderConfig; apiKey: string; rows: CatalogueRow[]; entry: ProviderRunSummary }[] = [];

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
        // An empty list is treated as a failed one, so a provider hiccup never marks every model missing.
        if (!result.ok || !result.models.length) {
            const failures = previousFailures(earlier, provider.id) + 1;
            const httpStatus = result.ok ? null : result.status;
            summary.providers[provider.id] = { listing: "failed", listingFailures: failures, httpStatus, error: result.ok ? "The list was empty." : result.error.slice(0, 300) };
            if (failures === 2) listingFailed.push(`${provider.label}${httpStatus ? ` (HTTP ${httpStatus})` : ""}`);
            continue;
        }

        const retired = retiredChatModelIds(provider.id);
        const codeIds = new Set(provider.chatModels.map((model) => model.id));
        const listing = new Map(result.models.map((model) => [model.modelId, model]));
        const tracked = selectDiscoverable(result.models, discovery, retired);
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

        const queue = [...after.values()]
            .filter((row) => row.providerId === provider.id && !retired.has(row.modelId))
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
    const { observations } = await collectModelObservations(() => Promise.all(probeQueues.map(async ({ provider, apiKey, rows, entry }) => {
        const counts = { probed: 0, passed: 0, failed: 0, inconclusive: 0 };
        Object.assign(entry, counts);
        for (const [index, row] of rows.entries()) {
            if (deps.now() - startedMs >= deps.runBudgetMs) {
                summary.budgetReached = true;
                entry.deferred = (entry.deferred ?? 0) + rows.length - index;
                break;
            }
            const checkVision = !row.inputs.length || row.inputs.includes("image");
            const result = await deps.probe({ provider, modelId: row.modelId, apiKey, checkVision }).catch((error): ProbeResult => {
                console.error(`[ModelDiscovery] Probe crashed for ${keyOf(row)}:`, error instanceof Error ? error.message : error);
                const step = { outcome: "transient" as const, httpStatus: null, ms: null, detail: "The probe crashed." };
                return { status: "inconclusive", retired: false, chatMs: null, supportsTools: null, supportsSearch: null, supportsVision: null, steps: { chat: step, tools: step, forced: step, vision: step } };
            });
            const next = applyProbe(after.get(keyOf(row)) ?? row, result, new Date(deps.now()).toISOString());
            after.set(keyOf(next), next);
            probeDetails.set(keyOf(next), { retired: result.retired, steps: result.steps });
            counts.probed += 1;
            counts[result.status === "passed" ? "passed" : result.status === "failed" ? "failed" : "inconclusive"] += 1;
            Object.assign(entry, counts);
        }
    })));
    await deps.persistObservations(observations).catch((error) => console.error("[ModelDiscovery] Could not store probe observations:", error instanceof Error ? error.message : error));

    const passedLines: string[] = [], missingLines: string[] = [], failedLines: string[] = [], missingKeys: string[] = [];
    for (const provider of deps.providers) {
        const codeIds = new Set(provider.chatModels.map((model) => model.id));
        const retired = retiredChatModelIds(provider.id);
        for (const row of after.values()) {
            if (row.providerId !== provider.id || retired.has(row.modelId)) continue;
            const old = before.get(keyOf(row));
            const inCode = codeIds.has(row.modelId);
            if (old?.probeStatus !== "passed" && row.probeStatus === "passed" && row.origin === "discovered" && row.approvedAt === null) {
                summary.passed.push(keyOf(row));
                passedLines.push(describe(provider, row));
            }
            if (old && old.probeStatus !== "failed" && row.probeStatus === "failed" && (inCode || row.approvedAt !== null)) {
                summary.failedRetests.push(keyOf(row));
                failedLines.push(describe(provider, row));
            }
            if (row.missingSince !== null && row.notifiedMissingAt === null && inPicker(row, inCode)) {
                missingKeys.push(keyOf(row));
                missingLines.push(describe(provider, row));
            }
        }
    }
    summary.newlyMissing = missingKeys;

    const message = discoveryMessage({ passed: passedLines, missing: missingLines, failedRetests: failedLines, listingFailed }, deps.reviewLink);
    if (message) {
        summary.notified = await deps.notify(message).catch((error) => {
            console.error("[ModelDiscovery] Notification failed:", error instanceof Error ? error.message : error);
            return false;
        });
        // Undelivered missing notices are retried by the next run.
        if (summary.notified) {
            for (const key of missingKeys) after.set(key, { ...after.get(key)!, notifiedMissingAt: now });
        }
    }

    const changed: SavedRow[] = [];
    for (const [key, row] of after) {
        const detail = probeDetails.get(key);
        if (detail !== undefined || JSON.stringify(before.get(key)) !== JSON.stringify(row)) changed.push({ row, probeDetail: detail });
    }
    if (changed.length) await deps.saveRows(changed, new Date(deps.now()).toISOString());
    await deps.refreshSnapshot().catch((error) => console.error("[ModelDiscovery] Snapshot refresh failed:", error instanceof Error ? error.message : error));
    summary.durationMs = deps.now() - startedMs;
    return summary;
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

/** Real dependencies. Imported lazily so this module loads without Supabase or messaging configuration. */
export async function liveDiscoveryDeps(): Promise<DiscoveryDeps> {
    const [store, router, health, publicUrl] = await Promise.all([
        import("@/lib/ai/catalogue/store"), import("@/lib/messaging/router"), import("@/lib/ai/model-health"), import("@/lib/public-url"),
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
    };
}
