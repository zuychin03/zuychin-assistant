import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireChatAuth } from "@/lib/auth/guard";
import { captureProfile, captureService, listCaptures } from "@/lib/capture/store";
import { CaptureError } from "@/lib/capture/service";
import { captureDocuments } from "@/lib/capture/documents";
import { VaultConflictError } from "@/lib/vault/github";
export const maxDuration = 60;
const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
function failure(error: unknown) {
    if (error instanceof CaptureError) return respond({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return respond({ error: "Check the capture fields and try again." }, 400);
    if (error instanceof VaultConflictError) return respond({ error: "The vault changed. Review the destination again." }, 409);
    return respond({ error: "The capture request could not be completed. Keep your draft and retry." }, 503);
}
export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    try { const profile = await captureProfile(); const [items, documents] = await Promise.all([listCaptures(profile.id), captureDocuments(profile.id)]); return respond({ profileId: profile.id, items, documents }); }
    catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    const origin = req.headers.get("origin");
    if (origin && origin !== req.nextUrl.origin) return respond({ error: "Open the capture inbox on this site before saving." }, 403);
    try {
        const raw = await req.text();
        if (raw.length > 3_000_000) throw new CaptureError("This capture is too large.", 413);
        const input = JSON.parse(raw);
        const profile = await captureProfile();
        if (input.profileId !== profile.id) throw new CaptureError("The account changed. Reopen the inbox before saving.", 409);
        const id = z.string().uuid().parse(input.id);
        if (input.action === "capture") {
            const saved = await captureService.capture(profile.id, id, input.source);
            return respond({ item: { ...saved, source: { ...saved.source, ...(saved.source.pdf ? { pdf: { name: saved.source.pdf.name, base64: "" } } : {}) } } });
        }
        if (input.action === "preview") return respond(await captureService.preview(profile.id, id, input.review));
        if (input.action === "ingest") return respond(await captureService.ingest(profile.id, { ...input, id }));
        throw new CaptureError("Choose capture, preview or ingest.");
    } catch (error) { return failure(error); }
}
