import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { Type } from "@google/genai";
import { ai, MODEL } from "@/lib/gemini";
import { listUnreadEmails, formatEmailSummary, type EmailThread } from "@/lib/integrations/gmail-service";
import { listUpcomingEvents, formatEventsSummary } from "@/lib/integrations/calendar-service";
import { sendDiscordMessage } from "@/lib/messaging/discord-service";
import { sendTelegramMessage } from "@/lib/messaging/telegram-service";

const CRON_SECRET = process.env.CRON_SECRET;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export const maxDuration = 300;

const MAX_HIGHLIGHTS = 6;

type Urgency = "act_now" | "needs_reply" | "fyi";

const URGENCY_ORDER: Urgency[] = ["act_now", "needs_reply", "fyi"];
const URGENCY_ICON: Record<Urgency, string> = { act_now: "🔴", needs_reply: "🟡", fyi: "🔵" };

interface Highlight {
    email: EmailThread;
    reason: string;
    urgency: Urgency;
}

// Picks the few emails worth attention. Returns null on failure so the
// caller can fall back to a plain listing.
async function triageEmails(emails: EmailThread[]): Promise<Highlight[] | null> {
    if (emails.length === 0) return [];

    const listing = emails
        .map((e, i) => `${i}. From: ${e.from} | Subject: ${e.subject} | Date: ${e.date} | ${e.snippet.slice(0, 140)}`)
        .join("\n");

    try {
        const res = await ai.models.generateContent({
            model: MODEL,
            contents: `You triage an inbox for a busy user. From the unread emails below, select ONLY the ones genuinely worth their attention or immediate action: real people writing to them personally, deadlines, bills/invoices, security alerts, bookings/deliveries, replies they are waiting on. EXCLUDE newsletters, promotions, product updates, social notifications and automated digests. Select at most ${MAX_HIGHLIGHTS} — selecting none is a valid answer if nothing matters.

For each selected email give an urgency: "act_now" (deadline, payment, security — handle today), "needs_reply" (a person is waiting on them), or "fyi" (worth knowing, no action).

Emails:
${listing}`,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        important: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    index: { type: Type.INTEGER, description: "Index of the email in the list above." },
                                    reason: { type: Type.STRING, description: "Why it matters, 6 words max." },
                                    urgency: { type: Type.STRING, enum: ["act_now", "needs_reply", "fyi"] },
                                },
                                required: ["index", "reason", "urgency"],
                            },
                        },
                    },
                    required: ["important"],
                },
            },
        });

        const parsed = JSON.parse(res.text ?? "") as { important: { index: number; reason: string; urgency: string }[] };
        return parsed.important
            .filter((x) => Number.isInteger(x.index) && x.index >= 0 && x.index < emails.length)
            .slice(0, MAX_HIGHLIGHTS)
            .map((x) => ({
                email: emails[x.index],
                reason: String(x.reason ?? "").trim(),
                urgency: (URGENCY_ORDER as string[]).includes(x.urgency) ? (x.urgency as Urgency) : "fyi",
            }))
            .sort((a, b) => URGENCY_ORDER.indexOf(a.urgency) - URGENCY_ORDER.indexOf(b.urgency));
    } catch (err) {
        console.warn("[Briefing] Email triage failed:", err);
        return null;
    }
}

// "Jane Doe <jane@x.com>" → "Jane Doe"
function senderName(from: string): string {
    return from.replace(/<[^>]*>/g, "").replace(/["']/g, "").trim() || from;
}

function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// One line per highlighted email, most urgent first; skipped emails are
// rolled up into a single count line.
function emailSection(emails: EmailThread[], highlights: Highlight[] | null): string {
    if (highlights === null) {
        // Triage unavailable: show a short slice instead of the full dump.
        const shown = emails.slice(0, 8);
        return `\n📧 **Unread Emails (showing ${shown.length} of ${emails.length}):**\n${formatEmailSummary(shown)}`;
    }
    if (highlights.length === 0) {
        return `\n📧 **Inbox:** ${emails.length} unread, nothing that needs you — newsletters and notifications only.`;
    }

    const lines = highlights
        .map((h) => {
            const reason = h.reason ? ` — _${h.reason}_` : "";
            return `${URGENCY_ICON[h.urgency]} **${truncate(senderName(h.email.from), 30)}** · ${truncate(h.email.subject, 60)}${reason}`;
        })
        .join("\n");
    const rest = emails.length - highlights.length;
    const restLine = rest > 0 ? `\n▫️ _${rest} more unread are newsletters & notifications — safe to skip._` : "";
    return `\n📧 **Inbox — ${highlights.length} of ${emails.length} unread need you** (🔴 act · 🟡 reply · 🔵 know):\n${lines}${restLine}`;
}

export async function POST(req: NextRequest) {
    try {
        const authHeader = req.headers.get("authorization");
        if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        if (!DISCORD_CHANNEL_ID && !TELEGRAM_CHAT_ID) {
            return NextResponse.json({ error: "No messaging channel configured." }, { status: 500 });
        }

        // Gmail/Calendar fetches + the triage model call can outlast the cron
        // client's timeout (cron-job.org caps at 30s): respond now, send after.
        after(() => buildAndSendBriefing());
        return NextResponse.json({ accepted: true }, { status: 202 });
    } catch (error) {
        console.error("[Briefing] Error:", error);
        return NextResponse.json({ error: "Daily briefing failed." }, { status: 500 });
    }
}

async function buildAndSendBriefing() {
    try {
        const [emails, events] = await Promise.all([
            listUnreadEmails(50).catch((err) => {
                console.warn("[Briefing] Gmail fetch failed:", err);
                return [];
            }),
            listUpcomingEvents(12, 10).catch((err) => {
                console.warn("[Briefing] Calendar fetch failed:", err);
                return [];
            }),
        ]);

        const highlights = emails.length > 0 ? await triageEmails(emails) : [];

        const now = new Date();
        const dateStr = now.toLocaleDateString("en-AU", {
            timeZone: "Australia/Sydney",
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
        });

        const parts: string[] = [
            `☀️ **Good morning! Here's your briefing for ${dateStr}.**`,
        ];

        if (events.length > 0) {
            parts.push(`\n📅 **Today's Schedule (${events.length} event${events.length > 1 ? "s" : ""}):**\n${formatEventsSummary(events)}`);
        } else {
            parts.push("\n📅 **Calendar:** No events scheduled today.");
        }

        if (emails.length > 0) {
            parts.push(emailSection(emails, highlights));
        } else {
            parts.push("\n📧 **Inbox:** All clear — no unread emails!");
        }

        parts.push("\n_Reply here to ask about any email or manage the schedule._");

        const msg = parts.join("\n");

        const sends: Promise<boolean>[] = [];
        if (DISCORD_CHANNEL_ID) sends.push(sendDiscordMessage(DISCORD_CHANNEL_ID, msg));
        if (TELEGRAM_CHAT_ID) sends.push(sendTelegramMessage(TELEGRAM_CHAT_ID, msg));
        await Promise.all(sends);

        console.log(`[Briefing] Sent daily briefing: ${highlights === null ? "triage failed, " : `${highlights.length} highlighted of `}${emails.length} emails, ${events.length} events.`);
    } catch (error) {
        console.error("[Briefing] Error:", error);
    }
}
