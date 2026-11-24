import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { sameOrigin } from "@/lib/auth/config";
import { bodyFailure, readJsonCapped } from "@/lib/http/body";
import { getDefaultProfile } from "@/lib/db";
import { getEmbeddingRef } from "@/lib/ai/embeddings";
import { ModelPolicyError } from "@/lib/ai/model-policy";
import { configureModelDataPolicy, withModelObservationCollector, type ModelCallObservation } from "@/lib/ai/model-observations";
import { persistModelObservations } from "@/lib/ai/model-health";
import { gatherBriefFacts, writeBrief } from "@/lib/ai/brief";
import { liveBriefSources } from "@/lib/ai/brief-sources";
import { resolveBriefChats } from "@/lib/ai/rag-service";

export const maxDuration = 60;
const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

/** The Today panel's Brief me button (V8 F8): the script only, on free routes; the panel speaks it through /api/tts. Nothing is saved. */
export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    if (!sameOrigin(req)) return respond({ error: "Briefings must be asked for from this app." }, 403);
    const observations: ModelCallObservation[] = [];
    let userProfileId: string | undefined;
    try {
        const body = await readJsonCapped(req);
        const study = body.study === true;
        const profile = await getDefaultProfile();
        if (!profile) throw new ModelPolicyError("Chat preferences are unavailable. Try again in a minute.");
        userProfileId = profile.id;
        const chats = resolveBriefChats("web", undefined, undefined, profile);
        return respond(await withModelObservationCollector(observations, async () => {
            configureModelDataPolicy(true);
            const facts = await gatherBriefFacts(liveBriefSources(), { study });
            return writeBrief({ chats, embRef: getEmbeddingRef(), study, facts, signal: req.signal });
        }, [], ["personal"]));
    } catch (error) {
        const failed = bodyFailure(error);
        if (failed) return failed;
        if (error instanceof ModelPolicyError) return respond({ error: error.message }, 503);
        console.error("[Brief] Failed:", error instanceof Error ? error.message : error);
        return respond({ error: "The briefing could not be written. Try again in a minute." }, 502);
    } finally {
        if (observations.length) await persistModelObservations(observations, { userProfileId }).catch(() => undefined);
    }
}
