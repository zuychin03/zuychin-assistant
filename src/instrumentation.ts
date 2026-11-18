const CATALOGUE_START_WAIT_MS = 3000;

// Next awaits register() before serving requests, so the first request sees the stored model catalogue.
export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    const { enableCatalogueRefresh, refreshCatalogueSnapshot } = await import("@/lib/ai/catalogue/snapshot");
    const { enableStatsRefresh, refreshStatsSnapshot } = await import("@/lib/ai/models/stats");
    enableCatalogueRefresh();
    enableStatsRefresh();
    void refreshStatsSnapshot();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), CATALOGUE_START_WAIT_MS); });
    const result = await Promise.race([refreshCatalogueSnapshot(), waited]);
    clearTimeout(timer);
    if (result === "timeout") console.warn("[ModelCatalogue] Start-up load is still running; serving code models until it finishes.");
    else if (result.storage !== "ok") console.warn(`[ModelCatalogue] Start-up load: ${result.storage}; serving code models only.`);
}
