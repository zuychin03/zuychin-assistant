import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { Type } from "@google/genai";
import { ai, MODEL } from "@/lib/gemini";
import { APP_TIMEZONE, currentDateTimeContext } from "@/lib/datetime";
import { getRecentMessages, listTodos, type Todo } from "@/lib/db";
import { listMemories } from "@/lib/ai/memory/store";
import { listUpcomingEvents, type CalendarEvent } from "@/lib/integrations/calendar-service";
import { sendDiscordMessage } from "@/lib/messaging/discord-service";
import { sendTelegramMessage } from "@/lib/messaging/telegram-service";
import { broadcastPush } from "@/lib/messaging/push-service";
import {
    INITIATIVE_CATEGORIES,
    getInitiativeFeedbackStats,
    getInitiativeSendGateInfo,
    listInitiativeDecisions,
    logInitiativeDecision,
    type InitiativeCategory,
} from "@/lib/ai/initiative-store";

const CRON_SECRET = process.env.CRON_SECRET;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export const maxDuration = 300;

// The external job fires every 2h; these gates own the real cadence.
const QUIET_START_HOUR = 22;
const QUIET_END_HOUR = 8;
const MIN_HOURS_BETWEEN_SENDS = 3;
const MAX_SENDS_PER_DAY = 3;

function localHour(): number {
    return Number(
        new Intl.DateTimeFormat("en-AU", {
            timeZone: APP_TIMEZONE,
            hour: "numeric",
            hour12: false,
        }).format(new Date())
    );
}

function formatTodos(todos: Todo[]): string {
    if (todos.length === 0) return "(none)";
    return todos
        .map((t) => `- [${t.priority}] ${t.title}${t.dueDate ? ` (due ${t.dueDate})` : ""}${t.description ? ` — ${t.description.slice(0, 100)}` : ""}`)
        .join("\n");
}

function formatEvents(events: CalendarEvent[]): string {
    if (events.length === 0) return "(none)";
    return events
        .map((e) => `- ${e.start}${e.end ? ` → ${e.end}` : ""}: ${e.summary}${e.location ? ` @ ${e.location}` : ""}`)
        .join("\n");
}

export async function POST(req: NextRequest) {
    const authHeader = req.headers.get("authorization");
    if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // --- Code gates: all of these run before any model call. ---

    const hour = localHour();
    if (hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR) {
        return NextResponse.json({ skipped: true, gate: "quiet_hours", hour });
    }

    // Unreadable ledger = hard abort: without it the rate gates can't hold,
    // and sending blind every tick would spam (same stance as email-triggers).
    let gateInfo;
    try {
        gateInfo = await getInitiativeSendGateInfo();
    } catch (err) {
        console.error("[Initiative] Gate info unavailable:", err);
        return NextResponse.json(
            { error: "initiative_log unreadable — has the DDL been run?" },
            { status: 503 }
        );
    }

    if (gateInfo.sentLast24h >= MAX_SENDS_PER_DAY) {
        return NextResponse.json({ skipped: true, gate: "daily_cap", sentLast24h: gateInfo.sentLast24h });
    }
    if (gateInfo.lastSentAt) {
        const hoursSince = (Date.now() - new Date(gateInfo.lastSentAt).getTime()) / 3_600_000;
        if (hoursSince < MIN_HOURS_BETWEEN_SENDS) {
            return NextResponse.json({ skipped: true, gate: "min_spacing", hoursSince: Number(hoursSince.toFixed(1)) });
        }
    }

    const recentMessages = await getRecentMessages(15).catch(() => []);
    const hourAgo = Date.now() - 3_600_000;
    if (recentMessages.some((m) => m.role === "user" && new Date(m.createdAt).getTime() > hourAgo)) {
        return NextResponse.json({ skipped: true, gate: "user_active" });
    }

    // The decide call + sends can outlast the cron client's timeout
    // (cron-job.org caps at 30s), so respond now and decide after.
    after(() => decideAndSend(recentMessages));
    return NextResponse.json({ accepted: true }, { status: 202 });
}

