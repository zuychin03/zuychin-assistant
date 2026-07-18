import { createHash } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { embedText, type ResolvedEmbedding } from "@/lib/ai/embeddings";
import { chunkMarkdown } from "@/lib/knowledge/chunker";
import { computeKnowledgeScore } from "@/lib/knowledge/recall";
import { hashContent, parseFrontmatter } from "@/lib/knowledge/markdown";
import type {
    KnowledgeDocumentMeta, KnowledgeProvenance, KnowledgeRecallHit,
} from "@/lib/knowledge/types";

function stringValue(value: string | string[] | undefined, fallback = ""): string {
    return Array.isArray(value) ? value[0] ?? fallback : value ?? fallback;
}

function deterministicLegacyId(path: string): string {
    const hash = createHash("sha256").update(path.toLowerCase()).digest("hex").slice(0, 24);
    return `zuychin-legacy-${hash}`;
}

function documentMeta(params: {
    path: string;
    title: string;
    summary: string;
    category: string;
    markdown: string;
}): KnowledgeDocumentMeta {
    const parsed = parseFrontmatter(params.markdown);
    const attributes = parsed.attributes;
    const now = new Date().toISOString();
    const sourcesValue = attributes.sources;
    const sources = Array.isArray(sourcesValue) ? sourcesValue : sourcesValue ? [sourcesValue] : [];
    const contentHash = hashContent(params.markdown);
    return {
        id: stringValue(attributes.zuychin_id) || deterministicLegacyId(params.path),
        path: params.path,
        title: params.title || stringValue(attributes.title),
        summary: params.summary,
        category: params.category || stringValue(attributes.category, "concepts"),
        kind: stringValue(attributes.type, params.category === "sources" ? "document" : "semantic") as KnowledgeDocumentMeta["kind"],
        scope: stringValue(attributes.scope, "user") as KnowledgeDocumentMeta["scope"],
        status: stringValue(attributes.status, "active") as KnowledgeDocumentMeta["status"],
        trust: stringValue(attributes.trust, "reviewed") as KnowledgeDocumentMeta["trust"],
        sensitivity: stringValue(attributes.sensitivity, "private") as KnowledgeDocumentMeta["sensitivity"],
        projectId: stringValue(attributes.project_id) || undefined,
        supersedesId: stringValue(attributes.supersedes) || undefined,
        validFrom: stringValue(attributes.valid_from) || undefined,
        validTo: stringValue(attributes.valid_to) || undefined,
        createdAt: stringValue(attributes.created, now),
        updatedAt: stringValue(attributes.updated, now),
        contentHash,
        provenance: sources.map((source): KnowledgeProvenance => ({
            source,
            ...(source.startsWith("http") ? { sourceUrl: source } : { sourcePath: source }),
            capturedAt: now,
            contentHash,
        })),
    };
}

function schemaUnavailable(message: string): boolean {
    return /does not exist|schema cache|could not find the table|could not find the function/i.test(message);
}

