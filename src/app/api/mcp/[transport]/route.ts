import { after } from "next/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { embedText, getEmbeddingRef } from "@/lib/ai/embeddings";
import { refreshEmbeddingOverride } from "@/lib/ai/embedding-override";
import {
    hybridSearchKnowledge, searchEmbeddings, storeEmbedding, getRecentMessages,
    listKnowledgeNotes, updateKnowledgeNote, deleteKnowledgeNote,
} from "@/lib/db";
import { searchVaultPages, vaultEmbeddingRef } from "@/lib/vault/store";
import { getFile, getVaultConfig } from "@/lib/vault/github";
import { ingestToVault, writeVaultPage, VAULT_CATEGORIES } from "@/lib/vault/ingest";
import {
    INTENTS_REQUIRING_REPLY_TO, INTENTS_REQUIRING_TARGET, MAX_BODY_CHARS, MAX_OPEN_COUNCILS,
    MODERATOR_NAME, clampWaitMs, type CouncilIntent,
} from "@/lib/council/protocol";
import {
    appendMessage, createCouncilSession, getParticipant, getSessionByCode, joinCouncil,
    leaveCouncil, listOpenCouncils, listParticipants, readTranscript,
} from "@/lib/council/store";
import {
    renderConveneResult, renderDispatchSpeakResult, renderDispatchWaitNote,
    renderLeft, renderNotAParticipant, renderPassed, renderRosterRejection, renderRulebook,
    renderSpeakResult, renderTranscript, renderTurn, renderUnknownSession, renderWaitResult,
} from "@/lib/council/render";
import { dispatchCouncil, pollCouncil } from "@/lib/council/wait";
import { proposeCouncilVerdict } from "@/lib/council/close";
import { moderateRound } from "@/lib/council/moderator";
import { COUNCIL_TYPES, getCouncilTemplate } from "@/lib/council/templates";
import { blockWorkItem, claimNextWorkItem, completeWorkItem, freezeIntegrationManifest, getCampaignForSession, heartbeatWorkItem, listCampaignWorkItems, recordExactVerification, recordV3Integration, reviewWorkItem } from "@/lib/council/campaign";
import { issueHostSeatKey, resolveSeatKey } from "@/lib/council/seat-keys";
import { councilHostService } from "@/lib/council/service";
import { promptDigest } from "@/lib/council/v3";

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

// Coarse gate for council tools: a read-write master key, or a guest seat key.
// Tools that act AS an agent must ALSO call requireSeat once they have resolved
// what they are acting on - a seat key is valid for one council and one name,
// and this check knows neither yet. Read-only keys observe via
// council_transcript, which is deliberately ungated here.
function requireCouncil(extra: ToolExtra) {
    const scopes = extra.authInfo?.scopes ?? [];
    if (scopes.includes("knowledge:write") || scopes.includes("council:seat")) return null;
    return denied("This tool needs a read-write API key or a council seat key; the key you used is read-only.");
}

function requireHost(extra: ToolExtra) {
    if (extra.authInfo?.scopes?.includes("council:host")) return null;
    return denied("This tool requires the dedicated Council host credential.");
}

function requireOwnerOrHost(extra: ToolExtra) {
    const scopes = extra.authInfo?.scopes ?? [];
    if (scopes.includes("knowledge:write") || scopes.includes("council:host")) return null;
    return denied("This tool requires an owner or Council host credential.");
}

function denied(text: string) {
    return { isError: true, content: [{ type: "text" as const, text }] };
}

function seatIdentity(extra: ToolExtra): { sessionId: string; seatName: string } | null {
    const id = extra.authInfo?.clientId ?? "";
    const marker = "council-seat:";
    if (!id.startsWith(marker)) return null;
    // Split on the FIRST colon only: a seat name may contain one, a uuid may not.
    const rest = id.slice(marker.length);
    const idx = rest.indexOf(":");
    if (idx < 0) return null;
    return { sessionId: rest.slice(0, idx), seatName: rest.slice(idx + 1) };
}

// A master key passes everything. A seat key passes only its own council and
// its own name, so a guest can neither speak as a peer nor reach a council it
// was not invited to.
function requireSeat(extra: ToolExtra, opts: { sessionId?: string; agentName?: string; protocolVersion?: number }) {
    // V2 identity compatibility.
    if (extra.authInfo?.scopes?.includes("knowledge:write")) {
        if (opts.protocolVersion === 3) return denied("Council V3 requires the participant's seat credential.");
        if (opts.protocolVersion === undefined && process.env.COUNCIL_V2_ASSERTED_IDENTITY !== "true") {
            return denied("Agent work requires a Council seat credential.");
        }
        return null;
    }
    const seat = seatIdentity(extra);
    if (!seat) return denied("This tool needs a read-write API key.");
    if (opts.sessionId && opts.sessionId !== seat.sessionId) {
        return denied("That seat key belongs to a different council.");
    }
    if (opts.agentName && opts.agentName !== seat.seatName) {
        return denied(`That seat key is for the seat "${seat.seatName}", not "${opts.agentName}".`);
    }
    return null;
}

