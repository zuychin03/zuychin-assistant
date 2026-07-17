import { ai, MODEL } from "@/lib/gemini";
import { Type } from "@google/genai";
import { embedText } from "@/lib/ai/embeddings";
import {
    searchMemories, insertMemory, updateMemoryFact, deleteMemory, reinforceMemory,
    memoryEmbeddingRef, type MemoryCategory, type MemoryHit,
} from "@/lib/ai/memory/store";

const CATEGORIES: MemoryCategory[] = ["identity", "preference", "relationship", "project", "routine", "fact", "other"];
const MAX_OPS = 4;
// Low threshold on purpose: we want near-misses as consolidation candidates.
const CANDIDATE_THRESHOLD = 0.35;
const CANDIDATE_COUNT = 8;
// Work/study observations enter as invisible candidates; everything else is a
// personal-life fact that must meet the explicit-statement bar in the prompt.
const PATTERN_GATED: MemoryCategory[] = ["project"];

interface ExtractOp {
    op: "ADD" | "UPDATE" | "DELETE" | "CONFIRM" | "NOOP";
    existing_index?: number;
    fact?: string;
    category?: string;
    scope?: "global" | "project";
}

// Post-turn fact extraction with Mem0-style consolidation: one structured call
// decides ADD/UPDATE/DELETE/CONFIRM/NOOP against the nearest existing facts, so
// contradictions get resolved instead of accumulating. Never throws: memory
// is best-effort and must not affect the reply path.
export async function extractMemories(params: {
    userMessage: string;
    assistantReply: string;
    channel: string;
    userProfileId?: string;
    projectId?: string;
    conversationId?: string;
}): Promise<void> {
    const { userMessage, assistantReply, channel, userProfileId, projectId, conversationId } = params;
    try {
        const trimmed = userMessage.trim();
        if (trimmed.length < 15 || trimmed.startsWith("/")) return;

        // Messaging channels have no conversation ids; a day bucket makes
        // "repeated on another day" count as fresh pattern evidence there.
        const evidenceKey = conversationId ?? `${channel}:${new Date().toISOString().slice(0, 10)}`;

        const embRef = await memoryEmbeddingRef();
        const queryEmbedding = await embedText(embRef, trimmed, "query");
        const existing = await searchMemories({
            queryEmbedding,
            userId: userProfileId,
            projectId,
            matchThreshold: CANDIDATE_THRESHOLD,
            matchCount: CANDIDATE_COUNT,
        });

        const ops = await proposeOperations(trimmed, assistantReply, existing, !!projectId);
        if (!ops || ops.length === 0) return;

        for (const op of ops.slice(0, MAX_OPS)) {
            const category = CATEGORIES.includes(op.category as MemoryCategory)
                ? (op.category as MemoryCategory)
                : "other";
            const target = Number.isInteger(op.existing_index) && op.existing_index! >= 0 && op.existing_index! < existing.length
                ? existing[op.existing_index!]
                : null;

            if (op.op === "ADD" && op.fact) {
                await insertMemory({
                    fact: op.fact,
                    category,
                    source: channel,
                    userProfileId,
                    projectId: op.scope === "project" ? projectId : undefined,
                    status: PATTERN_GATED.includes(category) ? "candidate" : "confirmed",
                    evidenceKey,
                });
            } else if (op.op === "UPDATE" && op.fact && target) {
                await updateMemoryFact({ id: target.id, fact: op.fact, category });
                await reinforceMemory(target.id, evidenceKey);
            } else if (op.op === "CONFIRM" && target) {
                await reinforceMemory(target.id, evidenceKey);
            } else if (op.op === "DELETE" && target) {
                await deleteMemory(target.id);
            }
        }
    } catch (err) {
        console.warn("[Memory] Extraction failed:", err);
    }
}

async function proposeOperations(
    userMessage: string,
    assistantReply: string,
    existing: MemoryHit[],
    inProject: boolean,
): Promise<ExtractOp[] | null> {
    const existingListing = existing.length > 0
        ? existing.map((m, i) => `${i}. [${m.category}${m.status === "candidate" ? ", unconfirmed pattern" : ""}] ${m.fact}`).join("\n")
        : "(none)";

    try {
        const res = await ai.models.generateContent({
            model: MODEL,
            contents: `You maintain a long-term memory of durable facts about one user, extracted from their conversations with an assistant. Precision matters far more than recall: a wrong or stale fact actively harms the assistant. Returning zero operations is the normal outcome for most exchanges.

Two kinds of facts, with different bars:

1. PERSONAL LIFE (categories: identity, relationship, preference, routine, fact) — capture ONLY what the user explicitly and literally stated about their real life: who people are, where they or the people close to them live, names, important dates, stable likes/dislikes, habits. These matter most — a detail like where the user's partner lives must not be missed when clearly stated. Rules:
   - The user must have SAID it, in this exchange. Never infer it from a question, a hypothetical, a task, or anything the assistant said.
   - It must be durable: still true and worth knowing a month from now. No recent trips, moods, one-off events, or pending tasks (a to-do list handles those).
   - Prefer specific over vague ("Cathy lives in Sydney" beats "the user has a girlfriend").

2. WORK / STUDY (category: project) — tools, frameworks, projects, courses, research topics, professional patterns. Use category "project" for ALL of these. Do not judge one mention as a fact; propose it anyway and the system tracks it as an unconfirmed pattern until it repeats in a later conversation. If the exchange shows the SAME pattern as an existing fact marked "unconfirmed pattern", emit CONFIRM with its index instead of ADD.

Consolidate against the existing facts listed below: if a new fact refines or contradicts an existing one, UPDATE it (new information wins); if an existing fact is now clearly false, DELETE it; CONFIRM an unconfirmed pattern the exchange demonstrates again; only ADD when nothing similar exists. Never ADD a rewording of an existing fact. At most ${MAX_OPS} operations. Each fact must be one self-contained sentence.${inProject ? `\nScope: mark a fact "project" only if it is specific to the current project context; general facts about the user are "global".` : ""}

Existing facts:
${existingListing}

Exchange:
User: ${userMessage.slice(0, 2000)}
Assistant: ${assistantReply.slice(0, 1000)}`,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        operations: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    op: { type: Type.STRING, enum: ["ADD", "UPDATE", "DELETE", "CONFIRM", "NOOP"] },
                                    existing_index: { type: Type.INTEGER, description: "Index into the existing facts list (UPDATE/DELETE/CONFIRM only)." },
                                    fact: { type: Type.STRING, description: "The fact text (ADD/UPDATE only)." },
                                    category: { type: Type.STRING, enum: CATEGORIES },
                                    scope: { type: Type.STRING, enum: ["global", "project"] },
                                },
                                required: ["op"],
                            },
                        },
                    },
                    required: ["operations"],
                },
            },
        });

        const parsed = JSON.parse(res.text ?? "") as { operations: ExtractOp[] };
        return parsed.operations.filter((o) => o.op !== "NOOP");
    } catch (err) {
        console.warn("[Memory] Extraction call failed:", err);
        return null;
    }
}
