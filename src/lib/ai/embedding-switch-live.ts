import { getProvider, isProviderAvailable, partitionIdFor, resolveEmbedding } from "@/lib/ai/providers";
import { catalogueSnapshot, refreshCatalogueSnapshot, rowKind, type CatalogueRow } from "@/lib/ai/catalogue/snapshot";
import { assessDataRoute } from "@/lib/ai/data-policy";
import { embedImagePassage, embedTexts, getEmbeddingRef } from "@/lib/ai/embeddings";
import { PAGE_IMAGE_BODY_LIMIT } from "@/lib/http/limits";
import { photoMime } from "@/lib/knowledge/photo-paths";
import { refreshEmbeddingOverride, setEmbeddingOverride } from "@/lib/ai/embedding-override";
import {
    MAX_BATCH, SWITCH_CONCURRENCY, SWITCH_STATE_KEY, estimateSeconds, parseSwitchState, runSwitch, shouldResume, switchBusy,
    type SwitchState,
} from "@/lib/ai/embedding-switch";
import type { MigrationItem } from "@/lib/ai/embedding-migration";

// pgvector stores and searches any dimension up to this.
export const MAX_DIMENSION = 16_000;
// Above this the confirm dialog warns about storage.
export const LARGE_DIMENSION = 4_096;
// One 2048-dimension row is about 8 KB of float4 vector.
const BYTES_PER_VALUE = 4;
const NON_BATCH_SIZE = 8;
const RUNNING_KEY = Symbol.for("zuychin.assistant.embeddingSwitchRunning");

export interface SwitchTarget {
    providerId: string;
    modelId: string;
    dimension: number;
    nativeDimension: number;
    partitionId: string;
    label: string;
    providerLabel: string;
    mayTrain: boolean;
    batch: boolean;
    /** Passed the probe's photo step, so photo rows go with their images. */
    images: boolean;
    msPerCall: number | null;
}

function catalogueRow(providerId: string, modelId: string): CatalogueRow | undefined {
    return catalogueSnapshot().typedRows.find((row) => rowKind(row) === "embedding" && row.providerId === providerId && row.modelId === modelId);
}

/** Checks a switch target against the catalogue and data policy; returns the target or why it cannot be used. */
export function switchTargetFor(providerId: string, modelId: string, dimension?: number): { ok: true; target: SwitchTarget } | { ok: false; error: string } {
    const provider = getProvider(providerId);
    if (!provider || !isProviderAvailable(provider)) return { ok: false, error: "That provider is unavailable or has no key." };
    const model = provider.embeddingModels.find((entry) => entry.id === modelId);
    const row = catalogueRow(providerId, modelId);
    if (!model || !row) return { ok: false, error: "That embedding model is not in the catalogue. Press Refresh first." };
    if (model.retired) return { ok: false, error: "That model is retired." };
    if (row.probeStatus !== "passed" || row.missingSince) return { ok: false, error: "Only a model whose last test passed, and that its provider still lists, can take over the knowledge store." };
    if (row.approvedAt === null) return { ok: false, error: "Approve the model first." };
    const native = row.dimension ?? model.dimension;
    const size = dimension ?? native;
    if (!Number.isInteger(size) || size < 1 || size > Math.min(native, MAX_DIMENSION)) return { ok: false, error: `Pick a size between 1 and ${Math.min(native, MAX_DIMENSION)}.` };
    if (size !== native && !(row.traits?.truncatable || provider.kind === "gemini")) return { ok: false, error: "This model did not accept a smaller size in its test." };
    const policy = assessDataRoute({ providerId, modelId, purpose: "embedding", classes: ["knowledge", "unattended"] });
    if (policy.allowed === false) return { ok: false, error: "The data policy does not allow this route for the knowledge store." };
    let partitionId = partitionIdFor(modelId, size, native);
    // Another provider may hold the same id at another size; an explicit size keeps the partitions apart.
    try { if (resolveEmbedding(partitionId).model.dimension !== size) partitionId = `${modelId}@${size}`; } catch { /* new id */ }
    return {
        ok: true,
        target: {
            providerId, modelId, dimension: size, nativeDimension: native, partitionId, label: model.label, providerLabel: provider.label,
            mayTrain: row.mayTrain === true || providerId === "gemini-free", batch: row.traits?.batch === true, images: row.traits?.images === true,
            msPerCall: row.probeChatMs,
        },
    };
}

export function storageEstimateBytes(rows: number, dimension: number): number {
    return rows * dimension * BYTES_PER_VALUE;
}

async function stores() {
    const [{ supabaseAdmin }, migration, cron] = await Promise.all([
        import("@/lib/supabase"), import("@/lib/ai/embedding-migration-store"), import("@/lib/cron-state"),
    ]);
    return { sb: supabaseAdmin, migration, cron };
}

export async function readSwitchState(): Promise<SwitchState | null> {
    const { cron } = await stores();
    return parseSwitchState(await cron.getCronState<Record<string, unknown>>(SWITCH_STATE_KEY));
}

