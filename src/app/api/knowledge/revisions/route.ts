import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireChatAuth } from "@/lib/auth/guard";
import { knowledgeRevisions } from "@/lib/knowledge/revision-store";
import { KnowledgeRevisionError } from "@/lib/knowledge/revisions";
import { VaultConflictError } from "@/lib/vault/github";

export const maxDuration = 60;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const documentId = z.string().min(1).max(200);
const sourcePath = z.string().max(1024).optional();
const readSchema = z.object({ documentId, sourceSha: sha.optional(), sourcePath, headSha: sha.optional(), page: z.coerce.number().int().min(1).max(1000).optional() });
const writeSchema = z.object({ documentId, sourceSha: sha, sourcePath: z.string().min(1).max(1024), headSha: sha, currentHash: hash.nullable(), previewHash: hash });
function failure(error: unknown) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "Invalid revision request." }, { status: 400 });
    if (error instanceof KnowledgeRevisionError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof VaultConflictError) return NextResponse.json({ error: "The vault changed. Preview the restore again." }, { status: 409 });
    return NextResponse.json({ error: "Knowledge revisions are unavailable. Check vault configuration or try again." }, { status: 503 });
}
export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    try {
        const input = readSchema.parse(Object.fromEntries(req.nextUrl.searchParams));
        const result = input.sourceSha
            ? await knowledgeRevisions.preview({ documentId: input.documentId, sourceSha: input.sourceSha, sourcePath: input.sourcePath })
            : await knowledgeRevisions.list(input);
        return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    const origin = req.headers.get("origin");
    if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ error: "Revision changes must come from this app." }, { status: 403 });
    try { return NextResponse.json(await knowledgeRevisions.restore(writeSchema.parse(await req.json()))); }
    catch (error) { return failure(error); }
}
