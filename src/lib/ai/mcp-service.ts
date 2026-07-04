import { Type } from "@google/genai";
import {
    listUpcomingEvents, createCalendarEvent, deleteCalendarEvent,
    formatEventsSummary,
} from "@/lib/integrations/calendar-service";
import {
    listUnreadEmails, listRecentEmails, getEmailContent, createDraftReply, sendEmail,
    formatEmailSummary,
} from "@/lib/integrations/gmail-service";
import { ARTIFACT_TOOLS, executeArtifactTool } from "@/lib/ai/tools/artifacts";
import type { ArtifactDescriptor } from "@/lib/types";

export interface McpToolParam {
    type: "string" | "number" | "integer" | "boolean" | "array" | "object";
    description: string;
    required?: boolean;
    enum?: string[];
    items?: McpToolParam;
    properties?: Record<string, McpToolParam>;
}

export interface McpTool {
    name: string;
    description: string;
    parameters: Record<string, McpToolParam>;
}

export interface ToolContext {
    conversationId?: string;
    userProfileId?: string;
    onArtifact?: (artifact: ArtifactDescriptor) => void;
}

export const WEB_SEARCH_TOOL: McpTool = {
    name: "search_web",
    description: "Search the internet for current, real-time or recent information - news, prices, weather, sports, events, or any fact that may have changed or happened after your training data. Returns a short list of results with their source URLs. Call this whenever the question needs up-to-date info or you aren't sure of the latest answer.",
    parameters: {
        query: {
            type: "string",
            description: "What to search for.",
            required: true,
        },
    },
};

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
        description: "Save a note or piece of information for the user to remember later. For actionable tasks or reminders use manage_todo_list instead — those show up in the user's Notes checklist where they can tick them off.",
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
                enum: ["create", "delete"],
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
                description: "Maximum number of emails to return (default: 25). Use a higher number when the user wants a full summary of everything unread.",
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
        name: "list_recent_emails",
        description: "List recent emails in the user's Gmail inbox, both read and unread. Defaults to the last 7 days. Use this when the user asks about recent or latest emails in general, not only unread ones. Supports Gmail search filters.",
        parameters: {
            max_results: {
                type: "number",
                description: "Maximum number of emails to return (default: 25).",
                required: false,
            },
            query: {
                type: "string",
                description: "Optional Gmail search query to narrow or widen results. Examples: 'newer_than:2d', 'from:john@example.com', 'subject:invoice', 'category:primary'. When provided it replaces the default 7-day window, so include a time filter like 'newer_than:Xd' if you still want one.",
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
        name: "vault_search",
        description: "Search the second-brain vault (the long-term research/study knowledge base of interlinked wiki pages). Returns matching pages with their path and a one-line summary. Use this for study or research questions about topics the user has ingested; use search_knowledge for personal/temporal memory instead.",
        parameters: {
            query: {
                type: "string",
                description: "What to look for in the vault.",
                required: true,
            },
        },
    },
    {
        name: "vault_read",
        description: "Read a page from the second-brain vault by its repo path (e.g. 'wiki/concepts/transformers.md' or 'index.md'). Use after vault_search to open the pages worth citing.",
        parameters: {
            path: {
                type: "string",
                description: "Path of the page inside the vault repo, including the .md extension.",
                required: true,
            },
        },
    },
    {
        name: "vault_ingest",
        description: "Save durable research/study knowledge into the second-brain vault. Takes raw material (an article, findings from web research, study notes) and runs the full ingest pipeline: writes an interlinked wiki page, auto-links it to related pages, updates the catalogue, verifies, and commits. Use for knowledge worth keeping long-term; use save_note for personal/temporal memory instead.",
        parameters: {
            title: {
                type: "string",
                description: "Human-readable page title, e.g. 'Transformer attention mechanisms'.",
                required: true,
            },
            content: {
                type: "string",
                description: "The material to distil into the page: the source text, or your synthesized research findings. Include the substance, not a placeholder.",
                required: true,
            },
            category: {
                type: "string",
                description: "'sources' for external material (default), 'concepts' for durable ideas/methods, 'entities' for people/tools/projects, 'synthesis' for cross-source answers.",
                required: false,
                enum: ["sources", "concepts", "entities", "synthesis"],
            },
            source: {
                type: "string",
                description: "Optional origin to cite: a URL, paper reference, or book/course name.",
                required: false,
            },
        },
    },
    {
        name: "vault_write",
        description: "Directly create or overwrite ONE vault wiki page with markdown you have already written — for corrections or deliberate edits after vault_read. Prefer vault_ingest for new knowledge (it handles synthesis and auto-linking). The catalogue and log update automatically. This tool cannot remove a page — to delete one call vault_delete; NEVER overwrite a page with a 'DELETE'/'redirect' marker.",
        parameters: {
            path: {
                type: "string",
                description: "Page path like 'wiki/concepts/attention.md' (must be under wiki/<category>/ with a kebab-case filename).",
                required: true,
            },
            markdown: {
                type: "string",
                description: "The COMPLETE new page content, including the YAML frontmatter (title, category, created, updated).",
                required: true,
            },
            summary: {
                type: "string",
                description: "One-line summary (< 140 chars) for the index catalogue.",
                required: false,
            },
        },
    },
    {
        name: "vault_delete",
        description: "Permanently delete ONE vault wiki page and everything pointing at it: wikilinks in other pages, its catalogue entry, and its search-index row, in one commit (the immutable raw/ capture and git history are kept). Use when a page is redundant — e.g. after merging duplicates — or the user asks to remove it. This is the ONLY way to remove a page; never mark one as deleted with vault_write.",
        parameters: {
            path: {
                type: "string",
                description: "Path of the wiki page to delete, e.g. 'wiki/concepts/attention.md'.",
                required: true,
            },
        },
    },
    {
        name: "vault_lint",
        description: "Health-check the second-brain vault: orphan pages, dead links, missing back-references, catalogue/search-index drift, contradictions. Mode 'suggest' (default) only reports findings; 'auto' also fixes the low-risk issues (link and catalogue hygiene), verifies, and commits. Use when the user asks to check, clean up, or maintain the vault.",
        parameters: {
            mode: {
                type: "string",
                description: "'suggest' to report findings only (default); 'auto' to apply low-risk fixes and commit.",
                required: false,
                enum: ["suggest", "auto"],
            },
        },
    },
    {
        name: "manage_todo_list",
        description: "Manage the user's to-do list. Actions: 'add' (create a task), 'list' (view tasks), 'complete' (mark as done), 'delete' (remove a task). Open tasks appear as a checklist in the web app's Notes panel, where the user can tick them off themselves — a task marked done there is finished; never remind the user about it again.",
        parameters: {
            action: {
                type: "string",
                description: "Action: 'add', 'list', 'complete', or 'delete'.",
                required: true,
                enum: ["add", "list", "complete", "delete"],
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
                enum: ["low", "medium", "high"],
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
                enum: ["pending", "in_progress", "done", "all"],
            },
        },
    },
];

