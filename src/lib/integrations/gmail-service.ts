import { google } from "googleapis";
import { getOAuth2Client } from "@/lib/google-auth";

function getGmail() {
    return google.gmail({ version: "v1", auth: getOAuth2Client() });
}

export interface EmailThread {
    id: string;
    subject: string;
    from: string;
    snippet: string;
    date: string;
    unread: boolean;
}

export interface EmailMessage {
    id: string;
    threadId: string;
    subject: string;
    from: string;
    to: string;
    body: string;
    date: string;
}


export async function listUnreadEmails(
    maxResults: number = 10,
    query?: string
): Promise<EmailThread[]> {
    const gmail = getGmail();

    const baseQuery = "is:unread in:inbox";
    const fullQuery = query ? `${baseQuery} ${query}` : baseQuery;

    const res = await gmail.users.messages.list({
        userId: "me",
        q: fullQuery,
        maxResults,
    });

    const messages = res.data.messages ?? [];
    const threads: EmailThread[] = [];

    for (const msg of messages) {
        try {
            const detail = await gmail.users.messages.get({
                userId: "me",
                id: msg.id!,
                format: "metadata",
                metadataHeaders: ["Subject", "From", "Date"],
            });

            const headers = detail.data.payload?.headers ?? [];
            const getHeader = (name: string) =>
                headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

            threads.push({
                id: msg.id!,
                subject: getHeader("Subject") || "(No subject)",
                from: getHeader("From"),
                snippet: detail.data.snippet ?? "",
                date: getHeader("Date"),
                unread: true,
            });
        } catch (err) {
            console.warn(`[Gmail] Failed to fetch message ${msg.id}:`, err);
        }
    }

    return threads;
}

export async function getEmailContent(messageId: string): Promise<EmailMessage | null> {
    const gmail = getGmail();

    try {
        const res = await gmail.users.messages.get({
            userId: "me",
            id: messageId,
            format: "full",
        });

        const headers = res.data.payload?.headers ?? [];
        const getHeader = (name: string) =>
            headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

        let body = "";
        const payload = res.data.payload;

        if (payload?.body?.data) {
            body = Buffer.from(payload.body.data, "base64").toString("utf-8");
        } else if (payload?.parts) {
            const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
            if (textPart?.body?.data) {
                body = Buffer.from(textPart.body.data, "base64").toString("utf-8");
            } else {
                const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
                if (htmlPart?.body?.data) {
                    body = Buffer.from(htmlPart.body.data, "base64").toString("utf-8")
                        .replace(/<[^>]*>/g, " ")
                        .replace(/\s+/g, " ")
                        .trim();
                }
            }
        }

        return {
            id: messageId,
            threadId: res.data.threadId ?? "",
            subject: getHeader("Subject") || "(No subject)",
            from: getHeader("From"),
            to: getHeader("To"),
            body: body.substring(0, 3000),
            date: getHeader("Date"),
        };
    } catch (err) {
        console.error(`[Gmail] Failed to get email ${messageId}:`, err);
        return null;
    }
}

export async function createDraftReply(params: {
    messageId: string;
    threadId: string;
    to: string;
    subject: string;
    body: string;
}): Promise<string | null> {
    const gmail = getGmail();

    const rawEmail = [
        `To: ${params.to}`,
        `Subject: Re: ${params.subject}`,
        `In-Reply-To: ${params.messageId}`,
        `References: ${params.messageId}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        params.body,
    ].join("\r\n");

    const encodedMessage = Buffer.from(rawEmail).toString("base64url");

    try {
        const res = await gmail.users.drafts.create({
            userId: "me",
            requestBody: {
                message: {
                    raw: encodedMessage,
                    threadId: params.threadId,
                },
            },
        });

        return res.data.id ?? null;
    } catch (err) {
        console.error("[Gmail] Failed to create draft:", err);
        return null;
    }
}

export async function sendEmail(params: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
}): Promise<{ success: boolean; messageId?: string }> {
    const gmail = getGmail();

    const headers = [
        `To: ${params.to}`,
        `Subject: ${params.subject}`,
        "Content-Type: text/plain; charset=utf-8",
    ];
    if (params.cc) headers.push(`Cc: ${params.cc}`);
    headers.push("", params.body);

    const rawEmail = headers.join("\r\n");
    const encodedMessage = Buffer.from(rawEmail).toString("base64url");

    try {
        const res = await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw: encodedMessage },
        });

        return { success: true, messageId: res.data.id ?? undefined };
    } catch (err) {
        console.error("[Gmail] Failed to send email:", err);
        return { success: false };
    }
}

export function formatEmailSummary(emails: EmailThread[]): string {
    if (emails.length === 0) return "No unread emails.";

    return emails.map((e, i) => {
        const sender = e.from.includes("<")
            ? e.from.split("<")[0].trim()
            : e.from;
        return `${i + 1}. **${e.subject}** — from ${sender}\n   _${e.snippet}_`;
    }).join("\n\n");
}
