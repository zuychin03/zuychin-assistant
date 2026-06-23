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


// Shared helper: run a Gmail search and return the matching threads with headers.
async function fetchEmailThreads(query: string, maxResults: number): Promise<EmailThread[]> {
    const gmail = getGmail();

    // Gmail only returns one page at a time, so we follow nextPageToken until we
    // either run out of pages or hit maxResults. Without this we'd silently drop
    // any email past the first page (default page size is small).
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
        const res = await gmail.users.messages.list({
            userId: "me",
            q: query,
            maxResults: Math.min(maxResults - ids.length, 100),
            pageToken,
        });
        for (const m of res.data.messages ?? []) {
            if (m.id) ids.push(m.id);
        }
        pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken && ids.length < maxResults);

    // Pull the headers for each message in small batches - one at a time is slow
    // when there are a lot of emails, and all at once can trip Gmail's rate limit.
    const threads: EmailThread[] = [];
    const batchSize = 10;
    for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        const details = await Promise.all(
            batch.map((id) =>
                gmail.users.messages
                    .get({
                        userId: "me",
                        id,
                        format: "metadata",
                        metadataHeaders: ["Subject", "From", "Date"],
                    })
                    .catch((err) => {
                        console.warn(`[Gmail] Failed to fetch message ${id}:`, err);
                        return null;
                    })
            )
        );

        for (const detail of details) {
            if (!detail) continue;
            const headers = detail.data.payload?.headers ?? [];
            const getHeader = (name: string) =>
                headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

            threads.push({
                id: detail.data.id!,
                subject: getHeader("Subject") || "(No subject)",
                from: getHeader("From"),
                snippet: detail.data.snippet ?? "",
                date: getHeader("Date"),
                unread: (detail.data.labelIds ?? []).includes("UNREAD"),
            });
        }
    }

    return threads;
}

export async function listUnreadEmails(
    maxResults: number = 50,
    query?: string
): Promise<EmailThread[]> {
    const baseQuery = "is:unread in:inbox";
    return fetchEmailThreads(query ? `${baseQuery} ${query}` : baseQuery, maxResults);
}

// Recent inbox emails, read or unread. Defaults to the last 7 days so "recent"
// stays meaningful, but a custom query can widen or narrow that.
export async function listRecentEmails(
    maxResults: number = 25,
    query?: string
): Promise<EmailThread[]> {
    const baseQuery = "in:inbox newer_than:7d";
    return fetchEmailThreads(query ? `in:inbox ${query}` : baseQuery, maxResults);
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

export function formatEmailSummary(emails: EmailThread[], showStatus: boolean = false): string {
    if (emails.length === 0) return "No emails.";

    return emails.map((e, i) => {
        const sender = e.from.includes("<")
            ? e.from.split("<")[0].trim()
            : e.from;
        const status = showStatus && e.unread ? " (unread)" : "";
        return `${i + 1}. **${e.subject}**${status} - from ${sender}\n   _${e.snippet}_`;
    }).join("\n\n");
}
