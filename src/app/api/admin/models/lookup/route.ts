import { NextRequest, NextResponse, after } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { PROVIDERS } from "@/lib/ai/providers";
import { catalogueModelRef } from "@/lib/ai/catalogue/rows";
import { readCatalogueRows } from "@/lib/ai/catalogue/store";
import { executeModelLookup, liveDiscoveryDeps, startFailure } from "@/lib/ai/catalogue/run";
import { markDraftPending } from "@/lib/ai/models/store";
import { BodyTooLargeError, bodyFailure, readJsonCapped } from "@/lib/http/body";

// Drafts a profile on request. Free sources and free drafting models only; the draft waits for the owner's approval.
export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    let input: unknown = null;
    try { input = await readJsonCapped(req); } catch (error) { if (error instanceof BodyTooLargeError) return bodyFailure(error)!; }
    const ref = catalogueModelRef(input);
    if (!ref) return NextResponse.json({ error: "Send providerId and modelId." }, { status: 400 });
    if (!PROVIDERS.some((entry) => entry.id === ref.providerId)) return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
    try {
        const stored = await readCatalogueRows();
        if (!stored.ok) {
            const failure = startFailure(stored.reason);
            return NextResponse.json({ error: failure.error }, { status: failure.status });
        }
        if (!stored.rows.some((row) => row.providerId === ref.providerId && row.modelId === ref.modelId)) {
            return NextResponse.json({ error: "That model is not in the catalogue." }, { status: 404 });
        }
        const deps = await liveDiscoveryDeps();
        const started = await deps.startRun("manual");
        if (!started.ok) {
            const failure = startFailure(started.reason);
            return NextResponse.json({ error: failure.error }, { status: failure.status });
        }
        try {
            await markDraftPending(ref.providerId, ref.modelId);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await deps.finishRun(started.runId, "failed", { kind: "lookup", providerId: ref.providerId, modelId: ref.modelId, error: message.slice(0, 500), durationMs: 0 }).catch(() => {});
            return NextResponse.json({ error: "The model profile table is missing or unavailable. Apply scripts/migrations/v7-model-awareness.sql." }, { status: 503 });
        }
        after(async () => { await executeModelLookup(started.runId, ref.providerId, ref.modelId, deps); });
        return NextResponse.json({ accepted: true, runId: started.runId }, { status: 202 });
    } catch (error) {
        console.error("[ModelLookup] Could not start a lookup:", error instanceof Error ? error.message : error);
        return NextResponse.json({ error: "The model lookup could not start." }, { status: 500 });
    }
}
