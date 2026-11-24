import { gateUnattendedTool, isUnattendedRun, recordUnattendedSource } from "@/lib/tasks/unattended-policy";
import { gateChatSend } from "@/lib/tasks/chat-approval";
import { proposeWithNotice } from "@/lib/tasks/approval-notices";
import { assertFreeModel, freeToolRefusal } from "@/lib/ai/model-policy";
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
import { supabaseAdmin } from "@/lib/supabase";
import { createBranchStore } from "@/lib/conversations/branch-store";
import { isolateBranchRecall } from "@/lib/conversations/branches";
import type { ArtifactDescriptor, CouncilProposal } from "@/lib/types";

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
    freeOnly?: boolean;
    conversationId?: string;
    userProfileId?: string;
    onArtifact?: (artifact: ArtifactDescriptor) => void;
    /** Only the web chat renders a proposal card; elsewhere the tool is a no-op. */
    onCouncilProposal?: (proposal: CouncilProposal) => void;
    /** Plain chat replies report their tool calls here; the agent loop emits its own events. */
    onTool?: (name: string, phase: "start" | "done") => void;
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
        depth: {
            type: "string",
            enum: ["quick", "thorough"],
            description: "'quick' (default) for a single fact or a current value - prices, weather, scores, dates, a name. 'thorough' for questions needing real source material: research, comparisons, how something works, anything you would want to read rather than glance at. 'thorough' is slower and costs more, so only pick it when snippets genuinely will not answer the question.",
            required: false,
        },
    },
};

export const COUNCIL_TOOLS: McpTool[] = [
    {
        name: "council_propose",
        description:
            "Draft a council for the user to start with one click: a debate between chat models from his selectable list, run on the server. This is the DEFAULT way to start a council in the web chat. It creates nothing - no session, no code - so a proposal he ignores costs him nothing. The proposal renders as a card under your reply with a Start button and he can change the models first; say what you proposed and why, and never invent a session code. Councils of coding agents on his computer now run in Converoom, not here.",
        parameters: {
            topic: { type: "string", description: "The question under debate, as one decidable question.", required: true },
            brief: { type: "string", description: "Context every seat needs: constraints, what has been tried, what a good answer looks like.", required: true },
            participants: {
                type: "array",
                description: "2-5 model seats. Name and modelKey are optional; leave them out (or send no participants) to auto-fill free models from different vendors.",
                required: false,
                items: {
                    type: "object",
                    description: "One seat.",
                    properties: {
                        name: { type: "string", description: "Seat name. Defaults to the model's short name." },
                        expertise: { type: "string", description: "One line on the angle this seat argues from." },
                        modelKey: { type: "string", description: "provider::model key from model_status. Leave it out to auto-fill." },
                    },
                },
            },
            closerName: { type: "string", description: "Which seat writes the verdict. Must be one of the seat names. Omit it and the first seat closes.", required: false },
            maxRounds: { type: "number", description: "Rounds before the verdict (2 to 8, default 4).", required: false },
            purpose: {
                type: "string",
                enum: ["research", "coding", "reasoning", "writing", "long-context", "multilingual", "agentic"],
                description: "What auto-fill picks models for. Defaults to reasoning.",
                required: false,
            },
            allowPaid: { type: "boolean", description: "Allow paid models. Set it only when he explicitly asks for paid models; Free only still wins.", required: false },
            research: {
                type: "object",
                description: "Research first: the server searches once before round 1 and every seat gets the results as numbered sources. Seats still have no tools. Leave it out for a plain debate.",
                required: false,
                properties: {
                    web: { type: "boolean", description: "One web search (1 Tavily credit). Turn it on when the question depends on current facts, prices, versions or recent events." },
                    notes: { type: "boolean", description: "Search his saved notes (and vault pages unless Free only is on). Only when he asks for his notes to be used: they go to every seat's provider." },
                    query: { type: "string", description: "A sharper search query. Defaults to the topic." },
                },
            },
        },
    },
    {
        name: "council_convene",
        description:
            "Start a council right away: a debate between chat models from his selectable list, run on the server, and return its code. It keeps going if he closes the app. Use it outside the web chat (Telegram, Discord) or when he asks to start one now; in the web chat prefer council_propose. Councils of coding agents on his computer now run in Converoom, not here. Do NOT use to record a conclusion he already holds; use save_note or vault_ingest for that.",
        parameters: {
            topic: { type: "string", description: "The question under debate, as one decidable question.", required: true },
            brief: { type: "string", description: "Context every seat needs: constraints, what has been tried, what a good answer looks like.", required: true },
            participants: {
                type: "array",
                description: "2-5 model seats. Name and modelKey are optional; leave them out (or send no participants) to auto-fill free models from different vendors.",
                required: false,
                items: {
                    type: "object",
                    description: "One seat.",
                    properties: {
                        name: { type: "string", description: "Seat name. Defaults to the model's short name." },
                        expertise: { type: "string", description: "One line on the angle this seat argues from." },
                        modelKey: { type: "string", description: "provider::model key from model_status. Leave it out to auto-fill." },
                    },
                },
            },
            closerName: { type: "string", description: "Which seat writes the verdict. Must be one of the seat names. Omit it and the first seat closes.", required: false },
            maxRounds: { type: "number", description: "Rounds before the verdict (2 to 8, default 4).", required: false },
            purpose: {
                type: "string",
                enum: ["research", "coding", "reasoning", "writing", "long-context", "multilingual", "agentic"],
                description: "What auto-fill picks models for. Defaults to reasoning.",
                required: false,
            },
            allowPaid: { type: "boolean", description: "Allow paid models. Set it only when he explicitly asks for paid models; Free only still wins.", required: false },
            research: {
                type: "object",
                description: "Research first: the server searches once before round 1 and every seat gets the results as numbered sources. Seats still have no tools. Leave it out for a plain debate.",
                required: false,
                properties: {
                    web: { type: "boolean", description: "One web search (1 Tavily credit). Turn it on when the question depends on current facts, prices, versions or recent events." },
                    notes: { type: "boolean", description: "Search his saved notes (and vault pages unless Free only is on). Only when he asks for his notes to be used: they go to every seat's provider." },
                    query: { type: "string", description: "A sharper search query. Defaults to the topic." },
                },
            },
        },
    },
    {
        name: "council_status",
        description:
            "Check on running councils. With no sessionCode, lists every open council with who it is waiting on and how long they have been quiet. With one, gives that council's state and recent transcript. Use when the user asks how a council is going or what his agents are up to.",
        parameters: {
            sessionCode: { type: "string", description: "Optional session code, e.g. 'CN-4KQ2'. Omit to list all open councils.", required: false },
        },
    },
    {
        name: "model_status",
        description:
            "Report the health of the chat models: the last daily model check, models that are failing, missing, unreliable or slow, profile drafts waiting for review, and the best free picks for a purpose. Calls no model. Use when the user asks which models are slow, broken or best for something.",
        parameters: {
            show: { type: "string", enum: ["problems", "all", "drafts"], description: "problems (default): what needs attention; all: also counts by speed; drafts: profiles waiting for review.", required: false },
            purpose: { type: "string", enum: ["research", "coding", "reasoning", "writing", "vision", "long-context", "multilingual", "agentic"], description: "Optional purpose tag for the top three free picks.", required: false },
        },
    },
    {
        name: "council_close",
        description:
            "Owner override: force a council closed and file the outcome, even if its closer never concluded. Writes a verdict from the transcript when none is supplied. Use when he says to close, stop, kill or retire a council.",
        parameters: {
            sessionCode: { type: "string", description: "Session code to close, e.g. 'CN-4KQ2'.", required: true },
            verdict: { type: "string", description: "Optional verdict text. Omitted, one is written from the transcript.", required: false },
        },
    },
];