export async function pendingRows(target: string): Promise<number> {
    const { sb, migration } = await stores();
    return Object.values(await migration.countPendingRows(sb, target)).reduce((sum, count) => sum + count, 0);
}

/** Active photo documents, one chunk each; zero when the table cannot be read. */
export async function photoRows(): Promise<number> {
    const { sb } = await stores();
    const { count, error } = await sb.from("knowledge_documents").select("id", { count: "exact", head: true }).like("path", "attachments/%").eq("status", "active");
    return error || count === null ? 0 : count;
}

/** A photo chunk with its image from the vault; the text alone when the file is gone or not a PNG or JPEG. */
async function photoEmbedder(ref: ReturnType<typeof resolveEmbedding>) {
    const github = await import("@/lib/vault/github");
    const cfg = github.requireVaultConfig();
    return async (item: MigrationItem): Promise<number[]> => {
        const path = (item.row.document as { path: string }).path;
        const file = await github.getBinaryFile(cfg, path);
        const mimeType = file ? photoMime(file.content) : null;
        if (!file || !mimeType || file.content.length > PAGE_IMAGE_BODY_LIMIT) return (await embedTexts(ref, [item.text], "passage"))[0];
        return (await embedImagePassage(ref, { image: { mimeType, base64: file.content.toString("base64") }, text: item.text })).vector;
    };
}

/** Runs a job in this process unless one already is. Resolves when the job stops. */
export async function runSwitchLive(state: SwitchState): Promise<SwitchState | null> {
    const holder = globalThis as typeof globalThis & { [RUNNING_KEY]?: boolean };
    if (holder[RUNNING_KEY]) return null;
    holder[RUNNING_KEY] = true;
    try {
        const { sb, migration, cron } = await stores();
        await refreshCatalogueSnapshot();
        const ref = resolveEmbedding(state.target, state.providerId);
        if (ref.provider.id !== state.providerId) throw new Error(`${state.providerId} no longer serves ${state.modelId}.`);
        const { notify } = await import("@/lib/messaging/router");
        return await runSwitch(state, {
            store: migration.createMigrationStore(sb, (target, signal) => setEmbeddingOverride(target, signal, { providerId: state.providerId, dimension: state.dimension })),
            pending: migration.createMigrationStore(sb, undefined, { pendingModel: state.target }),
            countRemaining: (target) => migration.countPendingRows(sb, target),
            embed: (texts) => embedTexts(ref, texts, "passage"),
            ...(ref.model.images ? { embedPhoto: await photoEmbedder(ref) } : {}),
            batchSize: ref.model.batch ? MAX_BATCH : NON_BATCH_SIZE,
            concurrency: SWITCH_CONCURRENCY,
            saveState: (next) => cron.setCronState(SWITCH_STATE_KEY, { ...next }),
            notify: async (text) => { await notify("model_catalogue", text); },
            now: Date.now,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[EmbeddingSwitch] Could not run:", message);
        const { cron } = await stores();
        await cron.setCronState(SWITCH_STATE_KEY, { ...state, status: "failed", error: message.slice(0, 300), updatedAt: new Date().toISOString() }).catch(() => {});
        return null;
    } finally {
        holder[RUNNING_KEY] = false;
    }
}

/** Starts a switch; the caller runs the returned state in after(). */
export async function beginSwitch(target: SwitchTarget): Promise<{ ok: true; state: SwitchState } | { ok: false; status: number; error: string }> {
    const current = await readSwitchState();
    if (switchBusy(current, Date.now())) return { ok: false, status: 409, error: "A knowledge model switch is already running." };
    await refreshEmbeddingOverride(undefined, true);
    const active = getEmbeddingRef();
    if (active.model.id === target.partitionId && active.provider.id === target.providerId) return { ok: false, status: 409, error: "That model already serves the knowledge store." };
    const now = new Date().toISOString();
    const state: SwitchState = {
        target: target.partitionId, providerId: target.providerId, modelId: target.modelId, dimension: target.dimension,
        status: "running", done: 0, remaining: null, startedAt: now, updatedAt: now, error: null,
    };
    const { cron } = await stores();
    await cron.setCronState(SWITCH_STATE_KEY, { ...state });
    return { ok: true, state };
}

/** The saved job when it should be picked up again (paused, or running but silent for 10 minutes). */
export async function switchToResume(): Promise<SwitchState | null> {
    const state = await readSwitchState().catch(() => null);
    return shouldResume(state, Date.now()) ? state : null;
}

export function switchEstimate(target: SwitchTarget, rows: number, photos = 0) {
    const batchSize = target.batch ? MAX_BATCH : 1;
    // Without the photo step, photo rows are plain text rows.
    const photoCount = target.images ? Math.min(Math.max(0, photos), rows) : 0;
    return {
        rows, photoRows: photoCount, batchSize, concurrency: SWITCH_CONCURRENCY, msPerCall: target.msPerCall,
        seconds: estimateSeconds(rows, target.msPerCall, batchSize, SWITCH_CONCURRENCY, photoCount),
        storageBytes: storageEstimateBytes(rows, target.dimension),
        large: target.dimension > LARGE_DIMENSION,
    };
}
