import { NextRequest, NextResponse } from "next/server";
import { ai, MODEL } from "@/lib/gemini";
import { getRecentMessages, getDefaultProfile } from "@/lib/db";
import { sendDiscordMessage } from "@/lib/messaging/discord-service";
import { sendTelegramMessage } from "@/lib/messaging/telegram-service";
import { buildToolSystemPrompt } from "@/lib/ai/mcp-service";



const CRON_SECRET = process.env.CRON_SECRET;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * POST /api/cron/proactive
 * External cron endpoint. Generates proactive messages (briefings, reminders, check-ins).
 */
export async function POST(req: NextRequest) {
    try {
        // Bearer token auth
        const authHeader = req.headers.get("authorization");
        if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { type = "daily_check" } = body;

        // Profile lookup
        const profile = await getDefaultProfile();
        if (!profile) {
            return NextResponse.json({ message: "No user profile found." });
        }

        // Recent activity check
        const recentMessages = await getRecentMessages(5);
        const hasRecentActivity = recentMessages.some((m) => {
            const msgTime = new Date(m.createdAt).getTime();
            const hourAgo = Date.now() - 60 * 60 * 1000;
            return msgTime > hourAgo;
        });

        // Prompt construction
        let proactivePrompt = "";

        switch (type) {
            case "morning_briefing":
                proactivePrompt = `You are Zuychin, a personal AI assistant. It's morning time.
Generate a brief, friendly morning briefing for the user. Include:
- A warm greeting
- Current date and day of week
- Any suggestions based on recent conversations

${buildToolSystemPrompt()}

Keep it concise (2-3 sentences max). Be warm and personal.`;
                break;

            case "daily_check":
                if (hasRecentActivity) {
                    return NextResponse.json({
                        message: "User is active, skipping proactive check.",
                        skipped: true,
                    });
                }

                proactivePrompt = `You are Zuychin, a personal AI assistant.
The user hasn't been active recently. Generate a brief, non-intrusive check-in message.
Keep it casual and short (1-2 sentences). Don't be pushy.`;
                break;

            case "reminder":
                const { reminderText } = body;
                proactivePrompt = `You are Zuychin, a personal AI assistant.
Remind the user about: "${reminderText}"
Be friendly and concise.`;
                break;

            default:
                return NextResponse.json({ error: "Unknown proactive type." }, { status: 400 });
        }

        // Gemini generation
        const result = await ai.models.generateContent({
            model: MODEL,
            contents: proactivePrompt,
        });
        const proactiveMessage = result.text ?? "";

        // Deliver to all configured channels
        let delivered = false;
        const sends: Promise<boolean>[] = [];

        const targetDiscordChannel = body.channelId ?? DISCORD_CHANNEL_ID;
        if (targetDiscordChannel) sends.push(sendDiscordMessage(targetDiscordChannel, proactiveMessage));
        if (TELEGRAM_CHAT_ID) sends.push(sendTelegramMessage(TELEGRAM_CHAT_ID, proactiveMessage));

        const results = await Promise.all(sends);
        delivered = results.some((r) => r);

        const channels: string[] = [];
        if (targetDiscordChannel) channels.push("discord");
        if (TELEGRAM_CHAT_ID) channels.push("telegram");

        return NextResponse.json({
            message: proactiveMessage,
            delivered,
            channels,
            type,
        });
    } catch (error) {
        console.error("[Proactive] Error:", error);
        return NextResponse.json(
            { error: "Proactive check failed." },
            { status: 500 }
        );
    }
}
