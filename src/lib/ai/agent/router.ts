import { ai, MODEL } from "@/lib/gemini";
import { Type, ThinkingLevel } from "@google/genai";

export interface RouteDecision {
    mode: "chat" | "agent";
}

const TRIVIAL = /^(hi|hey|hello|thanks|thank you|thx|cool|nice|sup|yo|good (morning|afternoon|evening|night))\b/i;

const AGENT_HINT = /\b(report|essay|write[- ]?up|document|generate|build|create|script|code|program|refactor|debug|implement|research|analy[sz]e|draft|bundle|project|spreadsheet|merge|clean ?up|vault|ingest|\.(py|js|ts|tsx|md|pdf|docx|csv|json|zip))\b/i;

// Short replies that pick up work the assistant just proposed ("Both", "yes",
// "go ahead", "the first one") — these must be judged by that proposal, not by
// their own length.
const CONTINUATION = /^(both|either|all\b|y(es|eah|ep)\b|sure\b|ok(ay)?\b|go ahead|do (it|both|all|that|them)|please\b|proceed|continue|start\b|option\b|\d+\b|the\b|first\b|second\b|third\b|latter\b|former\b)/i;

function routerPrompt(message: string, lastAssistant?: string): string {
    const context = lastAssistant
        ? `The assistant's previous message (the user is replying to it):\n"""${lastAssistant.slice(-1500)}"""\nIf the user is approving, choosing, or continuing work the assistant proposed there, classify by THAT work, not by the reply's length.\n`
        : "";
    return `You route a personal assistant's messages. Decide how to handle this user message.
Choose "agent" when it needs multiple steps, research, producing a document/report, writing code/files, or maintaining the knowledge vault — anything that benefits from an autonomous multi-step agent that uses tools and can return downloadable files.
Choose "chat" for simple questions, quick facts, casual talk, memory/recall, scheduling a single reminder, or anything answerable in one short reply.
${context}User message:
"""${message.slice(0, 2000)}"""
Respond ONLY with JSON: {"mode":"agent"} or {"mode":"chat"}.`;
}

export async function classifyIntent(message: string, lastAssistant?: string): Promise<RouteDecision> {
    const text = message.trim();

    const isShort = text.length < 16 || /^(yes|no|yep|nope|ok|okay)\b[.!]*$/i.test(text);
    const isContinuation = !!lastAssistant && CONTINUATION.test(text);

    if (TRIVIAL.test(text)) return { mode: "chat" };
    if (isShort && !isContinuation) return { mode: "chat" };

    try {
        const resp = await ai.models.generateContent({
            model: MODEL,
            contents: [{ role: "user", parts: [{ text: routerPrompt(text, isContinuation ? lastAssistant : undefined) }] }],
            config: {
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: { mode: { type: Type.STRING, enum: ["chat", "agent"] } },
                    required: ["mode"],
                },
            },
        });
        const parsed = JSON.parse(resp.text ?? "{}") as { mode?: string };
        return { mode: parsed.mode === "agent" ? "agent" : "chat" };
    } catch (err) {
        console.warn("[Router] classification failed, using heuristic:", err);
        const hinted = AGENT_HINT.test(text) || (isContinuation && AGENT_HINT.test(lastAssistant!));
        return { mode: hinted ? "agent" : "chat" };
    }
}
