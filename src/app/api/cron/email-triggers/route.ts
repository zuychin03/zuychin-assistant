import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { Type } from "@google/genai";
import { ai, MODEL } from "@/lib/gemini";
import { listRecentEmails, getEmailContent, type EmailThread } from "@/lib/integrations/gmail-service";
import { createCalendarEvent } from "@/lib/integrations/calendar-service";
import { addTodo, listTodos } from "@/lib/db";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { notify } from "@/lib/messaging/router";
import { currentDateTimeContext, APP_TIMEZONE } from "@/lib/datetime";

export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

const SCAN_LIMIT = 30;
const MAX_CANDIDATES = 5;
const BODY_CHARS = 3000;

const OBLIGATION_KINDS = ["bill", "deadline", "appointment", "renewal", "other"] as const;
type ObligationKind = (typeof OBLIGATION_KINDS)[number];

interface Obligation {
    title: string;
    kind: ObligationKind;
    dueDate: string | null;
    amount: string | null;
    summary: string;
}

interface SourcedObligation extends Obligation {
    from: string;
    subject: string;
}

interface FinalObligation extends Obligation {
    sources: { from: string; subject: string }[];
}

/** Stage 1 (snippets, cheap): which emails contain a real obligation? Null = call failed, retry next run. */
async function pickCandidates(emails: EmailThread[]): Promise<{ index: number; kind: string }[] | null> {
    const listing = emails
        .map((e, i) => `${i}. From: ${e.from} | Subject: ${e.subject} | Date: ${e.date} | ${e.snippet.slice(0, 140)}`)
        .join("\n");

    try {
        const res = await ai.models.generateContent({
            model: MODEL,
            contents: `You scan an inbox for concrete OBLIGATIONS the user must act on by a certain time: a bill or invoice to pay, a hard deadline, an appointment or booking to attend, a subscription/registration renewal. Select ONLY emails that clearly state such an obligation for the user personally. EXCLUDE newsletters, promotions, receipts for already-completed payments, general reminders without a real obligation, and anything ambiguous — a false positive creates junk tasks. Selecting none is the normal outcome. At most ${MAX_CANDIDATES}.

Emails:
${listing}`,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        candidates: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    index: { type: Type.INTEGER, description: "Index of the email in the list above." },
                                    kind: { type: Type.STRING, enum: [...OBLIGATION_KINDS] },
                                },
                                required: ["index", "kind"],
                            },
                        },
                    },
                    required: ["candidates"],
                },
            },
        });

        const parsed = JSON.parse(res.text ?? "") as { candidates: { index: number; kind: string }[] };
        return parsed.candidates
            .filter((c) => Number.isInteger(c.index) && c.index >= 0 && c.index < emails.length)
            .slice(0, MAX_CANDIDATES);
    } catch (err) {
        console.warn("[EmailTriggers] Candidate pass failed:", err);
        return null;
    }
}

