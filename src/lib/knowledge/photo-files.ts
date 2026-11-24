import { isImageAssetPath, photoMime } from "@/lib/knowledge/photo-paths";
import { getBinaryFile, requireVaultConfig } from "@/lib/vault/github";

// Discord's 8 MB attachment limit is the lower of the two channels (Telegram photos take 10 MB).
export const SENT_PHOTO_MAX_BYTES = 8 * 1024 * 1024;

export interface SavedPhoto { name: string; mimeType: "image/png" | "image/jpeg"; bytes: Buffer }

/** A saved photo from the vault for a channel to send, or null when it is gone or not a PNG or JPEG. */
export async function readSavedPhoto(path: string): Promise<SavedPhoto | null> {
    if (!isImageAssetPath(path)) return null;
    try {
        const file = await getBinaryFile(requireVaultConfig(), path);
        const mimeType = file ? photoMime(file.content) : null;
        if (!file || !mimeType || file.content.length > SENT_PHOTO_MAX_BYTES) return null;
        return { name: path.slice(path.lastIndexOf("/") + 1), mimeType, bytes: file.content };
    } catch (error) {
        console.warn("[Photos] Could not read a saved photo:", error instanceof Error ? error.message : error);
        return null;
    }
}

/** Cited photos as /api/chat artifacts, which the Discord bot attaches by name and bytes. */
export async function photoAttachments(paths: readonly string[] | undefined) {
    const out = [];
    for (const [index, path] of (paths ?? []).entries()) {
        const photo = await readSavedPhoto(path);
        if (photo) out.push({ id: `photo-${index + 1}`, name: photo.name, mime: photo.mimeType, kind: "image" as const, size: photo.bytes.length, base64: photo.bytes.toString("base64") });
    }
    return out;
}
