require("dotenv").config();
const { Client, GatewayIntentBits, Events } = require("discord.js");

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const API_URL = process.env.ZUYCHIN_API_URL || "http://localhost:3000";
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

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

const processedIds = new Set();

client.once(Events.ClientReady, (c) => {
    console.log(`[Bot] Online as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (CHANNEL_ID && message.channel.id !== CHANNEL_ID) return;

    if (processedIds.has(message.id)) return;
    processedIds.add(message.id);
    if (processedIds.size > 1000) {
        const first = processedIds.values().next().value;
        processedIds.delete(first);
    }

    const hasText = message.content.trim().length > 0;
    const attachment = message.attachments.first();
    if (!hasText && !attachment) return;

    console.log(`[Bot] ${message.author.tag}: ${message.content.substring(0, 50)}${attachment ? ` [+${attachment.name}]` : ""}`);

    try {
        await message.channel.sendTyping();

        let text = message.content.trim();
        let useSearch = false;
        let useThinking = false;
        let useAgent = false;
        if (/^[/!]search\b/i.test(text)) {
            useSearch = true;
            text = text.replace(/^[/!]search\b/i, "").trim();
        }
        if (/^[/!]think\b/i.test(text)) {
            useThinking = true;
            text = text.replace(/^[/!]think\b/i, "").trim();
        }
        if (/^[/!]agent\b/i.test(text)) {
            useAgent = true;
            text = text.replace(/^[/!]agent\b/i, "").trim();
        }

        const body = {
            message: text || (attachment ? `[Sent ${attachment.name}]` : ""),
            channel: "discord",
            search: useSearch,
            thinking: useThinking,
            agent: useAgent,
        };

        if (attachment && attachment.size <= 20 * 1024 * 1024) {
            try {
                const fileRes = await fetch(attachment.url);
                const arrayBuf = await fileRes.arrayBuffer();
                const base64 = Buffer.from(arrayBuf).toString("base64");
                body.file = {
                    name: attachment.name,
                    mimeType: attachment.contentType || "application/octet-stream",
                    base64,
                    size: attachment.size,
                };
                console.log(`[Bot] Attachment: ${attachment.name} (${(attachment.size / 1024).toFixed(0)} KB)`);
            } catch (dlErr) {
                console.error("[Bot] Failed to download attachment:", dlErr.message);
            }
        } else if (attachment) {
            console.warn(`[Bot] Attachment too large: ${(attachment.size / 1024 / 1024).toFixed(1)} MB`);
        }

        const res = await fetch(`${API_URL}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const err = await res.text();
            console.error(`[Bot] API error ${res.status}:`, err);
            await message.reply("Something went wrong. Try again later.");
            return;
        }

        const data = await res.json();
        const reply = data.reply || "No response.";

        const MAX_DISCORD_FILE = 8 * 1024 * 1024;
        const files = [];
        for (const a of data.artifacts || []) {
            if (!a.base64) continue;
            const buffer = Buffer.from(a.base64, "base64");
            if (buffer.length > MAX_DISCORD_FILE) {
                console.warn(`[Bot] Skipping ${a.name} — too large for Discord (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
                continue;
            }
            files.push({ attachment: buffer, name: a.name });
        }

        if (reply.length <= 2000) {
            await message.reply({ content: reply, files });
        } else {
            const chunks = splitMessage(reply, 2000);
            for (let i = 0; i < chunks.length; i++) {
                const isLast = i === chunks.length - 1;
                await message.channel.send({ content: chunks[i], files: isLast ? files : [] });
            }
        }
    } catch (err) {
        console.error("[Bot] Error:", err);
        await message.reply("Failed to reach the API.").catch(() => { });
    }
});

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

const http = require("http");
const PORT = process.env.PORT || 3001;
http.createServer((_, res) => {
    res.writeHead(200);
    res.end("OK");
}).listen(PORT, () => console.log(`[Health] Listening on port ${PORT}`));

client.login(BOT_TOKEN);
