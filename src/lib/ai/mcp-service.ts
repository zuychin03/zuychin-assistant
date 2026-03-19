import { Type } from "@google/genai";
import {
    listUpcomingEvents, createCalendarEvent, deleteCalendarEvent,
    formatEventsSummary,
} from "@/lib/integrations/calendar-service";
import {
    listUnreadEmails, getEmailContent, createDraftReply, sendEmail,
    formatEmailSummary,
} from "@/lib/integrations/gmail-service";


export interface McpTool {
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

export const MCP_TOOLS: McpTool[] = [
    {
        name: "get_current_time",
        description: "Get the current date and time in the user's timezone.",
        parameters: {
            timezone: {
                type: "string",
                description: "IANA timezone string (e.g. 'Australia/Sydney')",
                required: false,
            },
        },
    },
    {
        name: "search_knowledge",
        description: "Search the knowledge base for relevant information about a topic.",
        parameters: {
            query: {
                type: "string",
                description: "The search query to find relevant knowledge.",
                required: true,
            },
        },
    },
    {
        name: "save_note",
        description: "Save a note or piece of information for the user to remember later.",
        parameters: {
            content: {
                type: "string",
                description: "The content to save.",
                required: true,
            },
            category: {
                type: "string",
                description: "Category for the note (e.g. 'reminder', 'meeting', 'personal').",
                required: false,
            },
        },
    },
    {
        name: "get_recent_conversations",
        description: "Get a summary of recent conversations across all channels.",
        parameters: {
            limit: {
                type: "number",
                description: "Number of recent messages to retrieve (default: 10).",
                required: false,
            },
        },
    },
    {
        name: "manage_calendar_event",
        description: "Create or delete a Google Calendar event. For creating: provide summary, start datetime (ISO 8601), and optionally end, description, location. For deleting: provide action='delete' and event_id.",
        parameters: {
            action: {
                type: "string",
                description: "Action to perform: 'create' or 'delete'.",
                required: true,
            },
            summary: {
                type: "string",
                description: "Event title (required for create).",
                required: false,
            },
            start: {
                type: "string",
                description: "Start datetime in ISO 8601 format, e.g. '2026-03-20T14:00:00+11:00' or '2026-03-20' for all-day.",
                required: false,
            },
            end: {
                type: "string",
                description: "End datetime in ISO 8601 format. Defaults to 1 hour after start.",
                required: false,
            },
            description: {
                type: "string",
                description: "Optional event description or notes.",
                required: false,
            },
            location: {
                type: "string",
                description: "Optional event location.",
                required: false,
            },
            event_id: {
                type: "string",
                description: "Event ID (required for delete).",
                required: false,
            },
        },
    },
    {
        name: "list_calendar_events",
        description: "List upcoming Google Calendar events. Returns events within the next N hours. Each event includes its Event ID, which you can use with manage_calendar_event action='delete' to delete it.",
        parameters: {
            hours_ahead: {
                type: "number",
                description: "How many hours ahead to look (default: 24).",
                required: false,
            },
        },
    },
    {
        name: "list_unread_emails",
        description: "List unread emails in the user's Gmail inbox. Supports Gmail search filters to narrow results by label, sender, category, subject, etc.",
        parameters: {
            max_results: {
                type: "number",
                description: "Maximum number of emails to return (default: 10).",
                required: false,
            },
            query: {
                type: "string",
                description: "Optional Gmail search query to filter emails. Examples: 'from:john@example.com', 'label:work', 'category:promotions', 'subject:invoice', 'from:company.com'. Multiple filters can be combined.",
                required: false,
            },
        },
    },
    {
        name: "read_email",
        description: "Read the full content of an email by its message ID. Use after list_unread_emails to get the body.",
        parameters: {
            message_id: {
                type: "string",
                description: "The email message ID to read.",
                required: true,
            },
        },
    },
    {
        name: "draft_gmail_reply",
        description: "Create a draft reply to an email in the user's Gmail. The draft can be reviewed and sent by the user.",
        parameters: {
            message_id: {
                type: "string",
                description: "The original email message ID to reply to.",
                required: true,
            },
            reply_body: {
                type: "string",
                description: "The text content of the reply.",
                required: true,
            },
        },
    },
    {
        name: "send_email",
        description: "Compose and send a new email from the user's Gmail account. Use this when the user asks to send, write, or email someone.",
        parameters: {
            to: {
                type: "string",
                description: "Recipient email address.",
                required: true,
            },
            subject: {
                type: "string",
                description: "Email subject line.",
                required: true,
            },
            body: {
                type: "string",
                description: "Email body text.",
                required: true,
            },
            cc: {
                type: "string",
                description: "Optional CC recipient email address.",
                required: false,
            },
        },
    },
    {
        name: "manage_todo_list",
        description: "Manage the user's to-do list. Actions: 'add' (create a task), 'list' (view tasks), 'complete' (mark as done), 'delete' (remove a task).",
        parameters: {
            action: {
                type: "string",
                description: "Action: 'add', 'list', 'complete', or 'delete'.",
                required: true,
            },
            title: {
                type: "string",
                description: "Task title (required for add).",
                required: false,
            },
            description: {
                type: "string",
                description: "Optional task description (for add).",
                required: false,
            },
            priority: {
                type: "string",
                description: "Priority: 'low', 'medium', or 'high' (for add, default: medium).",
                required: false,
            },
            due_date: {
                type: "string",
                description: "Optional due date in ISO 8601 format (for add).",
                required: false,
            },
            todo_id: {
                type: "string",
                description: "To-do item ID (required for complete/delete).",
                required: false,
            },
            status_filter: {
                type: "string",
                description: "Filter for list: 'pending', 'in_progress', 'done', or 'all' (default: pending).",
                required: false,
            },
        },
    },
];

import { searchEmbeddings, storeEmbedding, getRecentMessages, addTodo, listTodos, updateTodoStatus, deleteTodo } from "@/lib/db";
import { generateEmbedding } from "@/lib/gemini";
export async function executeTool(
    toolName: string,
    args: Record<string, unknown>
): Promise<string> {
    switch (toolName) {
        case "get_current_time":
            return executeGetCurrentTime(args.timezone as string | undefined);

        case "search_knowledge":
            return executeSearchKnowledge(args.query as string);

        case "save_note":
            return executeSaveNote(
                args.content as string,
                args.category as string | undefined
            );

        case "get_recent_conversations":
            return executeGetRecentConversations(args.limit as number | undefined);

        case "manage_calendar_event":
            return executeManageCalendarEvent(args);

        case "list_calendar_events":
            return executeListCalendarEvents(args.hours_ahead as number | undefined);

        case "list_unread_emails":
            return executeListUnreadEmails(args.max_results as number | undefined, args.query as string | undefined);

        case "read_email":
            return executeReadEmail(args.message_id as string);

        case "draft_gmail_reply":
            return executeDraftGmailReply(args);

        case "send_email":
            return executeSendEmail(args);

        case "manage_todo_list":
            return executeManageTodoList(args);

        default:
            return `Unknown tool: ${toolName}`;
    }
}

async function executeGetCurrentTime(timezone?: string): Promise<string> {
    const tz = timezone ?? "Australia/Sydney";
    const now = new Date().toLocaleString("en-AU", { timeZone: tz });
    return `Current time (${tz}): ${now}`;
}

async function executeSearchKnowledge(query: string): Promise<string> {
    try {
        const embedding = await generateEmbedding(query);
        const results = await searchEmbeddings({
            queryEmbedding: embedding,
            matchThreshold: 0.6,
            matchCount: 5,
        });

        if (results.length === 0) {
            return "No relevant knowledge found.";
        }

        return results
            .map((r, i) => `[${i + 1}] ${r.content}`)
            .join("\n");
    } catch (error) {
        console.error("[MCP] Knowledge search failed:", error);
        return "Knowledge search is temporarily unavailable.";
    }
}

async function executeSaveNote(
    content: string,
    category?: string
): Promise<string> {
    try {
        const embedding = await generateEmbedding(content);
        await storeEmbedding({
            content,
            embedding,
            metadata: {
                source: "mcp_save_note",
                category: category ?? "general",
            },
        });
        return `Note saved successfully: "${content.substring(0, 50)}..."`;
    } catch (error) {
        console.error("[MCP] Save note failed:", error);
        return "Failed to save note. Please try again.";
    }
}

async function executeGetRecentConversations(
    limit?: number
): Promise<string> {
    try {
        const messages = await getRecentMessages(limit ?? 10);
        if (messages.length === 0) {
            return "No recent conversations found.";
        }

        return messages
            .map(
                (m) =>
                    `[${m.channel}] ${m.role === "user" ? "User" : "Bot"}: ${m.content.substring(0, 100)}`
            )
            .join("\n");
    } catch (error) {
        console.error("[MCP] Recent conversations failed:", error);
        return "Could not retrieve recent conversations.";
    }
}

async function executeManageCalendarEvent(
    args: Record<string, unknown>
): Promise<string> {
    try {
        const action = (args.action as string) ?? "create";

        if (action === "delete") {
            const eventId = args.event_id as string;
            if (!eventId) return "Error: event_id is required for delete.";
            const success = await deleteCalendarEvent(eventId);
            return success ? "Event deleted successfully." : "Failed to delete event.";
        }


        const summary = args.summary as string;
        const start = args.start as string;
        if (!summary || !start) return "Error: summary and start are required to create an event.";

        const created = await createCalendarEvent({
            summary,
            start,
            end: args.end as string | undefined,
            description: args.description as string | undefined,
            location: args.location as string | undefined,
        });

        const timeStr = created.start.includes("T")
            ? new Date(created.start).toLocaleString("en-AU", { timeZone: "Australia/Sydney" })
            : created.start;

        return `✅ Event created: "${created.summary}" on ${timeStr}${created.location ? ` at ${created.location}` : ""}. Event ID: ${created.id}`;
    } catch (error) {
        console.error("[MCP] Calendar event failed:", error);
        return "Failed to manage calendar event. Check Google API credentials.";
    }
}

async function executeListCalendarEvents(
    hoursAhead?: number
): Promise<string> {
    try {
        const events = await listUpcomingEvents(hoursAhead ?? 24);
        if (events.length === 0) return "No upcoming events in the next " + (hoursAhead ?? 24) + " hours.";
        return "Upcoming events:\n" + formatEventsSummary(events);
    } catch (error) {
        console.error("[MCP] List calendar events failed:", error);
        return "Failed to list calendar events. Check Google API credentials.";
    }
}

async function executeListUnreadEmails(
    maxResults?: number,
    query?: string
): Promise<string> {
    try {
        const emails = await listUnreadEmails(maxResults ?? 10, query);
        if (emails.length === 0) {
            const filterNote = query ? ` matching "${query}"` : "";
            return `No unread emails${filterNote} in the inbox.`;
        }
        const filterNote = query ? ` (filter: ${query})` : "";
        return `Found ${emails.length} unread email(s)${filterNote}:\n\n` + formatEmailSummary(emails);
    } catch (error) {
        console.error("[MCP] List unread emails failed:", error);
        return "Failed to list emails. Check Google API credentials.";
    }
}

async function executeReadEmail(messageId: string): Promise<string> {
    if (!messageId) return "Error: message_id is required.";
    try {
        const email = await getEmailContent(messageId);
        if (!email) return "Email not found.";
        return [
            `**Subject:** ${email.subject}`,
            `**From:** ${email.from}`,
            `**To:** ${email.to}`,
            `**Date:** ${email.date}`,
            "",
            email.body,
        ].join("\n");
    } catch (error) {
        console.error("[MCP] Read email failed:", error);
        return "Failed to read email.";
    }
}

async function executeDraftGmailReply(
    args: Record<string, unknown>
): Promise<string> {
    const messageId = args.message_id as string;
    const replyBody = args.reply_body as string;
    if (!messageId || !replyBody) return "Error: message_id and reply_body are required.";

    try {

        const original = await getEmailContent(messageId);
        if (!original) return "Error: original email not found.";

        const draftId = await createDraftReply({
            messageId,
            threadId: original.threadId,
            to: original.from,
            subject: original.subject,
            body: replyBody,
        });

        if (draftId) {
            return `✅ Draft reply created! Draft ID: ${draftId}. You can review and send it from your Gmail drafts.`;
        }
        return "Failed to create draft reply.";
    } catch (error) {
        console.error("[MCP] Draft Gmail reply failed:", error);
        return "Failed to create draft reply. Check Google API credentials.";
    }
}

async function executeSendEmail(
    args: Record<string, unknown>
): Promise<string> {
    const to = args.to as string;
    const subject = args.subject as string;
    const body = args.body as string;
    const cc = args.cc as string | undefined;

    if (!to || !subject || !body) {
        return "Error: to, subject, and body are required to send an email.";
    }

    try {
        const result = await sendEmail({ to, subject, body, cc });
        if (result.success) {
            return `✅ Email sent to ${to}!\nSubject: "${subject}"${cc ? `\nCC: ${cc}` : ""}`;
        }
        return "Failed to send email.";
    } catch (error) {
        console.error("[MCP] Send email failed:", error);
        return "Failed to send email. Check Google API credentials.";
    }
}

async function executeManageTodoList(
    args: Record<string, unknown>
): Promise<string> {
    const action = (args.action as string) ?? "list";

    try {
        switch (action) {
            case "add": {
                const title = args.title as string;
                if (!title) return "Error: title is required to add a task.";
                const id = await addTodo({
                    title,
                    description: args.description as string | undefined,
                    priority: args.priority as "low" | "medium" | "high" | undefined,
                    dueDate: args.due_date as string | undefined,
                });
                return `✅ Task added: "${title}" (ID: ${id})`;
            }

            case "list": {
                const filter = (args.status_filter as string) ?? "pending";
                const todos = await listTodos(
                    filter as "pending" | "in_progress" | "done" | "all"
                );
                if (todos.length === 0) return `No ${filter} tasks found.`;

                const formatted = todos.map((t, i) => {
                    const priority = t.priority === "high" ? "🔴" : t.priority === "medium" ? "🟡" : "🟢";
                    const status = t.status === "done" ? "✅" : t.status === "in_progress" ? "🔄" : "⬜";
                    const due = t.dueDate
                        ? ` (due: ${new Date(t.dueDate).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" })})`
                        : "";
                    return `${i + 1}. ${status} ${priority} **${t.title}**${due}\n   _ID: ${t.id}_`;
                }).join("\n");

                return `To-do list (${filter}):\n\n${formatted}`;
            }

            case "complete": {
                const todoId = args.todo_id as string;
                if (!todoId) return "Error: todo_id is required to complete a task.";
                const success = await updateTodoStatus(todoId, "done");
                return success ? "✅ Task marked as done!" : "Failed to update task.";
            }

            case "delete": {
                const todoId = args.todo_id as string;
                if (!todoId) return "Error: todo_id is required to delete a task.";
                const success = await deleteTodo(todoId);
                return success ? "🗑️ Task deleted." : "Failed to delete task.";
            }

            default:
                return `Unknown action: ${action}. Use 'add', 'list', 'complete', or 'delete'.`;
        }
    } catch (error) {
        console.error("[MCP] Todo list failed:", error);
        return "Failed to manage to-do list.";
    }
}


export function buildGeminiFunctionDeclarations() {
    const typeMap: Record<string, Type> = {
        string: Type.STRING,
        number: Type.NUMBER,
        integer: Type.INTEGER,
        boolean: Type.BOOLEAN,
    };

    return MCP_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: {
            type: Type.OBJECT as const,
            properties: Object.fromEntries(
                Object.entries(tool.parameters).map(([key, val]) => [
                    key,
                    { type: typeMap[val.type] ?? Type.STRING, description: val.description },
                ])
            ) as Record<string, { type: Type; description: string }>,
            required: Object.entries(tool.parameters)
                .filter(([, val]) => val.required)
                .map(([key]) => key),
        },
    }));
}


export function buildToolSystemPrompt(): string {
    const toolList = MCP_TOOLS.map(
        (t) => `- **${t.name}**: ${t.description}`
    ).join("\n");

    return `
## Available Tools
You have access to these tools:
${toolList}
`.trim();
}
