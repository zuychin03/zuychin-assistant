import { createHash } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { embedImagePassage, type ResolvedEmbedding } from "@/lib/ai/embeddings";
import { PAGE_IMAGE_BODY_LIMIT } from "@/lib/http/limits";
import { estimateTokens } from "@/lib/knowledge/chunker";
import { isImageAssetPath, photoMime, photoName } from "@/lib/knowledge/photo-paths";
import { schemaUnavailable } from "@/lib/knowledge/store";

// V8 F3: a kept photo is a knowledge document at its vault path with one chunk: the photo's text, embedded with the image.
// Larger photos are skipped: the page reader and the image embedding were only tested up to the Capture size.
export const PHOTO_INDEX_MAX_BYTES = PAGE_IMAGE_BODY_LIMIT;
export const PHOTO_TEXT_MAX = 4000;
export const PHOTO_CATEGORY = "photos";

export interface PhotoInput {
    path: string;
    /** Defaults to the file name. */
    title?: string;
    /** Caption and page text; may be empty. */
    text: string;
    bytes: Uint8Array;
    /** The note the photo belongs to, linked so the photo is not an orphan. */
    sourcePath?: string;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Git's blob id, so a vault listing tells an indexed photo from a changed one without downloading it. */
export function gitBlobSha(bytes: Uint8Array): string {
    return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function photoDocumentId(path: string): string {
    return `zuychin-photo-${sha256(path.toLowerCase()).slice(0, 24)}`;
}

/** The document row, its one chunk and the text to embed, before any call. */
export function photoDocument(input: PhotoInput, now = new Date()) {
    if (!isImageAssetPath(input.path)) throw new Error("Only PNG and JPEG files under attachments/ can be indexed as photos.");
    const title = (input.title?.replace(/\s+/g, " ").trim() || photoName(input.path)).slice(0, 200);
    const body = input.text.replace(/\r\n/g, "\n").trim();
    const content = (body || `Photo: ${title}`).slice(0, PHOTO_TEXT_MAX);
    const id = photoDocumentId(input.path);
    const blob = gitBlobSha(input.bytes);
    const source = input.sourcePath ?? input.path;
    const contentHash = sha256(content);
    return {
        document: {
            id, path: input.path, title, summary: content.slice(0, 240), category: PHOTO_CATEGORY, kind: "document" as const,
            scope: "user" as const, status: "active" as const, trust: "untrusted" as const, sensitivity: "private" as const,
            project_id: null, supersedes_id: null, valid_from: null, valid_to: null, content_hash: blob,
            provenance: [{ source, sourcePath: source, capturedAt: now.toISOString(), contentHash: blob }], updated_at: now.toISOString(),
        },
        chunk: {
            id: `${id}:0:${contentHash.slice(0, 12)}`, heading: "", heading_path: [] as string[], ordinal: 0, content,
            content_hash: contentHash, token_count: estimateTokens(content), modality: "image" as const, asset_path: input.path,
        },
        // What the switch job re-embeds for this chunk: the title, no heading path, the content.
        embedText: `${title}\n\n${content}`,
    };
}

/** Indexes one photo. Null means the knowledge tables are not there yet. */
export async function indexPhotoDocument(input: PhotoInput, embRef: ResolvedEmbedding, signal?: AbortSignal): Promise<{ id: string; withImage: boolean } | null> {
    const mimeType = photoMime(input.bytes);
    if (!mimeType) throw new Error("Only PNG and JPEG photos can be indexed.");
    if (input.bytes.length > PHOTO_INDEX_MAX_BYTES) throw new Error("The photo is over 2 MB, so it was not indexed.");
    const { document, chunk, embedText } = photoDocument(input);
    const { vector, withImage } = await embedImagePassage(embRef, { image: { mimeType, base64: Buffer.from(input.bytes).toString("base64") }, text: embedText }, signal);

    const { error: documentError } = await supabase.from("knowledge_documents").upsert(document, { onConflict: "id" });
    if (documentError) {
        if (schemaUnavailable(documentError.message)) return null;
        throw new Error(`Failed to index the photo: ${documentError.message}`);
    }
    // modality and asset_path are stored once v8-media.sql is applied; the older function ignores them.
    const { error: chunkError } = await supabase.rpc("replace_knowledge_chunks", {
        p_document_id: document.id,
        p_chunks: [{ ...chunk, embedding: vector, embedding_model: embRef.model.id }],
    });
    if (chunkError) {
        if (schemaUnavailable(chunkError.message)) return null;
        throw new Error(`Failed to index the photo's text: ${chunkError.message}`);
    }

    const { error: unlinkError } = await supabase.from("knowledge_links").delete().eq("source_document_id", document.id);
    if (unlinkError && !schemaUnavailable(unlinkError.message)) throw new Error(`Failed to refresh the photo's link: ${unlinkError.message}`);
    if (input.sourcePath?.endsWith(".md")) {
        const { data: notes } = await supabase.from("knowledge_documents").select("id").eq("path", input.sourcePath).limit(1);
        const { error: linkError } = await supabase.from("knowledge_links").insert({
            source_document_id: document.id, target_document_id: (notes?.[0] as { id?: string } | undefined)?.id ?? null,
            target_ref: input.sourcePath, relation: "related",
        });
        if (linkError && !schemaUnavailable(linkError.message)) throw new Error(`Failed to link the photo to its note: ${linkError.message}`);
    }
    return { id: document.id, withImage };
}
