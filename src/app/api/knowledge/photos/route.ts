import { after, NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { effectiveFreeOnly } from "@/lib/ai/model-policy";
import { resolveOwnerProfile } from "@/lib/owner-profile";
import { PHOTO_RUN_LIMIT, livePhotoDeps, livePhotoListing, photoRunState, planPhotos, runPhotoIndex, type PhotoRunResult } from "@/lib/knowledge/photo-sync";

export const maxDuration = 60;

const failure = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export async function GET(req: NextRequest) {
    const denied = await requireSession(req); if (denied) return denied;
    try {
        const listing = await livePhotoListing();
        const plan = planPhotos(await listing.listFiles(), await listing.indexedPhotos());
        const state = photoRunState();
        return NextResponse.json({
            indexed: plan.indexed, pending: plan.pending.length, tooLarge: plan.tooLarge.length,
            running: state.running, last: state.last, limit: PHOTO_RUN_LIMIT,
        });
    } catch (error) {
        console.error("[Knowledge Photos]", error);
        return NextResponse.json({ error: failure(error, "The photo index is unavailable.") }, { status: 503 });
    }
}

export async function POST(req: NextRequest) {
    const denied = await requireSession(req); if (denied) return denied;
    const state = photoRunState();
    if (state.running) return NextResponse.json({ error: "Photos are already being indexed." }, { status: 409 });
    try {
        const profile = await resolveOwnerProfile(AbortSignal.timeout(10_000)).catch(() => null);
        // Without the profile, Free only is assumed so a paid model never sees a photo by mistake.
        const deps = await livePhotoDeps(profile ? effectiveFreeOnly(profile) : true);
        state.running = true;
        // About 10 s a photo (description, then embedding), past Cloudflare's 100 s cut, so it runs after the reply.
        after(async () => {
            let last: PhotoRunResult;
            try { last = await runPhotoIndex(deps); }
            catch (error) {
                last = { finishedAt: new Date().toISOString(), indexed: [], withImage: 0, failed: [{ path: "", error: failure(error, "The photo run failed.").slice(0, 200) }], retired: 0, left: 0 };
            }
            state.last = last;
            state.running = false;
            console.log(`[Knowledge Photos] Indexed ${last.indexed.length}, ${last.failed.length} failed, ${last.left} left.`);
        });
        return NextResponse.json({ started: true, limit: PHOTO_RUN_LIMIT });
    } catch (error) {
        state.running = false;
        console.error("[Knowledge Photos]", error);
        return NextResponse.json({ error: failure(error, "Photo indexing could not start.") }, { status: 503 });
    }
}