async function decideAndSend(recentMessages: Awaited<ReturnType<typeof getRecentMessages>>) {
    // --- Gather context. Each source degrades to empty on failure. ---

    const [todos, events, memories, pastDecisions, feedbackStats] = await Promise.all([
        listTodos("pending", 20).catch(() => []),
        listUpcomingEvents(48, 15).catch(() => []),
        listMemories(30).catch(() => []),
        listInitiativeDecisions(20).catch(() => []),
        getInitiativeFeedbackStats().catch(() => []),
    ]);

    const conversationExcerpt = recentMessages
        .slice()
        .reverse()
        .map((m) => `${m.role} (${m.createdAt.slice(0, 16)}): ${m.content.slice(0, 200)}`)
        .join("\n") || "(none)";

    const decisionLog = pastDecisions
        .map((d) => `- ${d.decidedAt.slice(0, 16)} ${d.shouldSend ? "SENT" : "silent"} [${d.category}]${d.feedback === 1 ? " 👍" : d.feedback === -1 ? " 👎" : ""}: ${(d.message ?? d.reason ?? "").slice(0, 120)}`)
        .join("\n") || "(none)";

    const statsBlock = feedbackStats
        .map((s) => `- ${s.category}: ${s.sent} sent, ${s.up} 👍, ${s.down} 👎`)
        .join("\n") || "(no feedback yet)";

    const prompt = `You are the initiative engine of Zuychin, a personal AI assistant. On a schedule you review the user's current state and decide whether ANYTHING genuinely warrants proactively messaging them RIGHT NOW.

${currentDateTimeContext()}

STRONG DEFAULT: silence (shouldSend=false). The user hates noise. Only message for things a thoughtful human assistant would interrupt for:
- a commitment that is overdue or about to be missed (overdue_todo, deadline_warning)
- calendar events that overlap or collide with something else they planned (calendar_conflict)
- something they clearly said they'd do or follow up on and appear to have forgotten (forgotten_followup)

Never message about: routine pending todos that aren't time-critical, things already covered by a recent decision below (sent OR silent), generic check-ins, or anything speculative.

Feedback history — categories with 👎 need a MUCH higher bar; repeated 👍 means that category is welcome:
${statsBlock}

Recent initiative decisions (do not repeat these topics):
${decisionLog}

Pending todos:
${formatTodos(todos)}

Calendar (next 48h):
${formatEvents(events)}

Known facts about the user:
${memories.map((m) => `- ${m.fact}`).join("\n") || "(none)"}

Recent conversation (user inactive for over an hour):
${conversationExcerpt}

If shouldSend is true, write "message" as Zuychin speaking directly to the user: friendly, specific, 1-3 sentences, no preamble.`;

    let decision: { shouldSend: boolean; category: InitiativeCategory; reason: string; message?: string };
    try {
        const res = await ai.models.generateContent({
            model: MODEL,
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        shouldSend: { type: Type.BOOLEAN },
                        category: { type: Type.STRING, enum: [...INITIATIVE_CATEGORIES] },
                        reason: { type: Type.STRING, description: "Why this decision, 20 words max." },
                        message: { type: Type.STRING, description: "The message to send the user. Only when shouldSend is true." },
                    },
                    required: ["shouldSend", "category", "reason"],
                },
            },
        });
        const parsed = JSON.parse(res.text ?? "") as typeof decision;
        decision = {
            shouldSend: !!parsed.shouldSend,
            category: INITIATIVE_CATEGORIES.includes(parsed.category) ? parsed.category : "other",
            reason: String(parsed.reason ?? "").trim(),
            message: typeof parsed.message === "string" ? parsed.message.trim() : undefined,
        };
    } catch (err) {
        console.error("[Initiative] Decision call failed:", err);
        return;
    }

    if (!decision.shouldSend || !decision.message) {
        await logInitiativeDecision({ shouldSend: false, category: decision.category, reason: decision.reason });
        console.log(`[Initiative] Silent: [${decision.category}] ${decision.reason}`);
        return;
    }

    // Log before sending so the Telegram feedback buttons can carry the id.
    const decisionId = await logInitiativeDecision({
        shouldSend: true,
        category: decision.category,
        reason: decision.reason,
        message: decision.message,
    });

    const sends: Promise<boolean>[] = [];
    if (TELEGRAM_CHAT_ID) {
        sends.push(sendTelegramMessage(TELEGRAM_CHAT_ID, decision.message, decisionId ? {
            replyMarkup: {
                inline_keyboard: [[
                    { text: "👍", callback_data: `ini:${decisionId}:1` },
                    { text: "👎", callback_data: `ini:${decisionId}:-1` },
                ]],
            },
        } : undefined));
    }
    if (DISCORD_CHANNEL_ID) {
        sends.push(sendDiscordMessage(DISCORD_CHANNEL_ID, decision.message));
    }
    sends.push(broadcastPush({ title: "Zuychin", body: decision.message }).then((n) => n > 0));
    const delivered = (await Promise.all(sends)).some((r) => r);

    console.log(
        `[Initiative] Sent id=${decisionId} category=${decision.category} delivered=${delivered}: ${decision.message.slice(0, 120)}`
    );
}
