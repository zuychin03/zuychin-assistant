import { supabaseAdmin as supabase } from "@/lib/supabase";
import { commitFiles, getFile, requireVaultConfig, type CommitFileChange } from "@/lib/vault/github";
import { parseFrontmatter, serializeFrontmatter } from "@/lib/knowledge/markdown";
import { documentMeta, indexKnowledgeDocument } from "@/lib/knowledge/store";
import { knowledgeService } from "@/lib/knowledge/service";
import { vaultEmbeddingRef } from "@/lib/vault/store";
import type { KnowledgeScope, KnowledgeStatus, KnowledgeTrust } from "@/lib/knowledge/types";

interface DocumentRow {
    id: string;
    path: string;
    title: string;
    summary: string;
    category: string;
    status: KnowledgeStatus;
    scope: KnowledgeScope;
    trust: KnowledgeTrust;
}

function withProperties(
    markdown: string,
    properties: Record<string, string | undefined>,
): string {
    const parsed = parseFrontmatter(markdown);
    for (const [key, value] of Object.entries(properties)) {
        if (value === undefined) delete parsed.attributes[key];
        else parsed.attributes[key] = value;
    }
    return serializeFrontmatter(parsed);
}

async function getDocument(id: string): Promise<DocumentRow> {
    const { data, error } = await supabase
        .from("knowledge_documents")
        .select("id, path, title, summary, category, status, scope, trust")
        .eq("id", id)
        .single();
    if (error || !data) throw new Error("Knowledge document not found.");
    return data as DocumentRow;
}

async function commitLifecycleChanges(params: {
    changes: { document: DocumentRow; markdown: string; status: KnowledgeStatus; supersedesId?: string }[];
    message: string;
    action: "corrected" | "promoted" | "merged" | "archived" | "restored" | "deleted";
}): Promise<{ commit: string }> {
    const cfg = requireVaultConfig();
    const fileChanges: CommitFileChange[] = params.changes.map((change) => ({
        path: change.document.path,
        content: change.markdown,
    }));
    const { commit } = await commitFiles(cfg, fileChanges, params.message);
    const embRef = await vaultEmbeddingRef();

    for (const change of params.changes) {
        await indexKnowledgeDocument({
            path: change.document.path,
            title: change.document.title,
            summary: change.document.summary,
            category: change.document.category,
            markdown: change.markdown,
            embRef,
        });
        const meta = documentMeta({
            path: change.document.path,
            title: change.document.title,
            summary: change.document.summary,
            category: change.document.category,
            markdown: change.markdown,
        });
        await knowledgeService.recordEvent({
            documentId: meta.id,
            action: params.action,
            actor: "user",
            detail: {
                path: change.document.path,
                commit,
                supersedesId: change.supersedesId,
            },
        });
    }
    return { commit };
}

export type KnowledgeLifecycleAction =
    | "archive"
    | "restore"
    | "forget"
    | "promote"
    | "correct"
    | "merge";

export async function applyKnowledgeLifecycle(input: {
    action: KnowledgeLifecycleAction;
    documentId: string;
    markdown?: string;
    sourceIds?: string[];
    scope?: KnowledgeScope;
    trust?: KnowledgeTrust;
}): Promise<{ commit: string; affected: string[] }> {
    const target = await getDocument(input.documentId);
    const cfg = requireVaultConfig();
    const targetFile = await getFile(cfg, target.path);
    if (!targetFile) throw new Error(`${target.path} no longer exists in the vault.`);
    const today = new Date().toISOString().slice(0, 10);

    if (input.action === "merge") {
        if (!input.markdown?.trim() || !input.sourceIds?.length) {
            throw new Error("A merge needs merged Markdown and at least one source document.");
        }
        const sources = await Promise.all(
            [...new Set(input.sourceIds)].filter((id) => id !== target.id).map(getDocument),
        );
        const sourceFiles = await Promise.all(sources.map(async (source) => ({
            document: source,
            file: await getFile(cfg, source.path),
        })));
        if (sourceFiles.some((source) => !source.file)) throw new Error("A merge source is missing from the vault.");

        const targetMarkdown = withProperties(input.markdown, {
            zuychin_id: target.id,
            status: "active",
            updated: today,
            supersedes: undefined,
            valid_to: undefined,
        });
        const changes = [{
            document: target,
            markdown: targetMarkdown,
            status: "active" as const,
        }, ...sourceFiles.map(({ document, file }) => ({
            document,
            markdown: withProperties(file!.text, {
                status: "superseded",
                supersedes: target.id,
                valid_to: new Date().toISOString(),
                updated: today,
            }),
            status: "superseded" as const,
            supersedesId: target.id,
        }))];
        const result = await commitLifecycleChanges({
            changes,
            message: `curator: merge ${sources.length} pages into ${target.title}`,
            action: "merged",
        });
        return { ...result, affected: changes.map((change) => change.document.id) };
    }

    let markdown = input.markdown?.trim() || targetFile.text;
    let action: Parameters<typeof commitLifecycleChanges>[0]["action"];
    let status = target.status;
    const properties: Record<string, string | undefined> = {
        zuychin_id: target.id,
        updated: today,
    };

    switch (input.action) {
        case "archive":
            status = "archived";
            action = "archived";
            properties.status = status;
            break;
        case "restore":
            status = "active";
            action = "restored";
            properties.status = status;
            properties.valid_to = undefined;
            break;
        case "forget":
            status = "deleted";
            action = "deleted";
            properties.status = status;
            properties.valid_to = new Date().toISOString();
            break;
        case "promote":
            status = "active";
            action = "promoted";
            properties.status = status;
            properties.scope = input.scope ?? "user";
            properties.trust = input.trust ?? "trusted";
            break;
        case "correct":
            if (!input.markdown?.trim()) throw new Error("Corrected Markdown is required.");
            status = "active";
            action = "corrected";
            properties.status = status;
            break;
    }

    markdown = withProperties(markdown, properties);
    const result = await commitLifecycleChanges({
        changes: [{ document: target, markdown, status }],
        message: `curator: ${input.action} ${target.title}`,
        action,
    });
    return { ...result, affected: [target.id] };
}
