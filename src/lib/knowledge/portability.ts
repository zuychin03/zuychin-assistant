import { createHash } from "node:crypto";
import JSZip from "jszip";
import {
    commitFiles, getBinaryFile, listAllFiles, requireVaultConfig,
    type CommitFileChange,
} from "@/lib/vault/github";
import { vaultEmbeddingRef } from "@/lib/vault/store";
import { documentMeta, indexKnowledgeDocument } from "@/lib/knowledge/store";
import { parseFrontmatter } from "@/lib/knowledge/markdown";
import { knowledgeService } from "@/lib/knowledge/service";
import { safeVaultPath } from "@/lib/knowledge/paths";
export { safeVaultPath } from "@/lib/knowledge/paths";

const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MANIFEST_PATH = ".zuychin/manifest.json";

function sha256(content: Buffer): string {
    return createHash("sha256").update(content).digest("hex");
}


export interface ObsidianExportManifest {
    format: "zuychin-obsidian-v1";
    exportedAt: string;
    repository: string;
    branch: string;
    files: { path: string; bytes: number; sha256: string; blobSha: string }[];
}

export async function exportObsidianVault(): Promise<{
    archive: Buffer;
    manifest: ObsidianExportManifest;
}> {
    const cfg = requireVaultConfig();
    const entries = await listAllFiles(cfg);
    const zip = new JSZip();
    const files: ObsidianExportManifest["files"] = [];

    for (const entry of entries) {
        const file = await getBinaryFile(cfg, entry.path);
        if (!file) continue;
        zip.file(entry.path, file.content);
        files.push({
            path: entry.path,
            bytes: file.content.length,
            sha256: sha256(file.content),
            blobSha: entry.sha,
        });
    }

    const manifest: ObsidianExportManifest = {
        format: "zuychin-obsidian-v1",
        exportedAt: new Date().toISOString(),
        repository: `${cfg.owner}/${cfg.repo}`,
        branch: cfg.branch,
        files,
    };
    zip.file(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    return {
        archive: await zip.generateAsync({
            type: "nodebuffer",
            compression: "DEFLATE",
            compressionOptions: { level: 6 },
            platform: "UNIX",
        }),
        manifest,
    };
}

export interface ImportChange {
    path: string;
    action: "create" | "update" | "unchanged";
    bytes: number;
    markdown: boolean;
    hasStableId: boolean;
}

export interface ObsidianImportPlan {
    files: number;
    changed: number;
    created: number;
    updated: number;
    unchanged: number;
    totalBytes: number;
    missingStableIds: string[];
    changes: ImportChange[];
    commit?: string;
    dryRun: boolean;
}

interface LoadedImport {
    plan: ObsidianImportPlan;
    contents: Map<string, Buffer>;
}

async function loadImport(archive: Buffer): Promise<LoadedImport> {
    if (archive.length > MAX_ARCHIVE_BYTES) throw new Error("The vault archive is too large.");
    const zip = await JSZip.loadAsync(archive, { createFolders: false });
    const entries = Object.values(zip.files).filter((entry) => !entry.dir && entry.name !== MANIFEST_PATH);
    if (entries.length > MAX_FILES) throw new Error(`A vault import is limited to ${MAX_FILES} files.`);

    const cfg = requireVaultConfig();
    const current = new Map((await listAllFiles(cfg)).map((entry) => [entry.path, entry]));
    const contents = new Map<string, Buffer>();
    const changes: ImportChange[] = [];
    let totalBytes = 0;

    for (const entry of entries) {
        const path = safeVaultPath(entry.name);
        const content = await entry.async("nodebuffer");
        if (content.length > MAX_FILE_BYTES) throw new Error(`${path} exceeds the per-file import limit.`);
        totalBytes += content.length;
        if (totalBytes > MAX_ARCHIVE_BYTES) throw new Error("The expanded vault is too large.");
        contents.set(path, content);

        const existing = current.get(path);
        let action: ImportChange["action"] = "create";
        if (existing) {
            const currentFile = await getBinaryFile(cfg, path);
            action = currentFile?.content.equals(content) ? "unchanged" : "update";
        }
        const markdown = path.toLowerCase().endsWith(".md");
        const parsed = markdown ? parseFrontmatter(content.toString("utf8")) : null;
        changes.push({
            path,
            action,
            bytes: content.length,
            markdown,
            hasStableId: !!parsed?.attributes.zuychin_id,
        });
    }

    const changed = changes.filter((change) => change.action !== "unchanged");
    return {
        contents,
        plan: {
            files: changes.length,
            changed: changed.length,
            created: changes.filter((change) => change.action === "create").length,
            updated: changes.filter((change) => change.action === "update").length,
            unchanged: changes.filter((change) => change.action === "unchanged").length,
            totalBytes,
            missingStableIds: changes
                .filter((change) => change.markdown && !change.hasStableId)
                .map((change) => change.path),
            changes,
            dryRun: true,
        },
    };
}

export async function inspectObsidianImport(archive: Buffer): Promise<ObsidianImportPlan> {
    return (await loadImport(archive)).plan;
}

export async function importObsidianVault(
    archive: Buffer,
    options: { dryRun?: boolean } = {},
): Promise<ObsidianImportPlan> {
    const loaded = await loadImport(archive);
    if (options.dryRun !== false || loaded.plan.changed === 0) return loaded.plan;

    const changes: CommitFileChange[] = loaded.plan.changes
        .filter((change) => change.action !== "unchanged")
        .map((change) => ({
            path: change.path,
            contentBase64: loaded.contents.get(change.path)!.toString("base64"),
        }));
    const { commit } = await commitFiles(
        requireVaultConfig(),
        changes,
        `import: Obsidian vault (${changes.length} files)`,
    );

    const markdownChanges = loaded.plan.changes
        .filter((change) => change.markdown && change.action !== "unchanged");
    if (markdownChanges.length) {
        const embRef = await vaultEmbeddingRef();
        for (const change of markdownChanges) {
            const markdown = loaded.contents.get(change.path)!.toString("utf8");
            const parsed = parseFrontmatter(markdown);
            const titleValue = parsed.attributes.title;
            const title = (Array.isArray(titleValue) ? titleValue[0] : titleValue)
                || parsed.body.match(/^#\s+(.+)$/m)?.[1]
                || change.path.split("/").pop()!.replace(/\.md$/i, "");
            const categoryValue = parsed.attributes.category;
            const category = (Array.isArray(categoryValue) ? categoryValue[0] : categoryValue) || "notes";
            const meta = documentMeta({ path: change.path, title, summary: "", category, markdown });
            await indexKnowledgeDocument({
                path: change.path,
                title,
                summary: "",
                category,
                markdown,
                embRef,
            });
            await knowledgeService.recordEvent({
                documentId: meta.id,
                action: "imported",
                actor: "user",
                detail: { path: change.path, commit },
            });
        }
    }

    return { ...loaded.plan, commit, dryRun: false };
}
