import { ai, MODEL } from "@/lib/gemini";
import { Type } from "@google/genai";
import { embedText, type ResolvedEmbedding } from "@/lib/ai/embeddings";
import { searchMemories, insertMemory, updateMemoryFact, deleteMemory, type MemoryCategory, type MemoryHit } from "@/lib/ai/memory/store";

const CATEGORIES: MemoryCategory[] = ["identity", "preference", "relationship", "project", "routine", "fact", "other"];
const MAX_OPS = 4;
// Low threshold on purpose: we want near-misses as consolidation candidates.
const CANDIDATE_THRESHOLD = 0.35;
const CANDIDATE_COUNT = 8;

interface ExtractOp {
    op: "ADD" | "UPDATE" | "DELETE" | "NOOP";
    existing_index?: number;
    fact?: string;
    category?: string;
    scope?: "global" | "project";
}

// Post-turn fact extraction with Mem0-style consolidation: one structured call
// decides ADD/UPDATE/DELETE/NOOP against the nearest existing facts, so
// contradictions get resolved instead of accumulating. Never throws — memory
// is best-effort and must not affect the reply path.
export async function extractMemories(params: {
    userMessage: string;
    assistantReply: string;
    channel: string;
    userProfileId?: string;
    embRef: ResolvedEmbedding;
    projectId?: string;
}): Promise<void> {
    const { userMessage, assistantReply, channel, userProfileId, embRef, projectId } = params;
    try {
        const trimmed = userMessage.trim();
        if (trimmed.length < 15 || trimmed.startsWith("/")) return;

        const queryEmbedding = await embedText(embRef, trimmed, "query");
        const existing = await searchMemories({
            queryEmbedding,
            embeddingModel: embRef.model.id,
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
                    embRef,
                    userProfileId,
                    projectId: op.scope === "project" ? projectId : undefined,
                });
            } else if (op.op === "UPDATE" && op.fact && target) {
                await updateMemoryFact({ id: target.id, fact: op.fact, category, embRef });
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
        ? existing.map((m, i) => `${i}. [${m.category}] ${m.fact}`).join("\n")
        : "(none)";

    try {
        const res = await ai.models.generateContent({
            model: MODEL,
            contents: `You maintain a long-term memory of durable facts about one user, extracted from their conversations with an assistant.

From the exchange below, extract ONLY durable user facts worth remembering across future conversations: identity details, stable preferences, relationships (people, pets), ongoing projects/goals, routines, and hard facts about their life. EXCLUDE one-off requests, questions, task content, opinions about the current task, and anything the assistant said that the user didn't confirm. Returning zero operations is the normal outcome for most exchanges.

Consolidate against the existing facts listed below: if a new fact refines or contradicts an existing one, UPDATE it (new information wins); if an existing fact is now clearly false, DELETE it; only ADD when nothing similar exists. At most ${MAX_OPS} operations. Each fact must be one self-contained sentence.${inProject ? `\nScope: mark a fact "project" only if it is specific to the current project context; general facts about the user are "global".` : ""}

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
                                    op: { type: Type.STRING, enum: ["ADD", "UPDATE", "DELETE", "NOOP"] },
                                    existing_index: { type: Type.INTEGER, description: "Index into the existing facts list (UPDATE/DELETE only)." },
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