/** Stage 2 (full body): extract the concrete obligations from one candidate email. */
async function extractObligations(email: { from: string; subject: string; date: string; body: string }): Promise<Obligation[]> {
    try {
        const res = await ai.models.generateContent({
            model: MODEL,
            contents: `${currentDateTimeContext()}

Extract the concrete obligation(s) for the user from this email. For each: a short imperative title (e.g. "Pay electricity bill"), the kind, the due date/time as ISO 8601 if one is stated or clearly implied ("YYYY-MM-DD" when only a date is known, full datetime with offset when a time is stated), the amount if it is a payment, and a one-sentence summary. Resolve relative dates ("next Friday", "within 14 days of this email") against the current date above and the email's sent date. If no due date is determinable, leave it out. Do not invent obligations — an empty list is valid.

From: ${email.from}
Subject: ${email.subject}
Sent: ${email.date}

${email.body.slice(0, BODY_CHARS)}`,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        obligations: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    title: { type: Type.STRING },
                                    kind: { type: Type.STRING, enum: [...OBLIGATION_KINDS] },
                                    due_date: { type: Type.STRING, description: "ISO 8601; omit when unknown." },
                                    amount: { type: Type.STRING, description: "Payment amount with currency; omit if not a payment." },
                                    summary: { type: Type.STRING, description: "One sentence." },
                                },
                                required: ["title", "kind", "summary"],
                            },
                        },
                    },
                    required: ["obligations"],
                },
            },
        });

        const parsed = JSON.parse(res.text ?? "") as {
            obligations: { title: string; kind: string; due_date?: string; amount?: string; summary: string }[];
        };
        return parsed.obligations
            .filter((o) => o.title?.trim())
            .slice(0, 3)
            .map((o) => ({
                title: o.title.trim(),
                kind: (OBLIGATION_KINDS as readonly string[]).includes(o.kind) ? (o.kind as ObligationKind) : "other",
                dueDate: o.due_date && !isNaN(Date.parse(o.due_date)) ? o.due_date : null,
                amount: o.amount?.trim() || null,
                summary: o.summary?.trim() ?? "",
            }));
    } catch (err) {
        console.warn("[EmailTriggers] Extraction failed:", err);
        return [];
    }
}

/**
 * Stage 3: one batch-wide pass that merges obligations describing the same
 * underlying issue (repeat notifications, reminders, updates) and drops ones
 * an existing pending todo already covers. Null = call failed; the caller
 * leaves the candidate emails unmarked so they retry next run.
 */
async function consolidateObligations(
    extracted: SourcedObligation[],
    pendingTodos: { title: string; dueDate?: string | null }[]
): Promise<FinalObligation[] | null> {
    const listing = extracted.map((o, i) => ({
        index: i,
        title: o.title,
        kind: o.kind,
        dueDate: o.dueDate,
        amount: o.amount,
        summary: o.summary,
        from: o.from,
        subject: o.subject,
    }));
    const todoLines = pendingTodos
        .map((t) => `- ${t.title}${t.dueDate ? ` (due ${t.dueDate})` : ""}`)
        .join("\n") || "(none)";

    try {
        const res = await ai.models.generateContent({
            model: MODEL,
            contents: `You deduplicate obligations extracted from a batch of emails BEFORE they become todo items and calendar events. The user often receives several emails about the same issue and hates duplicate entries.

Extracted obligations (JSON; index identifies each):
${JSON.stringify(listing)}

The user's existing pending todos:
${todoLines}

Rules:
- Obligations that refer to the SAME underlying obligation (the same bill, job, deadline, appointment — including reminders, updates, or re-sends worded differently) MERGE into ONE entry: keep the clearest title, the most complete amount/summary, the LATEST stated due date, and list every contributing source index.
- DROP any obligation an existing pending todo already covers — match on the underlying issue, not exact wording. The user already knows about those.
- Genuinely distinct obligations stay separate entries.
An empty list is valid when everything is a duplicate.`,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        entries: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    title: { type: Type.STRING },
                                    kind: { type: Type.STRING, enum: [...OBLIGATION_KINDS] },
                                    due_date: { type: Type.STRING, description: "ISO 8601; omit when unknown." },
                                    amount: { type: Type.STRING, description: "Omit if not a payment." },
                                    summary: { type: Type.STRING, description: "One sentence." },
                                    source_indexes: {
                                        type: Type.ARRAY,
                                        items: { type: Type.INTEGER },
                                        description: "Indexes of every merged input obligation.",
                                    },
                                },
                                required: ["title", "kind", "summary", "source_indexes"],
                            },
                        },
                    },
                    required: ["entries"],
                },
            },
        });

        const parsed = JSON.parse(res.text ?? "") as {
            entries: { title: string; kind: string; due_date?: string; amount?: string; summary: string; source_indexes: number[] }[];
        };
        return parsed.entries
            .filter((e) => e.title?.trim())
            .map((e) => ({
                title: e.title.trim(),
                kind: (OBLIGATION_KINDS as readonly string[]).includes(e.kind) ? (e.kind as ObligationKind) : "other",
                dueDate: e.due_date && !isNaN(Date.parse(e.due_date)) ? e.due_date : null,
                amount: e.amount?.trim() || null,
                summary: e.summary?.trim() ?? "",
                sources: [...new Set((e.source_indexes ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < extracted.length))]
                    .map((i) => ({ from: extracted[i].from, subject: extracted[i].subject })),
            }));
    } catch (err) {
        console.warn("[EmailTriggers] Consolidation failed:", err);
        return null;
    }
}

