import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/guard";
import { sameOrigin } from "@/lib/auth/config";
import { bodyFailure, readJsonCapped } from "@/lib/http/body";
import { getDefaultProfile } from "@/lib/db";
import { getEmbeddingRef } from "@/lib/ai/embeddings";
import { effectiveFreeOnly, ModelPolicyError } from "@/lib/ai/model-policy";
import { configureModelDataPolicy, withModelObservationCollector, type ModelCallObservation } from "@/lib/ai/model-observations";
import { persistModelObservations } from "@/lib/ai/model-health";
import { findLanguage, liveTranslateDeps, translateText, translationCredit, TRANSLATE_MAX_CHARS } from "@/lib/ai/translate";
import { resolveChatForRequest } from "@/lib/ai/rag-service";

// Six 1,500-character pieces, three at a time, each with a 20 s model try and a chat retry, finish inside Cloudflare's 100 s.
export const maxDuration = 110;
const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const input = z.object({ text: z.string().trim().min(1).max(TRANSLATE_MAX_CHARS), target: z.string().trim().min(1).max(40) }).strict();

/** The Capture Translate action (V8 F9): the translation only; the page puts it under the reviewed notes. */
export async function POST(req: NextRequest) {
    const denied = await requireSession(req); if (denied) return denied;
    if (!sameOrigin(req)) return respond({ error: "Open Capture on this site before translating." }, 403);
    const observations: ModelCallObservation[] = [];
    let userProfileId: string | undefined;
    try {
        const parsed = input.safeParse(await readJsonCapped(req));
        if (!parsed.success) return respond({ error: `Send a language and at most ${TRANSLATE_MAX_CHARS.toLocaleString("en-AU")} characters of text.` }, 400);
        const target = findLanguage(parsed.data.target);
        if (!target) return respond({ error: "Choose a language from the list." }, 400);
        const profile = await getDefaultProfile();
        userProfileId = profile?.id;
        const freeOnly = effectiveFreeOnly(profile);
        const chat = resolveChatForRequest("web", undefined, undefined, profile, false, freeOnly);
        const translation = await withModelObservationCollector(observations, () => {
            configureModelDataPolicy(freeOnly);
            return translateText(parsed.data.text, target, { freeOnly, signal: req.signal }, liveTranslateDeps(chat, getEmbeddingRef()));
        }, [], ["personal"]);
        return respond({ text: translation.text, language: target.name, credit: translationCredit(translation) });
    } catch (error) {
        const failed = bodyFailure(error);
        if (failed) return failed;
        if (error instanceof ModelPolicyError) return respond({ error: error.message }, 503);
        console.error("[Capture] Translation failed:", error instanceof Error ? error.message : error);
        return respond({ error: "The translation failed. Your notes are unchanged." }, 502);
    } finally {
        if (observations.length) await persistModelObservations(observations, { userProfileId }).catch(() => undefined);
    }
}