// after() runs once the response stream closes, so the moderator's note lands on
// every participant's next tick and costs the poster nothing. It is one round
// late by construction; the alternative is an LLM call in the critical path of a
// tool three agents are blocked on. The bare-void fallback covers callers
// outside a request scope.
function scheduleModeration(sessionId: string, round: number) {
    try {
        after(() => moderateRound({ sessionId, round }));
    } catch {
        void moderateRound({ sessionId, round });
    }
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
                    await refreshEmbeddingOverride();
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
                    await refreshEmbeddingOverride();
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
                    await refreshEmbeddingOverride();
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
                                text: ok ? `Updated note ${id}.` : `No saved note with id ${id} - check list_notes.`,
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
                                text: ok ? `Deleted note ${id}.` : `No saved note with id ${id} - check list_notes.`,
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
                                      `- ${h.path} (${h.category}, ${h.similarity.toFixed(2)}): ${h.title} - ${h.summary}`,
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
                    "Save durable knowledge into the second-brain vault: study notes, project docs, work plans, research findings. Runs the full ingest pipeline - writes an interlinked wiki page, auto-links related pages, updates the catalogue, and commits. Prefer this over save_note for anything worth keeping long-term or that will be revised.",
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
                    "Create or overwrite ONE vault page with complete markdown you have already written - for corrections or deliberate edits after vault_read. Prefer vault_ingest for new knowledge (it synthesizes and auto-links). Never overwrite a page with a deletion marker.",
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

        server.registerTool(
            "council_convene",
            {
                description:
                    "[COUNCIL PROTOCOL] Open a new council: a live multi-round debate between several AI agents, held inside Zuychin. Returns a short session code plus a ready-to-paste kickoff block for every participant - hand each block to its agent unchanged and it will join and run the protocol on its own. You are convening, not debating: convene once, then paste. Name every participant up front; the roster is closed afterwards and an unknown agentName is rejected, which is what stops a typo from creating a phantom participant. Pick one closerName - only that participant may call council_conclude. Prefer save_note or vault_ingest if you only want to record a conclusion you already hold; a council is for questions where you want disagreement.",
                inputSchema: {
                    topic: z.string().min(1).describe("The question under debate, phrased as one decidable question."),
                    brief: z.string().min(1).describe("Context every participant needs: constraints, what has been tried, what a good answer looks like. Pasted verbatim into each agent's first tool result."),
                    participants: z.array(z.object({
                        name: z.string().min(1).max(40),
                        expertise: z.string().min(1),
                    })).min(2).max(5).describe("Agents to invite. Short lowercase handles the human will type into each agent ('codex', 'claude-code', 'cursor')."),
                    closerName: z.string().min(1).describe("Which participant may call council_conclude. Must be one of participants[].name."),
                    councilType: z.enum(COUNCIL_TYPES).optional().describe("Discussion template: debate, code, research, audit or debug. Defaults to debate."),
                    maxRounds: z.number().int().min(2).max(10).optional().describe("Rounds before the council must conclude (default 6)."),
                    maxMessages: z.number().int().min(10).max(200).optional().describe("Hard message cap for the whole session (default 60)."),
                    ttlMinutes: z.number().int().min(10).max(240).optional().describe("Hard expiry from now (default 90). The session self-terminates at this deadline whether or not anyone concludes."),
                    workspace: z.object({
                        repoPath: z.string().min(1).describe("Absolute path to the shared git repo the agents will work in."),
                        baseBranch: z.string().min(1).optional().describe("Branch each agent's worktree starts from (default 'main')."),
                        baseSha: z.string().regex(/^[0-9a-f]{40}$/i).optional().describe("Frozen base commit resolved by the local host."),
                    }).optional().describe("Set ONLY when the council will change code. Gives each agent its own git worktree and branch, so they cannot overwrite each other, and returns the merge steps for you. Omit for a debate-only council."),
                },
            },
            async ({ topic, brief, participants, closerName, councilType, maxRounds, maxMessages, ttlMinutes, workspace }, extra) => {
                // Master key only: a guest may take part in a council, never
                // create one.
                const denied = requireOwnerOrHost(extra);
                if (denied) return denied;
                try {
                    const names = participants.map((p) => p.name);
                    if (!names.includes(closerName)) {
                        return { content: [{ type: "text", text: `closerName "${closerName}" is not one of the participants (${names.join(", ")}). Nothing was created.` }] };
                    }
                    if (new Set(names).size !== names.length) {
                        return { content: [{ type: "text", text: `Participant names must be unique; got ${names.join(", ")}. Nothing was created.` }] };
                    }
                    if (names.includes(MODERATOR_NAME)) {
                        return { content: [{ type: "text", text: `"${MODERATOR_NAME}" is reserved for the moderator and cannot be a participant. Nothing was created.` }] };
                    }
                    const open = await listOpenCouncils();
                    if (open.length >= MAX_OPEN_COUNCILS) {
                        return { content: [{ type: "text", text: `${open.length} councils are already open (${open.map((s) => s.code).join(", ")}). Close one before convening another.` }] };
                    }

                    const template = getCouncilTemplate(councilType);
                    const session = await createCouncilSession({
                        topic, brief, closerName, participants, councilType,
                        maxRounds: maxRounds ?? template.defaults.maxRounds,
                        maxMessages: maxMessages ?? template.defaults.maxMessages,
                        ttlMinutes: ttlMinutes ?? template.defaults.ttlMinutes,
                        workspace: workspace ? { repoPath: workspace.repoPath, baseBranch: workspace.baseBranch ?? "main", baseSha: workspace.baseSha } : undefined,
                    });
                    const roster = await listParticipants(session.id);
                    const ws = workspace
                        ? { repoPath: workspace.repoPath, baseBranch: workspace.baseBranch ?? "main" }
                        : undefined;
                    return { content: [{ type: "text", text: renderConveneResult(session, roster, ws) }] };
                } catch (error) {
                    return { content: [{ type: "text", text: `Convene failed: ${errMsg(error)}` }] };
                }
            },
        );

        server.registerTool(
            "council_join",
            {
                description:
                    "[COUNCIL PROTOCOL] Join a council you were invited to and receive the full rulebook. Call this once, first, before any other council tool. Idempotent: calling it again re-issues the rules and the recent transcript, which is how you recover if your context was truncated or you lost track of the protocol. Returns your identity confirmation, the topic and brief, the roster, the six status keywords, the intent vocabulary, your budgets, and a NEXT line with exactly what to do next. Your agentName must be on the roster the convener set; if it is not, this tool lists the valid names.",
                inputSchema: {
                    sessionCode: z.string().min(1).describe("Session code from your human, e.g. 'CN-4KQ2'."),
                    agentName: z.string().min(1).describe("Your council name, exactly as your human gave it. Use it unchanged in every later call - a mismatch makes you invisible to the council."),
                    expertise: z.string().optional().describe("One line on what you bring. Shown to the other participants."),
                    dispatchMode: z.boolean().optional().describe("Set by a local council host that owns this agent's turns over ACP; agents must not set it themselves. When true the agent is prompted with each turn instead of polling, and council_wait stops blocking for it. Omit to leave the current setting unchanged."),
                },
            },
            async ({ sessionCode, agentName, expertise, dispatchMode }, extra) => {
                const denied = requireCouncil(extra);
                if (denied) return denied;
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) {
                        return { content: [{ type: "text", text: renderUnknownSession(sessionCode) }] };
                    }
                    const wrongSeat = requireSeat(extra, { sessionId: session.id, agentName, protocolVersion: session.protocolVersion });
                    if (wrongSeat) return wrongSeat;
                    const result = await joinCouncil({ sessionId: session.id, agentName, expertise, dispatchMode });
                    const roster = await listParticipants(session.id);
                    if (!result.ok) {
                        return { content: [{ type: "text", text: renderRosterRejection({ session, participants: roster, attempted: agentName }) }] };
                    }
                    const transcript = await readTranscript({ sessionId: session.id, limit: 20 });
                    return { content: [{ type: "text", text: renderRulebook({ session, participants: roster, agentName, transcript }) }] };
                } catch (error) {
                    return { content: [{ type: "text", text: `Join failed: ${errMsg(error)}` }] };
                }
            },
        );

        server.registerTool(
            "council_transcript",
            {
                description:
                    "[COUNCIL PROTOCOL] Read a council transcript without participating. Works with a read-only MCP key, so this is the observer's tool and the human's tool. Use it to catch up when a result told you messages were omitted, to review a closed council before acting on its verdict, or to check on a council you were not invited to. It never blocks, never marks you present, and never changes whose turn it is - it will not advance a debate, so do not poll it in place of council_wait.",
                inputSchema: {
                    sessionCode: z.string().min(1).describe("Session code, e.g. 'CN-4KQ2'."),
                    fromSeq: z.number().int().min(0).optional().describe("Start at this seq (default 0 = from the beginning)."),
                    limit: z.number().int().min(1).max(50).optional().describe("How many messages (default 30, oldest-first from fromSeq)."),
                },
            },
            async ({ sessionCode, fromSeq, limit }) => {
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) {
                        return { content: [{ type: "text", text: renderUnknownSession(sessionCode) }] };
                    }
                    const messages = await readTranscript({
                        sessionId: session.id, fromSeq: fromSeq ?? 0, limit: limit ?? 30,
                    });
                    return { content: [{ type: "text", text: renderTranscript({ session, messages, fromSeq: fromSeq ?? 0 }) }] };
                } catch (error) {
                    return { content: [{ type: "text", text: `Transcript read failed: ${errMsg(error)}` }] };
                }
            },
        );

        server.registerTool(
            "council_wait",
            {
                description:
                    "[COUNCIL PROTOCOL] Block for up to 30 seconds waiting for another participant to speak, then return everything new since sinceSeq. Use this when you have nothing to post yet - otherwise prefer council_speak, which posts and waits in one call. AN EMPTY RESULT IS NORMAL AND IS NOT AN ERROR: it means nobody spoke inside the window, and the correct response is to call it again immediately with the same sinceSeq. Never treat it as failure, never report it to your human, never stop because of it. If nobody has spoken for 8 seconds the floor is granted to you automatically, so waiting can never be terminal. Only a result containing \"=== COUNCIL CLOSED ===\" releases you from the loop. Requires a read-write key; use council_transcript to observe without participating.",
                inputSchema: {
                    sessionCode: z.string().min(1).describe("Session code, e.g. 'CN-4KQ2'."),
                    agentName: z.string().min(1).describe("Your council name. Also marks you alive; stop calling and the others are told you went quiet."),
                    sinceSeq: z.number().int().min(0).optional().describe("Highest seq you have already read. Copy the cursor value from the previous result; the NEXT line always has it filled in."),
                    waitSeconds: z.number().int().min(5).max(45).optional().describe("How long to block (default 30, clamped to 45 because most MCP clients time a tool call out at 60s). Lower it if your client times out."),
                },
            },
            async ({ sessionCode, agentName, sinceSeq, waitSeconds }, extra) => {
                const denied = requireCouncil(extra);
                if (denied) return denied;
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) {
                        return { content: [{ type: "text", text: renderUnknownSession(sessionCode) }] };
                    }
                    const wrongSeat = requireSeat(extra, { sessionId: session.id, agentName, protocolVersion: session.protocolVersion });
                    if (wrongSeat) return wrongSeat;
                    // Enforcement, not instruction: a host-dispatched agent that
                    // also polled would have its cursor acked twice, once by the
                    // host and once by itself, and would silently skip messages.
                    const me = await getParticipant(session.id, agentName);
                    if (me?.dispatchMode) {
                        return { content: [{ type: "text", text: renderDispatchWaitNote(session.code, agentName, sinceSeq ?? me.cursorSeq) }] };
                    }
                    const result = await pollCouncil({
                        session,
                        agentName,
                        sinceSeq,
                        waitMs: clampWaitMs(waitSeconds),
                        signal: extra.signal,
                    });
                    return { content: [{ type: "text", text: renderWaitResult(result, { sessionCode: session.code, agentName }) }] };
                } catch (error) {
                    return { content: [{ type: "text", text: `Wait failed: ${errMsg(error)}. This is not the council closing - call council_wait again.` }] };
                }
            },
        );

        server.registerTool(
            "council_speak",
            {
                description:
                    "[COUNCIL PROTOCOL] Say one thing to the council, then block until someone replies. This is the tool you spend the council in: posting and waiting are one call on purpose, because two calls would double your own token cost for nothing. Declare an intent; answer or concede first if anything is listed under OPEN TO YOU, then propose or refine. Set addressedTo when challenging or asking. Set replyToSeq to the seq you are responding to - that is what clears the obligation. clientKey must be a stable id you choose BEFORE the first attempt; reuse the exact same key if the call times out and you retry, and the retry returns the original message number instead of posting twice. You get 2 posts per round; over quota this returns NOT_YOUR_TURN, records nothing, and blocks anyway, which is a normal outcome and not a failure. The result carries every message that arrived while you waited, plus a NEXT line with the exact next call.",
                inputSchema: {
                    sessionCode: z.string().min(1).describe("Session code, e.g. 'CN-4KQ2'."),
                    agentName: z.string().min(1).describe("Your council name."),
                    intent: z.enum(["propose", "challenge", "answer", "concede", "refine", "ask"]).describe("Your move. 'propose' new position; 'challenge' object to a named participant; 'answer' reply to something aimed at you; 'concede' accept their point and drop yours; 'refine' amend your own earlier position; 'ask' put a direct question to one participant."),
                    message: z.string().min(1).max(6000).describe("What you are saying, in your own voice. Argue, do not summarise. Cite participants by name and by seq. Over 6000 chars is truncated and you are told so."),
                    clientKey: z.string().min(1).max(80).describe("Stable id you pick before the first attempt, e.g. 'codex-r2-1'. Reuse it verbatim on a retry."),
                    addressedTo: z.string().optional().describe("One participant's name, 'zuychin' for a moderator ruling, or 'all' (default). Required for 'challenge' and 'ask'."),
                    replyToSeq: z.number().int().min(1).optional().describe("The seq you are responding to. Required for 'answer', 'concede' and 'challenge'."),
                    sinceSeq: z.number().int().min(0).optional().describe("Highest seq you have read. Copy it from the previous result; the NEXT line always has it filled in. Omit it and the server resumes from your last acknowledged position."),
                    waitSeconds: z.number().int().min(0).max(45).optional().describe("How long to block after posting (default 30, clamped to 45 because most MCP clients time a tool call out at 60s). Pass 0 to post and return immediately."),
                },
            },
            async ({ sessionCode, agentName, intent, message, clientKey, addressedTo, replyToSeq, sinceSeq, waitSeconds }, extra) => {
                const denied = requireCouncil(extra);
                if (denied) return denied;
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) {
                        return { content: [{ type: "text", text: renderUnknownSession(sessionCode) }] };
                    }
                    const wrongSeat = requireSeat(extra, { sessionId: session.id, agentName, protocolVersion: session.protocolVersion });
                    if (wrongSeat) return wrongSeat;
                    const roster = await listParticipants(session.id);
                    const me = roster.find((p) => p.name === agentName && p.kind === "agent");
                    if (!me) {
                        return { content: [{ type: "text", text: renderNotAParticipant(session.code, agentName) }] };
                    }

                    // Validated before the append, so a malformed call records
                    // nothing rather than a message nobody is obliged to answer.
                    const target = addressedTo ?? "all";
                    const validTargets = [...roster.map((p) => p.name), "all"];
                    if (!validTargets.includes(target)) {
                        return { content: [{ type: "text", text: `PROTOCOL_ERROR - nothing was recorded.\naddressedTo "${target}" is not on the roster. Valid values: ${validTargets.join(", ")}.\n\nNEXT → repeat your council_speak call with a valid addressedTo.` }] };
                    }
                    if (INTENTS_REQUIRING_TARGET.includes(intent as CouncilIntent) && target === "all") {
                        return { content: [{ type: "text", text: `PROTOCOL_ERROR - nothing was recorded.\nintent "${intent}" must name one participant in addressedTo. Valid values: ${validTargets.filter((n) => n !== "all").join(", ")}.\n\nNEXT → repeat your council_speak call with addressedTo set.` }] };
                    }
                    if (INTENTS_REQUIRING_REPLY_TO.includes(intent as CouncilIntent) && replyToSeq === undefined) {
                        return { content: [{ type: "text", text: `PROTOCOL_ERROR - nothing was recorded.\nintent "${intent}" must set replyToSeq to the seq you are responding to; that is what clears the obligation.\n\nNEXT → repeat your council_speak call with replyToSeq set.` }] };
                    }

                    const post = await appendMessage({
                        sessionId: session.id, speaker: agentName, intent, body: message,
                        clientKey, addressedTo: target, replyToSeq, ackSeq: sinceSeq,
                    });
                    if (post.advanced) scheduleModeration(session.id, post.round);
                    const receipt = {
                        ...post, intent, addressedTo: target, replyToSeq,
                        truncatedChars: message.length > MAX_BODY_CHARS ? message.length - MAX_BODY_CHARS : undefined,
                    };

                    // waitSeconds is ignored for a dispatched agent: it posts and
                    // ends its turn, and the host delivers what arrives next.
                    if (me.dispatchMode) {
                        return {
                            content: [{
                                type: "text",
                                text: renderDispatchSpeakResult({
                                    post: receipt, session, agentName, cursor: sinceSeq ?? me.cursorSeq,
                                }),
                            }],
                        };
                    }

                    // The cursor for the block that follows is what the agent had
                    // READ, never the seq it just wrote: acking its own seq would
                    // silently drop every peer message below it.
                    const result = await pollCouncil({
                        session, agentName, sinceSeq: sinceSeq ?? undefined,
                        waitMs: clampWaitMs(waitSeconds), countWait: false, signal: extra.signal,
                    });

                    return {
                        content: [{
                            type: "text",
                            text: renderSpeakResult({ post: receipt, result, session, agentName }),
                        }],
                    };
                } catch (error) {
                    return { content: [{ type: "text", text: `Speak failed: ${errMsg(error)}. This is not the council closing - check council_transcript before retrying with the SAME clientKey.` }] };
                }
            },
        );

        server.registerTool(
            "council_conclude",
            {
                description:
                    "[COUNCIL PROTOCOL] Close the council and file the outcome. Only the participant named as closer at convene time may call this, and only once; anyone else, or a second call, gets a refusal and changes nothing. Writes the verdict, announces it to the human's Discord, and files the transcript as a quarantined vault page. Your verdict must state the decision, the reasoning that settled it, and who dissented and why; do not manufacture consensus the transcript does not show, and put anything genuinely unresolved in openQuestions where it becomes a follow-up rather than quietly disappearing. Call this when the debate has converged, when a result told you the council is concluding, or when the council was declared stalled. Returns the vault path - report it to your human.",
                inputSchema: {
                    sessionCode: z.string().min(1).describe("Session code, e.g. 'CN-4KQ2'."),
                    agentName: z.string().min(1).describe("Your council name. Must match the closer named at convene time."),
                    verdict: z.string().min(1).max(4000).describe("The decision, the reasoning that settled it, and named dissent. Cite seq numbers. This is what the human reads."),
                    openQuestions: z.array(z.string().min(1)).max(8).optional().describe("What stayed unresolved. Each becomes a follow-up todo for the human."),
                    workItems: z.array(z.object({
                        agentName: z.string().min(1).max(40), title: z.string().min(1).max(160),
                        instructions: z.string().min(1).max(8000), acceptanceCriteria: z.array(z.string().min(1).max(500)).min(1).max(12),
                        declaredPaths: z.array(z.string().min(1).max(500)).max(40).optional(),
                        verificationProfile: z.string().min(1).max(100).optional(),
                        dependencies: z.array(z.string().min(1).max(200)).max(20).optional(),
                    })).min(1).max(30).optional().describe("Optional implementation tasks with declared path scope and repository-controlled verification profile."),
                },
            },
            async ({ sessionCode, agentName, verdict, openQuestions, workItems }, extra) => {
                const denied = requireCouncil(extra);
                if (denied) return denied;
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) {
                        return { content: [{ type: "text", text: renderUnknownSession(sessionCode) }] };
                    }
                    const wrongSeat = requireSeat(extra, { sessionId: session.id, agentName, protocolVersion: session.protocolVersion });
                    if (wrongSeat) return wrongSeat;
                    if (agentName !== session.closerName) {
                        return { content: [{ type: "text", text: `NOT_YOUR_TURN - only ${session.closerName} may conclude ${session.code}. Nothing was changed.\n\nNEXT → council_wait({"sessionCode":"${session.code}","agentName":"${agentName}"})` }] };
                    }
                    // The closer PROPOSES; it does not close. Nothing is filed
                    // and no campaign exists until the owner accepts.
                    const outcome = await proposeCouncilVerdict({
                        session, closer: agentName, verdict, openQuestions: openQuestions ?? [],
                        workItems: workItems?.map((item) => ({ ...item })),
                    });
                    if (!outcome.changed) {
                        return { content: [{ type: "text", text: `COUNCIL_CLOSED - ${session.code} was already resolved (${outcome.status}).\n\nVERDICT (${outcome.closer}):\n${outcome.verdict || "(none recorded)"}\n\nNEXT → nothing. You are done with this council.` }] };
                    }
                    return { content: [{ type: "text", text: `COUNCIL_STANDBY - ${session.code} · your verdict is recorded and is now with the human.\nThe debate is closed to further posts. They will either accept it, which ends the council, or send it\nback with a fresh assignment, which reopens it with more rounds.\n\nNEXT → council_wait({"sessionCode":"${session.code}","agentName":"${agentName}"}) and hold.` }] };
                } catch (error) {
                    return { content: [{ type: "text", text: `Conclude failed: ${errMsg(error)}` }] };
                }
            },
        );


        server.registerTool(
            "council_open",
            {
                description:
                    "[COUNCIL HOST] List the open councils and their rosters, as JSON. Written for a local council host deciding whether there is anything here it could take over; a participant has no use for it and an observer should use council_transcript. Each participant carries the status and dispatchMode a host needs to tell an unclaimed seat from one a human is already driving by hand.",
                inputSchema: {},
            },
            async (_args, extra) => {
                // Lists every open council, so a seat key must not reach it.
                const denied = requireHost(extra);
                if (denied) return denied;
                try {
                    const sessions = await listOpenCouncils();
                    const councils = await Promise.all(sessions.map(async (session) => ({
                        code: session.code,
                        topic: session.topic,
                        councilType: session.councilType,
                        status: session.status,
                        round: session.round,
                        maxRounds: session.maxRounds,
                        protocolVersion: session.protocolVersion,
                        baseSha: session.baseSha,
                        createdAt: session.createdAt,
                        expiresAt: session.expiresAt,
                        participants: (await listParticipants(session.id))
                            .filter((p) => p.kind === "agent")
                            .map((p) => ({ name: p.name, status: p.status, dispatchMode: p.dispatchMode })),
                    })));
                    return { content: [{ type: "text", text: JSON.stringify({ councils }) }] };
                } catch (error) {
                    return { content: [{ type: "text", text: JSON.stringify({ error: errMsg(error) }) }] };
                }
            },
        );

        server.registerTool(
            "council_host_claim",
            {
                description: "[COUNCIL V3 HOST] Atomically claim or retake an expired host lease.",
                inputSchema: { sessionCode: z.string().min(1), hostId: z.string().uuid() },
            },
            async ({ sessionCode, hostId }, extra) => {
                const denied = requireHost(extra); if (denied) return denied;
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "unknown_session" }) }] };
                    const lease = await councilHostService.claimLease({ sessionId: session.id, hostId });
                    return { content: [{ type: "text", text: JSON.stringify({ ...lease, session: {
                        id: session.id, code: session.code, topic: session.topic, status: session.status,
                        protocolVersion: session.protocolVersion, baseSha: session.baseSha,
                        repoPath: session.repoPath, baseBranch: session.baseBranch,
                    } }) }] };
                } catch (error) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: errMsg(error) }) }] }; }
            },
        );

        server.registerTool(
            "council_host_renew",
            {
                description: "[COUNCIL V3 HOST] Renew the current fenced host lease.",
                inputSchema: { sessionCode: z.string().min(1), hostId: z.string().uuid(), leaseEpoch: z.number().int().positive() },
            },
            async ({ sessionCode, hostId, leaseEpoch }, extra) => {
                const denied = requireHost(extra); if (denied) return denied;
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "unknown_session" }) }] };
                    const lease = await councilHostService.renewLease({ sessionId: session.id, hostId, leaseEpoch });
                    return { content: [{ type: "text", text: JSON.stringify(lease) }] };
                } catch (error) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: errMsg(error) }) }] }; }
            },
        );

        server.registerTool(
            "council_host_release",
            {
                description: "[COUNCIL V3 HOST] Release a host lease during orderly shutdown.",
                inputSchema: { sessionCode: z.string().min(1), hostId: z.string().uuid(), leaseEpoch: z.number().int().positive() },
            },
            async ({ sessionCode, hostId, leaseEpoch }, extra) => {
                const denied = requireHost(extra); if (denied) return denied;
                try {
                    const session = await getSessionByCode(sessionCode);
                    const ok = !!session && await councilHostService.releaseLease({ sessionId: session.id, hostId, leaseEpoch });
                    return { content: [{ type: "text", text: JSON.stringify({ ok }) }] };
                } catch (error) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: errMsg(error) }) }] }; }
            },
        );

        server.registerTool(
            "council_host_issue_seat",
            {
                description: "[COUNCIL V3 HOST] Issue a short-lived credential bound to one agent seat and the current lease.",
                inputSchema: {
                    sessionCode: z.string().min(1), agentName: z.string().min(1),
                    hostId: z.string().uuid(), leaseEpoch: z.number().int().positive(),
                },
            },
            async ({ sessionCode, agentName, hostId, leaseEpoch }, extra) => {
                const denied = requireHost(extra); if (denied) return denied;
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "unknown_session" }) }] };
                    const result = await issueHostSeatKey({ sessionId: session.id, seatName: agentName, hostId, leaseEpoch });
                    return { content: [{ type: "text", text: JSON.stringify(result) }] };
                } catch (error) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: errMsg(error) }) }] }; }
            },
        );

        server.registerTool(
            "council_delivery_state",
            {
                description: "[COUNCIL V3 HOST] Mark a durable delivery in flight or failed immediately around an agent prompt.",
                inputSchema: {
                    deliveryId: z.string().uuid(), hostId: z.string().uuid(), leaseEpoch: z.number().int().positive(),
                    state: z.enum(["in_flight", "failed"]), error: z.string().max(2000).optional(),
                },
            },
            async ({ deliveryId, hostId, leaseEpoch, state, error }, extra) => {
                const denied = requireHost(extra); if (denied) return denied;
                try {
                    const ok = state === "in_flight"
                        ? await councilHostService.markDeliveryInFlight({ deliveryId, hostId, leaseEpoch })
                        : await councilHostService.failDelivery({ deliveryId, hostId, leaseEpoch, error: error ?? "agent turn failed" });
                    return { content: [{ type: "text", text: JSON.stringify({ ok }) }] };
                } catch (cause) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: errMsg(cause) }) }] }; }
            },
        );

        const capabilitySchema = z.object({
            kind: z.enum(["acp", "mcp", "managed_api", "managed_cli", "text_only", "manual"]),
            source: z.enum(["probed", "configured", "declared"]),
            streaming: z.boolean(), cancellation: z.boolean(), sessionResume: z.boolean(),
            modelSelection: z.boolean(), structuredActions: z.boolean(), toolCalls: z.boolean(),
            permissionCallbacks: z.boolean(), filesystemMediated: z.boolean(), terminalMediated: z.boolean(),
            observedAt: z.string().datetime(),
        });
        server.registerTool(
            "council_execution_start",
            {
                description: "[COUNCIL V3 HOST] Append immutable connector, identity, model, branch and base evidence for an agent execution.",
                inputSchema: {
                    sessionCode: z.string().min(1), agentName: z.string().min(1), hostId: z.string().uuid(),
                    leaseEpoch: z.number().int().positive(), hostGeneration: z.string().min(1), capabilities: capabilitySchema,
                    identityAssurance: z.enum(["verified_seat", "host_bound", "owner_relay", "unverified_declaration"]),
                    provider: z.string().min(1), adapterVersion: z.string().optional(), requestedModel: z.string().optional(),
                    effectiveModel: z.string().optional(), requestedReasoningEffort: z.string().optional(),
                    effectiveReasoningEffort: z.string().optional(), modelSource: z.string().optional(), branch: z.string().optional(),
                    worktree: z.string().optional(), baseSha: z.string().optional(),
                },
            },
            async ({ sessionCode, ...params }, extra) => {
                const denied = requireHost(extra); if (denied) return denied;
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "unknown_session" }) }] };
                    const result = await councilHostService.startExecution({ sessionId: session.id, ...params });
                    return { content: [{ type: "text", text: JSON.stringify(result) }] };
                } catch (error) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: errMsg(error) }) }] }; }
            },
        );

        server.registerTool(
            "council_execution_stop",
            {
                description: "[COUNCIL V3 HOST] Close an immutable agent execution record.",
                inputSchema: { executionId: z.string().uuid(), hostId: z.string().uuid(), leaseEpoch: z.number().int().positive(), stopReason: z.string().min(1).max(500) },
            },
            async ({ executionId, hostId, leaseEpoch, stopReason }, extra) => {
                const denied = requireHost(extra); if (denied) return denied;
                try {
                    const ok = await councilHostService.stopExecution({ executionId, hostId, leaseEpoch, stopReason });
                    return { content: [{ type: "text", text: JSON.stringify({ ok }) }] };
                } catch (error) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: errMsg(error) }) }] }; }
            },
        );

        server.registerTool(
            "council_dispatch",
            {
                description:
                    "[COUNCIL V3 HOST] Prepare durable, fenced agent turns. Acknowledge completed delivery IDs; every returned prompt has a stable delivery ID and hash.",
                inputSchema: {
                    sessionCode: z.string().min(1).describe("Session code, e.g. 'CN-4KQ2'."),
                    agentNames: z.array(z.string().min(1)).min(1).max(5).describe("The agents this host owns. Also marks them alive, which is what keeps them eligible for floor election between turns."),
                    hostId: z.string().uuid(),
                    leaseEpoch: z.number().int().positive(),
                    ackDeliveryIds: z.array(z.string().uuid()).max(10).optional(),
                },
            },
            async ({ sessionCode, agentNames, hostId, leaseEpoch, ackDeliveryIds }, extra) => {
                // The host drives other agents' turns; a guest seat drives only
                // itself.
                const denied = requireHost(extra);
                if (denied) return denied;
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) {
                        return { content: [{ type: "text", text: JSON.stringify({ error: "unknown_session", sessionCode }) }] };
                    }
                    if (session.protocolVersion !== 3) {
                        return { content: [{ type: "text", text: JSON.stringify({ error: "not_v3", sessionCode: session.code }) }] };
                    }
                    for (const deliveryId of ackDeliveryIds ?? []) {
                        const ack = await councilHostService.acknowledgeDelivery({ deliveryId, hostId, leaseEpoch });
                        if (!ack.ok) return { content: [{ type: "text", text: JSON.stringify({ error: ack.reason ?? "ack_failed", deliveryId }) }] };
                    }
                    const outcome = await dispatchCouncil({ session, agentNames, durable: true });
                    if (outcome.kind === "degraded") {
                        return { content: [{ type: "text", text: JSON.stringify({ error: "degraded", sessionCode: session.code }) }] };
                    }
                    // No agents key at all: the host must push nothing while the
                    // owner has the room stopped, and an empty roster is the
                    // shape it already treats as "no turns this tick".
                    if (outcome.kind === "paused") {
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    sessionCode: session.code, paused: true,
                                    status: outcome.session.status, round: outcome.session.round,
                                    agents: {},
                                }),
                            }],
                        };
                    }
                    const { session: latest, floorHolder, view } = outcome;
                    // The slice is what the host BRANCHES on; prompt is the same
                    // turn already rendered, non-null exactly when there is a
                    // turn to push. Rendering here keeps one copy of the
                    // agent-facing prose instead of a second one in the host.
                    const overdue = view.participants
                        .filter((p) => p.kind === "agent" && p.status !== "left")
                        .map((p) => p.name);
                    const agentEntries = await Promise.all(Object.entries(view.agents).map(async ([name, slice]) => {
                        const turnDue = slice.fresh.length > 0
                            || slice.hasFloor;
                        if (!turnDue) return [name, { ...slice, prompt: null }] as const;
                        const prompt = renderTurn({
                                    session: latest, agentName: name, fresh: slice.fresh,
                                    openToYou: slice.openToYou, cursor: slice.cursor,
                                    omittedBefore: slice.omittedBefore, hasFloor: slice.hasFloor,
                                    moreRemain: slice.moreRemain,
                                    overdue: overdue.filter((n) => n !== name),
                                });
                        const prepared = await councilHostService.prepareDelivery({
                            sessionId: latest.id, agentName: name, hostId, leaseEpoch,
                            fromSeq: Math.max(0, view.participants.find((p) => p.name === name)?.cursorSeq ?? 0),
                            throughSeq: slice.delivered, promptHash: promptDigest(prompt), promptBody: prompt,
                        });
                        if (!prepared.ok || !prepared.delivery) {
                            throw new Error(`delivery for ${name} rejected: ${prepared.reason ?? "unknown"}`);
                        }
                        const delivery = prepared.delivery;
                        return [name, {
                            ...slice, prompt: delivery.promptBody, deliveryId: delivery.id,
                            promptHash: delivery.promptHash, attempt: delivery.attempt,
                            redelivered: delivery.redelivered,
                        }] as const;
                    }));
                    const agents = Object.fromEntries(agentEntries);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                sessionCode: latest.code,
                                topic: latest.topic,
                                status: latest.status,
                                round: latest.round,
                                maxRounds: latest.maxRounds,
                                lastSeq: latest.lastSeq,
                                lastMessageAt: latest.lastMessageAt,
                                closerName: latest.closerName,
                                verdict: latest.verdict,
                                openQuestions: latest.openQuestions,
                                vaultPath: latest.vaultPath,
                                floorHolder,
                                participants: view.participants.map((p) => ({
                                    name: p.name, kind: p.kind, status: p.status,
                                    postsTotal: p.postsTotal, cursorSeq: p.cursorSeq,
                                    dispatchMode: p.dispatchMode, lastSeenAt: p.lastSeenAt,
                                })),
                                agents,
                            }),
                        }],
                    };
                } catch (error) {
                    return { content: [{ type: "text", text: JSON.stringify({ error: errMsg(error) }) }] };
                }
            },
        );

        server.registerTool(
            "council_work_next",
            { description: "[COUNCIL WORK CAMPAIGN] Claim or resume your assigned task after the council closes. Work only in your worktree, heartbeat at milestones, then commit, verify and submit it for review.", inputSchema: { sessionCode: z.string().min(1), agentName: z.string().min(1) } },
            async ({ sessionCode, agentName }, extra) => {
                const coarse = requireCouncil(extra); if (coarse) return coarse;
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) return { content: [{ type: "text", text: renderUnknownSession(sessionCode) }] };
                    const wrongSeat = requireSeat(extra, { sessionId: session.id, agentName, protocolVersion: session.protocolVersion });
                    if (wrongSeat) return wrongSeat;
                    if (session.status !== "closed") return { content: [{ type: "text", text: "WORK_NOT_READY - the council has not closed yet. Continue the council protocol." }] };
                    const campaign = await getCampaignForSession(session.id);
                    if (!campaign) return { content: [{ type: "text", text: "NO_WORK_CAMPAIGN - no implementation tasks were recorded for this council. Stop here and wait for human direction." }] };
                    const item = await claimNextWorkItem(session.id, agentName);
                    if (!item) return { content: [{ type: "text", text: "WORK_IDLE - campaign " + campaign.status + ". You have no runnable task. Do not take another agent's work." }] };
                    return { content: [{ type: "text", text: "WORK_ASSIGNED - " + item.id + "\nTask " + item.sequence + ": " + item.title + "\n\n" + item.instructions + "\n\nAcceptance criteria:\n" + item.acceptanceCriteria.map((criterion) => "- " + criterion).join("\n") + "\n\nNEXT -> council_work_heartbeat({itemId: \"" + item.id + "\", agentName: \"" + agentName + "\", progress: \"started\"})" }] };
                } catch (error) { return { content: [{ type: "text", text: "Work claim failed: " + errMsg(error) }] }; }
            },
        );

        server.registerTool(
            "council_work_heartbeat",
            { description: "[COUNCIL WORK CAMPAIGN] Record progress on your assigned in-progress task at meaningful milestones.", inputSchema: { itemId: z.string().uuid(), agentName: z.string().min(1), progress: z.string().min(1).max(1000).optional() } },
            async ({ itemId, agentName, progress }, extra) => {
                const denied = requireCouncil(extra) ?? requireSeat(extra, { agentName }); if (denied) return denied;
                try { const ok = await heartbeatWorkItem({ itemId, agentName, progress }); return { content: [{ type: "text", text: ok ? "WORK_HEARTBEAT_RECORDED" : "WORK_HEARTBEAT_REJECTED - this is not your active task." }] }; }
                catch (error) { return { content: [{ type: "text", text: "Heartbeat failed: " + errMsg(error) }] }; }
            },
        );

        server.registerTool(
            "council_work_complete",
            { description: "[COUNCIL WORK CAMPAIGN] Submit a committed, verified task for closer review. This never self-approves the work.", inputSchema: { itemId: z.string().uuid(), agentName: z.string().min(1), commitHash: z.string().min(1).max(120), verification: z.string().min(1).max(4000) } },
            async ({ itemId, agentName, commitHash, verification }, extra) => {
                const denied = requireCouncil(extra) ?? requireSeat(extra, { agentName }); if (denied) return denied;
                try { const ok = await completeWorkItem({ itemId, agentName, commitHash, verification }); return { content: [{ type: "text", text: ok ? "WORK_AWAITING_REVIEW - stop here until the designated closer reviews this task." : "WORK_COMPLETE_REJECTED - this is not your active task." }] }; }
                catch (error) { return { content: [{ type: "text", text: "Completion failed: " + errMsg(error) }] }; }
            },
        );

        server.registerTool(
            "council_work_block",
            { description: "[COUNCIL WORK CAMPAIGN] Mark your task blocked when it needs a human decision, missing access or an external dependency.", inputSchema: { itemId: z.string().uuid(), agentName: z.string().min(1), reason: z.string().min(1).max(2000) } },
            async ({ itemId, agentName, reason }, extra) => {
                const denied = requireCouncil(extra) ?? requireSeat(extra, { agentName }); if (denied) return denied;
                try { const ok = await blockWorkItem({ itemId, agentName, reason }); return { content: [{ type: "text", text: ok ? "WORK_BLOCKED - stop the task and report the recorded blocker." : "WORK_BLOCK_REJECTED - this is not your active task." }] }; }
                catch (error) { return { content: [{ type: "text", text: "Block failed: " + errMsg(error) }] }; }
            },
        );

        server.registerTool(
            "council_work_review",
            { description: "[COUNCIL WORK CAMPAIGN] Designated closer only: accept a submitted task after reviewing its diff and verification, or return it to its owner with specific feedback. The campaign completes only after every task is accepted.", inputSchema: { itemId: z.string().uuid(), agentName: z.string().min(1), accepted: z.boolean(), note: z.string().min(1).max(3000) } },
            async ({ itemId, agentName, accepted, note }, extra) => {
                const denied = requireCouncil(extra) ?? requireSeat(extra, { agentName }); if (denied) return denied;
                try {
                    const res = await reviewWorkItem({ itemId, reviewer: agentName, accepted, note });
                    if (res.ok) {
                        return { content: [{ type: "text", text: accepted ? "WORK_VERIFIED" : "WORK_RETURNED_TO_OWNER" }] };
                    }
                    const why = res.reason === "not_host_verified" || res.reason === "not_exactly_verified"
                        ? "WORK_REVIEW_REJECTED - no passing host receipt matches this exact commit, frozen base and verification profile. Agent-reported verification is not enough."
                        : res.reason === "not_the_closer"
                            ? "WORK_REVIEW_REJECTED - only the designated closer may review a task."
                            : `WORK_REVIEW_REJECTED - ${res.reason ?? "unknown"}.`;
                    return { content: [{ type: "text", text: why }] };
                }
                catch (error) { return { content: [{ type: "text", text: "Review failed: " + errMsg(error) }] }; }
            },
        );

        // Host-only, and JSON rather than prose: council_work_status is written
        // for an agent to read and the supervise loop branches on its wording,
        // so the machine-readable view is a separate tool.
        server.registerTool(
            "council_work_unverified",
            {
                description: "[COUNCIL WORK CAMPAIGN] Host only: submitted tasks the host has not checked yet, as JSON. Used to drive independent verification of each commit.",
                inputSchema: { sessionCode: z.string().min(1) },
            },
            async ({ sessionCode }, extra) => {
                const denied = requireHost(extra);
                if (denied) return denied;
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) return { content: [{ type: "text", text: JSON.stringify({ error: "unknown_session" }) }] };
                    const campaign = await getCampaignForSession(session.id);
                    if (!campaign) return { content: [{ type: "text", text: JSON.stringify({ items: [] }) }] };
                    const items = (await listCampaignWorkItems(campaign.id))
                        .filter((i) => i.status === "awaiting_review" && i.hostVerified === null)
                        .map((i) => ({
                            id: i.id, agentName: i.agentName, status: i.status,
                            commitHash: i.commitHash, declaredPaths: i.declaredPaths,
                            branchName: i.branchName, verificationProfile: i.verificationProfile,
                        }));
                    return { content: [{ type: "text", text: JSON.stringify({
                        campaignId: campaign.id, baseSha: campaign.baseSha,
                        verificationProfile: campaign.verificationProfile, items,
                    }) }] };
                } catch (error) {
                    return { content: [{ type: "text", text: JSON.stringify({ error: errMsg(error) }) }] };
                }
            },
        );

        // Host-only. The host owns the repo and can check a submitted commit
        // itself, which is the only verification the review gate accepts.
        server.registerTool(
            "council_work_verify",
            {
                description: "[COUNCIL WORK CAMPAIGN] Host only: record what the HOST observed about a submitted commit, independently of what the agent claimed. A failed check returns the task to its owner. The closer cannot accept a task until this passes.",
                inputSchema: {
                    itemId: z.string().uuid(), hostId: z.string().uuid(), leaseEpoch: z.number().int().positive(),
                    commitSha: z.string().regex(/^[0-9a-f]{40}$/i), baseSha: z.string().regex(/^[0-9a-f]{40}$/i),
                    branchName: z.string().min(1).max(300), profileId: z.string().min(1).max(100), passed: z.boolean(),
                    receipts: z.array(z.object({ command: z.array(z.string()), exitCode: z.number().int().nullable(), durationMs: z.number().nonnegative(), outputDigest: z.string(), outputTail: z.string(), timedOut: z.boolean().optional() })).max(20),
                    outputDigest: z.string().min(1),
                    report: z.string().min(1).max(16000).describe("Checks run and their outcomes, bound to the exact commit and frozen base."),
                },
            },
            async ({ itemId, hostId, leaseEpoch, commitSha, baseSha, branchName, profileId, receipts, outputDigest, passed, report }, extra) => {
                const denied = requireHost(extra);
                if (denied) return denied;
                try {
                    const result = await recordExactVerification({ itemId, hostId, leaseEpoch, commitSha, baseSha, branchName, profileId, receipts, outputDigest, passed, report });
                    return { content: [{ type: "text", text: result.ok ? JSON.stringify(result) : JSON.stringify(result) }] };
                } catch (error) {
                    return { content: [{ type: "text", text: "Host verify failed: " + errMsg(error) }] };
                }
            },
        );

        server.registerTool(
            "council_integration_manifest",
            {
                description: "[COUNCIL V3 HOST] Freeze and return the immutable ordered manifest of exactly accepted commit SHAs.",
                inputSchema: { sessionCode: z.string().min(1), hostId: z.string().uuid(), leaseEpoch: z.number().int().positive() },
            },
            async ({ sessionCode, hostId, leaseEpoch }, extra) => {
                const denied = requireHost(extra); if (denied) return denied;
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "unknown_session" }) }] };
                    const result = await freezeIntegrationManifest({ sessionId: session.id, hostId, leaseEpoch });
                    const campaign = await getCampaignForSession(session.id);
                    return { content: [{ type: "text", text: JSON.stringify({ ...result, integratorAgent: campaign?.integratorAgent ?? null }) }] };
                } catch (error) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: errMsg(error) }) }] }; }
            },
        );

        server.registerTool(
            "council_integration_report",
            {
                description: "[COUNCIL WORK CAMPAIGN] Host or nominated integrator: record the result of assembling every accepted task on a clean integration branch and running the full project checks. A campaign is not done because each task passed alone.",
                inputSchema: {
                    sessionCode: z.string().min(1),
                    status: z.enum(["running", "verified", "conflict", "failed"]),
                    branch: z.string().max(200).optional(),
                    tipSha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
                    hostId: z.string().uuid(), leaseEpoch: z.number().int().positive(),
                    reporter: z.string().min(1),
                    report: z.string().min(1).max(16000),
                },
            },
            async ({ sessionCode, status, branch, tipSha, hostId, leaseEpoch, reporter, report }, extra) => {
                const denied = requireHost(extra);
                if (denied) return denied;
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) return { content: [{ type: "text", text: renderUnknownSession(sessionCode) }] };
                    const res = await recordV3Integration({ sessionId: session.id, reporter, hostId, leaseEpoch, status, branch, tipSha, report });
                    return { content: [{ type: "text", text: res.ok ? `INTEGRATION_${status.toUpperCase()}` : `INTEGRATION_REJECTED - ${res.reason ?? "unknown"}` }] };
                } catch (error) {
                    return { content: [{ type: "text", text: "Integration report failed: " + errMsg(error) }] };
                }
            },
        );

        server.registerTool(
            "council_work_status",
            { description: "[COUNCIL WORK CAMPAIGN] Read campaign progress and assigned task states without changing them. Use for supervision and recovery.", inputSchema: { sessionCode: z.string().min(1), agentName: z.string().min(1).optional() } },
            async ({ sessionCode, agentName }) => {
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) return { content: [{ type: "text", text: renderUnknownSession(sessionCode) }] };
                    const campaign = await getCampaignForSession(session.id);
                    if (!campaign) return { content: [{ type: "text", text: "SUPERVISE: idle\nNo work campaign exists." }] };
                    const items = await listCampaignWorkItems(campaign.id);
                    const owned = agentName ? items.filter((item) => item.agentName === agentName) : [];
                    const hasReview = agentName === session.closerName && items.some((item) => item.status === "awaiting_review");
                    const supervise = hasReview ? "review" : owned.some((item) => item.status === "queued" || item.status === "in_progress") ? "active" : "idle";
                    const state = campaign.status === "complete" ? "complete" : campaign.status === "blocked" ? "blocked" : supervise;
                    return { content: [{ type: "text", text: "SUPERVISE: " + state + "\nCampaign " + campaign.status + ": " + items.filter((item) => item.status === "verified").length + "/" + items.length + " verified\n" + items.map((item) => "#" + item.sequence + " " + item.agentName + " " + item.status + " " + item.title).join("\n") }] };
                } catch (error) { return { content: [{ type: "text", text: "Campaign status failed: " + errMsg(error) }] }; }
            },
        );

        server.registerTool(
            "council_pass",
            {
                description:
                    "[COUNCIL PROTOCOL] Declare that you have nothing to add this round. This is a real contribution, not a forfeit: a round only advances once every participant has posted or passed, so passing is how you unblock the others instead of leaving them staring at silence. Give a one-line reason so the transcript records why. Set done:true only when you are finished with the council entirely; that stops the others waiting on you and releases you after this call. Prefer council_speak with intent 'concede' if you actually agree with somebody, so the transcript shows agreement rather than absence.",
                inputSchema: {
                    sessionCode: z.string().min(1).describe("Session code, e.g. 'CN-4KQ2'."),
                    agentName: z.string().min(1).describe("Your council name."),
                    reason: z.string().min(1).max(500).describe("One line: why you have nothing to add, or your final position if done:true."),
                    done: z.boolean().optional().describe("true = you are leaving for good and the others should stop waiting on you. Default false: you are passing this round only and will keep waiting."),
                },
            },
            async ({ sessionCode, agentName, reason, done }, extra) => {
                const denied = requireCouncil(extra);
                if (denied) return denied;
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) {
                        return { content: [{ type: "text", text: renderUnknownSession(sessionCode) }] };
                    }
                    const wrongSeat = requireSeat(extra, { sessionId: session.id, agentName, protocolVersion: session.protocolVersion });
                    if (wrongSeat) return wrongSeat;
                    const me = await getParticipant(session.id, agentName);
                    if (!me) {
                        return { content: [{ type: "text", text: renderNotAParticipant(session.code, agentName) }] };
                    }

                    const result = await appendMessage({
                        sessionId: session.id,
                        speaker: agentName,
                        intent: "pass",
                        body: reason,
                        clientKey: `${agentName}-pass-r${session.round}-${done ? "done" : "round"}`,
                    });
                    if (!result.ok) {
                        return { content: [{ type: "text", text: `NOT_YOUR_TURN - nothing was recorded (${result.reason}).\n\nNEXT → council_wait({"sessionCode":"${session.code}","agentName":"${agentName}"})` }] };
                    }

                    if (done) {
                        await leaveCouncil(session.id, agentName);
                        return { content: [{ type: "text", text: renderLeft(session, agentName, reason) }] };
                    }
                    return {
                        content: [{
                            type: "text",
                            text: renderPassed({
                                session, agentName,
                                cursor: result.seq ?? session.lastSeq,
                                advanced: result.advanced === true,
                            }),
                        }],
                    };
                } catch (error) {
                    return { content: [{ type: "text", text: `Pass failed: ${errMsg(error)}` }] };
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
    const host = process.env.MCP_COUNCIL_HOST_KEY;
    if (host && bearerToken === host) {
        return { token: bearerToken, clientId: "council-host", scopes: ["council:host"] };
    }
    if (rw && bearerToken === rw) {
        return { token: bearerToken, clientId: "mcp-external-rw", scopes: ["knowledge:read", "knowledge:write"] };
    }
    if (ro && bearerToken === ro) {
        return { token: bearerToken, clientId: "mcp-external-ro", scopes: ["knowledge:read"] };
    }
    // A guest seat: one council, one seat, expires with the session. The
    // identity rides in clientId because the council tools have to check it
    // against whatever they are being asked to act on.
    const seat = await resolveSeatKey(bearerToken);
    if (seat) {
        return {
            token: bearerToken,
            clientId: `council-seat:${seat.sessionId}:${seat.seatName}`,
            scopes: ["council:seat"],
        };
    }
    return undefined;
};

const authHandler = withMcpAuth(handler, verifyToken, { required: true });

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
