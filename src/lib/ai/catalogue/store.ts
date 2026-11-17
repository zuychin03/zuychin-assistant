import { supabaseAdmin } from "@/lib/supabase";
import { CATALOGUE_COLUMNS, catalogueRowFromDb, catalogueRowToDb, catalogueStorageFailure } from "@/lib/ai/catalogue/rows";
import type { CatalogueRow, CatalogueStorage } from "@/lib/ai/catalogue/snapshot";

const READ_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 15_000;
// A run longer than this has died with its process; later runs may take the lock.
const STALE_RUN_MS = 30 * 60_000;
const SAVE_CHUNK = 100;

export type StorageFailure = Exclude<CatalogueStorage, "empty" | "ok">;
export type DiscoveryTrigger = "cron" | "manual";
export type StartRunResult = { ok: true; runId: string } | { ok: false; reason: "busy" | StorageFailure };

export interface DiscoveryRunRecord {
    id: string;
    trigger: DiscoveryTrigger;
    startedAt: string;
    finishedAt: string | null;
    status: "running" | "done" | "failed";
    summary: Record<string, unknown>;
}

export async function readCatalogueRows(): Promise<{ ok: true; rows: CatalogueRow[] } | { ok: false; reason: StorageFailure }> {
    try {
        const { data, error } = await supabaseAdmin.from("model_catalogue").select(CATALOGUE_COLUMNS)
            .order("provider_id").order("model_id")
            .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
        if (error) return { ok: false, reason: catalogueStorageFailure(error) };
        if (!Array.isArray(data)) return { ok: false, reason: "unavailable" };
        return { ok: true, rows: data.map(catalogueRowFromDb).filter((row): row is CatalogueRow => row !== null) };
    } catch {
        return { ok: false, reason: "unavailable" };
    }
}

export interface SavedRow {
    row: CatalogueRow;
    /** Set only when a probe ran; other rows keep their stored detail. */
    probeDetail?: unknown;
}

export async function readCatalogueAdmin(): Promise<{ ok: true; rows: (CatalogueRow & { probeDetail: unknown })[] } | { ok: false; reason: StorageFailure }> {
    try {
        const { data, error } = await supabaseAdmin.from("model_catalogue").select(`${CATALOGUE_COLUMNS}, probe_detail`)
            .order("provider_id").order("model_id")
            .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
        if (error) return { ok: false, reason: catalogueStorageFailure(error) };
        if (!Array.isArray(data)) return { ok: false, reason: "unavailable" };
        const rows = data.flatMap((raw) => {
            const row = catalogueRowFromDb(raw);
            return row ? [{ ...row, probeDetail: (raw as { probe_detail?: unknown }).probe_detail ?? null }] : [];
        });
        return { ok: true, rows };
    } catch {
        return { ok: false, reason: "unavailable" };
    }
}

export async function saveCatalogueRows(rows: readonly SavedRow[], now: string): Promise<void> {
    // An upsert batch takes the union of its rows' keys and nulls the gaps, so rows with and without probe detail go separately.
    const groups = [rows.filter((entry) => entry.probeDetail !== undefined), rows.filter((entry) => entry.probeDetail === undefined)];
    for (const group of groups) {
        for (let start = 0; start < group.length; start += SAVE_CHUNK) {
            const chunk = group.slice(start, start + SAVE_CHUNK).map(({ row, probeDetail }) => catalogueRowToDb(row, now, probeDetail));
            const { error } = await supabaseAdmin.from("model_catalogue").upsert(chunk, { onConflict: "provider_id,model_id" })
                .abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS));
            if (error) throw new Error(`Saving the model catalogue failed: ${error.message}`);
        }
    }
}

export async function setCatalogueApproval(providerId: string, modelId: string, approved: boolean): Promise<"ok" | "not_found" | StorageFailure> {
    try {
        const { data, error } = await supabaseAdmin.from("model_catalogue")
            .update({ approved_at: approved ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
            .eq("provider_id", providerId).eq("model_id", modelId).select("model_id")
            .abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS));
        if (error) return catalogueStorageFailure(error);
        return Array.isArray(data) && data.length ? "ok" : "not_found";
    } catch {
        return "unavailable";
    }
}

export async function startDiscoveryRun(trigger: DiscoveryTrigger): Promise<StartRunResult> {
    try {
        const now = Date.now();
        const stale = await supabaseAdmin.from("model_discovery_runs")
            .update({ status: "failed", finished_at: new Date(now).toISOString(), summary: { error: "The run stopped without finishing." } })
            .eq("status", "running").lt("started_at", new Date(now - STALE_RUN_MS).toISOString())
            .abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS));
        if (stale.error) return { ok: false, reason: catalogueStorageFailure(stale.error) };
        const { data, error } = await supabaseAdmin.from("model_discovery_runs").insert({ trigger, status: "running" })
            .select("id").abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS)).single();
        // 23505: the partial unique index on status = 'running' is the lock.
        if (error) return { ok: false, reason: error.code === "23505" ? "busy" : catalogueStorageFailure(error) };
        return typeof data?.id === "string" ? { ok: true, runId: data.id } : { ok: false, reason: "unavailable" };
    } catch {
        return { ok: false, reason: "unavailable" };
    }
}

export async function finishDiscoveryRun(runId: string, status: "done" | "failed", summary: object): Promise<void> {
    const { error } = await supabaseAdmin.from("model_discovery_runs")
        .update({ status, finished_at: new Date().toISOString(), summary })
        .eq("id", runId).abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS));
    if (error) throw new Error(`Finishing the discovery run failed: ${error.message}`);
}

function runFromDb(raw: unknown): DiscoveryRunRecord | null {
    const row = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (typeof row.id !== "string" || typeof row.started_at !== "string") return null;
    if (row.trigger !== "cron" && row.trigger !== "manual") return null;
    if (row.status !== "running" && row.status !== "done" && row.status !== "failed") return null;
    return {
        id: row.id, trigger: row.trigger, startedAt: row.started_at,
        finishedAt: typeof row.finished_at === "string" ? row.finished_at : null, status: row.status,
        summary: row.summary !== null && typeof row.summary === "object" && !Array.isArray(row.summary) ? row.summary as Record<string, unknown> : {},
    };
}

export async function listDiscoveryRuns(limit = 10): Promise<{ ok: true; runs: DiscoveryRunRecord[] } | { ok: false; reason: StorageFailure }> {
    try {
        const { data, error } = await supabaseAdmin.from("model_discovery_runs").select("id, trigger, started_at, finished_at, status, summary")
            .order("started_at", { ascending: false }).limit(limit).abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
        if (error) return { ok: false, reason: catalogueStorageFailure(error) };
        return { ok: true, runs: (Array.isArray(data) ? data : []).map(runFromDb).filter((run): run is DiscoveryRunRecord => run !== null) };
    } catch {
        return { ok: false, reason: "unavailable" };
    }
}

/** Summaries of the latest finished runs other than `runId`, newest first. */
export async function recentDiscoverySummaries(runId: string, limit = 5): Promise<Record<string, unknown>[]> {
    const { data, error } = await supabaseAdmin.from("model_discovery_runs").select("id, trigger, started_at, finished_at, status, summary")
        .neq("id", runId).neq("status", "running")
        .order("started_at", { ascending: false }).limit(limit).abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
    if (error) throw new Error(`Reading earlier discovery runs failed: ${error.message}`);
    return (Array.isArray(data) ? data : []).map(runFromDb).flatMap((run) => run ? [run.summary] : []);
}
