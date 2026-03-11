// Discord REST API — no Gateway dependency.
// Sends messages via the Discord bot token without a persistent connection.

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_API = "https://discord.com/api/v10";

/** Send a text message to a Discord channel via REST API. */
export async function sendDiscordMessage(
    channelId: string,
    text: string
): Promise<boolean> {
    if (!DISCORD_BOT_TOKEN) {
        console.warn("[Discord] DISCORD_BOT_TOKEN not set, cannot send.");
        return false;
    }

    try {
        const chunks = text.length > 2000 ? splitMessage(text, 2000) : [text];

        for (const chunk of chunks) {
            const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
                },
                body: JSON.stringify({ content: chunk }),
            });

            if (!res.ok) {
                const err = await res.text();
                console.error("[Discord] REST send failed:", res.status, err);
                return false;
            }
        }

        return true;
    } catch (error) {
        console.error("[Discord] REST send error:", error);
        return false;
    }
}

/** Split text into chunks at newline/space boundaries. */
function splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLength) {
        let splitIdx = remaining.lastIndexOf("\n", maxLength);
        if (splitIdx < maxLength / 2) splitIdx = remaining.lastIndexOf(" ", maxLength);
        if (splitIdx < maxLength / 2) splitIdx = maxLength;

        chunks.push(remaining.substring(0, splitIdx));
        remaining = remaining.substring(splitIdx).trimStart();
    }

    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
}
