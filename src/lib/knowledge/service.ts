import { supabaseAdmin as supabase } from "@/lib/supabase";
import { normalizeVaultMarkdown } from "@/lib/knowledge/markdown";
import type {
    KnowledgeDocumentMeta, KnowledgeEvent, KnowledgeKind, KnowledgeScope,
    KnowledgeSensitivity, KnowledgeStatus, KnowledgeTrust,
} from "@/lib/knowledge/types";
import { GitHubVaultRepository, type KnowledgeRepository } from "@/lib/knowledge/repository";

function isSchemaUnavailable(message: string): boolean {
    return /does not exist|schema cache|could not find the table/i.test(message);
}

export class KnowledgeService {
    constructor(private readonly repository: KnowledgeRepository = new GitHubVaultRepository()) {}

    prepareDocument(params: {
        path: string;
        markdown: string;
        title?: string;
        category?: string;
        summary?: string;
        kind?: KnowledgeKind;
        scope?: KnowledgeScope;
        status?: KnowledgeStatus;
        trust?: KnowledgeTrust;
        sensitivity?: KnowledgeSensitivity;
        source?: string;
    }) {
        return normalizeVaultMarkdown(params);
    }

    read(path: string) {
        return this.repository.read(path);
    }

    listSourceFiles() {
        return this.repository.listMarkdown();
    }

    async upsertDocument(meta: KnowledgeDocumentMeta): Promise<void> {
        const { error } = await supabase.from("knowledge_documents").upsert({
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
        if (!error) return;
        if (isSchemaUnavailable(error.message)) {
            console.warn("[Knowledge] Run supabase-setup.sql to enable lifecycle metadata.");
            return;
        }
        throw new Error(`Failed to update knowledge metadata: ${error.message}`);
    }

    async recordEvent(event: KnowledgeEvent): Promise<void> {
        const { error } = await supabase.from("knowledge_events").insert({
            document_id: event.documentId,
            action: event.action,
            actor: event.actor,
            detail: event.detail ?? {},
            occurred_at: event.occurredAt ?? new Date().toISOString(),
        });
        if (!error || isSchemaUnavailable(error.message)) return;
        throw new Error(`Failed to record knowledge event: ${error.message}`);
    }
}

export const knowledgeService = new KnowledgeService();