function extractTargets(markdown: string): string[] {
    const targets = new Set<string>();
    for (const match of markdown.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]*)?\]\]/g)) {
        const target = match[1].trim().replace(/^\/+/, "").replace(/\.md$/i, "");
        if (target) targets.add(`${target}.md`);
    }
    for (const match of markdown.matchAll(/\[[^\]]+]\((?!https?:|mailto:|#)([^)#]+)(?:#[^)]*)?\)/g)) {
        const target = match[1].trim().replace(/^\.\//, "").replace(/\.md$/i, "");
        if (target) targets.add(`${target}.md`);
    }
    return [...targets];
}

export async function indexKnowledgeDocument(params: {
    path: string;
    title: string;
    summary: string;
    category: string;
    markdown: string;
    embRef: ResolvedEmbedding;
}): Promise<boolean> {
    const meta = documentMeta(params);
    const chunks = chunkMarkdown({
        documentId: meta.id,
        path: meta.path,
        markdown: params.markdown,
    });
    const embedded = [];
    for (const chunk of chunks) {
        const context = [meta.title, chunk.headingPath.join(" > "), chunk.content].filter(Boolean).join("\n\n");
        embedded.push({
            ...chunk,
            embedding: await embedText(params.embRef, context, "passage"),
        });
    }

    const { error: documentError } = await supabase.from("knowledge_documents").upsert({
        id: meta.id,
        path: meta.path,
        title: meta.title,
        summary: meta.summary,
        category: meta.category,
        kind: meta.kind,
        scope: meta.scope,
        status: meta.status,
        trust: meta.trust,
        sensitivity: meta.sensitivity,
        project_id: meta.projectId ?? null,
        supersedes_id: meta.supersedesId ?? null,
        valid_from: meta.validFrom ?? null,
        valid_to: meta.validTo ?? null,
        content_hash: meta.contentHash,
        provenance: meta.provenance,
        updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
    if (documentError) {
        if (schemaUnavailable(documentError.message)) return false;
        throw new Error(`Failed to index knowledge document: ${documentError.message}`);
    }

    const payload = embedded.map((chunk) => ({
        id: chunk.id,
        heading: chunk.heading,
        heading_path: chunk.headingPath,
        ordinal: chunk.ordinal,
        content: chunk.content,
        content_hash: chunk.contentHash,
        token_count: chunk.tokenCount,
        embedding: chunk.embedding,
        embedding_model: params.embRef.model.id,
    }));
    const { error: chunkError } = await supabase.rpc("replace_knowledge_chunks", {
        p_document_id: meta.id,
        p_chunks: payload,
    });
    if (chunkError) {
        if (schemaUnavailable(chunkError.message)) return false;
        throw new Error(`Failed to replace knowledge chunks: ${chunkError.message}`);
    }

    const targets = extractTargets(params.markdown);
    const { error: deleteLinkError } = await supabase
        .from("knowledge_links")
        .delete()
        .eq("source_document_id", meta.id);
    if (deleteLinkError && !schemaUnavailable(deleteLinkError.message)) {
        throw new Error(`Failed to refresh knowledge links: ${deleteLinkError.message}`);
    }
    if (targets.length) {
        const { data: documents } = await supabase
            .from("knowledge_documents")
            .select("id, path")
            .in("path", targets);
        const targetIds = new Map((documents ?? []).map((row: { id: string; path: string }) => [row.path, row.id]));
        const { error: linkError } = await supabase.from("knowledge_links").insert(targets.map((target) => ({
            source_document_id: meta.id,
            target_document_id: targetIds.get(target) ?? null,
            target_ref: target,
            relation: "related",
        })));
        if (linkError && !schemaUnavailable(linkError.message)) {
            throw new Error(`Failed to index knowledge links: ${linkError.message}`);
        }
    }
    return true;
}

interface RecallRow {
    document_id: string;
    chunk_id: string;
    path: string;
    title: string;
    heading: string;
    content: string;
    category: string;
    kind: KnowledgeDocumentMeta["kind"];
    trust: KnowledgeDocumentMeta["trust"];
    provenance: KnowledgeProvenance[];
    updated_at: string;
    semantic_score: number;
    lexical_score: number;
}

async function graphBoosts(documentIds: string[]): Promise<Map<string, number>> {
    const boosts = new Map<string, number>();
    if (!documentIds.length) return boosts;
    const [outbound, inbound] = await Promise.all([
        supabase.from("knowledge_links").select("source_document_id, target_document_id").in("source_document_id", documentIds),
        supabase.from("knowledge_links").select("source_document_id, target_document_id").in("target_document_id", documentIds),
    ]);
    const candidateSet = new Set(documentIds);
    for (const row of [...(outbound.data ?? []), ...(inbound.data ?? [])]) {
        const source = row.source_document_id as string;
        const target = row.target_document_id as string | null;
        if (candidateSet.has(source) && target && candidateSet.has(target)) {
            boosts.set(source, (boosts.get(source) ?? 0) + 1);
            boosts.set(target, (boosts.get(target) ?? 0) + 1);
        }
    }
    const max = Math.max(1, ...boosts.values());
    for (const [id, value] of boosts) boosts.set(id, value / max);
    return boosts;
}

export async function recallKnowledge(params: {
    query: string;
    embRef: ResolvedEmbedding;
    queryEmbedding?: number[];
    matchCount?: number;
    projectId?: string;
}): Promise<KnowledgeRecallHit[] | null> {
    const embedding = params.queryEmbedding ?? await embedText(params.embRef, params.query, "query");
    const { data, error } = await supabase.rpc("hybrid_recall_knowledge_chunks", {
        query_embedding: JSON.stringify(embedding),
        query_text: params.query,
        match_count: Math.max((params.matchCount ?? 8) * 4, 20),
        filter_model: params.embRef.model.id,
        filter_project: params.projectId ?? null,
    });
    if (error) {
        if (schemaUnavailable(error.message)) return null;
        console.error("[Knowledge] Recall failed:", error.message);
        return [];
    }

    const rows = (data ?? []) as RecallRow[];
    const graph = await graphBoosts([...new Set(rows.map((row) => row.document_id))]);
    return rows.map((row) => {
        const ageDays = Math.max(0, (Date.now() - new Date(row.updated_at).getTime()) / 86_400_000);
        return {
            documentId: row.document_id,
            chunkId: row.chunk_id,
            path: row.path,
            title: row.title,
            heading: row.heading,
            excerpt: row.content,
            category: row.category,
            score: computeKnowledgeScore({
                semantic: Number(row.semantic_score) || 0,
                lexical: Number(row.lexical_score) || 0,
                graph: graph.get(row.document_id) ?? 0,
                trust: row.trust,
                kind: row.kind,
                ageDays,
            }),
            provenance: row.provenance ?? [],
        };
    }).sort((a, b) => b.score.final - a.score.final).slice(0, params.matchCount ?? 8);
}
