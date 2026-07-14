import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { embedText, getEmbeddingRef } from "@/lib/ai/embeddings";
import { hybridSearchKnowledge, searchEmbeddings, storeEmbedding, getRecentMessages } from "@/lib/db";
import { listVaultPages, searchVaultPages } from "@/lib/vault/store";
import { getFile, getVaultConfig } from "@/lib/vault/github";

export const maxDuration = 300;

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// Rejects a write call authenticated by a read-only key. Returns null when the
// caller holds knowledge:write, otherwise the MCP error result to return.
function requireWrite(extra: ToolExtra) {
    if (extra.authInfo?.scopes?.includes("knowledge:write")) return null;
    return {
        isError: true,
        content: [{ type: "text" as const, text: "This tool needs a read-write API key; the key you used is read-only." }],
    };
}

// Shared knowledge base exposed to the user's other AI agents over MCP.
// Read tools pin the default embedding partition and no userId so external
// agents share the SAME global store the assistant itself uses.
const handler = createMcpHandler(
    (server) => {
        server.registerTool(
            "search_knowledge",
            {
                description:
                    "Search the shared knowledge base by semantic query. Returns the most relevant stored notes and snippets.",
                inputSchema: { query: z.string().min(1).describe("Natural-language search query.") },
            },
            async ({ query }) => {
                try {
                    const embRef = getEmbeddingRef();
                    const embedding = await embedText(embRef, query, "query");
                    const results =
                        (await hybridSearchKnowledge({
                            queryEmbedding: embedding,
                            queryText: query,
                            matchCount: 5,
                            embeddingModel: embRef.model.id,
                        })) ??
                        (await searchEmbeddings({
                            queryEmbedding: embedding,
                            matchThreshold: 0.6,
                            matchCount: 5,
                            embeddingModel: embRef.model.id,
                        }));
                    const text = results.length
                        ? results.map((r, i) => `[${i + 1}] ${r.content}`).join("\n\n")
                        : "No relevant knowledge found.";
                    return { content: [{ type: "text", text }] };
                } catch (error) {
                    return { content: [{ type: "text", text: `Search failed: ${errMsg(error)}` }] };
                }
            },
        );

        server.registerTool(
            "save_note",
            {
                description:
                    "Save a note into the shared knowledge base so it becomes searchable later by any connected agent and by the assistant.",
                inputSchema: {
                    content: z.string().min(1).describe("Note text to store."),
                    category: z.string().optional().describe("Optional category tag (default 'general')."),
                },
            },
            async ({ content, category }, extra) => {
                const denied = requireWrite(extra);
                if (denied) return denied;
                try {
                    const embRef = getEmbeddingRef();
                    const embedding = await embedText(embRef, content);
                    await storeEmbedding({
                        content,
                        embedding,
                        embeddingModel: embRef.model.id,
                        metadata: { source: "mcp_save_note", category: category ?? "general" },
                    });
                    return {
                        content: [
                            { type: "text", text: `Saved note (${content.length} chars) to the knowledge base.` },
                        ],
                    };
                } catch (error) {
                    return { content: [{ type: "text", text: `Save failed: ${errMsg(error)}` }] };
                }
            },
        );

        server.registerTool(
            "vault_search",
            {
                description:
                    "Search the second-brain vault (long-form interlinked notes) by topic. Returns matching page paths, titles and summaries.",
                inputSchema: { query: z.string().min(1).describe("Topic or question to search the vault for.") },
            },
            async ({ query }) => {
                try {
                    if (!getVaultConfig()) {
                        return { content: [{ type: "text", text: "The vault is not configured." }] };
                    }
                    const hits = await searchVaultPages({ query, embRef: await vaultEmbeddingRef(), hybrid: true });
                    const text = hits.length
                        ? hits
                              .map(
                                  (h) =>
                                      `- ${h.path} (${h.category}, ${h.similarity.toFixed(2)}): ${h.title} — ${h.summary}`,
                              )
                              .join("\n")
                        : "No vault pages matched.";
                    return { content: [{ type: "text", text }] };
                } catch (error) {
                    return { content: [{ type: "text", text: `Vault search failed: ${errMsg(error)}` }] };
                }
            },
        );

        server.registerTool(
            "vault_read",
            {
                description:
                    "Read the full Markdown of a vault page by its path (e.g. a path from vault_search, or 'index.md').",
                inputSchema: { path: z.string().min(1).describe("Vault page path, e.g. 'wiki/concepts/foo.md'.") },
            },
            async ({ path }) => {
                try {
                    const cfg = getVaultConfig();
                    if (!cfg) {
                        return { content: [{ type: "text", text: "The vault is not configured." }] };
                    }
                    const file = await getFile(cfg, path);
                    return {
                        content: [{ type: "text", text: file ? file.text : `No page found at "${path}".` }],
                    };
                } catch (error) {
                    return { content: [{ type: "text", text: `Vault read failed: ${errMsg(error)}` }] };
                }
            },
        );

        server.registerTool(
            "get_recent_conversations",
            {
                description:
                    "Get a summary of the user's most recent messages with the assistant across channels, for shared context on what they've been working on.",
                inputSchema: {
                    limit: z.number().int().min(1).max(30).optional().describe("How many recent messages (default 10)."),
                },
            },
            async ({ limit }) => {
                try {
                    const messages = await getRecentMessages(limit ?? 10);
                    const text = messages.length
                        ? messages
                              .map((m) => `${m.role === "user" ? "User" : "Assistant"} (${m.channel}): ${m.content.slice(0, 300)}`)
                              .join("\n")
                        : "No recent conversations.";
                    return { content: [{ type: "text", text }] };
                } catch (error) {
                    return { content: [{ type: "text", text: `Failed to fetch conversations: ${errMsg(error)}` }] };
                }
            },
        );
    },
    { serverInfo: { name: "zuychin-knowledge", version: "1.0.0" } },
    { basePath: "/api/mcp", maxDuration: 300 },
);

function errMsg(error: unknown): string {
    return error instanceof Error ? error.message : "unexpected error";
}

// Vault pages may live in a non-default partition (pages embed with whatever
// model was active at ingest). Search with the majority partition, same as
// the graph's suggestion logic in vault/graph.ts.
async function vaultEmbeddingRef() {
    const counts = new Map<string, number>();
    for (const p of await listVaultPages()) {
        counts.set(p.embeddingModel, (counts.get(p.embeddingModel) ?? 0) + 1);
    }
    const model = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return getEmbeddingRef(model);
}

// Two bearer tokens: MCP_API_KEY grants read + write, MCP_API_KEY_READONLY
// grants read only. An unmatched or missing token stays locked (undefined ->
// 401), so the knowledge base is never exposed unauthenticated. Write tools
// enforce the knowledge:write scope via requireWrite.
const verifyToken = async (_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> => {
    if (!bearerToken) return undefined;
    const rw = process.env.MCP_API_KEY;
    const ro = process.env.MCP_API_KEY_READONLY;
    if (rw && bearerToken === rw) {
        return { token: bearerToken, clientId: "mcp-external-rw", scopes: ["knowledge:read", "knowledge:write"] };
    }
    if (ro && bearerToken === ro) {
        return { token: bearerToken, clientId: "mcp-external-ro", scopes: ["knowledge:read"] };
    }
    return undefined;
};

const authHandler = withMcpAuth(handler, verifyToken, { required: true });

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
