import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireChatAuth } from "@/lib/auth/guard";
import { knowledgeRevisions } from "@/lib/knowledge/revision-store";
import { KnowledgeRevisionError } from "@/lib/knowledge/revisions";

const snapshotSchema = z.object({ documentId: z.string().min(1).max(200), commitSha: z.string().regex(/^[a-f0-9]{40}$/), path: z.string().max(1024).optional() });
const evidenceSchema = snapshotSchema.extend({ quote: z.string().min(1).max(20_000), startOffset: z.number().int().nonnegative().optional() });
function failure(error: unknown) {
    return NextResponse.json({ error: error instanceof KnowledgeRevisionError ? error.message
        : error instanceof z.ZodError || error instanceof SyntaxError ? "Invalid evidence request." : "The source snapshot is unavailable." },
    { status: error instanceof KnowledgeRevisionError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503 });
}
export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    try { return NextResponse.json(await knowledgeRevisions.snapshot(snapshotSchema.parse(Object.fromEntries(req.nextUrl.searchParams))), { headers: { "Cache-Control": "private, no-store" } }); }
    catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    const origin = req.headers.get("origin");
    if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ error: "Evidence requests must come from this app." }, { status: 403 });
    try { return NextResponse.json(await knowledgeRevisions.evidence(evidenceSchema.parse(await req.json())), { headers: { "Cache-Control": "private, no-store" } }); }
    catch (error) { return failure(error); }
}
