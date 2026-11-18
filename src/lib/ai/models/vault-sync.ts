import { PROVIDERS } from "@/lib/ai/providers";
import { readCatalogueRows } from "@/lib/ai/catalogue/store";
import { getVaultConfig } from "@/lib/vault/github";
import { writeVaultPage } from "@/lib/vault/ingest";
import { vaultEmbeddingRef } from "@/lib/vault/store";
import { familyKey } from "@/lib/ai/models/profiles";
import { readModelStats, readProfiles, saveVaultResult } from "@/lib/ai/models/store";
import { modelSpeed, statsKey } from "@/lib/ai/models/stats";
import { measuredFacts, resolveTags } from "@/lib/ai/models/view";
import { rowModel } from "@/lib/ai/models/admin-view";
import { modelVaultPage, modelVaultPath, type VaultRoute } from "@/lib/ai/models/vault";

/** Rewrites the family page after an approval. Runs in `after()`; a vault without configuration is skipped quietly. */
export async function syncModelVault(providerId: string, modelId: string): Promise<void> {
    if (!getVaultConfig()) return;
    try {
        const [catalogue, profiles, stats] = await Promise.all([readCatalogueRows(), readProfiles(), readModelStats()]);
        if (!catalogue.ok || !profiles.ok) throw new Error("The catalogue or profile table could not be read.");
        const family = familyKey(modelId);
        const routes: VaultRoute[] = profiles.profiles.flatMap((record) => {
            if (familyKey(record.modelId) !== family || !record.profile || !record.approvedAt) return [];
            const provider = PROVIDERS.find((entry) => entry.id === record.providerId);
            const row = catalogue.rows.find((entry) => entry.providerId === record.providerId && entry.modelId === record.modelId);
            if (!provider || !row) return [];
            const model = rowModel(row, provider.chatModels.find((entry) => entry.id === row.modelId));
            const speed = modelSpeed(stats.ok ? stats.speed.get(statsKey(row.providerId, row.modelId)) : undefined, row.probeChatMs);
            return [{ providerLabel: provider.label, row, record, tags: resolveTags(model, record, row).tags, speed, measured: measuredFacts(model, row, speed) }];
        });
        const page = modelVaultPage(routes);
        if (!page) return;
        const written = await writeVaultPage({ path: modelVaultPath(modelId), markdown: page.markdown, summary: page.summary, trust: "reviewed", embRef: await vaultEmbeddingRef() });
        await Promise.all(routes.map((route) => saveVaultResult(route.row.providerId, route.row.modelId, { path: written.pagePath })));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[ModelProfiles] Vault page failed:", message);
        await saveVaultResult(providerId, modelId, { error: message });
    }
}
