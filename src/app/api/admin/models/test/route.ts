import { NextRequest, NextResponse, after } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { PROVIDERS, getProviderApiKey } from "@/lib/ai/providers";
import { catalogueModelRef } from "@/lib/ai/catalogue/rows";
import { readCatalogueRows } from "@/lib/ai/catalogue/store";
import { executeModelTest, liveDiscoveryDeps, startFailure } from "@/lib/ai/catalogue/run";
import { BodyTooLargeError, bodyFailure, readJsonCapped } from "@/lib/http/body";

// Probes one model, paid ones included: the owner pressed Test, so the small cost is theirs to accept.
export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    let input: unknown = null;
    try { input = await readJsonCapped(req); } catch (error) { if (error instanceof BodyTooLargeError) return bodyFailure(error)!; }
    const ref = catalogueModelRef(input);
    if (!ref) return NextResponse.json({ error: "Send providerId and modelId." }, { status: 400 });
    const provider = PROVIDERS.find((entry) => entry.id === ref.providerId);
    if (!provider) return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
    if (provider.unavailableReason || !getProviderApiKey(provider)) {
        return NextResponse.json({ error: `${provider.label} is unavailable or has no key.` }, { status: 409 });
    }
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
        after(async () => { await executeModelTest(started.runId, ref.providerId, ref.modelId, deps); });
        return NextResponse.json({ accepted: true, runId: started.runId }, { status: 202 });
    } catch (error) {
        console.error("[ModelDiscovery] Could not start a test:", error instanceof Error ? error.message : error);
        return NextResponse.json({ error: "The model test could not start." }, { status: 500 });
    }
}
