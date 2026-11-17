import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { PROVIDERS, isProviderAvailable, retiredChatModelIds } from "@/lib/ai/providers";
import { catalogueModelRef } from "@/lib/ai/catalogue/rows";
import { listDiscoveryRuns, readCatalogueAdmin, setCatalogueApproval } from "@/lib/ai/catalogue/store";
import { refreshCatalogueSnapshot } from "@/lib/ai/catalogue/snapshot";
import { discoveryEnabled, maxProbesFromEnv, startFailure } from "@/lib/ai/catalogue/run";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    const [catalogue, runs] = await Promise.all([readCatalogueAdmin(), listDiscoveryRuns(10)]);
    if (!catalogue.ok) {
        return NextResponse.json({ storage: catalogue.reason, error: startFailure(catalogue.reason).error }, { status: 503, headers: NO_STORE });
    }
    const codeIds = new Map(PROVIDERS.map((provider) => [provider.id, new Set(provider.chatModels.map((model) => model.id))]));
    return NextResponse.json({
        storage: "ok",
        settings: { enabled: discoveryEnabled(), maxProbes: maxProbesFromEnv() },
        providers: PROVIDERS.map((provider) => ({
            id: provider.id, label: provider.label, available: isProviderAvailable(provider),
            discovery: provider.discovery ? { include: provider.discovery.include, pricing: provider.discovery.pricing } : null,
        })),
        rows: catalogue.rows.map((row) => ({
            ...row,
            inCode: codeIds.get(row.providerId)?.has(row.modelId) ?? false,
            retired: retiredChatModelIds(row.providerId).has(row.modelId),
        })),
        runs: runs.ok ? runs.runs : [],
    }, { headers: NO_STORE });
}

export async function PATCH(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    const body: unknown = await req.json().catch(() => null);
    const ref = catalogueModelRef(body);
    const approved = (body as { approved?: unknown } | null)?.approved;
    if (!ref || typeof approved !== "boolean") {
        return NextResponse.json({ error: "Send providerId, modelId and approved (true or false)." }, { status: 400 });
    }
    const result = await setCatalogueApproval(ref.providerId, ref.modelId, approved);
    if (result === "not_found") return NextResponse.json({ error: "That model is not in the catalogue." }, { status: 404 });
    if (result !== "ok") {
        const failure = startFailure(result);
        return NextResponse.json({ error: failure.error }, { status: failure.status });
    }
    await refreshCatalogueSnapshot();
    return NextResponse.json({ ok: true, ...ref, approved });
}
