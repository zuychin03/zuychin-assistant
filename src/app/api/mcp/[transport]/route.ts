import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { embedText, getEmbeddingRef } from "@/lib/ai/embeddings";
import {
    hybridSearchKnowledge, searchEmbeddings, storeEmbedding, getRecentMessages,
    listKnowledgeNotes, updateKnowledgeNote, deleteKnowledgeNote,
} from "@/lib/db";
import { searchVaultPages, vaultEmbeddingRef } from "@/lib/vault/store";
import { getFile, getVaultConfig } from "@/lib/vault/github";
import { ingestToVault, writeVaultPage, VAULT_CATEGORIES } from "@/lib/vault/ingest";

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
// Knowledge tools pin the default embedding partition and no userId so
// external agents share the SAME global store the assistant itself uses;
// vault tools pin the vault's majority partition (vaultEmbeddingRef).
const handler = createMcpHandler(
    (server) => {
        server.registerTool(
            "search_knowledge",
            {
                description:
                    "Search the shared knowledge base by semantic query. Returns the most relevant stored notes and snippets; saved notes carry a [note <id>] tag usable with update_note/delete_note.",
                inputSchema: {
                    query: z.string().min(1).describe("Natural-language search query."),
                    category: z
                        .string()
                        .optional()
                        .describe("Restrict to saved notes with this category tag (e.g. 'project', 'plan', 'study')."),
                },
            },
            async ({ query, category }) => {
                try {
                    const embRef = getEmbeddingRef();
                    const embedding = await embedText(embRef, query, "query");
                    // Category is a post-hoc metadata filter, so overfetch to keep ~5 survivors.
                    const matchCount = category ? 15 : 5;
                    const results =
                        (await hybridSearchKnowledge({
                            queryEmbedding: embedding,
                            queryText: query,
                            matchCount,
                            embeddingModel: embRef.model.id,
                        })) ??
                        (await searchEmbeddings({
                            queryEmbedding: embedding,
                            matchThreshold: 0.6,
                            matchCount,
                            embeddingModel: embRef.model.id,
                        }));
                    const filtered = category
                        ? results.filter((r) => r.metadata?.category === category).slice(0, 5)
                        : results;
                    const text = filtered.length
                        ? filtered
                              .map((r, i) => {
                                  const tag = r.metadata?.source === "mcp_save_note" ? ` [note ${r.id}]` : "";
                                  return `[${i + 1}]${tag} ${r.content}`;
                              })
                              .join("\n\n")
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
                    "Save a note into the shared knowledge base so it becomes searchable later by any connected agent and by the assistant. Suggested category tags: 'project', 'plan', 'study', 'idea'; default 'general'.",
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
                    const id = await storeEmbedding({
                        content,
                        embedding,
                        embeddingModel: embRef.model.id,
                        metadata: { source: "mcp_save_note", category: category ?? "general" },
                    });
                    return {
                        content: [
                            { type: "text", text: `Saved note ${id} (${content.length} chars) to the knowledge base.` },
                        ],
                    };
                } catch (error) {
                    return { content: [{ type: "text", text: `Save failed: ${errMsg(error)}` }] };
                }
            },
        );

        server.registerTool(
            "list_notes",
            {
                description:
                    "Browse saved knowledge-base notes newest-first, optionally filtered by category tag. Returns each note's id for use with update_note/delete_note.",
                inputSchema: {
                    category: z.string().optional().describe("Only notes with this category tag."),
                    limit: z.number().int().min(1).max(50).optional().describe("How many notes (default 20)."),
                },
            },
            async ({ category, limit }) => {
                try {
                    const notes = await listKnowledgeNotes({ category, limit });
                    const text = notes.length
                        ? notes
                              .map(
                                  (n) =>
                                      `- [${n.id}] (${n.metadata?.category ?? "general"}, ${n.createdAt.slice(0, 10)}) ${n.content.slice(0, 300)}`,
                              )
                              .join("\n")
                        : category
                          ? `No notes with category '${category}'.`
                          : "No notes saved yet.";
                    return { content: [{ type: "text", text }] };
                } catch (error) {
                    return { content: [{ type: "text", text: `Listing failed: ${errMsg(error)}` }] };
                }
            },
        );

        server.registerTool(
            "update_note",
            {
                description:
                    "Rewrite a saved note's text and/or change its category tag, keeping it searchable. Use for correcting stale plans or project info instead of saving a duplicate. Get ids from list_notes or search_knowledge.",
                inputSchema: {
                    id: z.string().min(1).describe("Note id from list_notes/search_knowledge."),
                    content: z.string().min(1).optional().describe("Replacement note text."),
                    category: z.string().optional().describe("New category tag."),
                },
            },
            async ({ id, content, category }, extra) => {
                const denied = requireWrite(extra);
                if (denied) return denied;
                if (!content && !category) {
                    return { isError: true, content: [{ type: "text" as const, text: "Provide content and/or category to change." }] };
                }
                try {
                    const embRef = getEmbeddingRef();
                    const embedding = content ? await embedText(embRef, content) : undefined;
                    const ok = await updateKnowledgeNote({
                        id,
                        content,
                        embedding,
                        embeddingModel: embRef.model.id,
                        category,
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: ok ? `Updated note ${id}.` : `No saved note with id ${id} — check list_notes.`,
                            },
                        ],
                    };
                } catch (error) {
                    return { content: [{ type: "text", text: `Update failed: ${errMsg(error)}` }] };
                }
            },
        );

        server.registerTool(
            "delete_note",
            {
                description:
                    "Permanently delete a saved knowledge-base note by id. Only affects saved notes, never conversation history. Get ids from list_notes or search_knowledge.",
                inputSchema: { id: z.string().min(1).describe("Note id from list_notes/search_knowledge.") },
            },
            async ({ id }, extra) => {
                const denied = requireWrite(extra);
                if (denied) return denied;
                try {
                    const ok = await deleteKnowledgeNote(id);
                    return {
                        content: [
                            {
                                type: "text",
                                text: ok ? `Deleted note ${id}.` : `No saved note with id ${id} — check list_notes.`,
                            },
                        ],
                    };
                } catch (error) {
                    return { content: [{ type: "text", text: `Delete failed: ${errMsg(error)}` }] };
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
            "vault_ingest",
            {
                description:
                    "Save durable knowledge into the second-brain vault: study notes, project docs, work plans, research findings. Runs the full ingest pipeline — writes an interlinked wiki page, auto-links related pages, updates the catalogue, and commits. Prefer this over save_note for anything worth keeping long-term or that will be revised.",
                inputSchema: {
                    title: z.string().min(1).describe("Human-readable page title, e.g. 'UsTime Stage 1 plan'."),
                    content: z
                        .string()
                        .min(1)
                        .describe("The material to distil into the page: source text, findings, or the plan/notes themselves."),
                    category: z
                        .enum(VAULT_CATEGORIES)
                        .optional()
                        .describe(
                            "'sources' external material (default), 'concepts' durable ideas/methods, 'entities' people/tools/projects, 'synthesis' cross-source answers and plans.",
                        ),
                    source: z.string().optional().describe("Optional origin to cite: URL, paper, book/course name."),
                },
            },
            async ({ title, content, category, source }, extra) => {
                const denied = requireWrite(extra);
                if (denied) return denied;
                try {
                    if (!getVaultConfig()) {
                        return { content: [{ type: "text", text: "The vault is not configured." }] };
                    }
                    const result = await ingestToVault({
                        title,
                        content,
                        category,
                        source,
                        embRef: await vaultEmbeddingRef(),
                    });
                    const links = result.links.length
                        ? ` Linked: ${result.links.map((l) => l.path).join(", ")}.`
                        : "";
                    return {
                        content: [
                            {
                                type: "text",
                                text: `${result.updatedExisting ? "Updated" : "Created"} ${result.pagePath} (commit ${result.commit.slice(0, 7)}). ${result.summary}${links}`,
                            },
                        ],
                    };
                } catch (error) {
                    return { content: [{ type: "text", text: `Vault ingest failed: ${errMsg(error)}` }] };
                }
            },
        );

        server.registerTool(
            "vault_write",
            {
                description:
                    "Create or overwrite ONE vault page with complete markdown you have already written — for corrections or deliberate edits after vault_read. Prefer vault_ingest for new knowledge (it synthesizes and auto-links). Never overwrite a page with a deletion marker.",
                inputSchema: {
                    path: z
                        .string()
                        .min(1)
                        .describe("Page path like 'wiki/concepts/attention.md' (under wiki/<category>/, kebab-case filename)."),
                    markdown: z
                        .string()
                        .min(1)
                        .describe("The COMPLETE new page content including YAML frontmatter (title, category, created, updated)."),
                    summary: z.string().optional().describe("One-line summary (<140 chars) for the index catalogue."),
                },
            },
            async ({ path, markdown, summary }, extra) => {
                const denied = requireWrite(extra);
                if (denied) return denied;
                try {
                    if (!getVaultConfig()) {
                        return { content: [{ type: "text", text: "The vault is not configured." }] };
                    }
                    const result = await writeVaultPage({
                        path,
                        markdown,
                        summary,
                        embRef: await vaultEmbeddingRef(),
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `${result.created ? "Created" : "Updated"} ${result.pagePath} (commit ${result.commit.slice(0, 7)}).`,
                            },
                        ],
                    };
                } catch (error) {
                    return { content: [{ type: "text", text: `Vault write failed: ${errMsg(error)}` }] };
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
