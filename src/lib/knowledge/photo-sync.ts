import { isImageAssetPath, photoMime, photoName } from "@/lib/knowledge/photo-paths";
import { PAGE_IMAGE_BODY_LIMIT as PHOTO_INDEX_MAX_BYTES } from "@/lib/http/limits";
import type { PhotoInput } from "@/lib/knowledge/photos";
import type { VaultEntry } from "@/lib/vault/github";

// Photos already in the vault's attachments/ (not from Capture) are indexed on request from the Knowledge page:
// each is read by the page reader for text or a short description, then indexed like a Capture photo.

export const PHOTO_RUN_LIMIT = 20;
const STATE_KEY = Symbol.for("zuychin.assistant.photoIndexRun");

export interface IndexedPhotoRow { id: string; path: string; content_hash: string; status: string }

export interface PhotoPlan {
    pending: VaultEntry[];
    /** Over 2 MB, so never indexed. */
    tooLarge: string[];
    /** Indexed photos whose file left the vault. */
    gone: IndexedPhotoRow[];
    indexed: number;
}

export interface PhotoRunResult {
    finishedAt: string;
    indexed: string[];
    withImage: number;
    failed: { path: string; error: string }[];
    retired: number;
    left: number;
}

export interface PhotoSyncDeps {
    listFiles(): Promise<VaultEntry[]>;
    indexedPhotos(): Promise<IndexedPhotoRow[]>;
    readFile(path: string): Promise<Uint8Array | null>;
    describe(bytes: Uint8Array, mimeType: "image/png" | "image/jpeg"): Promise<string>;
    index(input: PhotoInput): Promise<{ withImage: boolean } | null>;
    retire(rows: IndexedPhotoRow[]): Promise<void>;
}

export function planPhotos(files: readonly VaultEntry[], rows: readonly IndexedPhotoRow[]): PhotoPlan {
    const byPath = new Map(rows.map((row) => [row.path, row]));
    const photos = files.filter((file) => file.type === "file" && isImageAssetPath(file.path));
    const tooLarge = photos.filter((file) => (file.size ?? 0) > PHOTO_INDEX_MAX_BYTES).map((file) => file.path);
    const pending = photos.filter((file) => {
        if ((file.size ?? 0) > PHOTO_INDEX_MAX_BYTES) return false;
        const row = byPath.get(file.path);
        return !row || row.status !== "active" || row.content_hash !== file.sha;
    });
    const present = new Set(photos.map((file) => file.path));
    const gone = rows.filter((row) => row.status === "active" && isImageAssetPath(row.path) && !present.has(row.path));
    return { pending, tooLarge, gone, indexed: photos.length - pending.length - tooLarge.length };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export async function runPhotoIndex(deps: PhotoSyncDeps, limit = PHOTO_RUN_LIMIT): Promise<PhotoRunResult> {
    const plan = planPhotos(await deps.listFiles(), await deps.indexedPhotos());
    if (plan.gone.length) await deps.retire(plan.gone);
    const result: PhotoRunResult = { finishedAt: "", indexed: [], withImage: 0, failed: [], retired: plan.gone.length, left: 0 };
    const batch = plan.pending.slice(0, limit);
    for (const entry of batch) {
        try {
            const bytes = await deps.readFile(entry.path);
            if (!bytes) throw new Error("The file is no longer in the vault.");
            const mimeType = photoMime(bytes);
            if (!mimeType) throw new Error("The file is not a PNG or JPEG photo.");
            const text = await deps.describe(bytes, mimeType);
            const indexed = await deps.index({ path: entry.path, title: photoName(entry.path), text, bytes });
            if (!indexed) throw new Error("The knowledge tables are unavailable.");
            result.indexed.push(entry.path);
            if (indexed.withImage) result.withImage++;
        } catch (error) {
            result.failed.push({ path: entry.path, error: message(error) });
        }
    }
    result.left = plan.pending.length - result.indexed.length;
    result.finishedAt = new Date().toISOString();
    return result;
}

interface RunState { running: boolean; last: PhotoRunResult | null }

export function photoRunState(): RunState {
    const holder = globalThis as typeof globalThis & { [STATE_KEY]?: RunState };
    holder[STATE_KEY] ??= { running: false, last: null };
    return holder[STATE_KEY];
}

export async function livePhotoListing(): Promise<Pick<PhotoSyncDeps, "listFiles" | "indexedPhotos">> {
    const [{ supabaseAdmin: db }, github] = await Promise.all([import("@/lib/supabase"), import("@/lib/vault/github")]);
    const cfg = github.requireVaultConfig();
    return {
        listFiles: () => github.listAllFiles(cfg),
        async indexedPhotos() {
            const { data, error } = await db.from("knowledge_documents").select("id,path,content_hash,status").like("path", "attachments/%");
            if (error) throw new Error(`The photo index is unavailable: ${error.message}`);
            return (data ?? []) as IndexedPhotoRow[];
        },
    };
}

/** Live dependencies: the vault on GitHub, the owner's Free only setting, the knowledge model. */
export async function livePhotoDeps(freeOnly: boolean): Promise<PhotoSyncDeps> {
    const [{ supabaseAdmin: db }, github, { vaultEmbeddingRef }, { indexPhotoDocument }, { readPageImageRecorded }, { assertFreeModel }, listing] = await Promise.all([
        import("@/lib/supabase"), import("@/lib/vault/github"), import("@/lib/vault/store"), import("@/lib/knowledge/photos"),
        import("@/lib/capture/extract/page-image"), import("@/lib/ai/model-policy"), livePhotoListing(),
    ]);
    const cfg = github.requireVaultConfig();
    const embRef = await vaultEmbeddingRef();
    if (freeOnly) assertFreeModel(embRef);
    return {
        ...listing,
        readFile: async (path) => (await github.getBinaryFile(cfg, path))?.content ?? null,
        describe: async (bytes, mimeType) => (await readPageImageRecorded({ bytes, mimeType }, { freeOnly })).markdown,
        index: (input) => indexPhotoDocument(input, embRef),
        async retire(rows) {
            const now = new Date().toISOString();
            const { error } = await db.from("knowledge_documents").update({ status: "deleted", valid_to: now, updated_at: now }).in("id", rows.map((row) => row.id));
            if (error) throw new Error(`Removed photos could not be retired: ${error.message}`);
        },
    };
}
