/**
 * Next.js instrumentation hook — starts the Discord bot on server init.
 * Runs once per Node.js process; skipped in Edge runtime.
 */
export async function register() {
    if (process.env.NEXT_RUNTIME === "nodejs") {
        if (process.env.DISCORD_BOT_TOKEN) {
            const { startDiscordBot } = await import("@/lib/messaging/discord-service");
            await startDiscordBot();
        } else {
            console.warn("[Instrumentation] DISCORD_BOT_TOKEN not set, Discord bot will not start.");
        }
    }
}
