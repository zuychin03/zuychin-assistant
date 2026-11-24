import { randomUUID } from "node:crypto";
import { imageMime } from "@/lib/ai/media/requests";

// Android shares arrive as one multipart POST to /capture/share. What was shared waits here, in memory, until the
// Capture page fetches it and downscales the photo. On globalThis so every route bundle in the process sees the entries.
const KEY = Symbol.for("zuychin.capture.staged");
export const STAGED_TTL_MS = 10 * 60_000;
const MAX_STAGED = 3;

export interface SharedFile { name: string; type: string; bytes: Uint8Array }
export interface SharedInput { title: string; text: string; url: string; file: SharedFile | null; skipped: number }
export interface StagedShare extends SharedInput { id: string; createdAt: number }

const store = () => ((globalThis as unknown as Record<symbol, Map<string, StagedShare> | undefined>)[KEY] ??= new Map());

function sweep(entries: Map<string, StagedShare>, now: number) {
    for (const [id, entry] of entries) if (now - entry.createdAt > STAGED_TTL_MS) entries.delete(id);
}

export function stageShare(input: SharedInput, now = Date.now()): string {
    const entries = store();
    sweep(entries, now);
    while (entries.size >= MAX_STAGED) entries.delete(entries.keys().next().value!);
    const id = randomUUID();
    entries.set(id, { ...input, id, createdAt: now });
    return id;
}

export function stagedShare(id: string, now = Date.now()): StagedShare | null {
    const entries = store();
    sweep(entries, now);
    return entries.get(id) ?? null;
}

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

/** The type from the bytes, so a renamed file cannot pass as a photo or PDF. HEIC is kept for browsers that can decode it. */
export function sharedFileType(bytes: Uint8Array): string | null {
    if (bytes.length > 5 && ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
    const image = imageMime(bytes);
    if (image) return image;
    if (bytes.length > 12 && ascii(bytes, 4, 8) === "ftyp" && /^(heic|heix|heim|heis|mif1|msf1)$/.test(ascii(bytes, 8, 12))) return "image/heic";
    return null;
}

/** The share target's fields; the first photo or PDF among `files` is kept. Null when nothing was shared. */
export async function readShareForm(form: FormData): Promise<SharedInput | null> {
    const field = (name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
    let file: SharedFile | null = null, skipped = 0;
    for (const entry of form.getAll("files")) {
        if (typeof entry === "string") continue;
        const bytes = new Uint8Array(await entry.arrayBuffer());
        const type: string | null = file ? null : sharedFileType(bytes);
        if (type) file = { name: (entry.name || "shared").replace(/[\\/\x00-\x1f]/g, "_").slice(0, 200), type, bytes };
        else skipped++;
    }
    const input = { title: field("title").slice(0, 200), text: field("text").slice(0, 120_000), url: field("url").slice(0, 4000), file, skipped };
    return input.title || input.text || input.url || input.file || input.skipped ? input : null;
}
