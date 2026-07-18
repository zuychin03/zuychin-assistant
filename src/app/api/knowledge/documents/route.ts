import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getFile, requireVaultConfig } from "@/lib/vault/github";
import { applyKnowledgeLifecycle, type KnowledgeLifecycleAction } from "@/lib/knowledge/lifecycle";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
    try {
        const id = req.nextUrl.searchParams.get("id");
        if (id) {
            const [{ data: document, error }, { data: chunks }, { data: links }] = await Promise.all([
                supabase.from("knowledge_documents").select("*").eq("id", id).single(),
                supabase.from("knowledge_chunks")
                    .select("id, heading, heading_path, ordinal, content, token_count")
                    .eq("document_id", id)
                    .order("ordinal"),
                supabase.from("knowledge_links")
                    .select("id, target_document_id, target_ref, relation, rationale")
                    .eq("source_document_id", id),
            ]);
            if (error || !document) return NextResponse.json({ error: "Document not found." }, { status: 404 });
            const file = await getFile(requireVaultConfig(), document.path);
            return NextResponse.json({
                document,
                markdown: file?.text ?? "",
                chunks: chunks ?? [],
                links: links ?? [],
            });
        }

        let query = supabase.from("knowledge_documents")
            .select("id, path, title, summary, category, kind, scope, status, trust, sensitivity, updated_at")
            .order("updated_at", { ascending: false });
        const status = req.nextUrl.searchParams.get("status");
        const kind = req.nextUrl.searchParams.get("kind");
        const scope = req.nextUrl.searchParams.get("scope");
        if (status && status !== "all") query = query.eq("status", status);
        if (kind && kind !== "all") query = query.eq("kind", kind);
        if (scope && scope !== "all") query = query.eq("scope", scope);
        const { data, error } = await query.limit(500);
        if (error) throw error;
        return NextResponse.json({ documents: data ?? [] });
    } catch (error) {
        console.error("[Knowledge Documents]", error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Failed to load knowledge documents.",
        }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json() as {
            action?: KnowledgeLifecycleAction;
            documentId?: string;
            markdown?: string;
            sourceIds?: string[];
            scope?: "user" | "project" | "repository" | "session";
            trust?: "trusted" | "reviewed" | "untrusted";
        };
        if (!body.action || !body.documentId) {
            return NextResponse.json({ error: "action and documentId are required." }, { status: 400 });
        }
        const result = await applyKnowledgeLifecycle({
            action: body.action,
            documentId: body.documentId,
            markdown: body.markdown,
            sourceIds: body.sourceIds,
            scope: body.scope,
            trust: body.trust,
        });
        return NextResponse.json(result);
    } catch (error) {
        console.error("[Knowledge Lifecycle]", error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Knowledge update failed.",
        }, { status: 400 });
    }
}
