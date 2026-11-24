import { ai, MODEL } from "@/lib/gemini";
import { Type, ThinkingLevel } from "@google/genai";
import { observeGeminiClient } from "@/lib/ai/model-observations";
import { decide } from "@/lib/ai/decisions";
import type { DecisionQuestion } from "@/lib/ai/media/requests";

export interface RouteDecision {
    mode: "chat" | "agent";
}

const TRIVIAL = /^(hi|hey|hello|thanks|thank you|thx|cool|nice|sup|yo|good (morning|afternoon|evening|night))\b/i;

const AGENT_HINT = /\b(report|essay|write[- ]?up|document|generate|build|create|script|code|program|refactor|debug|implement|research|analy[sz]e|draft|bundle|project|spreadsheet|merge|clean ?up|vault|ingest|\.(py|js|ts|tsx|md|pdf|docx|csv|json|zip))\b/i;

// Short replies that pick up work the assistant just proposed ("Both", "yes",
// "go ahead", "the first one") - these must be judged by that proposal, not by
// their own length.
const CONTINUATION = /^(both|either|all\b|y(es|eah|ep)\b|sure\b|ok(ay)?\b|go ahead|do (it|both|all|that|them)|please\b|proceed|continue|start\b|option\b|\d+\b|the\b|first\b|second\b|third\b|latter\b|former\b)/i;

function routerPrompt(message: string, lastAssistant?: string): string {
    const context = lastAssistant
        ? `The assistant's previous message (the user is replying to it):\n"""${lastAssistant.slice(-1500)}"""\nIf the user is approving, choosing, or continuing work the assistant proposed there, classify by THAT work, not by the reply's length.\n`
        : "";
    return `You route a personal assistant's messages. Decide how to handle this user message.
Choose "agent" when it needs multiple steps, research, producing a document/report, writing code/files, or maintaining the knowledge vault - anything that benefits from an autonomous multi-step agent that uses tools and can return downloadable files.
Choose "chat" for simple questions, quick facts, casual talk, memory/recall, scheduling a single reminder, or anything answerable in one short reply.
${context}User message:
"""${message.slice(0, 2000)}"""
Respond ONLY with JSON: {"mode":"agent"} or {"mode":"chat"}.`;
}

const AGENT_CRITERION = "It needs multiple steps, research, producing a document or report, writing code or files, or maintaining the knowledge vault: anything that benefits from an autonomous multi-step agent that uses tools and can return downloadable files.";
const CHAT_CRITERION = "A simple question, a quick fact, casual talk, memory or recall, scheduling a single reminder, or anything answerable in one short reply.";

/** The decision model's question; the criteria are the generate prompt's descriptions. */
export function routeQuestions(continuation: boolean): { mode: DecisionQuestion } {
    return {
        mode: {
            type: "choice",
            instructions: `How should a personal assistant handle the user's message?${continuation ? " The user is replying to the assistant's previous message: if they approve, choose or continue work the assistant proposed there, judge by THAT work, not by the reply's length." : ""}`,
            criteria: { agent: AGENT_CRITERION, chat: CHAT_CRITERION },
        },
    };
}

export function routeInput(message: string, lastAssistant?: string): string {
    const context = lastAssistant ? `The assistant's previous message:\n${lastAssistant.slice(-1500)}\n\n` : "";
    return `${context}User message:\n${message.slice(0, 2000)}`;
}

type Decide = typeof decide;

export async function classifyIntent(message: string, lastAssistant?: string, freeOnly = false, decideImpl: Decide = decide): Promise<RouteDecision> {
    const text = message.trim();

    const isShort = text.length < 16 || /^(yes|no|yep|nope|ok|okay)\b[.!]*$/i.test(text);
    const isContinuation = !!lastAssistant && CONTINUATION.test(text);

    if (TRIVIAL.test(text)) return { mode: "chat" };
    if (isShort && !isContinuation) return { mode: "chat" };

    const context = isContinuation ? lastAssistant : undefined;
    const decided = await decideImpl(routeInput(text, context), routeQuestions(!!context), { freeOnly });
    if (decided) return { mode: decided.answers.mode.type === "choice" && decided.answers.mode.value === "agent" ? "agent" : "chat" };
    if (freeOnly) return { mode: AGENT_HINT.test(text) || (isContinuation && AGENT_HINT.test(lastAssistant!)) ? "agent" : "chat" };
    try {
        const resp = await observeGeminiClient(ai, { providerId: "gemini", purpose: "routing" }).models.generateContent({
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
