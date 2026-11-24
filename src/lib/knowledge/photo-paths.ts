// No server imports: the chat page renders cited photos with these too.

// A photo's knowledge document lives at its vault path, so a hit on one of these paths is a photo hit.
// Narrower than the knowledge_chunks asset_path check: only formats the page reader and the embedding probe take.
const IMAGE_ASSET_PATH = /^attachments\/[A-Za-z0-9._ /-]+\.(?:jpe?g|png)$/i;
export const MAX_SENT_PHOTOS = 3;

export function isImageAssetPath(path: string | null | undefined): path is string {
    return typeof path === "string" && path.length <= 320 && IMAGE_ASSET_PATH.test(path) && !path.includes("..") && !path.includes("//");
}

/** PNG or JPEG by their bytes; the only formats indexed or served as photos. */
export function photoMime(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    return null;
}

export function photoAssetUrl(path: string): string {
    return `/api/knowledge/asset?path=${encodeURIComponent(path)}`;
}

/** Photo hits whose path the reply cites, in source order, at most `max`. */
export function citedPhotoPaths(reply: string, sources: readonly { kind: string; ref?: string }[] | undefined, max = MAX_SENT_PHOTOS): string[] {
    const out: string[] = [];
    for (const source of sources ?? []) {
        if (source.kind !== "photo" || !isImageAssetPath(source.ref) || out.includes(source.ref) || !reply.includes(source.ref)) continue;
        out.push(source.ref);
        if (out.length >= max) break;
    }
    return out;
}

/** What the Knowledge reader shows for a photo document: the photo, then its indexed text. */
export function photoMarkdown(title: string, path: string, texts: readonly string[]): string {
    const alt = title.replace(/[[\]\r\n]/g, " ").trim() || "Photo";
    return [`![${alt}](${photoAssetUrl(path)})`, ...texts.map((text) => text.trim()).filter(Boolean)].join("\n\n") + "\n";
}

/** "attachments/captures/2026 trip-photo.jpg" as "2026 trip photo". */
export function photoName(path: string): string {
    const file = path.slice(path.lastIndexOf("/") + 1).replace(/\.[a-z]+$/i, "");
    return file.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || "Photo";
}
