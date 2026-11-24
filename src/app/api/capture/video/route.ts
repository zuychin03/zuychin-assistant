import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { sameOrigin } from "@/lib/auth/config";
import { BodyTooLargeError, readBodyCapped } from "@/lib/http/body";
import { captureProfile } from "@/lib/capture/store";
import { CaptureError } from "@/lib/capture/service";
import { acquireSlot } from "@/lib/capture/extract/gate";
import { effectiveFreeOnly } from "@/lib/ai/model-policy";
import { videoFailureText, videoMime, videoModels, videoTitle, videoToNotesRecorded, VIDEO_WEB_MAX_BYTES } from "@/lib/capture/video";
import { VIDEO_HEARTBEAT_MS, type VideoEvent } from "@/lib/capture/video-client";

export const maxDuration = 300;
const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

function fileName(req: NextRequest): string {
    try { return decodeURIComponent(req.headers.get("x-file-name") ?? "").slice(0, 200); } catch { return ""; }
}

/**
 * One video (up to 7 MB, the raw body) to notes for the Capture form (V8 F4). The answer is a stream of server-sent
 * events with a heartbeat, so a slow model never meets Cloudflare's 100 s cut. Nothing is stored.
 */
export async function POST(req: NextRequest) {
    const denied = await requireSession(req); if (denied) return denied;
    if (!sameOrigin(req)) return respond({ error: "Open Capture on this site before sending a video." }, 403);
    const type = req.headers.get("content-type") ?? "";
    if (!type.startsWith("video/") && !type.startsWith("application/octet-stream")) return respond({ error: videoFailureText("unsupported") }, 415);
    const bytes = await readBodyCapped(req, VIDEO_WEB_MAX_BYTES).catch((error) => { if (error instanceof BodyTooLargeError) return null; throw error; });
    if (!bytes) return respond({ error: "Videos here can be up to 7 MB. Send longer ones to the Telegram bot, which takes up to 20 MB." }, 413);
    if (!videoMime(bytes)) return respond({ error: videoFailureText("unsupported") }, 415);
    let freeOnly: boolean;
    try { freeOnly = effectiveFreeOnly(await captureProfile()); } catch (error) {
        if (error instanceof CaptureError) return respond({ error: error.message }, error.status);
        throw error;
    }
    const models = videoModels(freeOnly);
    if (!models.length) return respond({ error: `${videoFailureText("no_model")} Test a video-capable model on /admin.` }, 503);
    const release = acquireSlot("video");
    if (!release) return respond({ error: "Another video is being summarised. Try again when it finishes." }, 429);

    const stop = new AbortController();
    const signal = AbortSignal.any([req.signal, stop.signal]);
    const encoder = new TextEncoder();
    const title = videoTitle({ fileName: fileName(req) });
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (chunk: string) => { try { controller.enqueue(encoder.encode(chunk)); } catch { /* the reader went away */ } };
            const event = (value: VideoEvent) => send(`data: ${JSON.stringify(value)}\n\n`);
            event({ type: "started", model: models[0].label });
            const beat = setInterval(() => send(": wait\n\n"), VIDEO_HEARTBEAT_MS);
            const started = performance.now();
            try {
                const result = await videoToNotesRecorded({ bytes, title }, { freeOnly, signal });
                console.log(JSON.stringify({ event: "capture_video", ok: result.ok, bytes: bytes.byteLength, ms: Math.round(performance.now() - started),
                    ...(result.ok ? { model: result.model, speech: result.speech } : { reason: result.reason }) }));
                if (result.ok) event({ type: "done", title: result.title, text: result.text, model: result.model, speech: result.speech });
                else event({ type: "error", error: videoFailureText(result.reason) });
            } catch (error) {
                if (!signal.aborted) {
                    console.error("[Capture] Video notes failed:", error instanceof Error ? error.message : error);
                    event({ type: "error", error: videoFailureText("failed") });
                }
            } finally {
                clearInterval(beat);
                release();
                try { controller.close(); } catch { /* already closed */ }
            }
        },
        cancel() { stop.abort(); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" } });
}
