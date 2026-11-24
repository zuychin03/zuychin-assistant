const START_WAIT_MS = 3000;

// Next awaits register() before serving requests, so the first request sees the stored model catalogue and saved provider keys.
export async function registerNode() {
    const { enableCatalogueRefresh, refreshCatalogueSnapshot } = await import("@/lib/ai/catalogue/snapshot");
    const { enableStatsRefresh, refreshStatsSnapshot } = await import("@/lib/ai/models/stats");
    const { enableProviderKeyRefresh, refreshProviderKeys } = await import("@/lib/ai/provider-keys/snapshot");
    enableCatalogueRefresh();
    enableStatsRefresh();
    enableProviderKeyRefresh();
    const { enableMaskPrefsRefresh, refreshMaskPrefs } = await import("@/lib/ai/privacy/policy");
    enableMaskPrefsRefresh();
    void refreshMaskPrefs();
    void refreshStatsSnapshot();
    // Online councils run in this process, so a restart picks them back up here.
    const { startOnlineResumeScheduler } = await import("@/lib/council/online/service");
    startOnlineResumeScheduler();
    if (process.env.TELEGRAM_BOT_TOKEN) {
        const [{ setTelegramCommands }, { CHANNEL_COMMANDS }] = await Promise.all([import("@/lib/messaging/telegram-service"), import("@/lib/messaging/channel-threads")]);
        void setTelegramCommands(CHANNEL_COMMANDS.map(({ command, description }) => ({ command, description })));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), START_WAIT_MS); });
    const [catalogue, keys] = await Promise.all([Promise.race([refreshCatalogueSnapshot(), waited]), Promise.race([refreshProviderKeys(), waited])]);
    clearTimeout(timer);
    if (catalogue === "timeout") console.warn("[ModelCatalogue] Start-up load is still running; serving code models until it finishes.");
    else if (catalogue.storage !== "ok") console.warn(`[ModelCatalogue] Start-up load: ${catalogue.storage}; serving code models only.`);
    if (keys === "timeout") console.warn("[ProviderKeys] Start-up load is still running; using env keys until it finishes.");
    else if (keys.storage !== "ok") console.warn(`[ProviderKeys] Start-up load: ${keys.storage}; using env keys only.`);
    else if (keys.master !== "ready" && keys.otherRows) console.warn(`[ProviderKeys] Master key ${keys.master}; ${keys.otherRows} saved key(s) cannot be read.`);
}
