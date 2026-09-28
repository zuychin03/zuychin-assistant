import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { captureProfile } from "@/lib/capture/store";
import { captureDocuments } from "@/lib/capture/documents";
import { CaptureError } from "@/lib/capture/service";
import { knowledgeRevisions } from "@/lib/knowledge/revision-store";
import { getBranchHead, requireVaultConfig } from "@/lib/vault/github";
export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    try {
        const profile = await captureProfile();
        const documentId = req.nextUrl.searchParams.get("documentId") ?? "";
        if (!documentId || documentId.length > 200 || !(await captureDocuments(profile.id)).some(document => document.id === documentId)) throw new CaptureError("This source is not available to your profile.", 404);
        const commitSha = await getBranchHead(requireVaultConfig(), AbortSignal.timeout(15_000));
        const snapshot = await knowledgeRevisions.snapshot({ documentId, commitSha });
        return NextResponse.json({ ...snapshot, profileId: profile.id, downloadedAt: new Date().toISOString(),
            originalCaptureId: /^capture-[a-f0-9-]{36}$/.test(documentId) ? documentId.slice(8) : null }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) { return NextResponse.json({ error: error instanceof CaptureError ? error.message : "This document could not be downloaded. Its existing offline copy has not changed." }, { status: error instanceof CaptureError ? error.status : 503, headers: { "Cache-Control": "private, no-store" } }); }
}
