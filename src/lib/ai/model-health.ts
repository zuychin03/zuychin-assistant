import { supabaseAdmin } from "@/lib/supabase";
import { listProvidersPublic } from "@/lib/ai/providers";
import type { ModelCallObservation } from "@/lib/ai/model-observations";

const PURPOSES = ["chat", "embedding", "routing", "worker", "orchestration", "compaction", "continuation", "extraction", "summary", "title", "search", "speech", "study"] as const;
const STATUSES = ["success", "auth", "rate_limit", "transient", "unavailable", "retired", "aborted", "unknown"] as const;
const ERROR_CLASSES = ["http", "abort", "timeout", "transport", "unknown"] as const;
const CAPABILITIES = ["streaming", "tools", "vision", "grounding"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/;
const MAX_DURATION_MS = 86_400_000;

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const nullable = (value: unknown, test: (value: unknown) => boolean) => value === null || test(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const duration = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_DURATION_MS;
const timestamp = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const identifier = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const member = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && values.includes(value as T);

export interface ModelObservationContext {
    conversationId?: string;
    messageId?: string;
    userProfileId?: string;
}
export interface ModelHealthStorage {
    available: boolean;
    reason: "migration_required" | "unavailable" | null;
    message: string | null;
}
export interface ModelHealthSummary {
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    abortedCalls: number;
    unknownCalls: number;
    latestAt: string;
    latestStatus: ModelCallObservation["status"];
    latestErrorClass: ModelCallObservation["errorClass"];
    latestHttpStatus: number | null;
    latestDurationMs: number;
    latestFirstAnswerMs: number | null;
    lastSuccessfulAt: string | null;
    medianSuccessDurationMs: number | null;
    medianFirstAnswerMs: number | null;
    firstObservedAt: string;
    purposes: string[];
}
export interface ModelHealthEntry {
    providerId: string;
    providerLabel: string;
    modelId: string;
    modelLabel: string;
    kind: "chat" | "embedding" | "speech" | "historical";
    catalogue: "current" | "unavailable" | "historical";
    configured: boolean;
    unavailableReason: string | null;
    free: boolean | null;
    health: ModelHealthSummary | null;
    capabilities: Record<typeof CAPABILITIES[number], { observedAt: string | null }>;
}
export interface ModelHealthReport {
    scope: "assistant";
    generatedAt: string;
    storage: ModelHealthStorage;
    models: ModelHealthEntry[];
}

function storageFailure(error: unknown): ModelHealthStorage {
    const code = record(error).code;
    const missing = code === "PGRST202" || code === "PGRST204" || code === "PGRST205" || code === "42P01" || code === "42883";
    return { available: false, reason: missing ? "migration_required" : "unavailable", message: missing
        ? "Model health storage is not installed. Apply the V6 model health migration, then retry."
        : "Model health records could not be loaded or saved. Please retry." };
}

function observationRow(value: unknown, context: ModelObservationContext): Record<string, unknown> | null {
    const observation = record(value);
    const usage = record(observation.usage);
    const capabilities = record(observation.capabilities);
    if (typeof observation.id !== "string" || !UUID.test(observation.id)
        || !identifier(observation.providerId) || !identifier(observation.modelId)
        || !member(PURPOSES, observation.purpose) || !timestamp(observation.startedAt)
        || !duration(observation.durationMs) || !nullable(observation.firstAnswerMs, duration)
        || (typeof observation.firstAnswerMs === "number" && observation.firstAnswerMs > observation.durationMs)
        || !member(STATUSES, observation.status) || !nullable(observation.errorClass, value => member(ERROR_CLASSES, value))
        || !nullable(observation.httpStatus, value => count(value) && value >= 100 && value <= 599)
        || !["complete", "partial", "unavailable"].includes(String(usage.completeness))
        || !["promptTokens", "outputTokens", "totalTokens", "cachedInputTokens"].every(key => nullable(usage[key], count))
        || !CAPABILITIES.every(key => typeof capabilities[key] === "boolean")) return null;
    if (typeof usage.cachedInputTokens === "number" && typeof usage.promptTokens === "number" && usage.cachedInputTokens > usage.promptTokens) return null;
    if (observation.status === "retired" && observation.httpStatus !== 410) return null;
    if (usage.completeness === "complete" && [usage.promptTokens, usage.outputTokens, usage.totalTokens].some(value => value === null)) return null;
    return {
        id: observation.id, execution_scope: "assistant", provider_id: observation.providerId, model_id: observation.modelId,
        purpose: observation.purpose, started_at: observation.startedAt, duration_ms: observation.durationMs, first_answer_ms: observation.firstAnswerMs,
        status: observation.status, error_class: observation.errorClass, http_status: observation.httpStatus,
        prompt_tokens: usage.promptTokens, output_tokens: usage.outputTokens, total_tokens: usage.totalTokens,
        cached_input_tokens: usage.cachedInputTokens, usage_completeness: usage.completeness,
        streaming_observed: capabilities.streaming, tools_observed: capabilities.tools, vision_observed: capabilities.vision, grounding_observed: capabilities.grounding,
        conversation_id: context.conversationId ?? null, message_id: context.messageId ?? null, user_profile_id: context.userProfileId ?? null,
    };
}

export async function persistModelObservations(observations: readonly unknown[], context: ModelObservationContext = {}) {
    const result = { stored: 0, dropped: 0, available: true, error: null as ModelHealthStorage["reason"] };
    if (Object.values(context).some(value => value !== undefined && (typeof value !== "string" || !UUID.test(value)))) {
        return { ...result, dropped: observations.length };
    }
    const rows = observations.map(value => observationRow(value, context)).filter((row): row is Record<string, unknown> => row !== null);
    result.dropped = observations.length - rows.length;
    if (!rows.length) return result;
    try {
        const { error } = await supabaseAdmin.from("model_call_observations").upsert(rows, { onConflict: "id", ignoreDuplicates: true })
            .abortSignal(AbortSignal.timeout(2000));
        if (error) return { ...result, available: false, error: storageFailure(error).reason };
        return { ...result, stored: rows.length };
    } catch {
        return { ...result, available: false, error: "unavailable" as const };
    }
}

const emptyCapabilities = (): ModelHealthEntry["capabilities"] => ({ streaming: { observedAt: null }, tools: { observedAt: null }, vision: { observedAt: null }, grounding: { observedAt: null } });

function catalogue(): ModelHealthEntry[] {
    return listProvidersPublic().flatMap(provider => [
        ...provider.chatModels.map(model => ({ model, kind: "chat" as const, unavailable: null as string | null })),
        ...provider.unavailableChatModels.map(model => ({ model, kind: "chat" as const, unavailable: model.reason })),
        ...provider.embeddingModels.map(model => ({ model, kind: "embedding" as const, unavailable: null as string | null })),
        ...(provider.id === "gemini" ? [{ model: { id: process.env.GEMINI_TTS_MODEL ?? "gemini-3.1-flash-tts-preview", label: "Gemini speech", free: false },
            kind: "speech" as const, unavailable: null as string | null }] : []),
    ].map(({ model, kind, unavailable }) => ({
        providerId: provider.id, providerLabel: provider.label, modelId: model.id, modelLabel: model.label,
        kind, catalogue: unavailable ? "unavailable" as const : "current" as const,
        configured: provider.available && !unavailable, unavailableReason: unavailable ?? provider.unavailableReason ?? (provider.available ? null : "Provider key is not configured."),
        free: model.free, health: null, capabilities: emptyCapabilities(),
    })));
}

function aggregateHealth(raw: unknown): { providerId: string; modelId: string; health: ModelHealthSummary; capabilities: ModelHealthEntry["capabilities"] } | null {
    const row = record(raw);
    if (!identifier(row.provider_id) || !identifier(row.model_id)
        || !["total_calls", "successful_calls", "failed_calls", "aborted_calls", "unknown_calls"].every(key => count(row[key]))
        || !timestamp(row.latest_at) || !timestamp(row.first_observed_at) || !member(STATUSES, row.latest_status)
        || !nullable(row.latest_error_class, value => member(ERROR_CLASSES, value))
        || !nullable(row.latest_http_status, value => count(value) && value >= 100 && value <= 599)
        || !duration(row.latest_duration_ms) || !nullable(row.latest_first_answer_ms, duration)
        || !nullable(row.last_success_at, timestamp) || !nullable(row.median_success_duration_ms, duration)
        || !nullable(row.median_first_answer_ms, duration)
        || !CAPABILITIES.every(key => nullable(row[`${key}_observed_at`], timestamp))
        || !Array.isArray(row.purposes) || !row.purposes.every(value => member(PURPOSES, value))) return null;
    const capabilities = emptyCapabilities();
    for (const key of CAPABILITIES) capabilities[key].observedAt = row[`${key}_observed_at`] as string | null;
    return { providerId: row.provider_id, modelId: row.model_id, capabilities, health: {
        totalCalls: row.total_calls as number, successfulCalls: row.successful_calls as number, failedCalls: row.failed_calls as number, abortedCalls: row.aborted_calls as number, unknownCalls: row.unknown_calls as number,
        latestAt: row.latest_at, latestStatus: row.latest_status, latestErrorClass: row.latest_error_class as ModelCallObservation["errorClass"], latestHttpStatus: row.latest_http_status as number | null,
        latestDurationMs: row.latest_duration_ms, latestFirstAnswerMs: row.latest_first_answer_ms as number | null,
        lastSuccessfulAt: row.last_success_at as string | null, medianSuccessDurationMs: row.median_success_duration_ms as number | null,
        medianFirstAnswerMs: row.median_first_answer_ms as number | null, firstObservedAt: row.first_observed_at, purposes: row.purposes as string[],
    } };
}

export async function getModelHealth(): Promise<ModelHealthReport> {
    const report: ModelHealthReport = { scope: "assistant", generatedAt: new Date().toISOString(), storage: { available: true, reason: null, message: null }, models: catalogue() };
    try {
        const { data, error } = await supabaseAdmin.rpc("assistant_model_health").abortSignal(AbortSignal.timeout(10_000));
        if (error) return { ...report, storage: storageFailure(error) };
        if (!Array.isArray(data)) return { ...report, storage: storageFailure(null) };
        const aggregates = data.map(aggregateHealth);
        if (aggregates.some(row => row === null)) return { ...report, storage: storageFailure(null) };
        for (const row of aggregates) {
            if (!row) continue;
            const entry = report.models.find(model => model.providerId === row.providerId && model.modelId === row.modelId);
            if (entry) { entry.health = row.health; entry.capabilities = row.capabilities; }
            else report.models.push({ ...row, providerLabel: row.providerId, modelLabel: row.modelId, kind: "historical", catalogue: "historical", configured: false, unavailableReason: "Not in the current catalogue. Availability is unknown.", free: null });
        }
        return report;
    } catch {
        return { ...report, storage: storageFailure(null) };
    }
}
