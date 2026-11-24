import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireChatAuth } from "@/lib/auth/guard";
import { captureProfile, captureService, listCaptures } from "@/lib/capture/store";
import { CaptureError } from "@/lib/capture/service";
import { captureDocuments } from "@/lib/capture/documents";
import { ocrTiers } from "@/lib/capture/extract/ocr";
import { effectiveFreeOnly } from "@/lib/ai/model-policy";
import { resolveModelOfKind } from "@/lib/ai/media/resolve";
import { videoModels } from "@/lib/capture/video";
import { VaultConflictError } from "@/lib/vault/github";
import { sameOrigin } from "@/lib/auth/config";
import { BodyTooLargeError, readTextCapped } from "@/lib/http/body";
export const maxDuration = 60;
const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const extractOptions = z.object({ refresh: z.boolean().optional(), ocr: z.enum(["free", "paid"]).optional() });
function failure(error: unknown) {
    if (error instanceof CaptureError) return respond({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return respond({ error: "Check the capture fields and try again." }, 400);
    if (error instanceof VaultConflictError) return respond({ error: "The vault changed. Review the destination again." }, 409);
    return respond({ error: "The capture request could not be completed. Keep your draft and retry." }, 503);
}
export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    try {
        const profile = await captureProfile();
        const freeOnly = effectiveFreeOnly(profile);
        const [items, documents, pageReader] = await Promise.all([listCaptures(profile.id), captureDocuments(profile.id),
            resolveModelOfKind("parse", { freeOnly }).catch(() => null)]);
        return respond({ profileId: profile.id, items, documents, ocr: ocrTiers(freeOnly), pageReader: pageReader?.row.label ?? null,
            videoReader: videoModels(freeOnly)[0]?.label ?? null });
    } catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    if (!sameOrigin(req)) return respond({ error: "Open the capture inbox on this site before saving." }, 403);
    try {
        const raw = await readTextCapped(req).catch((error) => {
            throw error instanceof BodyTooLargeError ? new CaptureError("This capture is too large.", 413) : error;
        });
        const input = JSON.parse(raw);
        const profile = await captureProfile();
        if (input.profileId !== profile.id) throw new CaptureError("The account changed. Reopen the inbox before saving.", 409);
        const id = z.string().uuid().parse(input.id);
        if (input.action === "capture") {
            const saved = await captureService.capture(profile.id, id, input.source);
            return respond({ item: { ...saved, source: { ...saved.source, ...(saved.source.pdf ? { pdf: { name: saved.source.pdf.name, base64: "" } } : {}),
                ...(saved.source.image ? { image: { name: saved.source.image.name, base64: "" } } : {}) } } });
        }
        if (input.action === "preview") return respond(await captureService.preview(profile.id, id, input.review));
        if (input.action === "ingest") {
            const { background, ...result } = await captureService.ingest(profile.id, { ...input, id });
            if (background) after(background);
            return respond(result);
        }
        if (input.action === "extract") {
            const result = await captureService.extract(profile.id, id, extractOptions.parse({ refresh: input.refresh, ocr: input.ocr }));
            // Gemini can take minutes on a long PDF, past Cloudflare's 100 s cut, so the client polls.
            if (result.background) after(result.background);
            return respond({ extract: result.extract }, result.background ? 202 : 200);
        }
        if (input.action === "pages") {
            return respond({ extract: await captureService.savePages(profile.id, id, { text: input.text, pages: input.pages, unread: input.unread, model: input.model }) });
        }
        throw new CaptureError("Choose capture, preview, ingest, extract or pages.");
    } catch (error) { return failure(error); }
}
