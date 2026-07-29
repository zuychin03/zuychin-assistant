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
    renderCloseOutcome, renderConveneResult, renderLeft, renderNotAParticipant, renderPassed,
    renderRosterRejection, renderRulebook, renderSpeakResult, renderTranscript,
    renderUnknownSession, renderWaitResult,
} from "@/lib/council/render";
import { pollCouncil } from "@/lib/council/wait";
import { closeCouncil } from "@/lib/council/close";
import { moderateRound } from "@/lib/council/moderator";

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

// Council participation is a durable, Discord-mirrored write, so it rides the
// existing knowledge:write gate rather than minting a scope that would need its
// own key rotation. Read-only keys observe via council_transcript.
const requireCouncil = requireWrite;

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

        server.registerTool(
            "council_convene",
            {
                description:
                    "[COUNCIL PROTOCOL] Open a new council: a live multi-round debate between several AI agents, held inside Zuychin. Returns a short session code plus a ready-to-paste kickoff block for every participant — hand each block to its agent unchanged and it will join and run the protocol on its own. You are convening, not debating: convene once, then paste. Name every participant up front; the roster is closed afterwards and an unknown agentName is rejected, which is what stops a typo from creating a phantom participant. Pick one closerName — only that participant may call council_conclude. Prefer save_note or vault_ingest if you only want to record a conclusion you already hold; a council is for questions where you want disagreement.",
                inputSchema: {
                    topic: z.string().min(1).describe("The question under debate, phrased as one decidable question."),
                    brief: z.string().min(1).describe("Context every participant needs: constraints, what has been tried, what a good answer looks like. Pasted verbatim into each agent's first tool result."),
                    participants: z.array(z.object({
                        name: z.string().min(1).max(40),
                        expertise: z.string().min(1),
                    })).min(2).max(5).describe("Agents to invite. Short lowercase handles the human will type into each agent ('codex', 'claude-code', 'cursor')."),
                    closerName: z.string().min(1).describe("Which participant may call council_conclude. Must be one of participants[].name."),
                    maxRounds: z.number().int().min(2).max(10).optional().describe("Rounds before the council must conclude (default 6)."),
                    maxMessages: z.number().int().min(10).max(200).optional().describe("Hard message cap for the whole session (default 60)."),
                    ttlMinutes: z.number().int().min(10).max(240).optional().describe("Hard expiry from now (default 90). The session self-terminates at this deadline whether or not anyone concludes."),
                },
            },
            async ({ topic, brief, participants, closerName, maxRounds, maxMessages, ttlMinutes }, extra) => {
                const denied = requireCouncil(extra);
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

                    const session = await createCouncilSession({
                        topic, brief, closerName, participants, maxRounds, maxMessages, ttlMinutes,
                    });
                    const roster = await listParticipants(session.id);
                    return { content: [{ type: "text", text: renderConveneResult(session, roster) }] };
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
                    agentName: z.string().min(1).describe("Your council name, exactly as your human gave it. Use it unchanged in every later call — a mismatch makes you invisible to the council."),
                    expertise: z.string().optional().describe("One line on what you bring. Shown to the other participants."),
                },
            },
            async ({ sessionCode, agentName, expertise }, extra) => {
                const denied = requireCouncil(extra);
                if (denied) return denied;
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) {
                        return { content: [{ type: "text", text: renderUnknownSession(sessionCode) }] };
                    }
                    const result = await joinCouncil({ sessionId: session.id, agentName, expertise });
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
                    "[COUNCIL PROTOCOL] Read a council transcript without participating. Works with a read-only MCP key, so this is the observer's tool and the human's tool. Use it to catch up when a result told you messages were omitted, to review a closed council before acting on its verdict, or to check on a council you were not invited to. It never blocks, never marks you present, and never changes whose turn it is — it will not advance a debate, so do not poll it in place of council_wait.",
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
                    "[COUNCIL PROTOCOL] Block for up to 30 seconds waiting for another participant to speak, then return everything new since sinceSeq. Use this when you have nothing to post yet — otherwise prefer council_speak, which posts and waits in one call. AN EMPTY RESULT IS NORMAL AND IS NOT AN ERROR: it means nobody spoke inside the window, and the correct response is to call it again immediately with the same sinceSeq. Never treat it as failure, never report it to your human, never stop because of it. If nobody has spoken for 8 seconds the floor is granted to you automatically, so waiting can never be terminal. Only a result containing \"=== COUNCIL CLOSED ===\" releases you from the loop. Requires a read-write key; use council_transcript to observe without participating.",
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
                    const result = await pollCouncil({
                        session,
                        agentName,
                        sinceSeq,
                        waitMs: clampWaitMs(waitSeconds),
                        signal: extra.signal,
                    });
                    return { content: [{ type: "text", text: renderWaitResult(result, { sessionCode: session.code, agentName }) }] };
                } catch (error) {
                    return { content: [{ type: "text", text: `Wait failed: ${errMsg(error)}. This is not the council closing — call council_wait again.` }] };
                }
            },
        );

        server.registerTool(
            "council_speak",
            {
                description:
                    "[COUNCIL PROTOCOL] Say one thing to the council, then block until someone replies. This is the tool you spend the council in: posting and waiting are one call on purpose, because two calls would double your own token cost for nothing. Declare an intent; answer or concede first if anything is listed under OPEN TO YOU, then propose or refine. Set addressedTo when challenging or asking. Set replyToSeq to the seq you are responding to — that is what clears the obligation. clientKey must be a stable id you choose BEFORE the first attempt; reuse the exact same key if the call times out and you retry, and the retry returns the original message number instead of posting twice. You get 2 posts per round; over quota this returns NOT_YOUR_TURN, records nothing, and blocks anyway, which is a normal outcome and not a failure. The result carries every message that arrived while you waited, plus a NEXT line with the exact next call.",
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
                    const roster = await listParticipants(session.id);
                    if (!roster.some((p) => p.name === agentName && p.kind === "agent")) {
                        return { content: [{ type: "text", text: renderNotAParticipant(session.code, agentName) }] };
                    }

                    // Validated before the append, so a malformed call records
                    // nothing rather than a message nobody is obliged to answer.
                    const target = addressedTo ?? "all";
                    const validTargets = [...roster.map((p) => p.name), "all"];
                    if (!validTargets.includes(target)) {
                        return { content: [{ type: "text", text: `PROTOCOL_ERROR — nothing was recorded.\naddressedTo "${target}" is not on the roster. Valid values: ${validTargets.join(", ")}.\n\nNEXT → repeat your council_speak call with a valid addressedTo.` }] };
                    }
                    if (INTENTS_REQUIRING_TARGET.includes(intent as CouncilIntent) && target === "all") {
                        return { content: [{ type: "text", text: `PROTOCOL_ERROR — nothing was recorded.\nintent "${intent}" must name one participant in addressedTo. Valid values: ${validTargets.filter((n) => n !== "all").join(", ")}.\n\nNEXT → repeat your council_speak call with addressedTo set.` }] };
                    }
                    if (INTENTS_REQUIRING_REPLY_TO.includes(intent as CouncilIntent) && replyToSeq === undefined) {
                        return { content: [{ type: "text", text: `PROTOCOL_ERROR — nothing was recorded.\nintent "${intent}" must set replyToSeq to the seq you are responding to; that is what clears the obligation.\n\nNEXT → repeat your council_speak call with replyToSeq set.` }] };
                    }

                    const post = await appendMessage({
                        sessionId: session.id, speaker: agentName, intent, body: message,
                        clientKey, addressedTo: target, replyToSeq, ackSeq: sinceSeq,
                    });
                    if (post.advanced) scheduleModeration(session.id, post.round);

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
                            text: renderSpeakResult({
                                post: {
                                    ...post, intent, addressedTo: target, replyToSeq,
                                    truncatedChars: message.length > MAX_BODY_CHARS ? message.length - MAX_BODY_CHARS : undefined,
                                },
                                result, session, agentName,
                            }),
                        }],
                    };
                } catch (error) {
                    return { content: [{ type: "text", text: `Speak failed: ${errMsg(error)}. This is not the council closing — check council_transcript before retrying with the SAME clientKey.` }] };
                }
            },
        );

        server.registerTool(
            "council_conclude",
            {
                description:
                    "[COUNCIL PROTOCOL] Close the council and file the outcome. Only the participant named as closer at convene time may call this, and only once; anyone else, or a second call, gets a refusal and changes nothing. Writes the verdict, announces it to the human's Discord, and files the transcript as a quarantined vault page. Your verdict must state the decision, the reasoning that settled it, and who dissented and why; do not manufacture consensus the transcript does not show, and put anything genuinely unresolved in openQuestions where it becomes a follow-up rather than quietly disappearing. Call this when the debate has converged, when a result told you the council is concluding, or when the council was declared stalled. Returns the vault path — report it to your human.",
                inputSchema: {
                    sessionCode: z.string().min(1).describe("Session code, e.g. 'CN-4KQ2'."),
                    agentName: z.string().min(1).describe("Your council name. Must match the closer named at convene time."),
                    verdict: z.string().min(1).max(4000).describe("The decision, the reasoning that settled it, and named dissent. Cite seq numbers. This is what the human reads."),
                    openQuestions: z.array(z.string().min(1)).max(8).optional().describe("What stayed unresolved. Each becomes a follow-up todo for the human."),
                },
            },
            async ({ sessionCode, agentName, verdict, openQuestions }, extra) => {
                const denied = requireCouncil(extra);
                if (denied) return denied;
                try {
                    const session = await getSessionByCode(sessionCode);
                    if (!session) {
                        return { content: [{ type: "text", text: renderUnknownSession(sessionCode) }] };
                    }
                    if (agentName !== session.closerName) {
                        return { content: [{ type: "text", text: `NOT_YOUR_TURN — only ${session.closerName} may conclude ${session.code}. Nothing was changed.\n\nNEXT → council_wait({"sessionCode":"${session.code}","agentName":"${agentName}"})` }] };
                    }
                    const outcome = await closeCouncil({
                        session, closer: agentName, verdict, openQuestions: openQuestions ?? [],
                    });
                    return { content: [{ type: "text", text: renderCloseOutcome(session, outcome) }] };
                } catch (error) {
                    return { content: [{ type: "text", text: `Conclude failed: ${errMsg(error)}` }] };
                }
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
                        return { content: [{ type: "text", text: `NOT_YOUR_TURN — nothing was recorded (${result.reason}).\n\nNEXT → council_wait({"sessionCode":"${session.code}","agentName":"${agentName}"})` }] };
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
