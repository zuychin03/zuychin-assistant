import { Client, GatewayIntentBits, Events, TextChannel } from "discord.js";
import { ragChat } from "@/lib/ai/rag-service";

// ── Discord Client ──

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID; // Optional: restrict to a single channel

let client: Client | null = null;

/** Lazy-initialized Discord client singleton. */
function getClient(): Client {
    if (!client) {
        client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
            ],
        });
    }
    return client;
}

// ── Bot Startup ──

/** Connect to Discord Gateway and register the message listener. */
export async function startDiscordBot(): Promise<void> {
    if (!DISCORD_BOT_TOKEN) {
        console.warn("[Discord] DISCORD_BOT_TOKEN not set, skipping bot startup.");
        return;
    }

    const bot = getClient();

    bot.once(Events.ClientReady, (readyClient) => {
        console.log(`[Discord] Bot online as ${readyClient.user.tag}`);
    });

    bot.on(Events.MessageCreate, async (message) => {
        // Skip bot and empty messages
        if (message.author.bot) return;
        if (!message.content.trim()) return;

        // Channel restriction (if configured)
        if (DISCORD_CHANNEL_ID && message.channel.id !== DISCORD_CHANNEL_ID) return;

        console.log(`[Discord] Message from ${message.author.tag}: ${message.content.substring(0, 50)}`);

        try {
            // Typing indicator during RAG processing
            await message.channel.sendTyping();

            const { reply } = await ragChat({
                message: message.content,
                channel: "discord",
            });

            // Discord max message length: 2000 chars
            if (reply.length <= 2000) {
                await message.reply(reply);
            } else {
                // Split oversized replies
                const chunks = splitMessage(reply, 2000);
                for (const chunk of chunks) {
                    await message.channel.send(chunk);
                }
            }
        } catch (error) {
            console.error("[Discord] Error processing message:", error);
            await message.reply("Sorry, I encountered an error processing your message.").catch(() => { });
        }
    });

    await bot.login(DISCORD_BOT_TOKEN);
}

// ── Outbound Messaging ──

/** Send a text message to the specified Discord channel. */
export async function sendDiscordMessage(
    channelId: string,
    text: string
): Promise<boolean> {
    try {
        const bot = getClient();
        if (!bot.isReady()) {
            console.warn("[Discord] Bot not ready, cannot send message.");
            return false;
        }

        const channel = await bot.channels.fetch(channelId);
        if (!channel || !(channel instanceof TextChannel)) {
            console.error("[Discord] Channel not found or not a text channel:", channelId);
            return false;
        }

        // Split oversized messages
        if (text.length <= 2000) {
            await channel.send(text);
        } else {
            const chunks = splitMessage(text, 2000);
            for (const chunk of chunks) {
                await channel.send(chunk);
            }
        }

        return true;
    } catch (error) {
        console.error("[Discord] Send error:", error);
        return false;
    }
}

// ── Helpers ──

/** Split text into chunks at newline/space boundaries. */
function splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLength) {
        // Prefer newline break
        let splitIdx = remaining.lastIndexOf("\n", maxLength);
        if (splitIdx === -1 || splitIdx < maxLength / 2) {
            // Fallback: space break
            splitIdx = remaining.lastIndexOf(" ", maxLength);
        }
        if (splitIdx === -1 || splitIdx < maxLength / 2) {
            // Last resort: hard split
            splitIdx = maxLength;
        }

        chunks.push(remaining.substring(0, splitIdx));
        remaining = remaining.substring(splitIdx).trimStart();
    }

    if (remaining.length > 0) {
        chunks.push(remaining);
    }

    return chunks;
}
