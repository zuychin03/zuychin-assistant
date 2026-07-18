import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

export async function GET(req: NextRequest) {
    try {
        let query = supabase.from("knowledge_events")
            .select("id, document_id, assertion_id, action, actor, detail, occurred_at")
            .order("occurred_at", { ascending: false });
        const documentId = req.nextUrl.searchParams.get("documentId");
        if (documentId) query = query.eq("document_id", documentId);
        const { data, error } = await query.limit(300);
        if (error) throw error;
        return NextResponse.json({ events: data ?? [] });
    } catch (error) {
        console.error("[Knowledge Events]", error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Failed to load knowledge history.",
        }, { status: 500 });
    }
}
