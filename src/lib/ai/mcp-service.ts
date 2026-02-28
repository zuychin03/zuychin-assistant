import { Type } from "@google/genai";



/** MCP tool definitions for Gemini function calling. */

export interface McpTool {
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

// Tool registry
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
];

// Tool executors


import { searchEmbeddings, storeEmbedding, getRecentMessages } from "@/lib/db";
import { generateEmbedding } from "@/lib/gemini";

/** Dispatch and execute a tool by name. */
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

// Gemini SDK integration


/** Convert MCP tool definitions to Gemini function declaration format. */
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

/** Generate a system prompt section listing available tools (text fallback). */
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