import { searchEmbeddings, storeEmbedding, getRecentMessages, addTodo, listTodos, updateTodoStatus, deleteTodo } from "@/lib/db";
import { embedText, getEmbeddingRef, type ResolvedEmbedding } from "@/lib/ai/embeddings";
import { runWebSearch } from "@/lib/ai/web-search";
import { APP_TIMEZONE } from "@/lib/datetime";
import { getFile, getVaultConfig } from "@/lib/vault/github";
import { searchVaultPages } from "@/lib/vault/store";
import { ingestToVault, writeVaultPage, type VaultCategory } from "@/lib/vault/ingest";
import { lintVault, type LintMode } from "@/lib/vault/lint";
import { deleteGraphPage } from "@/lib/vault/graph";

export async function executeTool(
    toolName: string,
    args: Record<string, unknown>,
    embRef: ResolvedEmbedding = getEmbeddingRef(),
    ctx?: ToolContext
): Promise<string> {

    const artifactResult = await executeArtifactTool(toolName, args, ctx, embRef);
    if (artifactResult !== null) return artifactResult;

    switch (toolName) {
        case "get_current_time":
            return executeGetCurrentTime(args.timezone as string | undefined);

        case "search_web":
            return runWebSearch(args.query as string);

        case "search_knowledge":
            return executeSearchKnowledge(args.query as string, embRef);

        case "save_note":
            return executeSaveNote(
                args.content as string,
                args.category as string | undefined,
                embRef
            );

        case "get_recent_conversations":
            return executeGetRecentConversations(args.limit as number | undefined);

        case "manage_calendar_event":
            return executeManageCalendarEvent(args);

        case "list_calendar_events":
            return executeListCalendarEvents(args.hours_ahead as number | undefined);

        case "list_unread_emails":
            return executeListUnreadEmails(args.max_results as number | undefined, args.query as string | undefined);

        case "list_recent_emails":
            return executeListRecentEmails(args.max_results as number | undefined, args.query as string | undefined);

        case "read_email":
            return executeReadEmail(args.message_id as string);

        case "draft_gmail_reply":
            return executeDraftGmailReply(args);

        case "send_email":
            return executeSendEmail(args);

        case "vault_search":
            return executeVaultSearch(args.query as string, embRef);

        case "vault_read":
            return executeVaultRead(args.path as string);

        case "vault_ingest":
            return executeVaultIngest(args, embRef);

        case "vault_write":
            return executeVaultWrite(args, embRef);

        case "vault_delete":
            return executeVaultDelete(args.path as string);

        case "vault_lint":
            return executeVaultLint(args.mode as LintMode | undefined, embRef);

        case "manage_todo_list":
            return executeManageTodoList(args);

        default:
            return `Unknown tool: ${toolName}`;
    }
}