function formatDue(dueDate: string): string {
    return new Date(dueDate).toLocaleString("en-AU", {
        timeZone: APP_TIMEZONE,
        day: "numeric",
        month: "short",
        ...(dueDate.includes("T") && { hour: "numeric", minute: "2-digit", hour12: true }),
    });
}

export async function POST(req: NextRequest) {
    try {
        const authHeader = req.headers.get("authorization");
        if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const emails = await listRecentEmails(SCAN_LIMIT, "newer_than:2d");
        if (emails.length === 0) {
            return NextResponse.json({ message: "No recent emails.", scanned: 0 });
        }

        // Dedup ledger. A failing read must abort: without it every run would
        // re-create the same todos and events.
        const { data: seenRows, error: seenError } = await supabase
            .from("processed_emails")
            .select("gmail_message_id")
            .in("gmail_message_id", emails.map((e) => e.id));
        if (seenError) {
            console.warn("[EmailTriggers] Dedup read failed (run supabase-setup.sql?):", seenError.message);
            return NextResponse.json({ error: "processed_emails table unavailable — nothing processed." }, { status: 503 });
        }
        const seen = new Set((seenRows ?? []).map((r) => r.gmail_message_id));
        const fresh = emails.filter((e) => !seen.has(e.id));
        if (fresh.length === 0) {
            return NextResponse.json({ message: "All recent emails already processed.", scanned: emails.length, skipped: emails.length });
        }

        // Triage + bodies + extraction + consolidation can outlast the cron
        // client's timeout (cron-job.org caps at 30s), so respond now and
        // process after. Failure semantics inside are unchanged: unmarked
        // emails retry next run.
        after(() => processBatch(fresh, emails.length));
        return NextResponse.json(
            { accepted: true, scanned: emails.length, skipped: emails.length - fresh.length },
            { status: 202 }
        );
    } catch (error) {
        console.error("[EmailTriggers] Error:", error);
        return NextResponse.json({ error: "Email trigger scan failed." }, { status: 500 });
    }
}

