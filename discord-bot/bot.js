require("dotenv").config();
const { Client, GatewayIntentBits, Events } = require("discord.js");

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const API_URL = process.env.ZUYCHIN_API_URL || "http://localhost:3000";
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID; // Optional: restrict to one channel

if (!BOT_TOKEN) {
    console.error("DISCORD_BOT_TOKEN is required");
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once(Events.ClientReady, (c) => {
    console.log(`[Bot] Online as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.content.trim()) return;
    if (CHANNEL_ID && message.channel.id !== CHANNEL_ID) return;

    console.log(`[Bot] ${message.author.tag}: ${message.content.substring(0, 50)}`);

    try {
        await message.channel.sendTyping();

        const res = await fetch(`${API_URL}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: message.content,
                channel: "discord",
            }),
        });

        if (!res.ok) {
            const err = await res.text();
            console.error(`[Bot] API error ${res.status}:`, err);
            await message.reply("Something went wrong. Try again later.");
            return;
        }

        const data = await res.json();
        const reply = data.reply || "No response.";

        // Discord 2000 char limit
        if (reply.length <= 2000) {
            await message.reply(reply);
        } else {
            const chunks = splitMessage(reply, 2000);
            for (const chunk of chunks) {
                await message.channel.send(chunk);
            }
        }
    } catch (err) {
        console.error("[Bot] Error:", err);
        await message.reply("Failed to reach the API.").catch(() => { });
    }
});

// Split text at newline/space boundaries
function splitMessage(text, maxLen) {
    const chunks = [];
    let remaining = text;
    while (remaining.length > maxLen) {
        let idx = remaining.lastIndexOf("\n", maxLen);
        if (idx < maxLen / 2) idx = remaining.lastIndexOf(" ", maxLen);
        if (idx < maxLen / 2) idx = maxLen;
        chunks.push(remaining.substring(0, idx));
        remaining = remaining.substring(idx).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

// Health-check HTTP server (required for Render free Web Service).
// External cron pinger hits this every 14 min to prevent spin-down.
const http = require("http");
const PORT = process.env.PORT || 3001;
http.createServer((_, res) => {
    res.writeHead(200);
    res.end("OK");
}).listen(PORT, () => console.log(`[Health] Listening on port ${PORT}`));

client.login(BOT_TOKEN);
