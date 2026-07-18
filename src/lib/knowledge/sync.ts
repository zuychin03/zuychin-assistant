import { supabaseAdmin as supabase } from "@/lib/supabase";
import {
    commitFiles, getBranchHead, getFile, listAllFiles, requireVaultConfig,
    type CommitFileChange,
} from "@/lib/vault/github";
import { hashContent, normalizeVaultMarkdown, parseFrontmatter } from "@/lib/knowledge/markdown";
import { documentMeta, indexKnowledgeDocument } from "@/lib/knowledge/store";
import { knowledgeService } from "@/lib/knowledge/service";
import { vaultEmbeddingRef } from "@/lib/vault/store";
import { safeVaultPath } from "@/lib/knowledge/paths";

interface IndexedDocument {
    id: string;
    path: string;
    content_hash: string;
    status: string;
}

export interface ReconcileResult {
    cursor: string;
    scanned: number;
    indexed: string[];
    unchanged: string[];
    deleted: string[];
    identitiesAdded: string[];
    fullScan: boolean;
}

function titleAndCategory(path: string, markdown: string): { title: string; category: string } {
    const parsed = parseFrontmatter(markdown);
    const titleValue = parsed.attributes.title;
    const categoryValue = parsed.attributes.category;
    return {
        title: (Array.isArray(titleValue) ? titleValue[0] : titleValue)
            || parsed.body.match(/^#\s+(.+)$/m)?.[1]
            || path.split("/").pop()!.replace(/\.md$/i, ""),
        category: (Array.isArray(categoryValue) ? categoryValue[0] : categoryValue) || "notes",
    };
}

async function updateSyncState(patch: Record<string, unknown>): Promise<void> {
    const { error } = await supabase.from("knowledge_sync_state").upsert({
        source: "github-vault",
        ...patch,
        updated_at: new Date().toISOString(),
    }, { onConflict: "source" });
    if (error) console.warn("[Knowledge] Failed to update sync state:", error.message);
}

export async function reconcileKnowledge(options: {
    paths?: string[];
    deletedPaths?: string[];
    fullScan?: boolean;
    applyIdentities?: boolean;
} = {}): Promise<ReconcileResult> {
    const cfg = requireVaultConfig();
    const fullScan = options.fullScan === true;
    const cursor = await getBranchHead(cfg);
    const selectedPaths = options.paths?.map(safeVaultPath)
        .filter((path) => path.toLowerCase().endsWith(".md"));
    const files = selectedPaths
        ? (await Promise.all(selectedPaths.map((path) => getFile(cfg, path)))).filter((file) => !!file)
        : await Promise.all(
            (await listAllFiles(cfg))
                .filter((entry) => entry.path.toLowerCase().endsWith(".md"))
                .map((entry) => getFile(cfg, entry.path)),
        ).then((items) => items.filter((file) => !!file));

    const { data, error } = await supabase
        .from("knowledge_documents")
        .select("id, path, content_hash, status");
    if (error) throw new Error(`Failed to read the knowledge index: ${error.message}`);
    const indexedByPath = new Map(
        ((data ?? []) as IndexedDocument[]).map((document) => [document.path, document]),
    );

    const identityChanges: CommitFileChange[] = [];
    const identitiesAdded: string[] = [];
    const materialized = files.map((file) => {
        const parsed = parseFrontmatter(file.text);
        if (parsed.attributes.zuychin_id || !options.applyIdentities) {
            return { ...file, markdown: file.text };
        }
        const { title, category } = titleAndCategory(file.path, file.text);
        const prepared = normalizeVaultMarkdown({
            path: file.path,
            markdown: file.text,
            title,
            category,
            trust: "reviewed",
        });
        identityChanges.push({ path: file.path, content: prepared.markdown });
        identitiesAdded.push(file.path);
        return { ...file, markdown: prepared.markdown };
    });

    if (identityChanges.length) {
        await commitFiles(cfg, identityChanges, `curator: add stable ids to ${identityChanges.length} pages`);
    }

    const embRef = await vaultEmbeddingRef();
    const indexed: string[] = [];
    const unchanged: string[] = [];
    for (const file of materialized) {
        const contentHash = hashContent(file.markdown);
        const current = indexedByPath.get(file.path);
        if (current?.content_hash === contentHash && current.status === "active") {
            unchanged.push(file.path);
            continue;
        }
        const { title, category } = titleAndCategory(file.path, file.markdown);
        await indexKnowledgeDocument({
            path: file.path,
            title,
            summary: "",
            category,
            markdown: file.markdown,
            embRef,
        });
        const meta = documentMeta({ path: file.path, title, summary: "", category, markdown: file.markdown });
        await knowledgeService.recordEvent({
            documentId: meta.id,
            action: current ? "indexed" : "created",
            actor: "system",
            detail: { path: file.path, cursor },
        });
        indexed.push(file.path);
    }

    const deletedSet = new Set(
        (options.deletedPaths ?? []).map(safeVaultPath)
            .filter((path) => path.toLowerCase().endsWith(".md")),
    );
    if (fullScan) {
        const seen = new Set(materialized.map((file) => file.path));
        for (const document of indexedByPath.values()) {
            if (!seen.has(document.path)) deletedSet.add(document.path);
        }
    }

    const deleted: string[] = [];
    for (const path of deletedSet) {
        const document = indexedByPath.get(path);
        if (!document || document.status === "deleted") continue;
        const now = new Date().toISOString();
        const { error: deleteError } = await supabase
            .from("knowledge_documents")
            .update({ status: "deleted", valid_to: now, updated_at: now })
            .eq("id", document.id);
        if (deleteError) throw new Error(`Failed to retire ${path}: ${deleteError.message}`);
        await knowledgeService.recordEvent({
            documentId: document.id,
            action: "deleted",
            actor: "system",
            detail: { path, cursor, inferredFromCompleteScan: fullScan },
        });
        deleted.push(path);
    }

    if (fullScan) {
        await supabase.from("knowledge_suggestions")
            .delete()
            .eq("kind", "missing_identity")
            .eq("status", "open");
        const missing = materialized.filter((file) => !parseFrontmatter(file.markdown).attributes.zuychin_id);
        if (missing.length) {
            await supabase.from("knowledge_suggestions").insert(missing.map((file) => ({
                kind: "missing_identity",
                severity: "warning",
                document_ids: [indexedByPath.get(file.path)?.id].filter(Boolean),
                title: "Add a stable Markdown identity",
                detail: `${file.path} needs a zuychin_id property before it can be moved safely.`,
                evidence: { path: file.path },
                confidence: 1,
            })));
        }
    }

    await updateSyncState({
        cursor,
        last_success_at: new Date().toISOString(),
        ...(fullScan ? { last_complete_scan_at: new Date().toISOString() } : {}),
        last_error: null,
    });
    return {
        cursor,
        scanned: materialized.length,
        indexed,
        unchanged,
        deleted,
        identitiesAdded,
        fullScan,
    };
}
