import { createHash } from "node:crypto";
import { z } from "zod";
import { safeVaultPath } from "@/lib/knowledge/paths";
import { serializeFrontmatter } from "@/lib/knowledge/markdown";
import type { CaptureItem, CapturePreview, CaptureReview, CaptureSource } from "./types";

export const MAX_CAPTURE_PDF_BYTES = 2 * 1024 * 1024;
export class CaptureError extends Error {
    constructor(message: string, readonly status = 400) { super(message); this.name = "CaptureError"; }
}
const sha = z.string().regex(/^[a-f0-9]{40}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.object({
    kind: z.enum(["text", "link", "pdf", "offline_note"]), title: z.string().trim().min(1).max(200), text: z.string().max(120_000),
    url: z.string().max(4000).optional(), pdf: z.object({ name: z.string().min(1).max(200), base64: z.string().max(Math.ceil(MAX_CAPTURE_PDF_BYTES / 3) * 4) }).optional(),
    source: z.object({ documentId: z.string().min(1).max(200), path: z.string().max(1024), commitSha: sha, contentHash: hash }).optional(),
}).strict();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
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
}
export function createCaptureService(deps: Dependencies) {
    async function get(profile: string, id: string) {
        z.string().uuid().parse(id);
        const item = await deps.get(profile, id);
        if (!item) throw new CaptureError("Capture not found.", 404);
        return item;
    }
    async function preview(profile: string, id: string, rawReview: CaptureReview): Promise<CapturePreview> {
        const review = z.object({ title: z.string().trim().min(1).max(200), text: z.string().max(120_000), destination: z.string().min(1).max(800) }).parse(rawReview);
        let path: string; try { path = safeVaultPath(review.destination); } catch { throw new CaptureError("Choose a safe destination path."); }
        if (!path.endsWith(".md") || path.startsWith(".") || /[\x00-\x1f]/.test(path)) throw new CaptureError("The destination must be a Markdown path.");
        const item = await get(profile, id);
        const originalPath = item.source.pdf ? `attachments/captures/${id}.pdf` : null;
        const body = [`# ${review.title.replace(/[\r\n]/g, " ")}`, review.text.replace(/\r\n/g, "\n")];
        if (item.source.url) body.push(`Source: <${item.source.url.replace(/[<>]/g, encodeURIComponent)}>`);
        if (originalPath) body.push(`[Original PDF](/api/capture/original?id=${id})`);
        if (item.source.source) body.push(`Source snapshot: ${item.source.source.path} at ${item.source.source.commitSha}\n\nContent SHA-256: ${item.source.source.contentHash}`);
        const markdown = serializeFrontmatter({ attributes: { zuychin_id: `capture-${id}`, title: review.title,
            kind: "note", scope: "user", status: "active", trust: "untrusted", sensitivity: "private", capture_id: id,
            capture_source_hash: item.sourceHash, ...(originalPath ? { original_asset: originalPath } : {}) }, body: body.join("\n\n") + "\n" });
        const headSha = await deps.head();
        const existing = await deps.read(path, headSha);
        if (existing !== null && existing !== markdown) throw new CaptureError("That destination exists or has changed. Choose a new path; existing content will not be replaced.", 409);
        if (existing === null && originalPath && await deps.read(originalPath, headSha) !== null) throw new CaptureError("The original file destination already exists. Review the capture before retrying.", 409);
        return { id, review, path, markdown, originalPath, headSha, existing: existing !== null,
            previewHash: digest(JSON.stringify({ sourceHash: item.sourceHash, path, markdown, originalPath, headSha })) };
    }
    return {
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
            if (item.receipt) return { ...item.receipt, warning: item.receipt.indexed ? null : "The source was saved, but indexing needs reconciliation." };
            const plan = await preview(profile, input.id, input.review);
            if (!plan.existing && (plan.headSha !== input.headSha || plan.previewHash !== input.previewHash)) throw new CaptureError("The vault or preview changed. Review the destination again.", 409);
            const wanted = { path: plan.path, contentHash: digest(plan.markdown) };
            const claim = await deps.claim(profile, input.id, wanted);
            if (claim.path !== wanted.path || claim.contentHash !== wanted.contentHash) throw new CaptureError("This capture is reserved for an earlier reviewed destination and content. Retry that review, or create a separate capture.", 409);
            const changes = [{ path: plan.path, content: plan.markdown }, ...(item.source.pdf && plan.originalPath ? [{ path: plan.originalPath, contentBase64: item.source.pdf.base64 }] : [])];
            const commit = plan.existing ? plan.headSha : (await deps.commit(changes, plan.headSha)).commit;
            let indexed = true;
            try { await deps.index(plan.path, plan.review.title, plan.markdown, profile); } catch { indexed = false; }
            const receipt = { path: plan.path, commit, indexed };
            let recorded = true; try { await deps.receipt(profile, input.id, receipt); } catch { recorded = false; }
            return { ...receipt, warning: !indexed ? "The source was saved, but indexing failed. Reconcile the knowledge library before relying on recall."
                : !recorded ? "The source was saved, but the inbox status could not be updated. Retrying will not create a duplicate source." : null };
        },
    };
}
