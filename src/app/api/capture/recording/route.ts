import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/guard";
import { sameOrigin } from "@/lib/auth/config";
import { bodyFailure, readJsonCapped } from "@/lib/http/body";
import { captureProfile } from "@/lib/capture/store";
import { CaptureError } from "@/lib/capture/service";
import { effectiveFreeOnly, ModelPolicyError } from "@/lib/ai/model-policy";
import { summariseRecording } from "@/lib/capture/recording-summary";
import { CAPTURE_TEXT_MAX, RECORDING_MAX_SECONDS } from "@/lib/voice/recording-limits";

export const maxDuration = 90;
const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const input = z.object({
    name: z.string().trim().min(1).max(200), seconds: z.number().positive().max(RECORDING_MAX_SECONDS + 60),
    transcript: z.string().trim().min(1).max(CAPTURE_TEXT_MAX),
}).strict();

/** A title and summary for a transcribed Capture recording; nothing is stored here. */
export async function POST(req: NextRequest) {
    const denied = await requireSession(req); if (denied) return denied;
    if (!sameOrigin(req)) return respond({ error: "Open Capture on this site before summarising." }, 403);
    try {
        const parsed = input.safeParse(await readJsonCapped(req));
        if (!parsed.success) return respond({ error: "Send the file name, its length and a transcript of at most 120,000 characters." }, 400);
        const profile = await captureProfile();
        return respond(await summariseRecording(parsed.data, effectiveFreeOnly(profile)));
    } catch (error) {
        const failed = bodyFailure(error);
        if (failed) return failed;
        if (error instanceof CaptureError) return respond({ error: error.message }, error.status);
        if (error instanceof ModelPolicyError) return respond({ error: error.message }, 503);
        console.error("[Capture] Recording summary failed:", error instanceof Error ? error.message : error);
        return respond({ error: "The summary could not be written." }, 502);
    }
}
