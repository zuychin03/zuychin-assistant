import { NextRequest, NextResponse } from "next/server";
import { applyKnowledgeLifecycle } from "@/lib/knowledge/lifecycle";
import {
    listKnowledgeSuggestions, resolveKnowledgeSuggestion, runKnowledgeMaintenance,
} from "@/lib/knowledge/maintenance";
import { supabaseAdmin as supabase } from "@/lib/supabase";

export const maxDuration = 120;

export async function GET(req: NextRequest) {
    try {
        const status = req.nextUrl.searchParams.get("status") ?? "open";
        return NextResponse.json({ suggestions: await listKnowledgeSuggestions(status) });
    } catch (error) {
        console.error("[Knowledge Suggestions]", error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Failed to load suggestions.",
        }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json() as {
            action?: "scan" | "dismiss" | "merge";
            suggestionId?: string;
            includeAssisted?: boolean;
            targetId?: string;
            mergedMarkdown?: string;
        };

        if (body.action === "scan") {
            return NextResponse.json(await runKnowledgeMaintenance(body.includeAssisted !== false));
        }
        if (!body.suggestionId) {
            return NextResponse.json({ error: "suggestionId is required." }, { status: 400 });
        }
        if (body.action === "dismiss") {
            await resolveKnowledgeSuggestion(body.suggestionId, "dismissed");
            return NextResponse.json({ resolved: true });
        }
        if (body.action === "merge") {
            if (!body.targetId || !body.mergedMarkdown?.trim()) {
                return NextResponse.json({
                    error: "targetId and reviewed mergedMarkdown are required.",
                }, { status: 400 });
            }
            const { data: record, error } = await supabase
                .from("knowledge_suggestions")
                .select("id, kind, status, document_ids")
                .eq("id", body.suggestionId)
                .eq("status", "open")
                .single();
            if (error || !record) {
                return NextResponse.json({ error: "Open suggestion not found." }, { status: 404 });
            }
            if (!["duplicate", "merge"].includes(record.kind)) {
                return NextResponse.json({ error: "Only duplicate or merge suggestions can use this workflow." }, { status: 400 });
            }
            const documentIds = record.document_ids as string[];
            if (!documentIds.includes(body.targetId) || documentIds.length < 2) {
                return NextResponse.json({ error: "Choose a target from the suggested documents." }, { status: 400 });
            }
            const result = await applyKnowledgeLifecycle({
                action: "merge",
                documentId: body.targetId,
                markdown: body.mergedMarkdown,
                sourceIds: documentIds.filter((id) => id !== body.targetId),
            });
            await resolveKnowledgeSuggestion(body.suggestionId, "accepted");
            return NextResponse.json(result);
        }
        return NextResponse.json({ error: "Unknown maintenance action." }, { status: 400 });
    } catch (error) {
        console.error("[Knowledge Suggestions]", error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Maintenance action failed.",
        }, { status: 400 });
    }
}
