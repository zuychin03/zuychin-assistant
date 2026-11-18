import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { PROVIDERS, isProviderAvailable, retiredChatModelIds } from "@/lib/ai/providers";
import { catalogueModelRef } from "@/lib/ai/catalogue/rows";
import { listDiscoveryRuns, readCatalogueAdmin, setCatalogueApproval } from "@/lib/ai/catalogue/store";
import { refreshCatalogueSnapshot } from "@/lib/ai/catalogue/snapshot";
import { discoveryEnabled, lookupEnabled, maxLookupsFromEnv, maxProbesFromEnv, startFailure } from "@/lib/ai/catalogue/run";
import { readModelStats, readProfiles } from "@/lib/ai/models/store";
import { statsKey } from "@/lib/ai/models/stats";
import { adminModelInfo, rowModel } from "@/lib/ai/models/admin-view";
import { PURPOSE_TAGS, TAG_INFO } from "@/lib/ai/models/tags";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    const [catalogue, runs, profiles, stats] = await Promise.all([readCatalogueAdmin(), listDiscoveryRuns(10), readProfiles(), readModelStats()]);
    if (!catalogue.ok) {
        return NextResponse.json({ storage: catalogue.reason, error: startFailure(catalogue.reason).error }, { status: 503, headers: NO_STORE });
    }
    const codeModels = new Map(PROVIDERS.map((provider) => [provider.id, new Map(provider.chatModels.map((model) => [model.id, model]))]));
    const profileByKey = new Map((profiles.ok ? profiles.profiles : []).map((entry) => [statsKey(entry.providerId, entry.modelId), entry]));
    return NextResponse.json({
        storage: "ok",
        profileStorage: profiles.ok ? "ok" : profiles.reason,
        statsStorage: stats.ok ? "ok" : stats.reason,
        settings: { enabled: discoveryEnabled(), maxProbes: maxProbesFromEnv(), lookups: lookupEnabled() ? maxLookupsFromEnv() : 0 },
        tags: PURPOSE_TAGS.map((tag) => ({ tag, ...TAG_INFO[tag] })),
        providers: PROVIDERS.map((provider) => ({
            id: provider.id, label: provider.label, available: isProviderAvailable(provider),
            discovery: provider.discovery ? { include: provider.discovery.include, pricing: provider.discovery.pricing } : null,
        })),
        rows: catalogue.rows.map((row) => {
            const code = codeModels.get(row.providerId)?.get(row.modelId);
            const key = statsKey(row.providerId, row.modelId);
            return {
                ...row,
                inCode: code !== undefined,
                retired: retiredChatModelIds(row.providerId).has(row.modelId),
                ...adminModelInfo(row, rowModel(row, code), profileByKey.get(key), stats.ok ? stats.speed.get(key) : undefined, stats.ok ? stats.feedback.get(key) : undefined),
            };
        }),
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
