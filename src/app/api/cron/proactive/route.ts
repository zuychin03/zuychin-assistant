import { NextRequest, NextResponse } from "next/server";
import { geminiModel } from "@/lib/gemini";
import { getRecentMessages, getDefaultProfile } from "@/lib/db";
import { sendMessengerReply, sendWhatsAppReply } from "@/lib/messaging/meta-service";
import { buildToolSystemPrompt } from "@/lib/ai/mcp-service";



const CRON_SECRET = process.env.CRON_SECRET;

/**
 * POST /api/cron/proactive
 * Called by external cron. Generates proactive messages (briefings, reminders, check-ins).
 */
export async function POST(req: NextRequest) {
    try {
        // Auth check
        const authHeader = req.headers.get("authorization");
        if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { type = "daily_check" } = body;

        // Load profile
        const profile = await getDefaultProfile();
        if (!profile) {
            return NextResponse.json({ message: "No user profile found." });
        }

        // Check recent activity
        const recentMessages = await getRecentMessages(5);
        const hasRecentActivity = recentMessages.some((m) => {
            const msgTime = new Date(m.createdAt).getTime();
            const hourAgo = Date.now() - 60 * 60 * 1000;
            return msgTime > hourAgo;
        });

        // Build prompt based on type
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

        // Generate via Gemini
        const result = await geminiModel.generateContent(proactivePrompt);
        const proactiveMessage = result.response.text();

        // Route to last-used channel
        const lastChannel = recentMessages[0]?.channel ?? "web";
        const lastSenderId = body.senderId;

        let delivered = false;

        if (lastSenderId && lastChannel === "messenger") {
            delivered = await sendMessengerReply(lastSenderId, proactiveMessage);
        } else if (lastSenderId && lastChannel === "whatsapp") {
            const phoneNumberId = body.phoneNumberId ?? "";
            delivered = await sendWhatsAppReply(phoneNumberId, lastSenderId, proactiveMessage);
        }

        return NextResponse.json({
            message: proactiveMessage,
            delivered,
            channel: lastChannel,
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
