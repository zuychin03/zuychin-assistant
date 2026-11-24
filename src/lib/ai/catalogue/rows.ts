import type { CatalogueRow, CatalogueStorage, ExpiresSource, ModelTraits, ProbeStatus } from "@/lib/ai/catalogue/snapshot";
import { MODEL_KINDS, type ModelKind } from "@/lib/ai/catalogue/sources";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/;
const PROBE_STATUSES: readonly ProbeStatus[] = ["untested", "passed", "failed", "inconclusive"];
const EXPIRES_SOURCES: readonly ExpiresSource[] = ["listing", "lookup", "gone"];

export const LEGACY_CATALOGUE_COLUMNS = [
    "provider_id", "model_id", "origin", "label", "short_name", "description", "developer", "free", "metered", "may_train",
    "context_tokens", "max_output_tokens", "inputs", "listed_tools", "listed_structured", "listed_thinking",
    "probe_status", "probe_attempts", "probed_at", "probe_chat_ms",
    "supports_tools", "supports_search", "supports_vision", "supports_thinking", "supports_structured",
    "first_seen_at", "last_seen_at", "missed_checks", "missing_since", "notified_missing_at", "approved_at",
].join(", ");

// Added by v7-model-types.sql; reads fall back to the legacy list until it is applied.
export const TYPES_COLUMNS = "kind, dimension, expires_at, expires_source, notified_expiry_days, expiry_checked_at, space_of, traits";
export const CATALOGUE_COLUMNS = `${LEGACY_CATALOGUE_COLUMNS}, ${TYPES_COLUMNS}`;

/** PostgREST and Postgres codes for a column the database does not have yet. */
export function missingColumn(error: unknown): boolean {
    const code = record(error).code;
    return code === "42703" || code === "PGRST204";
}

const TRAIT_STRINGS = ["defaultVoice", "audioFormat", "familyId", "lookupUrl", "promptTemplate"] as const;
const TRAIT_NUMBERS = ["sampleRate", "channels", "firstAudioMs", "audioSec", "accuracy", "maxPairTokens", "outputTokens"] as const;
const TRAIT_FLAGS = ["needsInputType", "acceptsInputType", "asymmetric", "truncatable", "batch", "images", "imagePassages", "editing"] as const;
const TRAIT_LISTS = { voices: 300, sizes: 40, languages: 200 } as const;

