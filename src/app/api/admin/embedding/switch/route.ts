import { NextRequest, NextResponse, after } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { catalogueModelRef } from "@/lib/ai/catalogue/rows";
import { getEmbeddingRef } from "@/lib/ai/embeddings";
import { refreshEmbeddingOverride } from "@/lib/ai/embedding-override";
import { refreshCatalogueSnapshot } from "@/lib/ai/catalogue/snapshot";
import { beginSwitch, pendingRows, readSwitchState, runSwitchLive, switchEstimate, switchTargetFor, switchToResume } from "@/lib/ai/embedding-switch-live";
import { BodyTooLargeError, bodyFailure, readJsonCapped } from "@/lib/http/body";

const NO_STORE = { "Cache-Control": "no-store" };

function dimensionFrom(value: unknown): number | undefined | null {
    if (value === undefined || value === null || value === "") return undefined;
    const number = Number(value);
    return Number.isInteger(number) ? number : null;
}

/** The active knowledge model and the switch job. With providerId and modelId, also previews that target for the confirm dialog. */
export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    try {
        await Promise.all([refreshEmbeddingOverride(undefined, true), refreshCatalogueSnapshot()]);
        const resume = await switchToResume();
        if (resume) after(async () => { await runSwitchLive(resume); });
        const job = resume ? { ...resume, status: "running" as const } : await readSwitchState();
        const active = getEmbeddingRef();
        const params = req.nextUrl.searchParams;
        const providerId = params.get("providerId"), modelId = params.get("modelId");
        let preview: Record<string, unknown> | null = null;
        if (providerId && modelId) {
            const dimension = dimensionFrom(params.get("dimension"));
            const checked = dimension === null ? { ok: false as const, error: "The size must be a whole number." } : switchTargetFor(providerId, modelId, dimension);
            preview = checked.ok
                ? { target: checked.target, estimate: switchEstimate(checked.target, await pendingRows(checked.target.partitionId)) }
                : { error: checked.error };
        }
        return NextResponse.json({
            active: { partitionId: active.model.id, providerId: active.provider.id, providerLabel: active.provider.label, label: active.model.label, dimension: active.model.dimension },
            job: job ? { ...job, rowsLeft: job.status === "done" ? 0 : await pendingRows(job.target).catch(() => job.remaining) } : null,
            preview,
        }, { headers: NO_STORE });
    } catch (error) {
        console.error("[EmbeddingSwitch] Status failed:", error instanceof Error ? error.message : error);
        return NextResponse.json({ error: "The knowledge model status is unavailable. Please retry." }, { status: 503, headers: NO_STORE });
    }
}

/** Starts a switch: re-embeds every stored row on the server, then activates the new model. */
export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    let input: unknown = null;
    try { input = await readJsonCapped(req); } catch (error) { if (error instanceof BodyTooLargeError) return bodyFailure(error)!; }
    const ref = catalogueModelRef(input);
    const dimension = dimensionFrom((input as { dimension?: unknown } | null)?.dimension);
    if (!ref || dimension === null) return NextResponse.json({ error: "Send providerId, modelId and optionally a whole-number dimension." }, { status: 400 });
    try {
        await refreshCatalogueSnapshot();
        const checked = switchTargetFor(ref.providerId, ref.modelId, dimension);
        if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
        const started = await beginSwitch(checked.target);
        if (!started.ok) return NextResponse.json({ error: started.error }, { status: started.status });
        after(async () => { await runSwitchLive(started.state); });
        return NextResponse.json({ accepted: true, job: started.state }, { status: 202 });
    } catch (error) {
        console.error("[EmbeddingSwitch] Could not start:", error instanceof Error ? error.message : error);
        return NextResponse.json({ error: "The knowledge model switch could not start." }, { status: 500 });
    }
}
