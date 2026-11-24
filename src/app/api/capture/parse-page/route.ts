import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { sameOrigin } from "@/lib/auth/config";
import { BodyTooLargeError, readBodyCapped } from "@/lib/http/body";
import { captureProfile } from "@/lib/capture/store";
import { CaptureError } from "@/lib/capture/service";
import { acquireSlot } from "@/lib/capture/extract/gate";
import { PAGE_IMAGE_MAX_BYTES, pageImageMime, readPageImageRecorded } from "@/lib/capture/extract/page-image";
import { effectiveFreeOnly } from "@/lib/ai/model-policy";

export const maxDuration = 90;
const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

/** One page or photo (PNG or JPEG, up to 2 MB, sent as the raw body) to Markdown. The Capture page sends scanned PDF pages one at a time. */
export async function POST(req: NextRequest) {
    const denied = await requireSession(req); if (denied) return denied;
    if (!sameOrigin(req)) return respond({ error: "Open Capture on this site before reading pages." }, 403);
    let release: (() => void) | null = null;
    try {
        const bytes = await readBodyCapped(req, PAGE_IMAGE_MAX_BYTES).catch((error) => {
            throw error instanceof BodyTooLargeError ? new CaptureError("Send a page image no larger than 2 MB.", 413) : error;
        });
        const mimeType = pageImageMime(bytes);
        if (!mimeType) throw new CaptureError("Send one PNG or JPEG page image.", 415);
        const profile = await captureProfile();
        release = acquireSlot("page");
        if (!release) throw new CaptureError("Another page is being read. Try again when it finishes.", 429);
        const read = await readPageImageRecorded({ bytes, mimeType }, { freeOnly: effectiveFreeOnly(profile), signal: req.signal });
        if (read.method === "none") {
            if (read.failures.length) return respond({ error: `The page could not be read. ${read.failures.join(" ")}` }, 502);
            return respond({ error: "No page reading or vision model is approved yet. Use Read with Gemini instead." }, 503);
        }
        return respond({ markdown: read.markdown, model: read.model, method: read.method });
    } catch (error) {
        if (error instanceof CaptureError) return respond({ error: error.message }, error.status);
        console.error("[Capture] Page reading failed:", error instanceof Error ? error.message : error);
        return respond({ error: "The page could not be read. Try again." }, 503);
    } finally { release?.(); }
}
