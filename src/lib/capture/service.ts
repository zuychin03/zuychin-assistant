import { createHash } from "node:crypto";
import { z } from "zod";
import { safeVaultPath } from "@/lib/knowledge/paths";
import { serializeFrontmatter } from "@/lib/knowledge/markdown";
import { capText, countWords } from "./extract/text";
import { PAGE_READ_LIMIT } from "./review-source";
import type { CaptureExtract, CaptureExtractMethod, CaptureItem, CapturePreview, CaptureReview, CaptureSource, OcrTier } from "./types";

export const MAX_CAPTURE_PDF_BYTES = 2 * 1024 * 1024;
export const MAX_CAPTURE_IMAGE_BYTES = 2 * 1024 * 1024;
export const SOURCE_TEXT_MAX = 120_000;
export const OCR_STALE_MS = 10 * 60_000;
const EXTRACTED_BY: Record<CaptureExtractMethod, string> = {
    html: "defuddle", plain: "plain", "pdf-text": "pdf.js", tavily: "tavily", "ocr-free": "gemini-free", "ocr-paid": "gemini-paid",
    parse: "page-reader", caption: "vision-model",
};
export class CaptureError extends Error {
    constructor(message: string, readonly status = 400) { super(message); this.name = "CaptureError"; }
}
const sha = z.string().regex(/^[a-f0-9]{40}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.object({
    kind: z.enum(["text", "link", "pdf", "image", "offline_note"]), title: z.string().trim().min(1).max(200), text: z.string().max(120_000),
    url: z.string().max(4000).optional(), pdf: z.object({ name: z.string().min(1).max(200), base64: z.string().max(Math.ceil(MAX_CAPTURE_PDF_BYTES / 3) * 4) }).optional(),
    image: z.object({ name: z.string().min(1).max(200), base64: z.string().max(Math.ceil(MAX_CAPTURE_IMAGE_BYTES / 3) * 4) }).optional(),
    source: z.object({ documentId: z.string().min(1).max(200), path: z.string().max(1024), commitSha: sha, contentHash: hash }).optional(),
}).strict();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const isJpeg = (bytes: Buffer) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
/** Where a capture's original file goes in the vault, beside the note. */
export function originalAssetPath(id: string, source: Pick<CaptureSource, "pdf" | "image">): string | null {
    return source.pdf ? `attachments/captures/${id}.pdf` : source.image ? `attachments/captures/${id}.jpg` : null;
}
export function validateCaptureSource(input: unknown): CaptureSource {
    const value = sourceSchema.parse(input);
    value.text = value.text.replace(/\r\n/g, "\n");
    if (value.kind === "link") {
        let url: URL; try { url = new URL(value.url ?? ""); } catch { throw new CaptureError("A valid source URL is required."); }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new CaptureError("Use an HTTP or HTTPS source URL without credentials.");
        value.url = url.href;
    } else if (value.url) throw new CaptureError("Only link captures accept a source URL.");
    if (value.kind === "pdf") {
        if (!value.pdf || !/^[a-z0-9+/]*={0,2}$/i.test(value.pdf.base64)) throw new CaptureError("Attach a valid PDF original.");
        const bytes = Buffer.from(value.pdf.base64, "base64");
        if (bytes.length > MAX_CAPTURE_PDF_BYTES || bytes.subarray(0, 5).toString() !== "%PDF-") throw new CaptureError("Attach a PDF no larger than 2 MB.");
        value.pdf.name = value.pdf.name.replace(/[\\/\x00-\x1f]/g, "_");
        value.pdf.base64 = bytes.toString("base64");
    } else if (value.pdf) throw new CaptureError("Only PDF captures accept an original file.");
    if (value.kind === "image") {
        if (!value.image || !/^[a-z0-9+/]*={0,2}$/i.test(value.image.base64)) throw new CaptureError("Attach a valid photo.");
        const bytes = Buffer.from(value.image.base64, "base64");
        if (bytes.length > MAX_CAPTURE_IMAGE_BYTES || !isJpeg(bytes)) throw new CaptureError("Attach a JPEG photo no larger than 2 MB.");
        value.image.name = value.image.name.replace(/[\\/\x00-\x1f]/g, "_");
        value.image.base64 = bytes.toString("base64");
    } else if (value.image) throw new CaptureError("Only photo captures accept an image.");
    if (["text", "offline_note"].includes(value.kind) && !value.text.trim()) throw new CaptureError("A passage or note is required.");
    if (value.source) {
        if (value.kind !== "offline_note") throw new CaptureError("Only offline notes accept a source snapshot.");
        value.source.path = safeVaultPath(value.source.path);
    }
    return value;
}
interface Dependencies {
    get(profile: string, id: string): Promise<CaptureItem | null>;
    insert(item: CaptureItem): Promise<CaptureItem>;
    receipt(profile: string, id: string, value: NonNullable<CaptureItem["receipt"]>): Promise<void>;
    claim(profile: string, id: string, value: { path: string; contentHash: string }): Promise<{ path: string; contentHash: string }>;
    head(): Promise<string>;
    read(path: string, head: string): Promise<string | null>;
    commit(changes: { path: string; content?: string; contentBase64?: string }[], head: string): Promise<{ commit: string }>;
    index(path: string, title: string, markdown: string, profile: string): Promise<void>;
    /** A kept photo as its own knowledge document, so photo search finds it. */
    indexPhoto?(photo: CapturePhoto, profile: string): Promise<void>;
    saveExtract?(profile: string, id: string, extract: CaptureExtract): Promise<void>;
    extractor?: {
        read(source: CaptureSource, profile: string): Promise<CaptureExtract>;
        ocr(source: CaptureSource, stored: CaptureExtract | null, tier: OcrTier, profile: string): Promise<CaptureExtract>;
        ocrTiers(profile: string): Promise<Record<OcrTier, boolean>>;
        acquire(slot: "extract" | "ocr"): (() => void) | null;
        now?(): Date;
    };
}
const pagesSchema = z.object({
    text: z.string().max(2 * SOURCE_TEXT_MAX), pages: z.number().int().min(1).max(PAGE_READ_LIMIT), unread: z.number().int().min(0), model: z.string().trim().min(1).max(200),
}).strict();
export interface ExtractResult { extract: CaptureExtract; background?: () => Promise<void> }
export interface CapturePhoto { path: string; notePath: string; title: string; text: string; base64: string }
const isPdfExtract = (extract: CaptureExtract | null) => !!extract && (extract.contentType === "application/pdf" || extract.method === "pdf-text" || extract.method.startsWith("ocr-"));
export function createCaptureService(deps: Dependencies) {
    async function get(profile: string, id: string) {
        z.string().uuid().parse(id);
        const item = await deps.get(profile, id);
        if (!item) throw new CaptureError("Capture not found.", 404);
        return item;
    }
    async function preview(profile: string, id: string, rawReview: CaptureReview): Promise<CapturePreview> {
        const review = z.object({ title: z.string().trim().min(1).max(200), text: z.string().max(120_000), destination: z.string().min(1).max(800),
            sourceText: z.string().max(SOURCE_TEXT_MAX).optional() }).parse(rawReview);
        let path: string; try { path = safeVaultPath(review.destination); } catch { throw new CaptureError("Choose a safe destination path."); }
        if (!path.endsWith(".md") || path.startsWith(".") || /[\x00-\x1f]/.test(path)) throw new CaptureError("The destination must be a Markdown path.");
        const item = await get(profile, id);
        const originalPath = originalAssetPath(id, item.source);
        const sourceText = review.sourceText?.replace(/\r\n/g, "\n").trim() ?? "";
        const body = [`# ${review.title.replace(/[\r\n]/g, " ")}`, review.text.replace(/\r\n/g, "\n")];
        if (sourceText) body.push("## Source text", sourceText);
        if (item.source.url) body.push(`Source: <${item.source.url.replace(/[<>]/g, encodeURIComponent)}>`);
        if (originalPath) body.push(`[Original ${item.source.pdf ? "PDF" : "photo"}](/api/capture/original?id=${id})`);
        if (item.source.source) body.push(`Source snapshot: ${item.source.source.path} at ${item.source.source.commitSha}\n\nContent SHA-256: ${item.source.source.contentHash}`);
        // Only with source text, so documents for older reviews stay byte-identical to their ingest claims.
        const fetched = item.extract?.status === "running" ? null : item.extract ?? null;
        const provenance = sourceText ? {
            ...(item.source.url ? { source_url: item.source.url } : {}),
            ...(fetched?.finalUrl && fetched.finalUrl !== item.source.url ? { source_final_url: fetched.finalUrl } : {}),
            ...(fetched ? { fetched_at: fetched.fetchedAt, extracted_by: EXTRACTED_BY[fetched.method] } : {}),
            ...(fetched?.author ? { source_author: fetched.author } : {}),
            ...(fetched?.published ? { source_published: fetched.published } : {}),
        } : {};
        const markdown = serializeFrontmatter({ attributes: { zuychin_id: `capture-${id}`, title: review.title,
            kind: "note", scope: "user", status: "active", trust: "untrusted", sensitivity: "private", capture_id: id,
            capture_source_hash: item.sourceHash, ...(originalPath ? { original_asset: originalPath } : {}), ...provenance }, body: body.join("\n\n") + "\n" });
        const headSha = await deps.head();
        const existing = await deps.read(path, headSha);
        if (existing !== null && existing !== markdown) throw new CaptureError("That destination exists or has changed. Choose a new path; existing content will not be replaced.", 409);
        if (existing === null && originalPath && await deps.read(originalPath, headSha) !== null) throw new CaptureError("The original file destination already exists. Review the capture before retrying.", 409);
        return { id, review, path, markdown, originalPath, headSha, existing: existing !== null,
            previewHash: digest(JSON.stringify({ sourceHash: item.sourceHash, path, markdown, originalPath, headSha })) };
    }
    async function extract(profile: string, id: string, options: { refresh?: boolean; ocr?: OcrTier } = {}): Promise<ExtractResult> {
        const extractor = deps.extractor, save = deps.saveExtract;
        if (!extractor || !save) throw new CaptureError("Source text is not available on this server.", 503);
        const item = await get(profile, id);
        if (item.receipt) throw new CaptureError("This capture is already in knowledge, so its source text is fixed.", 409);
        if (item.source.kind !== "link" && item.source.kind !== "pdf" && item.source.kind !== "image") throw new CaptureError("Only link, PDF and photo captures have source text.");
        const now = extractor.now?.() ?? new Date();
        let stored = item.extract ?? null;
        if (stored?.status === "running" && now.getTime() - Date.parse(stored.startedAt ?? stored.fetchedAt) > OCR_STALE_MS) {
            stored = { ...stored, status: "failed", note: "Gemini didn't finish. Try again." };
            await save(profile, id, stored).catch(() => {});
        }
        if (options.ocr) {
            const tier = options.ocr;
            if (!(await extractor.ocrTiers(profile))[tier]) {
                throw new CaptureError(tier === "paid" ? "Paid Gemini is unavailable: Free only is on or the key is not set." : "The free Gemini key is not set.", 403);
            }
            if (item.source.kind !== "pdf" && item.source.kind !== "image" && !isPdfExtract(stored)) throw new CaptureError("Gemini reads PDFs and photos only. Read this link first.");
            if (stored?.status === "running") return { extract: stored };
            const release = extractor.acquire("ocr");
            if (!release) throw new CaptureError("Gemini is already reading a PDF. Try again when it finishes.", 429);
            const started = now.toISOString();
            const running: CaptureExtract = { version: 1, status: "running", method: tier === "paid" ? "ocr-paid" : "ocr-free", text: "", truncated: false, words: 0,
                fetchedAt: started, startedAt: started, finalUrl: stored?.finalUrl, contentType: stored?.contentType, pages: stored?.pages };
            try { await save(profile, id, running); } catch (error) { release(); throw error; }
            const background = async () => {
                try { await save(profile, id, await extractor.ocr(item.source, stored, tier, profile)); }
                catch (error) {
                    console.error("[Capture] OCR failed:", error instanceof Error ? error.message : error);
                    const note = error instanceof CaptureError ? error.message : "Gemini could not read the PDF. Try again.";
                    await save(profile, id, { ...running, status: "failed", note }).catch(() => {});
                } finally { release(); }
            };
            return { extract: running, background };
        }
        if (stored && (!options.refresh || stored.status === "running")) return { extract: stored };
        const release = extractor.acquire("extract");
        if (!release) throw new CaptureError("Another source is being read. Try again in a moment.", 429);
        try {
            const fresh = await extractor.read(item.source, profile);
            await save(profile, id, fresh);
            return { extract: fresh };
        } finally { release(); }
    }
    /** Stores the text the Capture page read page by page from a scanned PDF (V8 F2); the box never renders PDFs. */
    async function savePages(profile: string, id: string, input: unknown): Promise<CaptureExtract> {
        const save = deps.saveExtract;
        if (!save) throw new CaptureError("Source text is not available on this server.", 503);
        const value = pagesSchema.parse(input);
        if (value.unread > value.pages) throw new CaptureError("Check the page counts and try again.");
        const item = await get(profile, id);
        if (item.receipt) throw new CaptureError("This capture is already in knowledge, so its source text is fixed.", 409);
        if (item.source.kind !== "pdf") throw new CaptureError("Only PDF captures are read page by page.");
        if (item.extract?.status === "running") throw new CaptureError("Gemini is reading this PDF. Wait for it to finish.", 409);
        const capped = capText(value.text.replace(/\r\n/g, "\n").trim());
        const extract: CaptureExtract = {
            version: 1, status: capped.text ? "ok" : "empty", method: "parse", text: capped.text, truncated: capped.truncated, words: countWords(capped.text),
            fetchedAt: (deps.extractor?.now?.() ?? new Date()).toISOString(), contentType: "application/pdf", pages: value.pages, model: value.model,
            note: !capped.text ? `${value.model} found no readable text.` : value.unread ? `${value.unread} of ${value.pages} pages could not be read.` : undefined,
        };
        await save(profile, id, extract);
        return extract;
    }
    return {
        extract,
        savePages,
        async capture(profile: string, id: string, input: unknown) {
            z.string().uuid().parse(id);
            const source = validateCaptureSource(input), sourceHash = digest(JSON.stringify(source));
            const saved = await deps.insert({ id, profileId: profile, source, sourceHash, createdAt: new Date().toISOString(), receipt: null });
            if (saved.sourceHash !== sourceHash) throw new CaptureError("This capture ID already contains different content. Keep both by creating a new capture.", 409);
            return saved;
        },
        preview,
        async ingest(profile: string, input: Pick<CapturePreview, "id" | "review" | "headSha" | "previewHash">) {
            sha.parse(input.headSha); hash.parse(input.previewHash);
            const item = await get(profile, input.id);
            if (item.receipt) return { ...item.receipt, background: undefined, warning: item.receipt.indexed ? null : "The source was saved, but search indexing has not finished. If it stays this way, use Reconcile in Knowledge." };
            const plan = await preview(profile, input.id, input.review);
            if (!plan.existing && (plan.headSha !== input.headSha || plan.previewHash !== input.previewHash)) throw new CaptureError("The vault or preview changed. Review the destination again.", 409);
            const wanted = { path: plan.path, contentHash: digest(plan.markdown) };
            const claim = await deps.claim(profile, input.id, wanted);
            if (claim.path !== wanted.path || claim.contentHash !== wanted.contentHash) throw new CaptureError("This capture is reserved for an earlier reviewed destination and content. Retry that review, or create a separate capture.", 409);
            const original = item.source.pdf?.base64 ?? item.source.image?.base64;
            const changes = [{ path: plan.path, content: plan.markdown }, ...(original && plan.originalPath ? [{ path: plan.originalPath, contentBase64: original }] : [])];
            const commit = plan.existing ? plan.headSha : (await deps.commit(changes, plan.headSha)).commit;
            const receipt = { path: plan.path, commit, indexed: false };
            let recorded = true; try { await deps.receipt(profile, input.id, receipt); } catch { recorded = false; }
            const photo: CapturePhoto | null = item.source.image?.base64 && plan.originalPath && deps.indexPhoto ? {
                path: plan.originalPath, notePath: plan.path, title: plan.review.title, base64: item.source.image.base64,
                text: [plan.review.sourceText?.trim(), plan.review.text.trim()].filter(Boolean).join("\n\n"),
            } : null;
            // Source text can embed hundreds of chunks one by one, past Cloudflare's 100 s cut.
            const background = async () => {
                try { await deps.index(plan.path, plan.review.title, plan.markdown, profile); }
                catch (error) { console.error("[Capture] Indexing failed:", error instanceof Error ? error.message : error); return; }
                // The note is searchable either way; a photo that failed is picked up by Index photos on the Knowledge page.
                if (photo) await deps.indexPhoto!(photo, profile)
                    .catch((error) => console.error("[Capture] Photo indexing failed:", error instanceof Error ? error.message : error));
                await deps.receipt(profile, input.id, { ...receipt, indexed: true })
                    .catch((error) => console.error("[Capture] Indexed receipt not saved:", error instanceof Error ? error.message : error));
            };
            return { ...receipt, background, warning: !recorded ? "The source was saved, but the inbox status could not be updated. Retrying will not create a duplicate source." : null };
        },
    };
}