export function traitsFromDb(raw: unknown): ModelTraits {
    const value = record(raw);
    const traits: ModelTraits = {};
    for (const [key, max] of Object.entries(TRAIT_LISTS) as [keyof typeof TRAIT_LISTS, number][]) {
        const list = value[key];
        if (Array.isArray(list)) traits[key] = list.filter((entry): entry is string => typeof entry === "string").slice(0, max);
    }
    for (const key of TRAIT_STRINGS) if (typeof value[key] === "string" && value[key]) traits[key] = (value[key] as string).slice(0, 500);
    for (const key of TRAIT_NUMBERS) if (typeof value[key] === "number" && Number.isFinite(value[key])) traits[key] = value[key] as number;
    for (const key of TRAIT_FLAGS) if (typeof value[key] === "boolean") traits[key] = value[key] as boolean;
    return traits;
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const flag = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
const whole = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const stamp = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const words = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;

/** `{ providerId, modelId }` from a request body, or null when either id is malformed. */
export function catalogueModelRef(raw: unknown): { providerId: string; modelId: string } | null {
    const body = record(raw);
    const { providerId, modelId } = body;
    return typeof providerId === "string" && ID.test(providerId) && typeof modelId === "string" && ID.test(modelId) ? { providerId, modelId } : null;
}

export function catalogueRowFromDb(raw: unknown): CatalogueRow | null {
    const row = record(raw);
    const providerId = row.provider_id, modelId = row.model_id;
    if (typeof providerId !== "string" || !ID.test(providerId) || typeof modelId !== "string" || !ID.test(modelId)) return null;
    if (row.origin !== "seed" && row.origin !== "discovered") return null;
    const label = words(row.label), shortName = words(row.short_name), firstSeenAt = stamp(row.first_seen_at);
    if (!label || !shortName || !firstSeenAt || typeof row.free !== "boolean" || typeof row.metered !== "boolean") return null;
    const probeStatus = PROBE_STATUSES.includes(row.probe_status as ProbeStatus) ? row.probe_status as ProbeStatus : "untested";
    return {
        providerId, modelId, origin: row.origin, label, shortName,
        description: words(row.description), developer: words(row.developer),
        free: row.free, metered: row.metered, mayTrain: flag(row.may_train),
        contextTokens: whole(row.context_tokens), maxOutputTokens: whole(row.max_output_tokens),
        inputs: Array.isArray(row.inputs) ? row.inputs.filter((entry): entry is string => typeof entry === "string") : [],
        listedTools: flag(row.listed_tools), listedStructured: flag(row.listed_structured), listedThinking: flag(row.listed_thinking),
        probeStatus, probeAttempts: whole(row.probe_attempts) ?? 0, probedAt: stamp(row.probed_at),
        probeChatMs: typeof row.probe_chat_ms === "number" && Number.isFinite(row.probe_chat_ms) && row.probe_chat_ms >= 0 ? row.probe_chat_ms : null,
        supportsTools: flag(row.supports_tools), supportsSearch: flag(row.supports_search), supportsVision: flag(row.supports_vision),
        supportsThinking: flag(row.supports_thinking), supportsStructured: flag(row.supports_structured),
        firstSeenAt, lastSeenAt: stamp(row.last_seen_at), missedChecks: whole(row.missed_checks) ?? 0,
        missingSince: stamp(row.missing_since), notifiedMissingAt: stamp(row.notified_missing_at), approvedAt: stamp(row.approved_at),
        ...("kind" in row ? typesFromDb(row) : {}),
    };
}

function typesFromDb(row: Record<string, unknown>): Partial<CatalogueRow> {
    const kind: ModelKind = MODEL_KINDS.includes(row.kind as ModelKind) ? row.kind as ModelKind : "chat";
    const notified = typeof row.notified_expiry_days === "number" && Number.isSafeInteger(row.notified_expiry_days) && row.notified_expiry_days >= 0 ? row.notified_expiry_days : null;
    return {
        kind,
        dimension: whole(row.dimension),
        expiresAt: stamp(row.expires_at),
        expiresSource: EXPIRES_SOURCES.includes(row.expires_source as ExpiresSource) ? row.expires_source as ExpiresSource : null,
        notifiedExpiryDays: notified,
        expiryCheckedAt: stamp(row.expiry_checked_at),
        spaceOf: typeof row.space_of === "string" && ID.test(row.space_of) ? row.space_of : null,
        traits: traitsFromDb(row.traits),
    };
}

/**
 * Columns the discovery run owns. `approved_at` is left out so a run never overwrites an approval made meanwhile,
 * and `probe_detail` is written only when a probe ran.
 */
export function catalogueRowToDb(row: CatalogueRow, now: string, probeDetail?: unknown, typesColumns = true): Record<string, unknown> {
    return {
        ...(probeDetail === undefined ? {} : { probe_detail: probeDetail }),
        ...(typesColumns ? {
            kind: row.kind ?? "chat", dimension: row.dimension ?? null, expires_at: row.expiresAt ?? null, expires_source: row.expiresSource ?? null,
            notified_expiry_days: row.notifiedExpiryDays ?? null, expiry_checked_at: row.expiryCheckedAt ?? null,
            space_of: row.spaceOf ?? null, traits: row.traits ?? {},
        } : {}),
        provider_id: row.providerId, model_id: row.modelId, origin: row.origin, label: row.label, short_name: row.shortName,
        description: row.description, developer: row.developer, free: row.free, metered: row.metered, may_train: row.mayTrain,
        context_tokens: row.contextTokens, max_output_tokens: row.maxOutputTokens, inputs: row.inputs,
        listed_tools: row.listedTools, listed_structured: row.listedStructured, listed_thinking: row.listedThinking,
        probe_status: row.probeStatus, probe_attempts: row.probeAttempts, probed_at: row.probedAt, probe_chat_ms: row.probeChatMs,
        supports_tools: row.supportsTools, supports_search: row.supportsSearch, supports_vision: row.supportsVision,
        supports_thinking: row.supportsThinking, supports_structured: row.supportsStructured,
        first_seen_at: row.firstSeenAt, last_seen_at: row.lastSeenAt, missed_checks: row.missedChecks,
        missing_since: row.missingSince, notified_missing_at: row.notifiedMissingAt, updated_at: now,
    };
}

export function catalogueStorageFailure(error: unknown): Exclude<CatalogueStorage, "empty" | "ok"> {
    const code = record(error).code;
    return code === "PGRST202" || code === "PGRST204" || code === "PGRST205" || code === "42P01" || code === "42883" || code === "42703"
        ? "migration_required"
        : "unavailable";
}
