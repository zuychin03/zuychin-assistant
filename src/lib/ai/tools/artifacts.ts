import JSZip from "jszip";
import { renderDocument, type ExportFormat } from "@/lib/export";
import { saveArtifact } from "@/lib/artifacts/store";
import { storeEmbedding } from "@/lib/db";
import { embedText, getEmbeddingRef, type ResolvedEmbedding } from "@/lib/ai/embeddings";
import type { McpTool, ToolContext } from "@/lib/ai/mcp-service";

const EXPORT_FORMATS: ExportFormat[] = ["docx", "pdf", "md"];

function sanitizeFilename(name: string, fallback: string): string {
    const cleaned = (name || "")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^[_.]+/, "")
        .slice(0, 80);
    return cleaned || fallback;
}

function sanitizeZipPath(name: string, fallback: string): string {
    const cleaned = (name || "")
        .replace(/\\/g, "/")
        .replace(/[^a-zA-Z0-9._/-]/g, "_")
        .replace(/^\/+/, "")
        .replace(/\.{2,}/g, ".")
        .slice(0, 120);
    return cleaned || fallback;
}

export const ARTIFACT_TOOLS: McpTool[] = [
    {
        name: "create_document",
        description: "Generate a downloadable, nicely formatted report/document from Markdown and attach it to your reply. Use whenever the user asks for a report, summary write-up, briefing, or any document they can download and open (Word/PDF). Supports headings, lists, tables, code blocks, bold/italic and links. The document is automatically remembered in the knowledge base — do not save it again with save_note. After calling this, tell the user the document is ready to download.",
        parameters: {
            title: { type: "string", description: "Document title; also used as the filename.", required: true },
            markdown: { type: "string", description: "The full document body in Markdown.", required: true },
            format: { type: "string", description: "Output format (default pdf).", required: false, enum: ["pdf", "docx", "md"] },
        },
    },
    {
        name: "create_code_file",
        description: "Generate a single downloadable code or text file and attach it to your reply. Use when the user asks for code, a script, or a standalone config/text file. Call it multiple times to return several separate files.",
        parameters: {
            filename: { type: "string", description: "File name including extension, e.g. 'dedupe.py'.", required: true },
            content: { type: "string", description: "The full contents of the file.", required: true },
            language: { type: "string", description: "Optional language/type hint, e.g. 'python'.", required: false },
        },
    },
    {
        name: "create_code_bundle",
        description: "Bundle several related files into one downloadable .zip and attach it to your reply. Prefer this for multi-file projects (3+ files). Filenames may include folders, e.g. 'src/main.py'.",
        parameters: {
            bundle_name: { type: "string", description: "Name for the zip (without the .zip extension).", required: true },
            files: {
                type: "array",
                description: "The files to include in the zip.",
                required: true,
                items: {
                    type: "object",
                    description: "A single file entry.",
                    properties: {
                        filename: { type: "string", description: "Path/name inside the zip, e.g. 'src/main.py'.", required: true },
                        content: { type: "string", description: "The file contents.", required: true },
                    },
                },
            },
        },
    },
];

export async function executeArtifactTool(
    name: string,
    args: Record<string, unknown>,
    ctx?: ToolContext,
    embRef?: ResolvedEmbedding,
): Promise<string | null> {
    switch (name) {
        case "create_document": return execCreateDocument(args, ctx, embRef);
        case "create_code_file": return execCreateCodeFile(args, ctx);
        case "create_code_bundle": return execCreateCodeBundle(args, ctx);
        default: return null;
    }
}

// Embeds generated documents into the RAG knowledge base for later recall.
async function rememberDocument(
    title: string,
    filename: string,
    markdown: string,
    ctx?: ToolContext,
    embRef?: ResolvedEmbedding,
): Promise<void> {
    try {
        const ref = embRef ?? getEmbeddingRef();
        const content = `Generated document "${title}" (${filename}):\n${markdown.slice(0, 2000)}`;
        const embedding = await embedText(ref, content);
        await storeEmbedding({
            content,
            embedding,
            embeddingModel: ref.model.id,
            metadata: { source: "generated_document", filename },
            userProfileId: ctx?.userProfileId,
        });
    } catch (err) {
        console.warn("[Artifacts] failed to save document to knowledge base:", err);
    }
}

async function execCreateDocument(args: Record<string, unknown>, ctx?: ToolContext, embRef?: ResolvedEmbedding): Promise<string> {
    const title = String(args.title ?? "Document");
    const markdown = String(args.markdown ?? "");
    if (!markdown.trim()) return "Error: `markdown` content is required.";

    const fmtArg = String(args.format ?? "pdf");
    const format: ExportFormat = (EXPORT_FORMATS as string[]).includes(fmtArg) ? (fmtArg as ExportFormat) : "pdf";

    try {
        const { body, mimeType, filename } = await renderDocument(markdown, format, title);
        const art = await saveArtifact({
            kind: "document", filename, mimeType, body,
            conversationId: ctx?.conversationId, userProfileId: ctx?.userProfileId,
        });
        ctx?.onArtifact?.(art);
        await rememberDocument(title, filename, markdown, ctx, embRef);
        return `Created document "${filename}" (${(art.size / 1024).toFixed(0)} KB). It is attached to this reply as a download and saved to the knowledge base — let the user know it's ready.`;
    } catch (err) {
        console.error("[Artifacts] create_document failed:", err);
        return "Failed to generate the document.";
    }
}

async function execCreateCodeFile(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
    const content = String(args.content ?? "");
    if (!content) return "Error: file `content` is required.";
    const filename = sanitizeFilename(String(args.filename ?? ""), "code.txt");

    try {
        const art = await saveArtifact({
            kind: "code", filename, mimeType: "text/plain; charset=utf-8", body: content,
            conversationId: ctx?.conversationId, userProfileId: ctx?.userProfileId,
        });
        ctx?.onArtifact?.(art);
        return `Created file "${filename}" (${art.size} bytes), attached to this reply as a download.`;
    } catch (err) {
        console.error("[Artifacts] create_code_file failed:", err);
        return "Failed to create the file.";
    }
}

async function execCreateCodeBundle(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
    const rawFiles = Array.isArray(args.files) ? args.files : [];
    if (rawFiles.length === 0) return "Error: `files` must contain at least one file.";

    try {
        const zip = new JSZip();
        let count = 0;
        for (const f of rawFiles) {
            const entry = f as { filename?: unknown; content?: unknown };
            const path = sanitizeZipPath(String(entry.filename ?? ""), `file${count + 1}.txt`);
            zip.file(path, String(entry.content ?? ""));
            count++;
        }
        const buf = await zip.generateAsync({ type: "nodebuffer" });

        const bundleName = sanitizeFilename(String(args.bundle_name ?? "bundle"), "bundle").replace(/\.zip$/i, "");
        const filename = `${bundleName}.zip`;
        const art = await saveArtifact({
            kind: "archive", filename, mimeType: "application/zip", body: buf,
            conversationId: ctx?.conversationId, userProfileId: ctx?.userProfileId,
        });
        ctx?.onArtifact?.(art);
        return `Created bundle "${filename}" with ${count} file(s) (${(art.size / 1024).toFixed(0)} KB), attached as a download.`;
    } catch (err) {
        console.error("[Artifacts] create_code_bundle failed:", err);
        return "Failed to create the bundle.";
    }
}