export const MCP_TOOLS: McpTool[] = [
    ...COUNCIL_TOOLS,
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
        name: "search_history",
        description: "Search the user's past chat messages semantically (\"when did we talk about X?\", \"what did I say about Y?\"). Returns matching message snippets with links that open the conversation. Use search_knowledge for saved notes and documents instead.",
        parameters: {
            query: {
                type: "string",
                description: "What to look for in past conversations.",
                required: true,
            },
        },
    },
    {
        name: "save_note",
        description: "Save a note or piece of information for the user to remember later. For actionable tasks or reminders use manage_todo_list instead - those show up in the user's Notes checklist where they can tick them off.",
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
        name: "capture_add",
        description: "Save a link or a passage to the user's Capture inbox, where the user reviews it later and files it into the knowledge vault. Use only when the user asks to save, capture or keep something for later reading or review. Do not use it for reminders, tasks or personal notes (use manage_todo_list or save_note). Returns a link that opens the capture's review.",
        parameters: {
            kind: {
                type: "string",
                enum: ["link", "text"],
                description: "'link' for a web page or PDF URL, 'text' for a passage or note.",
                required: true,
            },
            title: {
                type: "string",
                description: "A short title, up to 200 characters.",
                required: true,
            },
            url: {
                type: "string",
                description: "The http or https URL. Required for kind 'link'.",
                required: false,
            },
            text: {
                type: "string",
                description: "The passage for kind 'text'. For a link, optional notes from the user.",
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
        description: "List upcoming Google Calendar events. Returns events within the next N hours. Each event includes its Event ID, which you can use with manage_calendar_event action='delete' to delete it. Event IDs are internal - never include them when relaying events to the user.",
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
        description: "Directly create or overwrite ONE vault wiki page with markdown you have already written - for corrections or deliberate edits after vault_read. Prefer vault_ingest for new knowledge (it handles synthesis and auto-linking). The catalogue and log update automatically. This tool cannot remove a page - to delete one call vault_delete; NEVER overwrite a page with a 'DELETE'/'redirect' marker.",
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
        description: "Permanently delete ONE vault wiki page and everything pointing at it: wikilinks in other pages, its catalogue entry, and its search-index row, in one commit (the immutable raw/ capture and git history are kept). Use when a page is redundant - e.g. after merging duplicates - or the user asks to remove it. This is the ONLY way to remove a page; never mark one as deleted with vault_write.",
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
        description: "Manage the user's to-do list. Actions: 'add' (create a task), 'list' (view tasks), 'complete' (mark as done), 'delete' (remove a task). Open tasks appear as a checklist in the web app's Notes panel, where the user can tick them off themselves - a task marked done there is finished; never remind the user about it again.",
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
    {
        name: "manage_scheduled_task",
        description: "Schedule the assistant to run an instruction later or on a recurring schedule and deliver the result (e.g. 'every weekday at 8am send me a workout reminder on telegram'). Actions: 'create', 'list', 'update', 'delete', 'enable', 'disable'. Recurring tasks use a 5-field cron expression evaluated in the user's timezone; one-off tasks use run_at. Channel 'web' delivers into the current conversation. Always tell the user the next run time from the tool result. This schedules future runs - for a to-do list item use manage_todo_list instead.",
        parameters: {
            action: {
                type: "string",
                description: "Action: 'create', 'list', 'update', 'delete', 'enable', or 'disable'.",
                required: true,
                enum: ["create", "list", "update", "delete", "enable", "disable"],
            },
            title: {
                type: "string",
                description: "Short task name (required for create), e.g. 'Morning workout reminder'.",
                required: false,
            },
            instruction: {
                type: "string",
                description: "The full instruction the assistant will execute on each run (required for create). Write it as a self-contained request.",
                required: false,
            },
            schedule_type: {
                type: "string",
                description: "'recurring' (needs cron) or 'once' (needs run_at). Required for create.",
                required: false,
                enum: ["once", "recurring"],
            },
            cron: {
                type: "string",
                description: "5-field cron 'minute hour day-of-month month day-of-week' in the user's timezone, e.g. '0 8 * * 1-5' for weekdays 8am.",
                required: false,
            },
            run_at: {
                type: "string",
                description: "ISO 8601 datetime for one-off tasks, e.g. '2026-07-10T09:00:00+10:00'.",
                required: false,
            },
            channel: {
                type: "string",
                description: "Where to deliver the result: 'telegram' (default), 'discord', or 'web' (into the current conversation).",
                required: false,
                enum: ["telegram", "discord", "web"],
            },
            agent_mode: {
                type: "boolean",
                description: "Run the instruction as a full agent task (multi-step research/tools). Only for tasks that genuinely need it - agent runs are slow and expensive.",
                required: false,
            },
            task_id: {
                type: "string",
                description: "Task ID (required for update/delete/enable/disable).",
                required: false,
            },
        },
    },
    {
        name: "manage_memory_facts",
        description: "Manage the extracted long-term memory facts (the Known Facts). Actions: 'list' (what is remembered, optionally by category), 'forget' (delete a fact the user wants gone), 'correct' (replace a fact's text with what the user says is right). Use when the user asks what you remember about them, or says to forget or fix something. New facts are extracted automatically from conversation - to explicitly save something, use save_note instead.",
        parameters: {
            action: {
                type: "string",
                description: "Action: 'list', 'forget', or 'correct'.",
                required: true,
                enum: ["list", "forget", "correct"],
            },
            category: {
                type: "string",
                description: "Filter for list: identity, preference, relationship, project, routine, fact, or other.",
                required: false,
                enum: ["identity", "preference", "relationship", "project", "routine", "fact", "other"],
            },
            fact_id: {
                type: "string",
                description: "Fact ID (required for forget/correct) - from a previous list result.",
                required: false,
            },
            fact: {
                type: "string",
                description: "The corrected fact text (required for correct).",
                required: false,
            },
        },
    },
    {
        name: "manage_notes",
        description: "Manage saved knowledge-base notes (the ones created with save_note). Actions: 'list' (browse newest-first, optionally by category), 'update' (rewrite a note's text and/or re-categorize - use for stale plans or project info instead of saving a duplicate), 'delete' (remove a note). Only touches saved notes, never conversation history.",
        parameters: {
            action: {
                type: "string",
                description: "Action: 'list', 'update', or 'delete'.",
                required: true,
                enum: ["list", "update", "delete"],
            },
            category: {
                type: "string",
                description: "Filter for list: the category tag notes were saved with (e.g. project, plan, study, idea, general).",
                required: false,
            },
            note_id: {
                type: "string",
                description: "Note ID (required for update/delete) - from a previous list result.",
                required: false,
            },
            content: {
                type: "string",
                description: "Replacement note text (for update).",
                required: false,
            },
            new_category: {
                type: "string",
                description: "New category tag (for update).",
                required: false,
            },
        },
    },
];

import {
    searchEmbeddings, hybridSearchKnowledge, storeEmbedding, getRecentMessages,
    listKnowledgeNotes, updateKnowledgeNote, deleteKnowledgeNote,
    addTodo, listTodos, updateTodoStatus, deleteTodo,
} from "@/lib/db";
import { embedText, getEmbeddingRef, type ResolvedEmbedding } from "@/lib/ai/embeddings";
import { similarityCutoffs } from "@/lib/ai/embedding-cutoffs";
import { refreshEmbeddingOverride } from "@/lib/ai/embedding-override";
import { runWebSearch } from "@/lib/ai/web-search";
import { APP_TIMEZONE } from "@/lib/datetime";
import { getFile, getVaultConfig } from "@/lib/vault/github";
import { searchVaultPages, vaultEmbeddingRef } from "@/lib/vault/store";
import { ingestToVault, writeVaultPage, type VaultCategory } from "@/lib/vault/ingest";
import { lintVault, type LintMode } from "@/lib/vault/lint";
import { deleteGraphPage } from "@/lib/vault/graph";
import {
    createScheduledTask, listScheduledTasks, updateScheduledTask, deleteScheduledTask,
    type ScheduledTask, type TaskChannel,
} from "@/lib/tasks/store";
import { validateCron, describeNextRun } from "@/lib/tasks/schedule";
import { listMemories, deleteMemory, updateMemoryFact, PROMOTE_EVIDENCE_COUNT } from "@/lib/ai/memory/store";
import { addModelDataClasses, withModelDataClasses } from "@/lib/ai/model-observations";
import { recordAskedTool, recordFetchedContent, recordReplySources } from "@/lib/ai/reply-sources";
import { executeCaptureAdd } from "@/lib/capture/chat-tool";
import { currentRoster } from "@/lib/ai/models/roster";
import { formatModelStatus } from "@/lib/ai/models/status";
import { isPurposeTag } from "@/lib/ai/models/tags";
import { readResearchRequest } from "@/lib/council/online/research";
import { listDiscoveryRuns } from "@/lib/ai/catalogue/store";
import { catalogueSnapshot } from "@/lib/ai/catalogue/snapshot";

export async function executeTool(
    toolName: string, args: Record<string, unknown>, embRef?: ResolvedEmbedding, ctx?: ToolContext,
): Promise<string> {
    const pending = await gateUnattendedTool(toolName, args, proposeWithNotice);
    if (pending) { recordAskedTool(toolName); return pending; }
    // An approved action runs under the unattended permit, which already authorised it.
    const held = isUnattendedRun() ? null : await gateChatSend(toolName, args);
    if (held) { recordAskedTool(toolName); return held; }
    recordReplySources([{ kind: toolName === "search_web" ? "web" : "tool", label: toolName, ref: toolName, weight: 0.5 }]);
    const knowledgeTool = ["search_knowledge", "vault_read", "vault_search", "vault_ingest", "vault_write", "vault_lint", "save_note"].includes(toolName);
    const knowledgePayload = ["vault_ingest", "vault_write", "vault_lint", "save_note"].includes(toolName);
    const result = await (knowledgePayload ? withModelDataClasses(["knowledge"], () => dispatchTool(toolName, args, embRef, ctx)) : dispatchTool(toolName, args, embRef, ctx));
    if (knowledgeTool) addModelDataClasses(["knowledge"]);
    if (toolName === "search_web") addModelDataClasses(["public_search"]);
    recordUnattendedSource(toolName, result, args);
    recordFetchedContent(toolName, result);
    return result;
}

async function dispatchTool(
    toolName: string, args: Record<string, unknown>, embRef?: ResolvedEmbedding, ctx?: ToolContext,
): Promise<string> {
    const refusal = freeToolRefusal(toolName, ctx?.freeOnly);
    if (refusal) return refusal;
    // Resolve the default ref only after the runtime partition override is
    // known - a default-param getEmbeddingRef() would run before the await.
    await refreshEmbeddingOverride(undefined, ctx?.freeOnly);
    embRef = embRef ?? getEmbeddingRef();
    if (ctx?.freeOnly) assertFreeModel(embRef);

    const artifactResult = await executeArtifactTool(toolName, args, ctx, embRef);
    if (artifactResult !== null) return artifactResult;

    switch (toolName) {
        case "get_current_time":
            return executeGetCurrentTime(args.timezone as string | undefined);

        case "search_web":
            return runWebSearch(args.query as string, args.depth === "thorough" ? "thorough" : "quick");

        case "council_propose":
            return executeCouncilPropose(args, ctx);
        case "council_convene":
            return executeCouncilConvene(args);
        case "council_status":
            return executeCouncilStatus(args.sessionCode as string | undefined);
        case "council_close":
            return executeCouncilClose(args.sessionCode as string, args.verdict as string | undefined);
        case "model_status":
            return executeModelStatus(args, ctx);

        case "search_knowledge":
            return executeSearchKnowledge(args.query as string, embRef, ctx);
        case "search_history":
            return executeSearchHistory(args.query as string, embRef, ctx);

        case "save_note":
            return executeSaveNote(
                args.content as string,
                args.category as string | undefined,
                embRef
            );

        case "capture_add":
            return executeCaptureAdd(args, { userProfileId: ctx?.userProfileId });

        case "get_recent_conversations":
            return executeGetRecentConversations(args.limit as number | undefined, ctx);

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

        // Vault tools resolve the vault's majority partition instead of the
        // turn ref: pages embed with whatever model was active at ingest, and
        // searching or writing in another partition misses/fragments them.
        case "vault_search":
            return executeVaultSearch(args.query as string, await vaultEmbeddingRef(), ctx?.freeOnly === true);

        case "vault_read":
            return executeVaultRead(args.path as string);

        case "vault_ingest":
            return executeVaultIngest(args, await vaultEmbeddingRef());

        case "vault_write":
            return executeVaultWrite(args, await vaultEmbeddingRef());

        case "vault_delete":
            return executeVaultDelete(args.path as string);

        case "vault_lint":
            return executeVaultLint(args.mode as LintMode | undefined, await vaultEmbeddingRef());

        case "manage_todo_list":
            return executeManageTodoList(args);

        case "manage_scheduled_task":
            return executeManageScheduledTask(args, ctx);

        case "manage_memory_facts":
            return executeManageMemoryFacts(args);

        case "manage_notes":
            return executeManageNotes(args);

        default:
            return `Unknown tool: ${toolName}`;
    }
}

async function executeGetCurrentTime(timezone?: string): Promise<string> {
    const tz = timezone ?? APP_TIMEZONE;
    const now = new Date().toLocaleString("en-AU", { timeZone: tz });
    return `Current time (${tz}): ${now}`;
}

async function scopeConversationRecall<T extends { metadata?: Record<string, string> }>(results: T[], ctx?: ToolContext): Promise<T[]> {
    if (!ctx?.conversationId || !results.some((result) => result.metadata?.source === "user_message" || result.metadata?.conversationId)) return results;
    if (!ctx.userProfileId) throw new Error("Conversation owner is unavailable for history recall.");
    const branched = await createBranchStore(supabaseAdmin).isBranch(ctx.conversationId, ctx.userProfileId);
    return isolateBranchRecall(results, ctx.conversationId, branched);
}

async function executeSearchKnowledge(query: string, embRef: ResolvedEmbedding, ctx?: ToolContext): Promise<string> {
    try {
        const embedding = await embedText(embRef, query, "query");
        const results = await hybridSearchKnowledge({
            queryEmbedding: embedding,
            queryText: query,
            matchCount: 5,
            embeddingModel: embRef.model.id,
        }) ?? await searchEmbeddings({
            queryEmbedding: embedding,
            matchThreshold: similarityCutoffs(embRef.model).toolNotes,
            matchCount: 5,
            embeddingModel: embRef.model.id,
        });

        const scoped = await scopeConversationRecall(results, ctx);
        if (scoped.length === 0) {
            return "No relevant knowledge found.";
        }

        return scoped
            .map((r, i) => `[${i + 1}] ${r.content}`)
            .join("\n");
    } catch (error) {
        console.error("[MCP] Knowledge search failed:", error);
        return "Knowledge search is temporarily unavailable.";
    }
}

async function executeSearchHistory(query: string, embRef: ResolvedEmbedding, ctx?: ToolContext): Promise<string> {
    try {
        const embedding = await embedText(embRef, query, "query");
        // The store mixes notes/documents in; overfetch then keep messages only.
        const results = await hybridSearchKnowledge({
            queryEmbedding: embedding,
            queryText: query,
            matchCount: 20,
            embeddingModel: embRef.model.id,
        }) ?? await searchEmbeddings({
            queryEmbedding: embedding,
            matchThreshold: similarityCutoffs(embRef.model).toolHistory,
            matchCount: 20,
            embeddingModel: embRef.model.id,
        });

        const hits = (await scopeConversationRecall(results, ctx))
            .filter((r) => r.metadata?.source === "user_message")
            .slice(0, 5);

        if (hits.length === 0) {
            return "No matching past messages found.";
        }

        // Rows embedded before conversation linking exist without a link.
        return hits
            .map((r, i) => {
                const channel = r.metadata?.channel ? ` (${r.metadata.channel})` : "";
                const link = r.metadata?.conversationId
                    ? ` [open](/?c=${r.metadata.conversationId})`
                    : "";
                return `[${i + 1}]${channel} ${r.content.slice(0, 300)}${link}`;
            })
            .join("\n");
    } catch (error) {
        console.error("[MCP] History search failed:", error);
        return "History search is temporarily unavailable.";
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
    limit?: number, ctx?: ToolContext
): Promise<string> {
    try {
        if (ctx?.conversationId && !ctx.userProfileId) throw new Error("Conversation owner is unavailable for history recall.");
        const branched = ctx?.conversationId && ctx.userProfileId
            ? await createBranchStore(supabaseAdmin).isBranch(ctx.conversationId, ctx.userProfileId) : false;
        const messages = await getRecentMessages(limit ?? 10, undefined, branched ? ctx?.conversationId : undefined);
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

        return `✅ Event created: "${created.summary}" on ${timeStr}${created.location ? ` at ${created.location}` : ""}.`;
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
        return "Upcoming events:\n" + formatEventsSummary(events, { withIds: true });
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

async function executeVaultSearch(query: string, embRef: ResolvedEmbedding, freeOnly: boolean): Promise<string> {
    if (!query) return "Error: query is required.";
    if (!getVaultConfig()) return "The second-brain vault is not configured.";

    try {
        const hits = await searchVaultPages({ query, embRef, hybrid: true, onePerPage: true, rerank: { freeOnly } });
        if (hits.length === 0) {
            return "No vault pages matched. The topic may not have been ingested yet - check index.md via vault_read('index.md') if unsure.";
        }
        return hits
            .map((h) => `- ${h.path} (${h.category}, ${h.similarity.toFixed(2)}): ${h.title} - ${h.summary}`)
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
            : "No related pages yet - this is a new area of the vault.";
        return `${result.updatedExisting ? "Updated" : "Created"} ${result.pagePath} (commit ${result.commit.slice(0, 7)}). Summary: ${result.summary} ${links}`;
    } catch (error) {
        console.error("[MCP] Vault ingest failed:", error);
        const message = error instanceof Error ? error.message : "";
        if (message.startsWith("Verification failed")) return message;
        return "Vault ingest failed - nothing was committed. Try again, or use vault_write if you already have the exact page content.";
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
        return "Vault write failed - nothing was committed.";
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
            return `No page found at "${trimmed}" - nothing was deleted. Use vault_read('index.md') to find valid paths.`;
        }
        return "Vault delete failed - nothing was removed.";
    }
}

async function executeVaultLint(mode: LintMode | undefined, embRef: ResolvedEmbedding): Promise<string> {
    if (!getVaultConfig()) return "The second-brain vault is not configured.";
    try {
        const result = await lintVault({ mode: mode === "auto" ? "auto" : "suggest", embRef });
        return result.report;
    } catch (error) {
        console.error("[MCP] Vault lint failed:", error);
        return "Vault lint failed - nothing was changed.";
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

function formatTask(t: ScheduledTask): string {
    const schedule = t.scheduleType === "recurring" ? `cron ${t.cron}` : `once at ${t.runAt}`;
    const state = t.enabled ? describeNextRun(t.nextRunAt, t.timezone) : "disabled";
    const last = t.lastStatus ? `, last run ${t.lastStatus}` : "";
    return `- "${t.title}" (${schedule}, ${t.channel}${t.agentMode ? ", agent" : ""}) - ${state}${last} [id: ${t.id}]`;
}

async function executeManageScheduledTask(
    args: Record<string, unknown>,
    ctx?: ToolContext
): Promise<string> {
    const action = (args.action as string) ?? "list";
    const taskId = args.task_id as string | undefined;

    try {
        switch (action) {
            case "create": {
                const title = (args.title as string | undefined)?.trim();
                const instruction = (args.instruction as string | undefined)?.trim();
                const scheduleType = args.schedule_type as "once" | "recurring" | undefined;
                if (!title || !instruction) return "Error: title and instruction are required to create a task.";
                if (scheduleType !== "once" && scheduleType !== "recurring") {
                    return "Error: schedule_type must be 'once' (with run_at) or 'recurring' (with cron).";
                }

                const cron = (args.cron as string | undefined)?.trim();
                const runAt = (args.run_at as string | undefined)?.trim();
                if (scheduleType === "recurring") {
                    if (!cron) return "Error: a recurring task needs a 5-field cron expression.";
                    const cronError = validateCron(cron);
                    if (cronError) return `Error: ${cronError}`;
                } else {
                    if (!runAt || isNaN(Date.parse(runAt))) return "Error: a one-off task needs a valid ISO run_at datetime.";
                    if (new Date(runAt) <= new Date()) return "Error: run_at is in the past - pick a future time.";
                }

                const channel = (args.channel as TaskChannel | undefined) ?? "telegram";
                if (channel === "web" && !ctx?.conversationId) {
                    return "Error: channel 'web' delivers into the current conversation, which is unavailable here. Use 'telegram' or 'discord' instead.";
                }

                const task = await createScheduledTask({
                    title,
                    instruction,
                    scheduleType,
                    cron,
                    runAt,
                    channel,
                    conversationId: channel === "web" ? ctx?.conversationId : undefined,
                    agentMode: args.agent_mode === true,
                    userProfileId: ctx?.userProfileId,
                });
                return `✅ Scheduled "${task.title}" (${task.channel}${task.agentMode ? ", agent mode" : ""}) - ${describeNextRun(task.nextRunAt, task.timezone)}. Task id: ${task.id}`;
            }

            case "list": {
                const tasks = await listScheduledTasks();
                if (tasks.length === 0) return "No scheduled tasks yet.";
                return `Scheduled tasks:\n${tasks.map(formatTask).join("\n")}`;
            }

            case "update": {
                if (!taskId) return "Error: task_id is required to update a task.";
                const cron = (args.cron as string | undefined)?.trim();
                if (cron) {
                    const cronError = validateCron(cron);
                    if (cronError) return `Error: ${cronError}`;
                }
                const runAt = (args.run_at as string | undefined)?.trim();
                if (runAt && isNaN(Date.parse(runAt))) return "Error: run_at must be a valid ISO datetime.";

                const task = await updateScheduledTask(taskId, {
                    ...(args.title !== undefined && { title: args.title as string }),
                    ...(args.instruction !== undefined && { instruction: args.instruction as string }),
                    ...(args.schedule_type !== undefined && { scheduleType: args.schedule_type as "once" | "recurring" }),
                    ...(cron !== undefined && { cron }),
                    ...(runAt !== undefined && { runAt }),
                    ...(args.channel !== undefined && { channel: args.channel as TaskChannel }),
                    ...(args.agent_mode !== undefined && { agentMode: args.agent_mode === true }),
                });
                if (!task) return "Failed to update - check the task_id with action 'list'.";
                return `✅ Updated "${task.title}" - ${task.enabled ? describeNextRun(task.nextRunAt, task.timezone) : "still disabled"}.`;
            }

            case "delete": {
                if (!taskId) return "Error: task_id is required to delete a task.";
                const ok = await deleteScheduledTask(taskId);
                return ok ? "🗑️ Scheduled task deleted." : "Failed to delete - check the task_id with action 'list'.";
            }

            case "enable":
            case "disable": {
                if (!taskId) return `Error: task_id is required to ${action} a task.`;
                const task = await updateScheduledTask(taskId, { enabled: action === "enable" });
                if (!task) return "Failed - check the task_id with action 'list'.";
                return action === "enable"
                    ? `✅ Enabled "${task.title}" - ${describeNextRun(task.nextRunAt, task.timezone)}.`
                    : `⏸ Disabled "${task.title}".`;
            }

            default:
                return `Unknown action: ${action}. Use 'create', 'list', 'update', 'delete', 'enable', or 'disable'.`;
        }
    } catch (error) {
        console.error("[MCP] Scheduled task failed:", error);
        return "Failed to manage scheduled tasks.";
    }
}

async function executeManageMemoryFacts(
    args: Record<string, unknown>,
): Promise<string> {
    const action = (args.action as string) ?? "list";
    const factId = args.fact_id as string | undefined;

    try {
        switch (action) {
            case "list": {
                const category = args.category as string | undefined;
                const facts = await listMemories(50, category);
                if (facts.length === 0) return category ? `No ${category} facts remembered yet.` : "No facts remembered yet.";
                const formatted = facts
                    .map((f) => `- [${f.category}${f.projectId ? ", project" : ""}${f.status === "candidate" ? `, unconfirmed pattern ${f.evidenceCount}/${PROMOTE_EVIDENCE_COUNT}` : ""}] ${f.fact}\n  _ID: ${f.id}_`)
                    .join("\n");
                return `Known facts (${facts.length}):\n${formatted}`;
            }

            case "forget": {
                if (!factId) return "Error: fact_id is required to forget a fact - list them first.";
                const ok = await deleteMemory(factId);
                return ok ? "🗑️ Fact forgotten." : "Failed to delete - check the fact_id with action 'list'.";
            }

            case "correct": {
                const fact = (args.fact as string | undefined)?.trim();
                if (!factId || !fact) return "Error: fact_id and the corrected fact text are both required.";
                const ok = await updateMemoryFact({ id: factId, fact });
                return ok ? `✅ Fact updated to: "${fact}"` : "Failed to update - check the fact_id with action 'list'.";
            }

            default:
                return `Unknown action: ${action}. Use 'list', 'forget', or 'correct'.`;
        }
    } catch (error) {
        console.error("[MCP] Memory facts failed:", error);
        return "Failed to manage memory facts.";
    }
}

async function executeManageNotes(args: Record<string, unknown>): Promise<string> {
    const action = (args.action as string) ?? "list";
    const noteId = args.note_id as string | undefined;

    try {
        switch (action) {
            case "list": {
                const category = args.category as string | undefined;
                const notes = await listKnowledgeNotes({ category });
                if (notes.length === 0) return category ? `No notes with category '${category}'.` : "No notes saved yet.";
                const formatted = notes
                    .map((n) => `- [${n.metadata?.category ?? "general"}, ${n.createdAt.slice(0, 10)}] ${n.content.slice(0, 300)}\n  _ID: ${n.id}_`)
                    .join("\n");
                return `Saved notes (${notes.length}):\n${formatted}`;
            }

            case "update": {
                const content = (args.content as string | undefined)?.trim();
                const newCategory = (args.new_category as string | undefined)?.trim();
                if (!noteId) return "Error: note_id is required to update - list notes first.";
                if (!content && !newCategory) return "Error: provide content and/or new_category to change.";
                // Re-embed in the default partition so edited notes land in the
                // shared store regardless of the turn's embedding selection.
                const embRef = getEmbeddingRef();
                const embedding = content ? await embedText(embRef, content) : undefined;
                const ok = await updateKnowledgeNote({
                    id: noteId,
                    content,
                    embedding,
                    embeddingModel: embRef.model.id,
                    category: newCategory,
                });
                return ok ? "✅ Note updated." : "Failed to update - check the note_id with action 'list'.";
            }

            case "delete": {
                if (!noteId) return "Error: note_id is required to delete - list notes first.";
                const ok = await deleteKnowledgeNote(noteId);
                return ok ? "🗑️ Note deleted." : "Failed to delete - check the note_id with action 'list'.";
            }

            default:
                return `Unknown action: ${action}. Use 'list', 'update', or 'delete'.`;
        }
    } catch (error) {
        console.error("[MCP] Manage notes failed:", error);
        return "Failed to manage notes.";
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

// Tools with no external effect. Two callers depend on this: the agent loop
// schedules these concurrently and serialises everything else, and worker
// sub-agents are allowed nothing outside it. Unlisted names count as writes, so
// a tool added later is serialised and withheld until somebody classifies it.
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
    "get_current_time", "search_web", "search_knowledge", "search_history",
    "get_recent_conversations", "list_calendar_events", "list_unread_emails",
    "list_recent_emails", "read_email", "vault_search", "vault_read", "council_status", "model_status",
]);

// Returned instead of running a tool the caller is not allowed to use. Phrased
// as an instruction because the model reads it and has to do something next.
export function toolRefusal(name: string): string {
    return `Refused: "${name}" is not available on this run. Report what you have and let the lead agent act on it.`;
}

export function buildOpenAIToolDeclarations(allow?: ReadonlySet<string>): OpenAITool[] {

    return [...MCP_TOOLS, ...ARTIFACT_TOOLS, WEB_SEARCH_TOOL].filter((t) => !allow || allow.has(t.name)).map((tool) => ({
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

// --- zuychin-council: the user starts, checks and closes councils from chat. ---

const ONLINE_PURPOSES = ["research", "coding", "reasoning", "writing", "long-context", "multilingual", "agentic"] as const;

async function onlineSeatsFromArgs(args: Record<string, unknown>) {
    const { chatSeats, checkOnlineSeats } = await import("@/lib/council/online/service");
    const purpose = (ONLINE_PURPOSES as readonly string[]).includes(String(args.purpose)) ? args.purpose as typeof ONLINE_PURPOSES[number] : "reasoning";
    const assembled = chatSeats(args.participants, purpose);
    if (!assembled.ok) return { ok: false as const, error: assembled.error };
    const allowPaid = args.allowPaid === true;
    const checked = await checkOnlineSeats(assembled.seats, allowPaid);
    if (!checked.ok) return { ok: false as const, error: checked.error };
    const wanted = String(args.closerName ?? "").trim().toLowerCase();
    const closer = (wanted && checked.seats.find((seat) => seat.name.toLowerCase() === wanted)) || checked.seats[0];
    return { ok: true as const, seats: checked.seats, closer, allowPaid, purpose, research: readResearchRequest(args.research) };
}

function researchPhrase(research: ReturnType<typeof readResearchRequest>): string {
    if (!research) return "";
    const what = [research.web ? "the web" : "", research.notes ? "his notes" : ""].filter(Boolean).join(" and ");
    return ` It searches ${what}${research.query ? ` for "${research.query}"` : " for the topic"} before round 1.`;
}

async function executeOnlinePropose(args: Record<string, unknown>, onCouncilProposal: NonNullable<ToolContext["onCouncilProposal"]>): Promise<string> {
    const topic = String(args.topic ?? "").trim();
    const brief = String(args.brief ?? "").trim();
    if (!topic) return "A council needs a topic. Nothing was proposed.";
    if (!brief) return "A council needs a brief. Nothing was proposed.";
    const built = await onlineSeatsFromArgs(args);
    if (!built.ok) return `${built.error} Nothing was proposed.`;
    const maxRounds = typeof args.maxRounds === "number" && args.maxRounds > 0 ? Math.floor(args.maxRounds) : undefined;
    onCouncilProposal({
        topic, brief, councilType: "debate", closerName: built.closer.name, online: true, allowPaid: built.allowPaid, purpose: built.purpose,
        participants: built.seats.map((seat) => ({ name: seat.name, expertise: seat.expertise, modelKey: seat.modelKey, source: seat.source })),
        ...(maxRounds ? { maxRounds } : {}),
        ...(built.research ? { research: built.research } : {}),
    });
    return `Proposed a council on "${topic}" with ${built.seats.map((seat) => `${seat.name} (${seat.resolved.model.label})`).join(", ")}, closed by ${built.closer.name}.${researchPhrase(built.research)} `
        + "The card is under your reply with a Start button; he can change the models first. Nothing has been created and there is no session code yet; "
        + "summarise what you proposed and stop.";
}

async function executeOnlineConvene(args: Record<string, unknown>): Promise<string> {
    const { startOnlineCouncil } = await import("@/lib/council/online/service");
    const { ownerLink } = await import("@/lib/public-url");
    const built = await onlineSeatsFromArgs(args);
    if (!built.ok) return `${built.error} Nothing was created.`;
    const result = await startOnlineCouncil({
        topic: String(args.topic ?? ""), brief: String(args.brief ?? ""), closerName: built.closer.name,
        maxRounds: typeof args.maxRounds === "number" ? args.maxRounds : undefined, allowPaid: built.allowPaid,
        seats: built.seats.map((seat) => ({ modelKey: seat.modelKey, name: seat.name, expertise: seat.expertise, source: seat.source })),
        research: built.research,
    });
    if (!result.ok) return result.error;
    const { describeResearch } = await import("@/lib/council/online/research");
    const sources = result.research ? `${describeResearch(result.research)} ` : "";
    return `Council ${result.code} is running on the server: ${result.seats.map((seat) => `${seat.name} (${seat.label}${seat.paid ? ", paid" : ""})`).join(", ")}. ${sources}`
        + `${result.closerName} writes the verdict after ${result.maxRounds} rounds. It keeps going without him and asks for his decision when the verdict is ready. `
        + `Watch it at ${ownerLink("/council")}, or ask for council_status ${result.code}.`;
}

async function executeCouncilPropose(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
    if (!ctx?.onCouncilProposal) {
        return "A proposal card can only be shown in the web chat. Use council_convene here to start it straight away.";
    }
    return executeOnlinePropose(args, ctx.onCouncilProposal);
}

async function executeCouncilConvene(args: Record<string, unknown>): Promise<string> {
    return executeOnlineConvene(args);
}

function quietFor(iso: string): string {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

async function executeModelStatus(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
    const show = args.show === "all" || args.show === "drafts" ? args.show : "problems";
    const purpose = isPurposeTag(args.purpose) ? args.purpose : null;
    if (args.purpose && !purpose) return `Unknown purpose "${String(args.purpose)}". Use research, coding, reasoning, writing, vision, long-context, multilingual or agentic.`;
    const runs = await listDiscoveryRuns(10);
    const roster = currentRoster({ freeOnly: ctx?.freeOnly === true, paidOrchestrator: true, unattended: false });
    return formatModelStatus({ roster, runs: runs.ok ? runs.runs : [], profiles: catalogueSnapshot().profiles, show, purpose });
}

async function executeCouncilStatus(sessionCode?: string): Promise<string> {
    const {
        getSessionByCode, listOpenCouncils, listParticipants, readTranscript,
    } = await import("@/lib/council/store");
    const { latestSeatModels } = await import("@/lib/council/online/store");
    const seatModels = async (sessionId: string) => latestSeatModels(sessionId).catch(() => new Map<string, { modelKey: string }>());

    if (!sessionCode) {
        const open = await listOpenCouncils();
        if (open.length === 0) return "No councils are open.";
        const lines: string[] = [];
        for (const s of open) {
            const [parts, models] = await Promise.all([listParticipants(s.id), seatModels(s.id)]);
            const agents = parts.filter((p) => p.kind === "agent");
            const online = agents.length > 0 && agents.every((p) => models.has(p.name));
            const waiting = agents
                .filter((p) => p.status !== "left" && p.postsThisRound === 0)
                .map((p) => p.name);
            lines.push(
                `${s.code}${online ? "" : " · local"} · round ${s.round}/${s.maxRounds} · ${waiting.length ? `waiting on ${waiting.join(", ")}` : "all posted this round"}`
                + ` (quiet ${quietFor(s.lastMessageAt)}) · ${s.lastSeq} msgs · ${s.topic}`,
            );
        }
        return lines.join("\n");
    }

    const session = await getSessionByCode(sessionCode);
    if (!session) return `No council found with code "${sessionCode}".`;
    const [parts, messages, models] = await Promise.all([
        listParticipants(session.id),
        readTranscript({ sessionId: session.id, limit: 12 }),
        seatModels(session.id),
    ]);
    const roster = parts
        .filter((p) => p.kind === "agent")
        .map((p) => `${p.name} (${models.has(p.name) ? `model ${models.get(p.name)!.modelKey}, ` : ""}${p.status}, ${p.postsTotal} posts, seen ${quietFor(p.lastSeenAt)} ago)`)
        .join("\n");
    const recent = messages.map((m) => `[${m.seq}] ${m.speaker} → ${m.addressedTo} (${m.intent}): ${m.body.slice(0, 300)}`).join("\n");
    return `${session.code} - ${session.topic}\nStatus ${session.status}, round ${session.round}/${session.maxRounds}, ${session.lastSeq} messages, quiet ${quietFor(session.lastMessageAt)}.\n\nParticipants:\n${roster}\n\nRecent:\n${recent || "(nothing yet)"}`
        + (session.verdict ? `\n\nVERDICT (${session.closerName}):\n${session.verdict}` : "");
}

async function executeCouncilClose(sessionCode: string, verdict?: string): Promise<string> {
    const { getSessionByCode, readTranscript } = await import("@/lib/council/store");
    const { closeCouncil } = await import("@/lib/council/close");

    const session = await getSessionByCode(sessionCode);
    if (!session) return `No council found with code "${sessionCode}".`;
    if (session.status === "closed") {
        return `${session.code} is already closed.\n\nVERDICT (${session.closerName}):\n${session.verdict ?? "(none recorded)"}`;
    }

    let text = (verdict ?? "").trim();
    if (!text) {
        const messages = await readTranscript({ sessionId: session.id, limit: 200 });
        const speakers = [...new Set(messages.filter((m) => m.role === "agent").map((m) => m.speaker))];
        text = messages.length
            ? `Closed manually before the council concluded on its own. ${speakers.join(", ")} exchanged `
              + `${messages.length} messages over ${session.round} round(s) on "${session.topic}". `
              + `No agent verdict was written; read the transcript before relying on this.`
            : `Closed manually. Nothing was said in this council.`;
    }

    // closer = "zuychin" is the human override running the same single-writer CAS.
    const outcome = await closeCouncil({
        session, closer: "zuychin", verdict: text, openQuestions: [],
    });
    if (!outcome.changed) {
        return `${session.code} was already concluded by ${outcome.closer}.\n\n${outcome.verdict}`;
    }
    return `Closed ${session.code}. The agents will see "=== COUNCIL CLOSED ===" on their next call.\n\n`
        + (outcome.vaultPath ? `Filed (unreviewed draft): ${outcome.vaultPath}` : `Vault filing failed: ${outcome.archiveError}`);
}
