import { supabaseAdmin } from "@/lib/supabase";
import { catalogueStorageFailure } from "@/lib/ai/catalogue/rows";
import { PROFILE_COLUMNS, profileRecordFromDb, type ModelProfile, type ProfileDraft, type ProfileRecord } from "@/lib/ai/models/profiles";
import { feedbackFromDb, FEEDBACK_WINDOW_DAYS, SPEED_WINDOW_DAYS, speedFromDb, statsKey, type ModelFeedback, type SpeedStats } from "@/lib/ai/models/stats";
import type { PurposeTag } from "@/lib/ai/models/tags";
import type { DraftSave } from "@/lib/ai/catalogue/run";

const READ_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 15_000;

type StorageFailure = "migration_required" | "unavailable";

export async function readProfiles(): Promise<{ ok: true; profiles: ProfileRecord[] } | { ok: false; reason: StorageFailure }> {
    try {
        const { data, error } = await supabaseAdmin.from("model_profiles").select(PROFILE_COLUMNS)
            .order("provider_id").order("model_id").abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
        if (error) return { ok: false, reason: catalogueStorageFailure(error) };
        if (!Array.isArray(data)) return { ok: false, reason: "unavailable" };
        return { ok: true, profiles: data.map(profileRecordFromDb).filter((row): row is ProfileRecord => row !== null) };
    } catch {
        return { ok: false, reason: "unavailable" };
    }
}

export async function readProfile(providerId: string, modelId: string): Promise<ProfileRecord | null> {
    const { data, error } = await supabaseAdmin.from("model_profiles").select(PROFILE_COLUMNS)
        .eq("provider_id", providerId).eq("model_id", modelId).abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS)).maybeSingle();
    if (error) throw new Error(`Reading the model profile failed: ${error.message}`);
    return data ? profileRecordFromDb(data) : null;
}

export async function readModelStats(): Promise<{ ok: true; speed: Map<string, SpeedStats>; feedback: Map<string, ModelFeedback> } | { ok: false; reason: StorageFailure }> {
    try {
        const [speed, feedback] = await Promise.all([
            supabaseAdmin.rpc("assistant_model_speed", { p_days: SPEED_WINDOW_DAYS }).abortSignal(AbortSignal.timeout(10_000)),
            supabaseAdmin.rpc("assistant_model_feedback", { p_days: FEEDBACK_WINDOW_DAYS }).abortSignal(AbortSignal.timeout(10_000)),
        ]);
        if (speed.error) return { ok: false, reason: catalogueStorageFailure(speed.error) };
        if (feedback.error) return { ok: false, reason: catalogueStorageFailure(feedback.error) };
        const rows = (Array.isArray(speed.data) ? speed.data : []).map(speedFromDb).filter((row): row is SpeedStats => row !== null);
        return {
            ok: true,
            speed: new Map(rows.map((row) => [statsKey(row.providerId, row.modelId), row])),
            feedback: feedbackFromDb(Array.isArray(feedback.data) ? feedback.data : []),
        };
    } catch {
        return { ok: false, reason: "unavailable" };
    }
}

/** Marks a lookup as running; creates the profile row when the model has none. */
export async function markDraftPending(providerId: string, modelId: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin.from("model_profiles")
        .upsert({ provider_id: providerId, model_id: modelId, draft_status: "pending", updated_at: now }, { onConflict: "provider_id,model_id" })
        .abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS));
    if (error) throw new Error(`Saving the lookup state failed: ${error.message}`);
}

/** Creates the profile row when the model has none; its empty seed tags keep the derived ones. */
export async function setModelRemoved(providerId: string, modelId: string, removed: boolean): Promise<"ok" | "not_found" | StorageFailure> {
    try {
        const now = new Date().toISOString();
        const { error } = await supabaseAdmin.from("model_profiles")
            .upsert({ provider_id: providerId, model_id: modelId, removed_at: removed ? now : null, updated_at: now }, { onConflict: "provider_id,model_id" })
            .abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS));
        if (!error) return "ok";
        // 23503: no catalogue row for this model.
        return (error as { code?: string }).code === "23503" ? "not_found" : catalogueStorageFailure(error);
    } catch {
        return "unavailable";
    }
}

/** Upserts each lookup result; a new row keeps the default tags until the owner approves. */
export async function saveDrafts(results: readonly DraftSave[]): Promise<void> {
    const now = new Date().toISOString();
    for (const { providerId, modelId, attempts, outcome } of results) {
        const fields = outcome.ok
            ? { draft: outcome.draft satisfies ProfileDraft, draft_status: "ready", draft_error: null, drafted_at: now, lookup_attempts: 0 }
            : { draft_status: "failed", draft_error: outcome.error.slice(0, 500), lookup_attempts: attempts };
        const { error } = await supabaseAdmin.from("model_profiles")
            .upsert({ provider_id: providerId, model_id: modelId, ...fields, updated_at: now }, { onConflict: "provider_id,model_id" })
            .abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS));
        if (error) throw new Error(`Saving the profile draft for ${providerId}::${modelId} failed: ${error.message}`);
    }
}

export type ApproveResult = "ok" | "not_found" | StorageFailure;

/** Tags and profile in one statement; `approveModel` also approves the model for automatic routes. Null keeps the stored value. */
export async function approveProfile(providerId: string, modelId: string, input: { tags: PurposeTag[] | null; profile: ModelProfile | null; approveModel: boolean }): Promise<ApproveResult> {
    try {
        const { data, error } = await supabaseAdmin.rpc("model_profile_approve", {
            p_provider_id: providerId, p_model_id: modelId, p_tags: input.tags, p_profile: input.profile, p_approve_model: input.approveModel,
        }).abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS));
        if (error) return catalogueStorageFailure(error);
        return data === "not_found" ? "not_found" : "ok";
    } catch {
        return "unavailable";
    }
}

export async function saveVaultResult(providerId: string, modelId: string, result: { path: string } | { error: string }): Promise<void> {
    const now = new Date().toISOString();
    const update = "path" in result
        ? { vault_path: result.path, vault_synced_at: now, vault_error: null, updated_at: now }
        : { vault_error: result.error.slice(0, 500), updated_at: now };
    const { error } = await supabaseAdmin.from("model_profiles").update(update)
        .eq("provider_id", providerId).eq("model_id", modelId).abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS));
    if (error) console.error("[ModelProfiles] Saving the vault result failed:", error.message);
}

export interface FeedbackInput {
    providerId: string;
    modelId: string;
    purpose: PurposeTag | null;
    source: "lead" | "auto";
    useful: boolean;
    reason: string | null;
    agentRunId: string | null;
}

export async function insertFeedback(rows: readonly FeedbackInput[]): Promise<boolean> {
    if (!rows.length) return true;
    try {
        const { error } = await supabaseAdmin.from("model_feedback").insert(rows.map((row) => ({
            provider_id: row.providerId, model_id: row.modelId, purpose: row.purpose, source: row.source,
            useful: row.useful, reason: row.reason?.slice(0, 200) ?? null, agent_run_id: row.agentRunId,
        }))).abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS));
        if (error) console.error("[ModelFeedback] Insert failed:", error.message);
        return !error;
    } catch (error) {
        console.error("[ModelFeedback] Insert failed:", error instanceof Error ? error.message : error);
        return false;
    }
}