async function executeGetCurrentTime(timezone?: string): Promise<string> {
    const tz = timezone ?? APP_TIMEZONE;
    const now = new Date().toLocaleString("en-AU", { timeZone: tz });
    return `Current time (${tz}): ${now}`;
}

async function executeSearchKnowledge(query: string, embRef: ResolvedEmbedding): Promise<string> {
    try {
        const embedding = await embedText(embRef, query, "query");
        const results = await searchEmbeddings({
            queryEmbedding: embedding,
            matchThreshold: 0.6,
            matchCount: 5,
            embeddingModel: embRef.model.id,
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
    category: string | undefined,
    embRef: ResolvedEmbedding
): Promise<string> {
    try {
        const embedding = await embedText(embRef, content);
        await storeEmbedding({
            content,
            embedding,
            embeddingModel: embRef.model.id,
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
        const emails = await listUnreadEmails(maxResults ?? 25, query);
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

async function executeListRecentEmails(
    maxResults?: number,
    query?: string
): Promise<string> {
    try {
        const emails = await listRecentEmails(maxResults ?? 25, query);
        if (emails.length === 0) {
            const filterNote = query ? ` matching "${query}"` : "";
            return `No recent emails${filterNote} in the inbox.`;
        }
        const filterNote = query ? ` (filter: ${query})` : " (last 7 days)";
        return `Found ${emails.length} recent email(s)${filterNote}:\n\n` + formatEmailSummary(emails, true);
    } catch (error) {
        console.error("[MCP] List recent emails failed:", error);
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

async function executeVaultSearch(query: string, embRef: ResolvedEmbedding): Promise<string> {
    if (!query) return "Error: query is required.";
    if (!getVaultConfig()) return "The second-brain vault is not configured.";

    try {
        const hits = await searchVaultPages({ query, embRef });
        if (hits.length === 0) {
            return "No vault pages matched. The topic may not have been ingested yet — check index.md via vault_read('index.md') if unsure.";
        }
        return hits
            .map((h) => `- ${h.path} (${h.category}, ${h.similarity.toFixed(2)}): ${h.title} — ${h.summary}`)
            .join("\n");
    } catch (error) {
        console.error("[MCP] Vault search failed:", error);
        return "Vault search is temporarily unavailable.";
    }
}

async function executeVaultRead(path: string): Promise<string> {
    if (!path) return "Error: path is required.";
    const cfg = getVaultConfig();
    if (!cfg) return "The second-brain vault is not configured.";

    try {
        const file = await getFile(cfg, path);
        if (!file) return `No page found at "${path}". Use vault_search or vault_read('index.md') to find valid paths.`;
        return file.text;
    } catch (error) {
        console.error("[MCP] Vault read failed:", error);
        return "Vault read is temporarily unavailable.";
    }
}

async function executeVaultIngest(
    args: Record<string, unknown>,
    embRef: ResolvedEmbedding
): Promise<string> {
    const title = (args.title as string | undefined)?.trim();
    const content = (args.content as string | undefined)?.trim();
    if (!title || !content) return "Error: title and content are both required.";
    if (!getVaultConfig()) return "The second-brain vault is not configured.";

    try {
        const result = await ingestToVault({
            title,
            content,
            category: args.category as VaultCategory | undefined,
            source: args.source as string | undefined,
            embRef,
        });
        const links = result.links.length
            ? `Linked (bidirectionally): ${result.links.map((l) => `${l.path} (${l.label})`).join(", ")}.`
            : "No related pages yet — this is a new area of the vault.";
        return `${result.updatedExisting ? "Updated" : "Created"} ${result.pagePath} (commit ${result.commit.slice(0, 7)}). Summary: ${result.summary} ${links}`;
    } catch (error) {
        console.error("[MCP] Vault ingest failed:", error);
        const message = error instanceof Error ? error.message : "";
        if (message.startsWith("Verification failed")) return message;
        return "Vault ingest failed — nothing was committed. Try again, or use vault_write if you already have the exact page content.";
    }
}

async function executeVaultWrite(
    args: Record<string, unknown>,
    embRef: ResolvedEmbedding
): Promise<string> {
    const path = (args.path as string | undefined)?.trim();
    const markdown = args.markdown as string | undefined;
    if (!path || !markdown?.trim()) return "Error: path and markdown are both required.";
    if (!getVaultConfig()) return "The second-brain vault is not configured.";

    try {
        const result = await writeVaultPage({
            path,
            markdown,
            summary: args.summary as string | undefined,
            embRef,
        });
        return `${result.created ? "Created" : "Updated"} ${result.pagePath} (commit ${result.commit.slice(0, 7)}). Index and log updated.`;
    } catch (error) {
        console.error("[MCP] Vault write failed:", error);
        const message = error instanceof Error ? error.message : "";
        if (message.startsWith("vault_write only")) return message;
        return "Vault write failed — nothing was committed.";
    }
}

async function executeVaultDelete(path: string): Promise<string> {
    const trimmed = path?.trim();
    if (!trimmed) return "Error: path is required.";
    if (!getVaultConfig()) return "The second-brain vault is not configured.";
    if (!/^wiki\/(sources|concepts|entities|synthesis)\/[a-z0-9-]+\.md$/.test(trimmed)) {
        return "vault_delete only removes wiki pages: path must look like wiki/<sources|concepts|entities|synthesis>/<page-name>.md.";
    }

    try {
        const result = await deleteGraphPage(trimmed);
        const cleaned = result.changedPages.length
            ? ` Unlinked from: ${result.changedPages.join(", ")}.`
            : "";
        return `Deleted ${trimmed} (commit ${result.commit.slice(0, 7)}). Index, log and search index updated.${cleaned}`;
    } catch (error) {
        console.error("[MCP] Vault delete failed:", error);
        const message = error instanceof Error ? error.message : "";
        if (message.startsWith("Page not found")) {
            return `No page found at "${trimmed}" — nothing was deleted. Use vault_read('index.md') to find valid paths.`;
        }
        return "Vault delete failed — nothing was removed.";
    }
}

async function executeVaultLint(mode: LintMode | undefined, embRef: ResolvedEmbedding): Promise<string> {
    if (!getVaultConfig()) return "The second-brain vault is not configured.";
    try {
        const result = await lintVault({ mode: mode === "auto" ? "auto" : "suggest", embRef });
        return result.report;
    } catch (error) {
        console.error("[MCP] Vault lint failed:", error);
        return "Vault lint failed — nothing was changed.";
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

function toGeminiSchema(param: McpToolParam): Record<string, unknown> {
    const typeMap: Record<string, Type> = {
        string: Type.STRING,
        number: Type.NUMBER,
        integer: Type.INTEGER,
        boolean: Type.BOOLEAN,
        array: Type.ARRAY,
        object: Type.OBJECT,
    };
    const schema: Record<string, unknown> = {
        type: typeMap[param.type] ?? Type.STRING,
        description: param.description,
    };
    if (param.enum) schema.enum = param.enum;
    if (param.type === "array" && param.items) schema.items = toGeminiSchema(param.items);
    if (param.type === "object" && param.properties) {
        schema.properties = Object.fromEntries(
            Object.entries(param.properties).map(([k, v]) => [k, toGeminiSchema(v)])
        );
        schema.required = Object.entries(param.properties).filter(([, v]) => v.required).map(([k]) => k);
    }
    return schema;
}

export function geminiDeclarationsFor(tools: McpTool[]) {
    return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: {
            type: Type.OBJECT as const,
            properties: Object.fromEntries(
                Object.entries(tool.parameters).map(([key, val]) => [key, toGeminiSchema(val)])
            ),
            required: Object.entries(tool.parameters)
                .filter(([, val]) => val.required)
                .map(([key]) => key),
        },
    }));
}

export type GeminiToolDeclarations = ReturnType<typeof geminiDeclarationsFor>;

export function buildGeminiFunctionDeclarations() {

    return geminiDeclarationsFor([...MCP_TOOLS, ...ARTIFACT_TOOLS]);
}

export interface OpenAITool {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, Record<string, unknown>>;
            required: string[];
        };
    };
}

function toOpenAISchema(param: McpToolParam): Record<string, unknown> {
    const schema: Record<string, unknown> = {
        type: param.type === "integer" ? "number" : param.type,
        description: param.description,
    };
    if (param.enum) schema.enum = param.enum;
    if (param.type === "array" && param.items) schema.items = toOpenAISchema(param.items);
    if (param.type === "object" && param.properties) {
        schema.properties = Object.fromEntries(
            Object.entries(param.properties).map(([k, v]) => [k, toOpenAISchema(v)])
        );
        schema.required = Object.entries(param.properties).filter(([, v]) => v.required).map(([k]) => k);
    }
    return schema;
}

export function buildOpenAIToolDeclarations(): OpenAITool[] {

    return [...MCP_TOOLS, ...ARTIFACT_TOOLS, WEB_SEARCH_TOOL].map((tool) => ({
        type: "function" as const,
        function: {
            name: tool.name,
            description: tool.description,
            parameters: {
                type: "object" as const,
                properties: Object.fromEntries(
                    Object.entries(tool.parameters).map(([key, val]) => [key, toOpenAISchema(val)])
                ),
                required: Object.entries(tool.parameters)
                    .filter(([, val]) => val.required)
                    .map(([key]) => key),
            },
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