async function processBatch(fresh: EmailThread[], scanned: number) {
    try {
        const candidates = await pickCandidates(fresh);
        if (candidates === null) {
            // Nothing marked processed — the whole batch retries next run.
            console.warn("[EmailTriggers] Candidate triage failed — batch retries next run.");
            return;
        }
        const candidateIndexes = new Set(candidates.map((c) => c.index));

        const digest: string[] = [];
        let todosCreated = 0;
        let eventsCreated = 0;
        const processedRows: { gmail_message_id: string; outcome: Record<string, unknown> }[] = [];
        // Candidate emails only join processedRows once consolidation succeeds,
        // so a failed consolidation call retries them next run.
        const candidateRows: { gmail_message_id: string; outcome: Record<string, unknown> }[] = [];
        const extracted: SourcedObligation[] = [];

        for (const [index, email] of fresh.entries()) {
            if (!candidateIndexes.has(index)) {
                processedRows.push({ gmail_message_id: email.id, outcome: { obligations: 0 } });
                continue;
            }

            const content = await getEmailContent(email.id);
            if (!content) {
                // Body fetch failed — leave unmarked so this one retries.
                console.warn(`[EmailTriggers] Could not fetch body for "${email.subject}".`);
                continue;
            }

            const obligations = await extractObligations(content);
            extracted.push(...obligations.map((o) => ({ ...o, from: email.from, subject: email.subject })));
            candidateRows.push({ gmail_message_id: email.id, outcome: { obligations: obligations.length } });
        }

        // Stage 3: batch-wide merge and dedup against pending todos.
        let finalEntries: FinalObligation[] = [];
        let consolidationFailed = false;
        if (extracted.length > 0) {
            const pendingTodos = await listTodos("pending", 50).catch(() => [] as Awaited<ReturnType<typeof listTodos>>);
            const consolidated = await consolidateObligations(extracted, pendingTodos);
            if (consolidated === null) consolidationFailed = true;
            else finalEntries = consolidated;
        }
        if (!consolidationFailed) {
            processedRows.push(...candidateRows);
        }

        for (const o of finalEntries) {
            const sourceLines = o.sources.length > 1
                ? `From ${o.sources.length} emails:\n${o.sources.map((s) => `- ${s.from} — ${s.subject}`).join("\n")}`
                : o.sources.length === 1
                    ? `From: ${o.sources[0].from} — ${o.sources[0].subject}`
                    : "";

            try {
                await addTodo({
                    title: o.title,
                    description: `${sourceLines ? `${sourceLines}\n` : ""}${o.summary}${o.amount ? `\nAmount: ${o.amount}` : ""}`,
                    priority: o.dueDate && new Date(o.dueDate).getTime() - Date.now() < 3 * 86_400_000 ? "high" : "medium",
                    dueDate: o.dueDate ?? undefined,
                });
                todosCreated++;
            } catch (err) {
                console.warn(`[EmailTriggers] addTodo failed for "${o.title}":`, err);
            }

            if (o.dueDate) {
                try {
                    await createCalendarEvent({
                        summary: `📌 ${o.title}`,
                        start: o.dueDate,
                        description: `${o.summary}${o.amount ? ` (${o.amount})` : ""}${sourceLines ? `\n${sourceLines}` : ""}`,
                    });
                    eventsCreated++;
                } catch (err) {
                    console.warn(`[EmailTriggers] createCalendarEvent failed for "${o.title}":`, err);
                }
            }

            digest.push(`- **${o.title}**${o.dueDate ? ` (due ${formatDue(o.dueDate)})` : ""}${o.amount ? ` — ${o.amount}` : ""}${o.sources.length > 1 ? ` _(merged from ${o.sources.length} emails)_` : ""}\n  _${o.summary}_`);
        }

        if (processedRows.length > 0) {
            const { error: upsertError } = await supabase
                .from("processed_emails")
                .upsert(processedRows, { onConflict: "gmail_message_id" });
            if (upsertError) console.warn("[EmailTriggers] Failed to record processed emails:", upsertError.message);
        }

        if (digest.length > 0) {
            const msg = `📬 **Found in your inbox** (added to your todo list${eventsCreated ? " + calendar" : ""} — delete anything that's off):\n\n${digest.join("\n")}`;
            await notify("email_obligation", msg, {
                pushTitle: "Zuychin found obligations in your inbox",
                pushBody: msg.replace(/\*\*|_/g, "").slice(0, 500),
            });
        }

        // Keep the ledger from growing forever.
        await supabase
            .from("processed_emails")
            .delete()
            .lt("processed_at", new Date(Date.now() - 90 * 86_400_000).toISOString());

        if (consolidationFailed) {
            console.warn(`[EmailTriggers] Consolidation failed for ${extracted.length} obligation(s) — candidate emails retry next run.`);
            return;
        }

        console.log(`[EmailTriggers] Scanned ${fresh.length} new of ${scanned}, ${extracted.length} extracted → ${finalEntries.length} after consolidation, ${todosCreated} todo(s), ${eventsCreated} event(s).`);
    } catch (error) {
        console.error("[EmailTriggers] Background processing failed:", error);
    }
}
